/**
 * Slack 请求验签（纯逻辑，可单测）。
 *
 * 与 Telegram 的双防线（IP 网段 + secret_token）对齐，Slack 官方只提供
 * 签名验证这一层（v0 版 HMAC）：
 *   sig = HMAC-SHA256(signing_secret, "v0:<ts>:<body>")
 *   头：X-Slack-Signature（v0=...）、X-Slack-Request-Timestamp（秒）
 *
 * 安全要点：
 *   1. 必须用**原始请求体**算哈希（不能先 JSON.parse 再序列化——字段顺序/转义
 *      差一个字节签名就对不上），所以 index.ts 里先 text() 再验签再 parse。
 *   2. 时间戳超过 5 分钟 = 旧请求重放 → 拒绝（官方建议）。
 *   3. Signing Secret 未配置 = fail-closed（与 Telegram WEBHOOK_SECRET 同策略）。
 *
 * 注意：本模块被 node 单测直接 import，按仓库约定必须**自包含**（不能带
 * 运行时相对导入——tsc 输出不补 .js 后缀，Node ESM 解析不了）。
 * hmacHex / timingSafeEq 从 agent-auth.ts 内联（约 12 行，语义一致）。
 */

const te = new TextEncoder();

/** HMAC-SHA256 → 小写十六进制（与 agent-auth.ts 的同名函数语义一致）。 */
async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(msg));
  return toHex(new Uint8Array(sig));
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** 定长比较（防计时侧信道，与 agent-auth.ts 同实现）。 */
function timingSafeEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** 允许的时钟偏差（秒）。官方建议 5 分钟。 */
export const SLACK_TS_WINDOW_SEC = 300;

/**
 * 验证一次 Slack 请求。通过返回 null；不通过返回应回给 Slack 的 Response。
 *
 * @param secret     Signing Secret（app 配置页 App Credentials 里，形如 8f742231b10e8888abcd99yyy...
 * @param sig        X-Slack-Signature 头（v0=<hex>）
 * @param ts         X-Slack-Request-Timestamp 头（秒级字符串）
 * @param rawBody    原始请求体（逐字节参与签名）
 * @param now        当前毫秒时间戳（测试可注入）
 */
export async function verifySlackRequest(
  secret: string | undefined,
  sig: string | null,
  ts: string | null,
  rawBody: string,
  now = Date.now(),
): Promise<Response | null> {
  if (!secret) return new Response("slack signing secret not configured", { status: 403 });
  if (!sig || !ts) return new Response("missing signature headers", { status: 403 });

  // 时间戳必须是纯数字秒；超窗 = 陈旧请求（重放），拒绝
  if (!/^\d{1,12}$/.test(ts)) return new Response("bad timestamp", { status: 403 });
  const ageSec = Math.abs(Math.floor(now / 1000) - Number(ts));
  if (ageSec > SLACK_TS_WINDOW_SEC) return new Response("stale request", { status: 403 });

  const want = await hmacHex(secret, `v0:${ts}:${rawBody}`);
  // Slack 的签名头自带 "v0=" 前缀；对齐后做定长比较
  const got = sig.startsWith("v0=") ? sig.slice(3) : sig;
  if (!timingSafeEq(got, want)) return new Response("bad signature", { status: 403 });
  return null;
}
