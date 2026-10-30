/**
 * 运行时长账本（纯逻辑，可单测）。
 *
 * 为什么单独抽出来：/usage 之前的账本有三个毛病，全是「记账方式」而不是「取数」的问题：
 *   ① 每次换 DO_KEY（部署强制换版）DO storage 清零 → 本月用量归零；
 *      GitHub 那边的计费是按真实开机时间累加的，不会因为谁部署了一次就重来。
 *   ② 一个窗口跨零点时，整段分钟数全记到「关窗那天」→ 今日/本月都不准。
 *   ③ 进程崩在窗口中间（或 DO 被驱逐），这一段既没落账也没留下起点 → 直接丢。
 *
 * 这里把「按天切分」「幂等合并」「估计停机时刻」这些纯计算抽出来，
 * bot-do 只负责把它们接到 KV / SQL 上。
 */

export type DayMap = Record<string, number>; // YYYY-MM-DD → 分钟

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** UTC 日期键（与 GitHub 计费周期一致，不受 Worker 运行地时区影响）。 */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 把 [from, to) 按 UTC 自然日切段，返回每天各多少分钟。
 *
 * 跨零点的窗口必须切开：否则「昨天开了 3 小时、今天关」会把 3 小时全算今天。
 */
export function splitWindowByDay(from: number, to: number): DayMap {
  const out: DayMap = {};
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out;
  let cur = from;
  // 循环上限：一年。防脏数据（bootAt=0）把 Worker 卡死在这里。
  for (let i = 0; i < 400 && cur < to; i++) {
    const day = dayKey(cur);
    const nextDay = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
    const segEnd = Math.min(to, nextDay);
    out[day] = (out[day] ?? 0) + (segEnd - cur) / MIN_MS;
    cur = segEnd;
  }
  return out;
}

/** 逐日取较大值合并：幂等，用来把 KV 里的持久账本「还魂」进 DO 时不会重复累加。 */
export function mergeMax(a: DayMap, b: DayMap): DayMap {
  const out: DayMap = { ...a };
  for (const [d, m] of Object.entries(b)) {
    if (!Number.isFinite(m)) continue;
    out[d] = Math.max(out[d] ?? 0, m);
  }
  return out;
}

/** 逐日相加：只用于「新落账的一段窗口」。重复调用会重复计，调用方保证只加一次。 */
export function addDays(a: DayMap, b: DayMap): DayMap {
  const out: DayMap = { ...a };
  for (const [d, m] of Object.entries(b)) {
    if (!Number.isFinite(m)) continue;
    out[d] = (out[d] ?? 0) + m;
  }
  return out;
}

/** 区间求和（含首尾，字符串比较即可，格式固定 YYYY-MM-DD）。 */
export function sumRange(days: DayMap, from: string, to: string): number {
  let total = 0;
  for (const [d, m] of Object.entries(days)) {
    if (d < from || d > to) continue;
    if (!Number.isFinite(m)) continue;
    total += m;
  }
  return total;
}

/**
 * 估计「机器真正停下来」的时刻。
 *
 * GitHub 计费算到停机为止，而停机是「空闲超时」触发的 —— 最后一次活动 + idle 超时 ≈ 停机时刻。
 * 我们只能事后发现（巡检 30 分钟一次），直接按「发现时刻」算会多记最多 30 分钟，
 * 按 last_used_at 算又会少记一整段空闲。取中间这个估计值最接近 GitHub 的账。
 */
export function estimateStop(now: number, lastUsedAt: number | null, idleTimeoutMin: number): number {
  if (!lastUsedAt || !Number.isFinite(lastUsedAt) || lastUsedAt <= 0) return now;
  const idle = Number.isFinite(idleTimeoutMin) && idleTimeoutMin > 0 ? idleTimeoutMin : 30;
  const est = lastUsedAt + idle * MIN_MS;
  if (est >= now) return now; // 还没到超时点就发现没了（手动停的）：按现在算
  if (est <= lastUsedAt) return Math.min(now, lastUsedAt);
  return est;
}

/** Codespaces 计算的单价：$0.09 / core-hour（2 核机器 $0.18/小时 = 2 core-hour）。 */
export const CORE_HOUR_USD = 0.09;

/**
 * GitHub 官方用量（enhanced billing platform 口径）。
 *
 * 单位说明：compute 与 storage 是**两种 SKU**，数字不可相加 —— compute 按小时，
 * storage 按 GB-小时。所以分两个字段返回，展示时也分开写，别合成一个「总量」。
 */
export interface BillingUsage {
  /** 本月 Codespaces 计算用量（GitHub 报表里的 quantity，单位看 unitType） */
  computeHours: number;
  /**
   * 折算成 core-hour 的计算用量 —— 只有它能把「免费额度」减明白。
   *
   * 为什么要用金额折：报表的 quantity 是「这台机器跑了几小时」，而免费额度是
   * core-hour（2 核跑 1 小时 = 2 core-hour）。GitHub 文档没有写明 quantity 的单位，
   * 但 grossAmount = quantity × pricePerUnit 一定成立，而 core-hour 单价是 $0.09，
   * 所以 grossAmount / 0.09 一定是 core-hour，与机器几核无关。
   */
  computeCoreHours: number;
  /** 本月 Codespaces 存储用量（GB-小时） */
  storageGbHours: number;
  /** 被包含额度抵掉的金额（美元） */
  includedUsd: number;
  /** 实付金额（美元） */
  netUsd: number;
  /** 本月计费用的金额（美元，抵扣前） */
  grossUsd: number;
  /** 命中的明细条数（0 = 本月还没有用量） */
  items: number;
}

/**
 * 解析 `GET /users/{login}/settings/billing/usage`。
 *
 * 为什么不是 `/settings/billing/codespaces`：那个路径**不存在**。
 * 2026-10-29 实测（任何 token 都一样）返回的是「找不到路由」的 404，
 * 和随手编一个 `/settings/billing/nope` 完全同一个响应体 —— 换句话说，
 * 以前那个接口不是「没权限」，而是压根没这个 URL，永远不会成功。
 *
 * 现在走 enhanced billing platform 的 usage 报表，形状是
 * `{ usageItems: [{ product, sku, quantity, unitType, discountAmount, netAmount }] }`。
 * 只保留 product 里含 codespace 的行；字段缺失/改版时返回 null，上层退回本地账本。
 */
export function parseBilling(raw: unknown): BillingUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const items = (raw as Record<string, unknown>).usageItems;
  if (!Array.isArray(items)) return null;

  let computeHours = 0;
  let computeSpend = 0;
  let storageGbHours = 0;
  let includedUsd = 0;
  let netUsd = 0;
  let grossUsd = 0;
  let hits = 0;

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const row = it as Record<string, unknown>;
    if (!String(row.product ?? "").toLowerCase().includes("codespace")) continue;
    const qty = Number(row.quantity);
    if (!Number.isFinite(qty)) continue;
    const unit = String(row.unitType ?? "").toLowerCase();
    const sku = String(row.sku ?? "").toLowerCase();
    // 存储的 unitType 是 GB-hours，会被下面的 unit 判断带偏，必须先分流
    if (unit.includes("gb") || sku.includes("storage")) {
      storageGbHours += qty;
    } else {
      computeHours += unit.includes("minute") ? qty / 60 : qty;
      computeSpend += Number(row.grossAmount) || 0;
    }
    includedUsd += Number(row.discountAmount) || 0;
    netUsd += Number(row.netAmount) || 0;
    grossUsd += Number(row.grossAmount) || 0;
    hits++;
  }

  // 金额有值就按金额折（不受「几核」影响）；全 0 时退回 quantity，权当它本来就是 core-hour
  const computeCoreHours = computeSpend > 0 ? computeSpend / CORE_HOUR_USD : computeHours;

  return { computeHours, computeCoreHours, storageGbHours, includedUsd, netUsd, grossUsd, items: hits };
}

/**
 * 每月免费计算额度（core-hours）。GitHub 没有接口能读这个数，只能按 plan 名映射：
 * Free = 120，Pro = 180（含学生包）。取不到 plan 时按 Free 算 —— 宁可早报警。
 */
export function includedCoreHours(planName: string | null | undefined): number {
  const p = String(planName ?? "").toLowerCase();
  if (p.includes("pro")) return 180;
  return 120;
}

/**
 * 下一次额度重置的时刻：UTC 每月 1 日 00:00。
 *
 * 依据 GitHub《Billing cycles》：metered 产品的计费周期「starts at 00:00:00 UTC on
 * the first day of each month」，包含额度在周期起点回满 —— 不是「账号注册日」。
 */
export function nextResetAt(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * 把失败响应翻译成「下一步该做什么」。
 *
 * GitHub 对计费接口的拒绝很吝啬：没权限时给 404 而不是 403，光看状态码会以为是
 * 路由写错了。真正有用的是响应头，而且**两种 token 的头不一样**：
 *   · fine-grained → `x-accepted-github-permissions: plan=read`
 *   · classic/OAuth → `x-accepted-oauth-scopes: user`
 * 2026-10-29 实测：classic token 少的是 `user`，不是 manage_billing:codespaces
 * （那个 scope 是给旧的 codespaces 账单接口的，而那个接口已经不存在了）。
 */
export function billingError(
  status: number,
  h: { permissions?: string | null; oauthScopes?: string | null } = {},
): string {
  const need = h.permissions
    ? `, needs ${h.permissions} (fine-grained)`
    : h.oauthScopes
      ? `, needs the '${h.oauthScopes}' scope (classic)`
      : "";
  if (status === 401) return "HTTP 401 — PAT rejected (expired or revoked)";
  if (status === 403) return `HTTP 403 — token lacks billing permission${need}`;
  if (status === 404) {
    return `HTTP 404 — GitHub hides billing from this token${need}; fine-grained: Plan read-only, classic: user scope`;
  }
  return `HTTP ${status}${need}`;
}
