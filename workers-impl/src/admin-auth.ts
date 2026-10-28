/**
 * 管理端点 / 部署重载端点的鉴权 —— 全部是**纯函数**（只吃 env + Request），
 * 这样能在纯 node 里单测：index.ts 的路由依赖 DO stub，没法脱离 Workers 环境测。
 *
 * 安全审查 #8：密钥只认请求头，绝不接受 URL 查询串。
 * 原因：?key= 会被访问日志、代理遥测、浏览器历史、Referer 记录下来；
 * 请求头不会出现在 URL 里。这是本模块所有测试的回归保护目标。
 */
import type { Env } from "./env";
import { FailWindow, timingSafeEq } from "./agent-auth.js";

/** 管理端点限流：窗口内失败达到此次数即封禁（安全审查 P2）。 */
export const ADMIN_FAIL_LIMIT = 8;
/** 限流窗口（毫秒）。失败计数超过此窗口自动回落，即「8 次/10 分钟」。 */
export const ADMIN_FAIL_WINDOW_MS = 10 * 60_000;

/**
 * 从请求里取密钥候选值：
 *   优先 `Authorization: Bearer <key>`，退而用备用头 altHeader（明文）。
 * Bearer 前缀大小写按 RFC 惯例处理，取到后统一 trim，避免首尾空白导致误判。
 */
export function bearerToken(request: Request, altHeader: string): string {
  const raw = request.headers.get("Authorization") ?? request.headers.get(altHeader) ?? "";
  const t = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  return t.trim();
}

/**
 * 管理端点（/status、/setup、/send、/csdebug、/patrol、/shell/status）是否被拒绝。
 * ADMIN_KEY 未配置 = 全部拒绝（默认安全，宁可不可用也不裸奔）。
 */
export function adminDenied(env: Pick<Env, "ADMIN_KEY">, request: Request): boolean {
  const key = env.ADMIN_KEY;
  if (!key) return true;
  // 用 timingSafeEq 而非 !==：避免按字节逐步比较泄露「前缀对了多少」
  return !timingSafeEq(bearerToken(request, "X-Admin-Key"), key);
}

export type ReloadVerdict = { ok: true } | { ok: false; status: 405 | 401 };

/**
 * 部署重载端点（/admin/reload）的判定：
 *   - 非 POST → 405：重载会 abort 整个 DO 实例，是状态变更，不能走 GET
 *     （GET 会被预取、爬虫、缓存顺手触发）。
 *   - DEPLOY_KEY 未配置，或头里的密钥不匹配 → 401。
 * 密钥只认 Authorization: Bearer <DEPLOY_KEY> 或 X-Deploy-Key 头，绝不进 URL。
 */
export function reloadVerdict(env: Pick<Env, "DEPLOY_KEY">, request: Request): ReloadVerdict {
  if (request.method !== "POST") return { ok: false, status: 405 };
  const key = env.DEPLOY_KEY;
  if (!key) return { ok: false, status: 401 };
  return timingSafeEq(bearerToken(request, "X-Deploy-Key"), key)
    ? { ok: true }
    : { ok: false, status: 401 };
}

/** 把 ReloadVerdict 转成 HTTP 响应（index.ts 与 bot-do.ts 共用以保持行为一致）。 */
export function reloadErrorResponse(v: { ok: false; status: 405 | 401 }): Response {
  if (v.status === 405) return new Response("method not allowed", { status: 405 });
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

/**
 * 取客户端 IP（限流键）。
 * CF-Connecting-IP 由边缘写入，客户端伪造不了；本地/测试无此头时退化为 "unknown"
 * （所有无头请求共用一个窗口，够用）。
 */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * 管理端点（/status、/setup、/send、/csdebug、/patrol、/shell/status）准入决策。
 * 纯函数；失败计数由调用方持有的 FailWindow 维护。顺序刻意如此：
 *   - "block"：该 IP 失败次数已封顶 → 直接 429，连「密钥对不对」都不透露（不泄露存在性）
 *   - "deny" ：密钥不对 → 调用方应 record(ip) 记一次失败并回 403
 *   - "allow"：密钥正确 → 放行
 * 限流优先于密钥判断，所以被封的 IP 哪怕后来猜对密钥也进不来，直到窗口回落。
 */
export function adminGate(
  window: FailWindow,
  ip: string,
  env: Pick<Env, "ADMIN_KEY">,
  request: Request,
  now = Date.now(),
): "block" | "deny" | "allow" {
  if (window.blocked(ip, now)) return "block";
  if (adminDenied(env, request)) return "deny";
  return "allow";
}

/**
 * /admin/reload 准入决策（DEPLOY_KEY + 仅 POST）。限流逻辑与 adminGate 一致：
 * 先查 block（429），再交给 reloadVerdict（405/401），通过则 "ok"。
 */
export function reloadGate(
  window: FailWindow,
  ip: string,
  env: Pick<Env, "DEPLOY_KEY">,
  request: Request,
  now = Date.now(),
): { decision: "block" } | { decision: "ok" } | { decision: "deny"; status: 405 | 401 } {
  if (window.blocked(ip, now)) return { decision: "block" };
  const v = reloadVerdict(env, request);
  return v.ok ? { decision: "ok" } : { decision: "deny", status: v.status };
}

/** 限流响应（429 + Retry-After），与 bot-do.ts 既有 429 风格保持一致。 */
export function rateLimitedResponse(retryAfterSec: number): Response {
  return Response.json(
    { ok: false, error: `too many failed attempts, retry after ${retryAfterSec}s`, retryAfter: retryAfterSec },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}
