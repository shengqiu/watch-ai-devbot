/**
 * Slack 通道 + 接线护栏 —— **独立测试文件**（2026-10-29）。
 *
 * 为什么要独立：2026-10-29 发生过一次「陈旧工作副本覆盖」事故 ——
 * 另一个会话把 bot-do.ts / index.ts / test/logic.test.mjs 整体提交成旧版本，
 * 一次性抹掉 412 行 Slack 集成并一路绿灯部署上线。
 * 根因之一是 Slack 的测试与断言都塞在 logic.test.mjs 里：那个文件被覆盖，
 * 护栏也跟着一起没了，于是「集成还在不在」无人把关。
 *
 * 拆成独立文件 + 独立运行后：对方覆盖 logic.test.mjs 抹不掉这里的断言，
 * 下次再有人把 Slack 接线删掉，CI 会立刻变红而不是静默上线。
 *
 * 运行：npm test（package.json 里已串上）
 */
import { readFileSync } from "node:fs";
import {
  isUrlVerification,
  extractSlackEvent,
  extractSlackCommand,
  normalizeSlackText,
} from "../src/slack/update.js";
import { mdToSlack } from "../src/slack/markdown.js";
import { verifySlackRequest, SLACK_TS_WINDOW_SEC } from "../src/slack/verify.js";
import { channelOf } from "../src/telegram/update.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

// 测试侧自算签名用的 HMAC（Web Crypto，Node 18+ 全局可用；与 verify.ts 同算法）
async function testHmacHex(secret, msg) {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Slack 通道（v4.22：提取/握手/提及归一化/mrkdwn/通道路由）----

// 握手识别
check("url_verification 识别", isUrlVerification({ type: "url_verification", challenge: "abc123" }), true);
check("普通事件不是握手", isUrlVerification({ type: "event_callback", event: {} }), false);

// 事件提取：chatId 命名空间前缀 + bot 过滤 + 子事件过滤
const slackEvent = {
  token: "xx",
  team_id: "T000",
  api_app_id: "A000",
  event_id: "Ev111",
  type: "event_callback",
  event: { type: "message", ts: "1690000000.000100", text: "  /boot  ", channel: "C123", user: "U9", subtype: undefined, bot_id: undefined },
};
const se = extractSlackEvent(slackEvent);
check("slack 事件 chatId 前缀", se?.chatId, "slack:C123");
check("slack 事件 userId", se?.userId, "U9");
check("slack 事件 trim", se?.text, "/boot");
check("slack 去重键带前缀", se?.updateId.startsWith("slack:"), true);

// bot 自己的消息必须忽略（自言自语死循环防护）
check(
  "bot 消息忽略",
  extractSlackEvent({ ...slackEvent, event: { ...slackEvent.event, bot_id: "B123", text: "hi" } }),
  null,
);
// message_changed 等子事件忽略
check(
  "message_changed 忽略",
  extractSlackEvent({ ...slackEvent, event: { ...slackEvent.event, subtype: "message_changed" } }),
  null,
);
// 空文本忽略
check("空文本忽略", extractSlackEvent({ ...slackEvent, event: { ...slackEvent.event, text: "   " } }), null);
// 非 event_callback 忽略
check("非事件回调忽略", extractSlackEvent({ type: "url_verification", challenge: "x" }), null);

// Slash 指令提取：command 去斜杠 + text 拼接（与指令注册表同构）
const slash1 = extractSlackCommand({ command: "/boot", text: "", channel_id: "C123", user_id: "U9" });
check("slash 指令文本", slash1?.text, "boot");
check("slash 指令 chatId", slash1?.chatId, "slack:C123");
const slash2 = extractSlackCommand({ command: "/gemini", text: "写个爬虫", channel_id: "C123", user_id: "U9" });
check("slash 带参数拼接", slash2?.text, "gemini 写个爬虫");
check("slash 缺频道 → null", extractSlackCommand({ command: "/boot", text: "", user_id: "U9" }), null);
check("非斜杠 → null", extractSlackCommand({ command: "boot", text: "", channel_id: "C123" }), null);

// 提及归一化（<@U123> → @user_U123；<!here> → @here；<#C1|general> → #channel）
check("用户提及归一化", normalizeSlackText("<@U123ABC> 你好"), "@user_U123ABC 你好");
check("特殊提及归一化", normalizeSlackText("Attention <!here>"), "Attention @here");
check("频道提及归一化", normalizeSlackText("去 <#C012ABC|general> 看"), "去 #channel 看");
check("普通文本不动", normalizeSlackText("ls -la"), "ls -la");

// mrkdwn 转换：代码块原样、粗体/斜体/删除线/链接/标题映射
check("代码块原样保留", mdToSlack("看这个：\n```python\nprint(1)\n```").includes("```python"), true);
check("粗体映射", mdToSlack("**重要**"), "*重要*");
check("斜体映射", mdToSlack("*斜*"), "_斜_");
check("删除线保留", mdToSlack("~~没了~~"), "~没了~");
check("链接映射", mdToSlack("[点我](https://a.b)"), "<https://a.b|点我>");
check("标题转粗体", mdToSlack("## 标题"), "*标题*");
check("行内代码保留", mdToSlack("用 `npm i` 装"), "用 `npm i` 装");
check("数字不误判斜体", mdToSlack("2 * 3 * 4"), "2 * 3 * 4");
check("空串安全", mdToSlack(""), "");

// 验签：构造合法签名 → 通过；篡改 body / 旧时间戳 / 未配 secret → 拒绝
const ss = "8f742231b10e8888abcd99";
const rawBody = JSON.stringify({ type: "event_callback", event: { text: "hi" } });
const tsOk = String(Math.floor(Date.now() / 1000));
const sigOk = "v0=" + (await testHmacHex(ss, `v0:${tsOk}:${rawBody}`));
check("合法签名通过", (await verifySlackRequest(ss, sigOk, tsOk, rawBody)) === null, true);
check("未配 secret 拒绝", (await verifySlackRequest(undefined, sigOk, tsOk, rawBody)) !== null, true);
check("缺签名头拒绝", (await verifySlackRequest(ss, null, tsOk, rawBody)) !== null, true);
check(
  "篡改 body 拒绝",
  (await verifySlackRequest(ss, sigOk, tsOk, rawBody + "x")) !== null,
  true,
);
const tsOld = String(Math.floor(Date.now() / 1000) - SLACK_TS_WINDOW_SEC - 60);
check("旧时间戳拒绝（防重放）", (await verifySlackRequest(ss, sigOk, tsOld, rawBody)) !== null, true);
const sigBad = "v0=" + "0".repeat(64);
check("假签名拒绝", (await verifySlackRequest(ss, sigBad, tsOk, rawBody)) !== null, true);

// 通道路由：chatId 前缀判定（DO reply/sendShellChunk 按它选客户端）
check("slack 前缀识别", channelOf("slack:C123"), "slack");
check("裸数字 = telegram", channelOf("555"), "telegram");
check("slack: 空后缀也是 slack", channelOf("slack:"), "slack");


// ---- 接线护栏：bot-do 里 ShellHub 的 Sender 转发必须带第三个参数 ----
// v4.22 的事故：ShellHub 加了 markdown 标志（Sender 第三参），flush 正确传出、
// sendShellChunk 正确接收，但 bot-do 构造处的箭头函数写的是 (chatId, text) => ...
// 把 opts 当场丢掉 —— AI 输出一直是纯文本，而逻辑测试全绿（测试直接 new ShellHub，
// 没走 bot-do 那条真机接线）。这里用源码文本断言钉住这根线，谁改丢谁红。
//
// 路径说明：npm test 先把 ts 编译到 /tmp/wi-test 再在那里跑测试，所以
// import.meta.url 指向的是编译产物 —— 源码要从 process.cwd()（= workers-impl）
// 读。本地直接 node test/logic.test.mjs 时 cwd 也是 workers-impl，两条路都对。
{
  const src = readFileSync(`${process.cwd()}/src/bot-do.ts`, "utf8");
  const m = /new ShellHub\(\(([^)]*)\)\s*=>\s*this\.sendShellChunk\(([^)]*)\)/.exec(src);
  check("ShellHub Sender 转发存在", m !== null, true);
  if (m) {
    const params = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const args = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    check("Sender 转发参数个数 = 3", params.length, 3);
    check("转发实参个数 = 3", args.length, 3);
    check("第三个参数名一致（opts 原样转发）", params[2], args[2]);
  }
  // 六个 AI 下发点都必须带 markdown: true
  const withMd = src.match(/hideCwd: true,\s*markdown: true/g) ?? [];
  check("AI 下发点全部带 markdown 标志（6 处）", withMd.length, 6);
}

// ---- 接线护栏：Slack 通道必须在 bot-do/index 里接全 ----
// 同样的一类事故：2026-10-29 有一次提交把 Slack 集成整体覆盖掉了（陈旧工作副本），
// 而逻辑测试仍全绿（测试直接测纯函数，不看端点是否接线）。这里钉住「接线存在」。
{
  const doSrc = readFileSync(`${process.cwd()}/src/bot-do.ts`, "utf8");
  const idxSrc = readFileSync(`${process.cwd()}/src/index.ts`, "utf8");
  check("bot-do 接到 Slack 事件", doSrc.includes("handleSlackEvents"), true);
  check("bot-do 接到 Slack slash 指令", doSrc.includes("handleSlackCommand"), true);
  check("bot-do 按 chatId 前缀路由回包", doSrc.includes('channelOf(chatId) === "slack"'), true);
  check("index 注册 /slack/events", idxSrc.includes("/slack/events"), true);
  check("index 注册 /slack/commands", idxSrc.includes("/slack/commands"), true);
  check("index 在入口做 Slack 验签", idxSrc.includes("verifySlackRequest"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
