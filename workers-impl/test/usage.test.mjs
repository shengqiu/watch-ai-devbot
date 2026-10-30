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
  billingError,
  dayKey,
  estimateStop,
  includedCoreHours,
  mergeMax,
  nextResetAt,
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

// ---- 官方用量解析（enhanced billing platform 的 usageItems）----
{
  // 真实形状：一行一个 SKU，compute 按小时、storage 按 GB-小时，不能相加
  const raw = {
    usageItems: [
      // 2 核机器：quantity 是机器小时，pricePerUnit 0.18 = 2 × $0.09/core-h
      { product: "Codespaces", sku: "Codespaces Compute", quantity: 10.5, unitType: "hours", pricePerUnit: 0.18, grossAmount: 1.89, discountAmount: 1.89, netAmount: 0 },
      { product: "Codespaces", sku: "Codespaces Compute", quantity: 5.25, unitType: "hours", pricePerUnit: 0.18, grossAmount: 0.945, discountAmount: 0.945, netAmount: 0 },
      { product: "Codespaces", sku: "Codespaces Storage", quantity: 240, unitType: "GB-hours", pricePerUnit: 0, grossAmount: 0, discountAmount: 0, netAmount: 0.02 },
      { product: "Actions", sku: "Actions Linux", quantity: 900, unitType: "minutes", pricePerUnit: 0.008, grossAmount: 7.2, discountAmount: 7.2, netAmount: 0 },
    ],
  };
  const b = parseBilling(raw);
  check("只算 Codespaces 的计算时长", b.computeHours, 15.75);
  // 免费的额度是 core-hour：2 核跑 1 小时扣 2 —— 15.75 机器小时 = 31.5 core-h
  check("按金额折 core-hour", b.computeCoreHours, 31.5);
  check("存储单独算（GB-小时）", b.storageGbHours, 240);
  check("被额度抵掉的金额", Number(b.includedUsd.toFixed(3)), 2.835);
  check("实付金额", b.netUsd, 0.02);
  check("命中条数（不含 Actions）", b.items, 3);

  // 分钟口径的 SKU 要换算，别把 900 分钟当小时
  const mins = parseBilling({ usageItems: [{ product: "Codespaces", quantity: 120, unitType: "minutes" }] });
  check("分钟 → 小时", mins.computeHours, 2);
  // 没有金额（老数据/字段缺失）时退回 quantity，权当它本来就是 core-hour
  check("无金额时 core-hour 退回 quantity", mins.computeCoreHours, 2);

  // 本月还没用量：是「0」而不是「读不到」，不能让上层退回本地账本
  const empty = parseBilling({ usageItems: [] });
  check("空 usageItems → 0 条", empty.items, 0);
  check("空 usageItems 不是 null", empty === null, false);

  // 接口被拒 / 改版：返回 null → 上层退回本地账本，不能崩
  check("空对象 → null", parseBilling({}), null);
  check("null → null", parseBilling(null), null);
  check("usageItems 类型不对 → null", parseBilling({ usageItems: "n/a" }), null);
  check("旧版字段不再被误读", parseBilling({ total_minutes_used: 42 }), null);
}

// ---- 失败原因要能指导下一步（GitHub 拒绝计费时只给 404，不说缺什么）----
// 两种 token 的头不一样：fine-grained 看 x-accepted-github-permissions，
// classic 看 x-accepted-oauth-scopes（实测缺的是 user，不是 manage_billing:codespaces）
{
  check("401", billingError(401), "HTTP 401 — PAT rejected (expired or revoked)");
  check(
    "403 fine-grained",
    billingError(403, { permissions: "plan=read" }),
    "HTTP 403 — token lacks billing permission, needs plan=read (fine-grained)",
  );
  check(
    "403 classic",
    billingError(403, { oauthScopes: "user" }),
    "HTTP 403 — token lacks billing permission, needs the 'user' scope (classic)",
  );
  check("404 fine-grained 指向 Plan", billingError(404, { permissions: "plan=read" }).includes("plan=read"), true);
  check("404 classic 指向 user", billingError(404, { oauthScopes: "user" }).includes("'user' scope (classic)"), true);
  const bare = billingError(404);
  check("404 无头也给出两条路", [bare.includes("Plan read-only"), bare.includes("classic: user scope")], [true, true]);
  check("其他状态码", billingError(418), "HTTP 418");
}

// ---- 免费额度与重置时刻 ----
{
  // GitHub 只有 Free=120 / Pro=180 两种个人额度，学生包等同 Pro
  check("Free", includedCoreHours("free"), 120);
  check("Pro", includedCoreHours("pro"), 180);
  check("取不到 plan 按 Free 算", includedCoreHours(null), 120);
  check("空串按 Free 算", includedCoreHours(""), 120);

  // 配额按 UTC 每月 1 日 00:00 回满（GitHub《Billing cycles》）
  check("月中 → 下月 1 日", new Date(nextResetAt(T("2026-10-30T02:06:00Z"))).toISOString(), "2026-11-01T00:00:00.000Z");
  check("跨年", new Date(nextResetAt(T("2026-12-31T23:59:00Z"))).toISOString(), "2027-01-01T00:00:00.000Z");
  check("正好在 1 日零点 → 还是下个月", new Date(nextResetAt(T("2026-11-01T00:00:00Z"))).toISOString(), "2026-12-01T00:00:00.000Z");
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
  // v4.34：旧的 billing/codespaces 路径根本不存在，别再请它回来
  check("计费走 usage 报表", /settings\/billing\/usage\?year=/.test(src), true);
  // 注释里可以提到它（解释历史），但不能再拼进真实请求
  check("不再打那个不存在的 URL", /https:\/\/api\.github\.com[^`"]*billing\/codespaces/.test(src), false);
  check("计费可单独配 token", /GH_BILLING_PAT \|\| this\.env\.GH_CODESPACE_PAT/.test(src), true);
  check("缓存按月份隔离", /usage_billing:\$\{month\}/.test(src), true);
  // v4.37：/cs 与 /usage 合成一条 —— 状态与额度必须在同一个回复里，别偷偷拆回去
  check("cs 一条指令统筹两半", /await this\.handleUsage\(st\)/.test(src), true);
  check("不再有独立的 usage 分支", /case "usage":/.test(src), false);
  check("状态只查一次并传给用量", /private async handleUsage\(st: CodespaceStatus \| null\)/.test(src), true);
  check("窗口与真实状态冲突时先收尾", /CS_STOPPED_STATES\.has\(st\.state\)/.test(src), true);
  // KV 绑定名必须与 wrangler.toml 一致，否则线上 env.USAGE_KV 是 undefined
  const toml = readFileSync(`${process.cwd()}/wrangler.toml`, "utf8");
  check("wrangler.toml 有 USAGE_KV 绑定", /binding\s*=\s*"USAGE_KV"/.test(toml), true);
  check("代码读的就是 USAGE_KV", /env\.USAGE_KV/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
