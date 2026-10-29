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

/** GitHub Codespaces 计费接口返回（字段名照抄官方，单位见 parseBilling 注释）。 */
export interface BillingUsage {
  /** 已用（GitHub 口径的分钟数，见下方 unit 说明） */
  usedMin: number;
  /** 本月包含额度（同口径） */
  includedMin: number;
  /** 超出部分计费分钟 */
  paidMin: number;
  /** 其中 Ubuntu 机器 */
  ubuntuMin: number;
}

/**
 * 解析 `GET /users/{login}/settings/billing/codespaces`。
 *
 * 注意单位：GitHub 这个接口把「包含额度」按 core-hours 报（Free=120 / Pro=180），
 * 而 total_minutes_used 是 core-minutes。两者口径不同，所以这里**不做换算**，
 * 只把原始值交给上层展示，并在文案里写明「GitHub 口径」，避免二次算错。
 * 字段缺失（接口被拒/改版）时返回 null，上层退回本地账本。
 */
export function parseBilling(raw: unknown): BillingUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const used = Number(d.total_minutes_used);
  if (!Number.isFinite(used)) return null;
  const included = Number(d.included_minutes);
  const paid = Number(d.total_paid_minutes_used);
  const breakdown = (d.minutes_used_breakdown ?? {}) as Record<string, unknown>;
  const ubuntu = Number(breakdown.UBUNTU);
  return {
    usedMin: used,
    includedMin: Number.isFinite(included) ? included : 0,
    paidMin: Number.isFinite(paid) ? paid : 0,
    ubuntuMin: Number.isFinite(ubuntu) ? ubuntu : 0,
  };
}
