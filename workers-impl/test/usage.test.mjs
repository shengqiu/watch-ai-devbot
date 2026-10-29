/**
 * 运行时长账本单测（src/usage.ts）。
 *
 * 回归背景（用户 2026-10-29）：「/usage 拿的用量不对，每次重新部署都会清零，
 * 但 codespace 的计算不是这样的」。清零的根因在存储（DO 换实例），
 * 但记账本身也有两个 bug：跨零点串味、崩在窗口中间整段丢失。
 * 这里钉住纯计算部分。
 */
import { readFileSync } from "node:fs";
import {
  addDays,
  dayKey,
  estimateStop,
  mergeMax,
  parseBilling,
  splitWindowByDay,
  sumRange,
} from "../src/usage.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

const T = (iso) => Date.parse(iso);
const near = (a, b) => Math.abs(a - b) < 1e-6;

// ---- 按天切分 ----
{
  // 同一天内：一段就是一段
  const d = splitWindowByDay(T("2026-10-29T01:00:00Z"), T("2026-10-29T03:30:00Z"));
  check("同日窗口只落一天", Object.keys(d), ["2026-10-29"]);
  check("同日窗口 150 分钟", near(d["2026-10-29"], 150), true);
}
{
  // 跨零点：必须切成两天（旧实现全记到关窗那天 → 「今日」虚高）
  const d = splitWindowByDay(T("2026-10-28T22:00:00Z"), T("2026-10-29T02:00:00Z"));
  check("跨零点切成两天", Object.keys(d).sort(), ["2026-10-28", "2026-10-29"]);
  check("前一天 120 分钟", near(d["2026-10-28"], 120), true);
  check("后一天 120 分钟", near(d["2026-10-29"], 120), true);
}
{
  // 跨月也一样（月初统计不能把上月最后几小时算进来）
  const d = splitWindowByDay(T("2026-10-31T23:00:00Z"), T("2026-11-01T01:00:00Z"));
  check("跨月切成两个月份", Object.keys(d).map((k) => k.slice(0, 7)).sort(), ["2026-10", "2026-11"]);
}
{
  // 脏数据：倒序 / 相等 / 非法 → 空，不抛
  check("倒序窗口 → 空", splitWindowByDay(T("2026-10-29T03:00:00Z"), T("2026-10-29T01:00:00Z")), {});
  check("零长窗口 → 空", splitWindowByDay(1000, 1000), {});
  check("NaN → 空", splitWindowByDay(NaN, 1000), {});
  // bootAt=0 这种脏数据不能把 Worker 卡在一年循环里
  const huge = splitWindowByDay(0, T("2026-10-29T00:00:00Z"));
  check("bootAt=0 也能收敛（≤400 天）", Object.keys(huge).length <= 400, true);
}

// ---- 合并 / 求和 ----
{
  const a = { "2026-10-28": 120, "2026-10-29": 30 };
  const b = { "2026-10-29": 90, "2026-10-30": 10 };
  // mergeMax 幂等：同一份持久账本重复合并不会翻倍（这是 KV 还魂的正确性基础）
  check("mergeMax 取大", mergeMax(a, b), { "2026-10-28": 120, "2026-10-29": 90, "2026-10-30": 10 });
  check("mergeMax 幂等", mergeMax(mergeMax(a, b), b), mergeMax(a, b));
  // addDays 才是累加（新落账一段窗口用）
  check("addDays 累加", addDays(a, b), { "2026-10-28": 120, "2026-10-29": 120, "2026-10-30": 10 });
}
{
  const days = { "2026-09-30": 60, "2026-10-01": 10, "2026-10-31": 20, "2026-11-01": 99 };
  check("sumRange 只算本月", sumRange(days, "2026-10-01", "2026-10-31"), 30);
  check("sumRange 单日", sumRange(days, "2026-10-01", "2026-10-01"), 10);
  check("sumRange 空集合", sumRange({}, "2026-10-01", "2026-10-31"), 0);
}

// ---- 停机时刻估计 ----
{
  const now = T("2026-10-29T10:00:00Z");
  const lastUsed = T("2026-10-29T09:00:00Z");
  // 最后活动 09:00 + 空闲超时 30min = 09:30，比「发现时刻 10:00」更接近 GitHub 的账
  check("按最后活动+超时估", estimateStop(now, lastUsed, 30), T("2026-10-29T09:30:00Z"));
  // 刚活动过就被发现停机（手动停）：按现在算，不能给出未来时刻
  check("估计值超不过现在", estimateStop(now, T("2026-10-29T09:50:00Z"), 30), now);
  // 没有 last_used_at（接口没给）：退回 now，不猜
  check("无 lastUsedAt → now", estimateStop(now, null, 30), now);
  check("idle 非法 → 按 30 分钟", estimateStop(now, lastUsed, 0), T("2026-10-29T09:30:00Z"));
  check("估算不早于最后活动", estimateStop(now, lastUsed, -5) >= lastUsed, true);
}

// ---- 官方账单解析 ----
{
  const raw = {
    total_minutes_used: 305,
    total_paid_minutes_used: 0,
    included_minutes: 120,
    minutes_used_breakdown: { UBUNTU: 305, MACOS: 0, WINDOWS: 0 },
  };
  const b = parseBilling(raw);
  check("账单 used", b.usedMin, 305);
  check("账单 included", b.includedMin, 120);
  check("账单 paid", b.paidMin, 0);
  check("账单 ubuntu", b.ubuntuMin, 305);
  // 接口被拒 / 改版：返回 null → 上层退回本地账本，不能崩
  check("空对象 → null", parseBilling({}), null);
  check("null → null", parseBilling(null), null);
  check("字段类型不对 → null", parseBilling({ total_minutes_used: "n/a" }), null);
  const partial = parseBilling({ total_minutes_used: 42 });
  check("缺字段按 0", [partial.includedMin, partial.paidMin, partial.ubuntuMin], [0, 0, 0]);
}

// ---- 日期键 ----
{
  check("dayKey UTC", dayKey(T("2026-10-29T23:59:59Z")), "2026-10-29");
  check("dayKey 零点", dayKey(T("2026-10-29T00:00:00Z")), "2026-10-29");
}

// ---- 接线护栏：/usage 必须真的走 KV，别悄悄退回「只写 DO storage」 ----
// 事故形态和 v4.22 的 markdown 一样：逻辑测试全绿，但接线处没接上。
// 源码文本断言，谁把 KV 那几行删了就红。
{
  const src = readFileSync(`${process.cwd()}/src/bot-do.ts`, "utf8");
  check("账本写 KV（persistUsage 存在）", /private async persistUsage\(/.test(src), true);
  check("账本从 KV 还魂（restoreUsageOnce）", /private async restoreUsageOnce\(/.test(src), true);
  check("窗口起点写 KV（markWindowOpen）", /private async markWindowOpen\(/.test(src), true);
  check("巡检会补账（reconcileUsage）", /await this\.reconcileUsage\(st\)/.test(src), true);
  check("关窗落账按天切分（addRuntimeWindow）", /await this\.addRuntimeWindow\(/.test(src), true);
  check("还魂按 max 合并（不重复累加）", /mergeMax\(cur, saved\)/.test(src), true);
  // KV 绑定名必须与 wrangler.toml 一致，否则线上 env.USAGE_KV 是 undefined
  const toml = readFileSync(`${process.cwd()}/wrangler.toml`, "utf8");
  check("wrangler.toml 有 USAGE_KV 绑定", /binding\s*=\s*"USAGE_KV"/.test(toml), true);
  check("代码读的就是 USAGE_KV", /env\.USAGE_KV/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
