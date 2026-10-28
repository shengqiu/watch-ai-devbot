/**
 * agent ⇄ Worker 双向鉴权（HMAC-SHA256 + 时间窗 + 随机数防重放）。
 *
 * 为什么不再只用一个静态 `X-Agent-Key` 头：
 *   1. 静态密钥在**每一次请求**里明文出现。它可能落进 CF 的请求日志、`wrangler tail`
 *      的输出、抓包、或任何一次误发的截图里 —— 一旦泄露，对方就能长期冒充 agent
 *      连上 /shell/stream、往 /shell/out 灌伪造输出。
 *   2. 没有时间戳 = 抓到一个历史请求就能**无限重放**。
 *   3. 没有随机数 = 同一个请求体在一分钟内可以重复利用。
 *
 * 现在改成：密钥只用于算签名，**永不上线**（不上行文、不进 header）。
 *
 * 签名内容（两端必须逐字节一致）：
 *   请求  v1\n<ts>\n<nonce>\n<METHOD>\n<path>\n<sha256(body)>
 *   命令  v1\n<id>\n<cmd>
 *
 * 命令签名是**下行**方向的保护：agent 只执行签名对得上的命令。这样即使有人
 * 拿到了 AGENT_KEY 并挤进 SSE 通道，也不能凭空造一条命令让机器跑。
 *
 * 时间窗 120s：允许机器时钟轻微漂移，同时把重放窗口压到两分钟内；配合
 * NonceCache（3 分钟），同一个签名只会被接受一次。
 */

/** 请求头（agent → Worker）。名字都带 X-Agent- 前缀，方便在 CF 日志里定位。 */
export const AGENT_HDR = {
  sig: "X-Agent-Sig",
  ts: "X-Agent-Ts",
  nonce: "X-Agent-Nonce",
  id: "X-Agent-Id",
  legacyKey: "X-Agent-Key",
} as const;

/** 允许的时钟偏差（毫秒）。太小会让时钟不准的机器连不上，太大等于放宽重放窗口。 */
export const AUTH_WINDOW_MS = 120_000;
/** 随机数的记忆时长（毫秒）。必须 ≥ 2 × 时间窗，否则边界上仍可重放。 */
export const NONCE_TTL_MS = 240_000;
/** NonceCache 上限，防止被灌爆内存（超出就丢最旧的）。 */
const NONCE_MAX = 4096;

// ------------------------------------------------------------------ 基础原语

const te = new TextEncoder();

/** SHA-256 → 小写十六进制。空串也有确定值（e3b0c442…），不需要特判。 */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", te.encode(text));
  return toHex(new Uint8Array(d));
}

/** HMAC-SHA256 → 小写十六进制。 */
export async function hmacHex(secret: string, msg: string): Promise<string> {
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

/**
 * 定长比较：不提前 return、不比较长度差异。
 *
 * `a === b` 在 V8 里是短路的，比较耗时随「前多少位相同」变化。对 HMAC 签名
 * 这种逐字节猜测的场景，理论上可被计时侧信道逐步逼近（实践上隔着网络很难，
 * 但这属于零成本就能避免的坏习惯）。
 */
export function timingSafeEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** 时间戳是否在窗口内。ts 必须是毫秒整数串（agent 侧 Date.now()）。 */
export function tsFresh(ts: string, now = Date.now(), windowMs = AUTH_WINDOW_MS): boolean {
  if (!/^\d{1,16}$/.test(ts)) return false;
  const t = Number(ts);
  return Math.abs(now - t) <= windowMs;
}

// ------------------------------------------------------------------ 签名

/** 上行请求的待签字符串。path 含 query 时必须两端一致（这里统一用 pathname）。 */
export function requestInput(ts: string, nonce: string, method: string, path: string, bodySha: string): string {
  return `v1\n${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodySha}`;
}

/** 下行命令的待签字符串。id 与 cmd 用 \n 分隔，cmd 内的换行不影响解析（整体一次签名）。 */
export function commandInput(id: string, cmd: string): string {
  return `v1\n${id}\n${cmd}`;
}

export async function signRequest(
  secret: string,
  opts: { ts: string; nonce: string; method: string; path: string; bodyText: string },
): Promise<string> {
  return hmacHex(secret, requestInput(opts.ts, opts.nonce, opts.method, opts.path, await sha256Hex(opts.bodyText)));
}

export async function signCommand(secret: string, id: string, cmd: string): Promise<string> {
  return hmacHex(secret, commandInput(id, cmd));
}

// ------------------------------------------------------------------ 重放防护

/**
 * 最近见过的 nonce。内存态即可：DO 被驱逐时连接也一起断了，重放窗口自然消失。
 * 容量满时清掉过期项；仍满则整体清空（宁可放过一次重放，也不能无限涨内存）。
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  /** true = 之前见过（判定为重放）；false = 首次见到，已记录。 */
  check(nonce: string, now = Date.now(), ttlMs = NONCE_TTL_MS): boolean {
    this.prune(now, ttlMs);
    if (this.seen.has(nonce)) return true;
    if (this.seen.size >= NONCE_MAX) this.seen.clear();
    this.seen.set(nonce, now);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(now: number, ttlMs: number): void {
    for (const [k, at] of this.seen) if (now - at > ttlMs) this.seen.delete(k);
  }
}

// ------------------------------------------------------------------ 鉴权限流

/**
 * 失败计数滑动窗口（「N 次/窗口 → 429」暴力尝试防护用）。
 *
 * 固定窗口 + 自动过期：record 一次失败 → 窗口内计数 +1；超过窗口的旧记录会被
 * prune 掉，计数自然回落。blocked 在计数达到 limit 时为真；retryAfterSec 给出
 * 距解除还有多少秒（给 429 的 Retry-After 头用）。
 *
 * 状态只在内存（entry/DO 实例生命周期内），不做持久化：限流是软护栏，丢窗口
 * 不影响安全（最坏是短暂放行，真正的门是密钥本身）。key 一般取客户端 IP。
 */
export class FailWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 记录一次失败（now 毫秒时间戳）。 */
  record(key: string, now = Date.now()): void {
    const arr = this.hits.get(key) ?? [];
    this.prune(arr, now);
    arr.push(now);
    this.hits.set(key, arr);
  }

  /** 窗口内失败次数是否已 ≥ limit（顺带清理过期记录，避免 Map 无限增长）。 */
  blocked(key: string, now = Date.now()): boolean {
    const arr = this.hits.get(key);
    if (!arr || arr.length === 0) return false;
    this.prune(arr, now);
    return arr.length >= this.limit;
  }

  /** 距限流解除还有多少秒（给 Retry-After）；未限流返回 0。 */
  retryAfterSec(key: string, now = Date.now()): number {
    const arr = this.hits.get(key);
    if (!arr || arr.length === 0) return 0;
    this.prune(arr, now);
    if (arr.length < this.limit) return 0;
    return Math.max(0, Math.ceil((arr[0]! + this.windowMs - now) / 1000));
  }

  private prune(arr: number[], now: number): void {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < arr.length && (arr[i] as number) < cut) i++;
    if (i > 0) arr.splice(0, i);
  }
}

// ------------------------------------------------------------------ 判定

export type AuthResult = { ok: true; mode: "hmac" | "legacy" } | { ok: false; reason: string };

export interface VerifyOpts {
  /** Worker 侧 secret（AGENT_KEY）。空 = 一律拒绝（fail-closed）。 */
  secret: string | undefined;
  /** 过渡开关：仍接受明文 X-Agent-Key（仅用于 agent 还没升级的那段时间）。 */
  legacyAllowed: boolean;
  headers: Headers;
  method: string;
  /** 只取 pathname，不含 query。 */
  path: string;
  bodyText: string;
  /** 期望的 agent 身份（codespace 名）。空 = 不校验。 */
  expectedId?: string;
  now?: number;
  nonces: NonceCache;
}

/**
 * 校验一次 agent 请求。顺序刻意如此：密钥缺失 → 直接拒绝（绝不「没配就当通过」）。
 */
export async function verifyAgentRequest(o: VerifyOpts): Promise<AuthResult> {
  if (!o.secret) return { ok: false, reason: "AGENT_KEY 未配置" };
  const now = o.now ?? Date.now();

  const sig = o.headers.get(AGENT_HDR.sig) ?? "";
  if (!sig) {
    // 没有签名：只有显式打开的过渡窗口才接受明文密钥
    if (!o.legacyAllowed) return { ok: false, reason: "缺少签名头" };
    const got = o.headers.get(AGENT_HDR.legacyKey) ?? "";
    return timingSafeEq(got, o.secret) ? { ok: true, mode: "legacy" } : { ok: false, reason: "密钥不匹配" };
  }

  const ts = o.headers.get(AGENT_HDR.ts) ?? "";
  const nonce = o.headers.get(AGENT_HDR.nonce) ?? "";
  if (!nonce || nonce.length < 16) return { ok: false, reason: "缺少或过短的 nonce" };
  if (!tsFresh(ts, now)) return { ok: false, reason: "时间戳超出窗口" };

  const agentId = o.headers.get(AGENT_HDR.id) ?? "";
  if (o.expectedId && agentId !== o.expectedId) return { ok: false, reason: `身份不匹配（${agentId || "空"}）` };

  const bodySha = await sha256Hex(o.bodyText);
  const want = await hmacHex(o.secret, requestInput(ts, nonce, o.method, o.path, bodySha));
  if (!timingSafeEq(sig, want)) return { ok: false, reason: "签名不匹配" };

  // 签名先验、再记 nonce：否则攻击者随便发个假签名就能把缓存灌满
  if (o.nonces.check(nonce, now)) return { ok: false, reason: "nonce 重复（疑似重放）" };
  return { ok: true, mode: "hmac" };
}
