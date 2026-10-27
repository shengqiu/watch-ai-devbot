/**
 * 「webhook 只认 Telegram」——按来源 IP 做入口白名单。
 *
 * 为什么光有 `X-Telegram-Bot-Api-Secret-Token` 不够：
 *   那是一个**静态共享密钥**。它只能证明「发请求的人知道这串字符」，不能证明对方
 *   是 Telegram。任何一次泄漏（日志、截图、备份、误 push）都会让第三方永久拥有
 *   伪造更新的能力 —— 而伪造一条 text=/boot 就足以驱动整台开发机。
 *
 * 为什么 IP 白名单这次是**真证据**：
 *   `CF-Connecting-IP` 由 Cloudflare 边缘写入并覆盖，客户端自己带的同名头会被丢弃。
 *   所以这个值等价于「TCP 连接的对端地址」，无法伪造。配合 Telegram 官方公布的
 *   两个网段，就等于「只有 Telegram 的服务器能敲这扇门」。
 *
 * 已知限制（必须说清楚，别当成万能）：
 *   1. 只有 IPv4。Telegram 官方明确「IPv6 is currently not supported for webhooks」。
 *   2. 网段是**官方公布、可能变**的（文档每次都写 "might change in the future"）。
 *      真变了的表现是：bot 完全收不到消息，而 CF 日志里全是 not-telegram。
 *      所以留了 TELEGRAM_IP_GUARD=warn（只记日志）/off（关掉）两个逃生阀。
 *   3. 它约束的是「谁能在网络层连进来」，不约束「Telegram 里谁能指挥 bot」——
 *      后者是 ALLOWED_USERS 白名单 + 验证词的事，两者互不替代。
 *
 * 官方出处：https://core.telegram.org/bots/webhooks
 *   "If you want to limit access to Telegram only, please allow traffic from
 *    149.154.160.0/20 and 91.108.4.0/22."
 */

/** Telegram Bot API 发 webhook 的两个来源网段（IPv4）。 */
export const TELEGRAM_CIDRS = ["149.154.160.0/20", "91.108.4.0/22"];

/** 归一化：去空白/方括号、小写、把 IPv4-mapped IPv6（::ffff:1.2.3.4）还原成 IPv4。 */
export function normalizeIp(raw: string | null | undefined): string {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]") > 0 ? s.indexOf("]") : undefined);
  if (s.startsWith("::ffff:")) s = s.slice(7);
  return s;
}

/** 点分 IPv4 → 32 位无符号整数；非法返回 null。 */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** ip 是否落在 cidr（如 "149.154.160.0/20"）里。非法输入一律 false（fail-closed）。 */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(normalizeIp(ip));
  const b = ipv4ToInt(normalizeIp(base));
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function isTelegramIp(ip: string, cidrs: readonly string[] = TELEGRAM_CIDRS): boolean {
  const s = normalizeIp(ip);
  if (!s) return false;
  return cidrs.some((c) => inCidr(s, c));
}

export type IpGuardMode = "on" | "warn" | "off";
export interface IpVerdict {
  mode: IpGuardMode;
  allow: boolean;
  reason: "ok" | "guard-off" | "warn-only" | "missing-ip" | "not-telegram";
}

/** 解析 TELEGRAM_IP_GUARD：默认 on（安全优先），只有显式 off 才关。 */
export function guardMode(raw: string | undefined): IpGuardMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "warn") return "warn";
  return "on";
}

/**
 * 给入口用的判定：warn 模式放行但 reason 会告诉调用方「本该拒绝」，
 * 这样切到 on 之前可以先在日志里观察真实流量，不会一句话把 bot 变哑。
 */
export function webhookVerdict(
  ip: string | null | undefined,
  rawGuard: string | undefined,
  cidrs: readonly string[] = TELEGRAM_CIDRS,
): IpVerdict {
  const mode = guardMode(rawGuard);
  if (mode === "off") return { mode, allow: true, reason: "guard-off" };
  const s = normalizeIp(ip);
  if (!s) return { mode, allow: mode === "warn", reason: "missing-ip" };
  if (isTelegramIp(s, cidrs)) return { mode, allow: true, reason: "ok" };
  return { mode, allow: mode === "warn", reason: mode === "warn" ? "warn-only" : "not-telegram" };
}
