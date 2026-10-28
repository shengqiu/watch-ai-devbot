/**
 * Worker 入口：Telegram 通道。无长连接、无 cron——事件驱动，按需唤醒 DO。
 *   GET  /healthz                 → 公开存活探针（只回 {ok:true}，不含任何部署/连接信息）
 *   GET  /status                  → 诊断详情（build/identity/shell/auth/来源 IP；需 X-Admin-Key 头）
 *   GET  /setup                   → 一次性注册 webhook（需 X-Admin-Key 头，防重注册攻击）
 *   POST /webhook                 → Telegram 事件推送入口
 *                                   （① 来源 IP 必须是 Telegram 网段 ② 必须带 secret_token 头）
 *   GET  /send                    → 调试推送（需 X-Admin-Key 头）
 *   GET  /csdebug                 → Codespace 状态诊断（需 X-Admin-Key 头）
 *   GET  /shell/stream            → agent 下行命令通道（SSE 长连接，需 HMAC 签名头）
 *   POST /shell/out               → agent 回传命令输出（需 HMAC 签名头）
 *   GET  /shell/status            → shell 通道诊断（需 X-Admin-Key 头）
 *   管理端点鉴权一律走请求头（Authorization: Bearer <ADMIN_KEY> 或 X-Admin-Key），
 *   绝不接受 ?key= 查询串——避免密钥被访问日志 / 代理遥测记录（安全审查 #8）。
 */
import type { Env } from "./env";
import { endpoints } from "./config";
import { TelegramClient } from "./telegram/client";
import { guardMode, webhookVerdict } from "./telegram-ip";
import { adminGate, reloadGate, reloadVerdict, reloadErrorResponse, rateLimitedResponse, clientIp, ADMIN_FAIL_LIMIT, ADMIN_FAIL_WINDOW_MS } from "./admin-auth";
import { FailWindow } from "./agent-auth";

// Durable Object 必须从入口导出（wrangler 据此注册绑定）
export { AssistantDO } from "./bot-do";

// 管理端点鉴权抽到 admin-auth.ts（纯函数，可单测）：
//   密钥只认请求头（Authorization: Bearer <ADMIN_KEY> 或 X-Admin-Key），绝不接受 URL 查询串，
//   避免密钥被访问日志 / 代理遥测记录（安全审查 #8）。
// 另加每-IP 失败限流（FailWindow：8 次/10 分钟 → 429），防密钥暴力破解（安全审查 P2-6）。

// 限流窗口在入口 Worker 实例内存里，覆盖所有管理端点（含 /admin/reload）。
// 注意：多实例边缘下这是 per-isolate 的软护栏——真正的安全门仍是密钥本身；
// 若以后要全局一致限流，把计数挪到 DO storage 即可（见 bot-do.ts 的额度实现）。
const adminFailWindow = new FailWindow(ADMIN_FAIL_LIMIT, ADMIN_FAIL_WINDOW_MS);

/**
 * 管理端点准入：限流优先（429），其次密钥（403 并记一次失败），通过返回 null。
 * 限流优先意味着被封的 IP 连「密钥对不对」都探不出来。
 */
function adminAdmit(ip: string, env: Env, request: Request): Response | null {
  const g = adminGate(adminFailWindow, ip, env, request);
  if (g === "block") return rateLimitedResponse(adminFailWindow.retryAfterSec(ip));
  if (g === "deny") {
    adminFailWindow.record(ip);
    return Response.json(
      { ok: false, error: "需要 Authorization: Bearer <ADMIN_KEY>（或 X-Admin-Key 头）" },
      { status: 403 },
    );
  }
  return null;
}

/**
 * 取单例 DO 的 stub。
 *
 * 名字走 DO_KEY（默认 "singleton"）而不是写死 —— 这是**强制换版开关**：
 * DO 被 SSE 钉住时 deploy 不生效，改一次 DO_KEY 就路由到全新实例，立刻拿到新代码。
 * 详见 env.ts 里 DO_KEY 的说明（代价是旧 storage 全部清零）。
 */
function doStub(env: Env): DurableObjectStub {
  return env.BOT.get(env.BOT.idFromName(env.DO_KEY || "singleton"));
}

/** 需要走 ADMIN_KEY 鉴权再透传给 DO 的管理端点（含机器密钥管理）。 */
function isAdminProxy(pathname: string): boolean {
  return (
    pathname === "/csdebug" ||
    pathname === "/send" ||
    pathname === "/patrol" ||
    pathname === "/shell/status" ||
    pathname === "/admin/agents" ||
    pathname.startsWith("/admin/agents/")
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 顶层 try/catch：任何未捕获异常都转成可读 JSON，而不是 opaque 的 1101
    try {
      const url = new URL(request.url);
      const stub = doStub(env);
      const ip = clientIp(request); // 限流键：边缘写入，伪造不了

      if (url.pathname === "/healthz") {
        // 公开只读存活探针：只回通用 liveness，不暴露任何部署/连接信息
        // （build/identity/shell/auth/来源 IP 全部挪到需 ADMIN_KEY 的 /status，见安全审查 #7）。
        return Response.json({ ok: true });
      }

      if (url.pathname === "/status") {
        // 诊断详情：仅限管理员。暴露部署身份、shell 在线状态、鉴权模式、最近来源 IP
        // 这些都属于 operational metadata，不能对匿名公开（/healthz 只回 liveness）。
        const d = adminAdmit(ip, env, request);
        if (d) return d;
        const r = await stub.fetch("http://do/status");
        return Response.json({
          ok: true,
          ...((await r.json()) as Record<string, unknown>),
          // 入口白名单状态（on/warn/off），便于部署后一眼确认门槛是开的
          webhookGuard: guardMode(env.TELEGRAM_IP_GUARD),
        });
      }

      if (url.pathname === "/setup") {
        const d = adminAdmit(ip, env, request);
        if (d) return d;
        if (!env.TELEGRAM_BOT_TOKEN) {
          return Response.json(
            { ok: false, error: "TELEGRAM_BOT_TOKEN 未配置。先运行: npx wrangler secret put TELEGRAM_BOT_TOKEN" },
            { status: 400 },
          );
        }
        const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, endpoints(env).telegramApiBase);
        const callback = `${url.origin}/webhook`;
        const ok = await tg.setWebhook(callback, env.TELEGRAM_WEBHOOK_SECRET);
        const info = await tg.getWebhookInfo();
        return Response.json({ ok, callback, webhook: info });
      }

      if (url.pathname === "/webhook") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        // 入口白名单：只收 Telegram 官宣的两个网段（CF-Connecting-IP 由边缘写入，
        // 客户端伪造不了）。这是「Telegram 是唯一入口」的**网络层**证据，
        // 与 DO 内的 secret_token（密钥层）互为冗余。见 src/telegram-ip.ts。
        const ip = request.headers.get("CF-Connecting-IP");
        const v = webhookVerdict(ip, env.TELEGRAM_IP_GUARD);
        if (!v.allow) {
          console.log(`[webhook] 拒绝来源 ${ip ?? "(空)"}：${v.reason}`);
          return new Response("forbidden", { status: 403 });
        }
        if (v.reason !== "ok" && v.mode === "warn") {
          // warn 模式：照常处理，但把「本该拒掉」的来源记下来，观察够了再切 on
          console.log(`[webhook] warn：来源 ${ip ?? "(空)"} ${v.reason}（仍放行）`);
        }
        if (v.reason === "ok") console.log(`[webhook] 来源 ${ip}`);
        // 原样透传 headers + body 流（secret_token 校验在 DO 内做）
        return stub.fetch(
          new Request("http://do/webhook", {
            method: "POST",
            headers: request.headers,
            body: request.body,
          }),
        );
      }

      // Shell 通道（codespace 内 agent 反连）：不走 ADMIN_KEY，
      // 由 DO 用 AGENT_KEY 做双向鉴权（agent 只需收命令 + 回传输出，不给它管理权限）。
      if (url.pathname === "/shell/stream" || url.pathname === "/shell/out" || url.pathname === "/shell/ping") {
        return stub.fetch(
          new Request(`http://do${url.pathname}?${url.searchParams.toString()}`, {
            method: request.method,
            headers: request.headers,
            body: request.method === "POST" ? request.body : undefined,
          }),
        );
      }

      // 部署后重载：让 DO 换到新构建。鉴权用独立的 DEPLOY_KEY（只给 CI），
      // 不套 ADMIN_KEY —— 这样 CI 不需要拿到管理全站的那把钥匙。
      // 安全（安全审查 #8）：只接受 POST，密钥走 Authorization 头，绝不进 URL。
      if (url.pathname === "/admin/reload") {
        const g = reloadGate(adminFailWindow, ip, env, request);
        if (g.decision === "block") return rateLimitedResponse(adminFailWindow.retryAfterSec(ip));
        if (g.decision === "deny") {
          adminFailWindow.record(ip);
          return reloadErrorResponse({ ok: false, status: g.status });
        }
        return stub.fetch(
          new Request("http://do/admin/reload", {
            method: "POST",
            headers: request.headers,
          }),
        );
      }

      // DO 内部路由透传（管理端点，统一 ADMIN_KEY 鉴权）
      if (isAdminProxy(url.pathname)) {
        const d = adminAdmit(ip, env, request);
        if (d) return d;
        // GET/HEAD 走查询串；POST/DELETE 转发请求体（机器密钥管理需要 body）
        const forwardBody = request.method === "POST" || request.method === "DELETE";
        return stub.fetch(`http://do${url.pathname}?${url.searchParams.toString()}`, {
          method: request.method,
          headers: request.headers,
          body: forwardBody ? request.body : undefined,
        });
      }

      return new Response("watch-ai assistant (telegram). try /healthz", { status: 200 });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },

  // 看门狗巡检：cron 每 30 分钟触发（wrangler.toml [triggers]）。
  // 弥补 DO alarm 的盲区——机器在跑但无 episode 记录（VS Code/网页直接开机）。
  async scheduled(event, env): Promise<void> {
    try {
      const stub = doStub(env);
      const r = await stub.fetch("http://do/patrol");
      console.log("[patrol]", await r.text());
    } catch (e) {
      console.error("[patrol] 巡检失败", e);
    }
  },
} satisfies ExportedHandler<Env>;
