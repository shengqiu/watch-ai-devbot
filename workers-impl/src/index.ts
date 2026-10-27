/**
 * Worker 入口：Telegram 通道。无长连接、无 cron——事件驱动，按需唤醒 DO。
 *   GET  /healthz                 → DO 状态（build 等，部署后验收用；公开只读）
 *   GET  /setup?key=              → 一次性注册 webhook（需 ADMIN_KEY，防重注册攻击）
 *   POST /webhook                 → Telegram 事件推送入口
 *                                   （① 来源 IP 必须是 Telegram 网段 ② 必须带 secret_token 头）
 *   GET  /send?key=&text=&chat_id= → 调试推送（需 ADMIN_KEY）
 *   GET  /csdebug?key=            → Codespace 状态诊断（需 ADMIN_KEY）
 *   GET  /shell/stream            → agent 下行命令通道（SSE 长连接，需 HMAC 签名头）
 *   POST /shell/out               → agent 回传命令输出（需 HMAC 签名头）
 *   GET  /shell/status?key=       → shell 通道诊断（需 ADMIN_KEY）
 */
import type { Env } from "./env";
import { endpoints } from "./config";
import { TelegramClient } from "./telegram/client";
import { guardMode, webhookVerdict } from "./telegram-ip";

// Durable Object 必须从入口导出（wrangler 据此注册绑定）
export { AssistantDO } from "./bot-do";

/** 管理端点鉴权：ADMIN_KEY secret 未配置 = 全部管理端点拒绝（默认安全）。 */
function adminDenied(env: Env, request: Request): boolean {
  const key = env.ADMIN_KEY;
  if (!key) return true;
  const url = new URL(request.url);
  const got = url.searchParams.get("key") ?? request.headers.get("X-Admin-Key") ?? "";
  return got !== key;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 顶层 try/catch：任何未捕获异常都转成可读 JSON，而不是 opaque 的 1101
    try {
      const url = new URL(request.url);
      const stub = doStub(env);

      if (url.pathname === "/healthz") {
        const r = await stub.fetch("http://do/status");
        return Response.json({
          ok: true,
          ...((await r.json()) as Record<string, unknown>),
          // 入口白名单状态（on/warn/off），便于部署后一眼确认门槛是开的
          webhookGuard: guardMode(env.TELEGRAM_IP_GUARD),
        });
      }

      if (url.pathname === "/setup") {
        if (adminDenied(env, request)) {
          return Response.json({ ok: false, error: "需要 ?key=ADMIN_KEY（或 X-Admin-Key 头）" }, { status: 403 });
        }
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

      // 部署后重载：让 DO 换到新构建。鉴权在 DO 内用独立的 DEPLOY_KEY（只给 CI），
      // 不套 ADMIN_KEY —— 这样 CI 不需要拿到管理全站的那把钥匙。
      if (url.pathname === "/admin/reload") {
        return stub.fetch(`http://do/admin/reload?${url.searchParams.toString()}`);
      }

      // DO 内部路由透传（管理端点，统一 ADMIN_KEY 鉴权）
      if (
        url.pathname === "/csdebug" ||
        url.pathname === "/send" ||
        url.pathname === "/patrol" ||
        url.pathname === "/shell/status"
      ) {
        if (adminDenied(env, request)) {
          return Response.json({ ok: false, error: "需要 ?key=ADMIN_KEY（或 X-Admin-Key 头）" }, { status: 403 });
        }
        return stub.fetch(`http://do${url.pathname}?${url.searchParams.toString()}`);
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
