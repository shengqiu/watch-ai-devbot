/**
 * 纯逻辑单测：意图解析 + 长文本分段 + Telegram Update 提取。
 * 运行：npm test（内部先 tsc 编译到 /tmp/wi-test 再 node 跑）
 */
import { parseIntent, effortFor } from "../src/router/intent.js";
import { clampEffort, modelOrder } from "../src/router/providers.js";
import { escapeV2, mdToV2 } from "../src/telegram/markdown.js";
import { chunkText } from "../src/asr.js";
import { extractIncoming } from "../src/telegram/update.js";
import {
  buildGeminiScript,
  DEFAULT_GEMINI_MODEL,
  buildKeyScript,
  buildStatusScript,
  buildNewSessionScript,
  parseGeminiArgs,
  previewPrompt,
  sanitizeModel,
  b64Utf8,
  resolveKeyLines,
  GEMINI_SECRETS_FILE,
} from "../src/gemini.js";
import {
  COMMANDS,
  matchCommand,
  looksLikeUnknownSlash,
  suggestCommand,
  renderHelp,
  renderCommandHelp,
  menuCommands,
} from "../src/commands.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

// ---- 意图解析 ----
check("gemini 编程", parseIntent("用 gemini 帮我写个爬虫").provider, "gemini");
check("gemini 任务类型", parseIntent("用 gemini 帮我写个爬虫").taskType, "code");
check("gemini prompt 清洗", parseIntent("用 gemini 帮我写个爬虫").prompt, "帮我写个爬虫");
check("deepseek", parseIntent("让 deepseek 重构这个函数").provider, "deepseek");
check("gpt", parseIntent("@gpt 解释这段报错").provider, "openai");
check("fallback 链", parseIntent("先用 deepseek，不行再用 gemini").chain, ["deepseek", "gemini"]);
check("pro 档 flagship", parseIntent("这个问题很复杂，用 pro 档").modelTier, "flagship");
check("product 不误伤", parseIntent("做个 product 页面").modelTier, "default");
check("flash fast", parseIntent("用 gemini flash 快点写").modelTier, "fast");
check("claude 仍识别", parseIntent("用 claude 写代码").provider, "anthropic");
check("google 别名", parseIntent("google 帮我看看这个").provider, "gemini");
check("未指定厂商", parseIntent("今天天气怎么样").provider, null);
check("闲聊类型", parseIntent("今天天气怎么样").taskType, "chat");
check("clean 空转原文", parseIntent("你好").prompt, "你好");

// ---- 思考档位（Gemini reasoning_effort 映射）----
check("闲聊 → minimal", effortFor(parseIntent("你好")), "minimal");
check("天气闲聊 → minimal", effortFor(parseIntent("今天天气怎么样")), "minimal");
check("写代码 → low", effortFor(parseIntent("帮我写个爬虫")), "low");
check("重构代码 → low", effortFor(parseIntent("重构这个函数")), "low");
check("明确 fast → minimal", effortFor(parseIntent("用 gemini flash 快点写")), "minimal");
check("明确 pro 档 → high", effortFor(parseIntent("这个问题很复杂，用 pro 档")), "high");
check("代码+复杂词 → high", effortFor(parseIntent("写个复杂的架构设计")), "high");

// ---- 思考档位钳制（3.7/3.8 Flash 已移除 minimal，传了直接 400）----
check("3.8-flash minimal→low", clampEffort("gemini-3.8-flash", "minimal"), "low");
check("3.7-flash minimal→low", clampEffort("gemini-3.7-flash", "minimal"), "low");
check("3.8-flash low 保持", clampEffort("gemini-3.8-flash", "low"), "low");
check("flash-lite minimal 保持", clampEffort("gemini-3.5-flash-lite", "minimal"), "minimal");
check("pro minimal→low", clampEffort("gemini-3.1-pro-preview", "minimal"), "low");
check("无档位透传 undefined", clampEffort("gemini-3.8-flash", undefined), undefined);

// ---- 模型尝试顺序 ----
const fakeCfg = {
  default_model: "gemini-3.8-flash",
  fast_model: "gemini-3.5-flash-lite",
  flagship_model: "gemini-3.1-pro-preview",
};
check("默认顺序 [主, fast]", modelOrder(fakeCfg, "default"), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
check("闲聊顺序 [fast, 主]", modelOrder(fakeCfg, "default", true), ["gemini-3.5-flash-lite", "gemini-3.8-flash"]);
check("fast 档顺序", modelOrder(fakeCfg, "fast"), ["gemini-3.5-flash-lite"]);
check("旗舰顺序", modelOrder(fakeCfg, "flagship"), ["gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]);
check("fast=default 去重", modelOrder({ ...fakeCfg, fast_model: "gemini-3.8-flash" }, "default"), ["gemini-3.8-flash"]);
check("无 fast 模型", modelOrder({ ...fakeCfg, fast_model: "" }, "default"), ["gemini-3.8-flash"]);

// ---- 长文本分段 ----
check("短文本不分段", chunkText("你好", 800), ["你好"]);
check("长文本分段数", chunkText("a".repeat(2000), 800).length, 3);
check("按换行断", chunkText("第一段\n第二段", 5), ["第一段", "第二段"]);
check("空文本", chunkText("  ", 800), []);

// ---- MarkdownV2 转义（防 Telegram 400）----
check("普通文本转义", escapeV2("你好. 世界! (x)"), "你好\\. 世界\\! \\(x\\)");
check("下划线转义", escapeV2("my_var = 1"), "my\\_var \\= 1");
check("代码块内不转义括号", mdToV2("```python\nprint(1 + 2)\n```"), "```python\nprint(1 + 2)\n```");
check("代码块语言保留", mdToV2("```js\nlet x = 1;\n```"), "```js\nlet x = 1;\n```");
check("无语言围栏", mdToV2("```\nplain code\n```"), "```\nplain code\n```");
check("行内代码保留", mdToV2("用 `print(x)` 输出"), "用 `print(x)` 输出");
check("混合文本+代码块", mdToV2("写法如下:\n```python\ndef f():\n    pass\n```\n搞定!"),
  "写法如下:\n```python\ndef f():\n    pass\n```\n搞定\\!");
check("未闭合围栏→字面量不抛错", mdToV2("```python\nx = 1"), "\\`\\`\\`python\nx \\= 1");
check("代码块内反引号转义", mdToV2("```\na`b\n```"), "```\na\\`b\n```");

// ---- 缩进代码块兜底提升（MarkdownV2 不认缩进代码块，必须转 ``` 围栏）----
check("缩进代码块→围栏", mdToV2("快排如下:\n\n    def q(l):\n        return l\n\n搞定"),
  "快排如下:\n\n```\ndef q(l):\n    return l\n```\n搞定");
check("tab 缩进→围栏", mdToV2("\tdef f():\n\t    pass"), "```\ndef f():\n    pass\n```");
check("缩进代码含特殊字符只转义引号", mdToV2("代码:\n\n    x = f(1) - 2\n    y = g(3)\n"),
  "代码:\n\n```\nx = f(1) - 2\ny = g(3)\n```");
check("嵌套列表 4 空格不误判", mdToV2("- 一级\n\n    - 三级"), "\\- 一级\n\n    \\- 三级");
check("引用块不误判", mdToV2("引用:\n\n    > 深层引用"), "引用:\n\n    \\> 深层引用");
check("单行缩进不转换", mdToV2("说明\n\n    单独一句"), "说明\n\n    单独一句");
check("段内缩进(列表续行)不转换", mdToV2("- 项\n    续行"), "\\- 项\n    续行");
check("围栏内缩进行不受影响", mdToV2("```python\ndef f():\n    pass\n```"), "```python\ndef f():\n    pass\n```");
check("缩进+围栏混合", mdToV2("第一种:\n\n    a = 1\n    b = 2\n\n第二种:\n\n```js\nlet x = 1;\n```\n"),
  "第一种:\n\n```\na = 1\nb = 2\n```\n第二种:\n\n```js\nlet x = 1;\n```\n");

// ---- 正文富文本（markdown 行内 → MarkdownV2 实体）----
check("粗体", mdToV2("这是**重点**内容"), "这是*重点*内容");
check("斜体", mdToV2("这是*强调*内容"), "这是_强调_内容");
check("删除线", mdToV2("~~旧方法~~ 新方法"), "~旧方法~ 新方法");
check("标题转粗体", mdToV2("## 快速排序"), "*快速排序*");
check("三级标题", mdToV2("### 小节"), "*小节*");
check("粗体内部转义", mdToV2("**注意. 这个!**"), "*注意\\. 这个\\!*");
check("数学乘号不误判斜体", mdToV2("2 * 3 * 4 = 24"), "2 \\* 3 \\* 4 \\= 24");
check("snake_case 不误判", mdToV2("my_var = 1"), "my\\_var \\= 1");
check("链接", mdToV2("看[文档](https://a.com/x)了解"), "看[文档](https://a.com/x)了解");
check("富文本+行内代码混合", mdToV2("**加粗** 和 `print(x)` 和 *斜体*"),
  "*加粗* 和 `print(x)` 和 _斜体_");
check("富文本+代码块混合", mdToV2("**用法**:\n```python\nf(1)\n```\n**注意**: 传参"),
  "*用法*:\n```python\nf(1)\n```\n*注意*: 传参");
check("围栏内 markdown 不转换", mdToV2("```\n**not bold**\n```"), "```\n**not bold**\n```");
check("不成对星号字面", mdToV2("a ** b"), "a \\*\\* b");

// ---- 代码块感知分段 ----
// 短代码块不被切断
const shortBlock = "前言\n```python\nx = 1\n```\n结语";
const sc = chunkText(shortBlock, 20);
check("短代码块完整保留", sc.some((c) => c.includes("```python\nx = 1\n```")), true);
// 长代码块：每段都带完整围栏
const longLines = Array.from({ length: 6 }, (_, i) => `line_${i}_xxxxxxxxxx`).join("\n");
const lc = chunkText("```python\n" + longLines + "\n```", 40);
check("长代码块被切分", lc.length > 1, true);
check("每段都有围栏", lc.every((c) => c.startsWith("```python") && c.endsWith("```")), true);
// 切分后拼接回去 = 原始代码行
const joined = lc.map((c) => c.replace(/^```python\n/, "").replace(/\n```$/, "")).join("\n");
check("代码内容不丢失", joined, longLines);

// ---- Telegram Update 提取 ----
// 文本消息
const textUpdate = {
  update_id: 100,
  message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555 }, date: 1, text: "  用 gemini 写个快排  " },
};
const t = extractIncoming(textUpdate);
check("文本 chat_id", t?.chatId, "555");
check("文本 trim", t?.text, "用 gemini 写个快排");
check("文本无语音", t?.voiceFileId, null);

// 语音消息（Apple Watch 场景）
const voiceUpdate = {
  update_id: 101,
  message: {
    message_id: 2,
    chat: { id: 555, type: "private" },
    from: { id: 555 },
    date: 2,
    voice: { file_id: "VOICE123", file_unique_id: "u", duration: 3, mime_type: "audio/ogg" },
  },
};
const v = extractIncoming(voiceUpdate);
check("语音 file_id", v?.voiceFileId, "VOICE123");
check("语音无文本", v?.text, "");
check("语音 mime", v?.voiceMime, "audio/ogg");

// 非消息类 update（如 callback_query）→ null
check("无 message 返回 null", extractIncoming({ update_id: 102 }), null);

// ---- Codespace 开发机（beginBoot / checkBoot / stopCodespace / describeState）----
import {
  describeState,
  beginBoot,
  checkBoot,
  stopCodespace,
  bootTimeoutReply,
  BOOT_MAX_ATTEMPTS,
  BOOT_RETRY_DELAY_MS,
} from "../src/codespace.js";

// 状态中文化
check("state Available", describeState("Available"), "运行中");
check("state Shutdown", describeState("Shutdown"), "已关机");
check("state Provisioning", describeState("Provisioning"), "启动中");
check("state ShuttingDown", describeState("ShuttingDown"), "正在关机");

// 假 client：注入状态序列与调用记录
function fakeClient(states, calls = []) {
  return {
    calls,
    async status() {
      calls.push("status");
      const s = states.shift();
      if (s === "ERR") throw new Error("boom");
      return { name: "cs-x", state: s, sshUrl: null };
    },
    async start() { calls.push("start"); return "Provisioning"; },
    async stop() { calls.push("stop"); return "ShuttingDown"; },
  };
}

// 已开机 → 阶段1单跳成功，不 start、不安排二查
{
  const c = fakeClient(["Available"]);
  const p1 = await beginBoot(c);
  check("已开机 reply", p1.reply, "开发机已在运行中 ✓");
  check("已开机不安排二查", p1.scheduleCheck, false);
  check("已开机不 start", c.calls.join(","), "status");
}

// 未开机 → 阶段1 start + 安排二查
{
  const c = fakeClient(["Shutdown"]);
  const p1 = await beginBoot(c);
  check("开机阶段1 reply", p1.reply.includes("正在启动"), true);
  check("开机阶段1 安排二查", p1.scheduleCheck, true);
  check("开机阶段1 调用序列", c.calls.join(","), "status,start");
}

// 阶段2：Available → 成功
{
  const c = fakeClient(["Available"]);
  const r = await checkBoot(c);
  check("二查成功 ok", r.ok, true);
  check("二查成功 pending", r.pending, false);
  check("二查成功 reply", r.reply.includes("启动成功"), true);
}

// 阶段2：仍 Shutdown → 失败
{
  const c = fakeClient(["Shutdown"]);
  const r = await checkBoot(c);
  check("二查失败提示", r.reply.includes("开机失败"), true);
  check("二查失败 pending", r.pending, false);
}

// 阶段2：Provisioning / Queued 属于「还没好」，不能误报失败（回归：30s 时机器常卡在 Provisioning）
for (const st of ["Provisioning", "Queued", "Creating", "ProvisioningWithWarning"]) {
  const c = fakeClient([st]);
  const r = await checkBoot(c);
  check(`二查 ${st} pending`, r.pending, true);
  check(`二查 ${st} 不判失败`, r.ok, false);
  check(`二查 ${st} 静默（reply 为空）`, r.reply, "");
}

// 阶段1：已经在启动途中 → 不重复 POST start（会 409），直接进观察模式
{
  const c = fakeClient(["Provisioning"]);
  const p1 = await beginBoot(c);
  check("启动中不重复 start", c.calls.join(","), "status");
  check("启动中仍安排二查", p1.scheduleCheck, true);
  check("启动中文案含「我会告诉你」", p1.reply.includes("我会告诉你"), true);
}

// 超时收尾文案
check("超时文案", bootTimeoutReply().includes("2.5 分钟"), true);

// 阶段2：查询异常 → 手动确认提示
{
  const c = fakeClient(["ERR"]);
  check("二查异常提示", (await checkBoot(c)).reply.includes("手动确认"), true);
}

// 首查异常 → 单跳失败，不安排二查
{
  const c = fakeClient(["ERR"]);
  const p1 = await beginBoot(c);
  check("首查失败含错误", p1.reply.includes("查询 codespace 状态失败"), true);
  check("首查失败不安排二查", p1.scheduleCheck, false);
}

// 启动指令异常 → 单跳失败
{
  const c = {
    calls: [],
    async status() { return { name: "cs-x", state: "Shutdown", sshUrl: null }; },
    async start() { throw new Error("403 forbidden"); },
    async stop() { return "ShuttingDown"; },
  };
  const p1 = await beginBoot(c);
  check("start 失败提示", p1.reply.includes("启动请求失败"), true);
  check("start 失败不安排二查", p1.scheduleCheck, false);
}

// 停机：运行中 → stop；已关机 → 幂等
{
  const c = fakeClient(["Available"]);
  check("停机调用 stop", (await stopCodespace(c)).includes("停机指令"), true);
  check("停机调用序列", c.calls.join(","), "status,stop");
}
{
  const c = fakeClient(["Shutdown"]);
  check("已关机幂等", (await stopCodespace(c)).includes("已经是关机"), true);
}

// ---- 身份验证会话（verify.ts）----
import {
  isVerified,
  isAnswerMatch,
  normalizeAnswer,
  nextExpiry,
  CHALLENGE_TEXT,
  shouldReplay,
  previewCmd,
  PENDING_CMD_TTL_MS,
  answerFingerprint,
  looksLikeCommand,
} from "../src/verify.js";

const T0 = 1_000_000;
const HALF_H = 30 * 60_000;

check("未验证（无状态）", isVerified(undefined, T0), false);
check("未验证（已过期）", isVerified({ exp: T0 - 1 }, T0), false);
check("已验证（未到期）", isVerified({ exp: T0 + HALF_H }, T0), true);
check("到期边界=过期", isVerified({ exp: T0 }, T0), false);

check("答案精确匹配", isAnswerMatch("爸爸", "爸爸"), true);
check("答案首尾空格容忍", isAnswerMatch("  爸爸  ", "爸爸"), true);
check("答案带了标点 → 不通过", isAnswerMatch("爸爸。", "爸爸"), false);
check("答案带感叹 → 不通过", isAnswerMatch("爸爸！", "爸爸"), false);
check("答案多一个字 → 不通过", isAnswerMatch("爸爸爸", "爸爸"), false);
check("答案少一个字 → 不通过", isAnswerMatch("爸", "爸爸"), false);
check("答案中间加空格 → 不通过", isAnswerMatch("爸 爸", "爸爸"), false);
check("大小写不敏感？→ 敏感", isAnswerMatch("ABC", "abc"), false);
check("错误答案", isAnswerMatch("妈妈", "爸爸"), false);
check("空答案", isAnswerMatch("", "爸爸"), false);
check("纯标点答案", isAnswerMatch("。。", "爸爸"), false);

check("归一化去首尾标点", normalizeAnswer("。爸爸！"), "爸爸");
check("归一化保留中间标点", normalizeAnswer("爸。爸"), "爸。爸");

// ---- 验证词指纹（换词后旧会话立即失效）----
{
  const fpA = answerFingerprint("哈哈");
  const fpB = answerFingerprint("爸爸");
  check("同词同指纹", answerFingerprint("哈哈"), fpA);
  check("带标点同指纹", answerFingerprint(" 哈哈！ "), fpA);
  check("不同词不同指纹", fpA === fpB, false);
  // 会话绑定指纹：换词后即便没过期也不算已验证
  const future = T0 + HALF_H;
  check("指纹匹配 → 已验证", isVerified({ exp: future, fp: fpA }, T0, fpA), true);
  check("指纹不符（换词）→ 需重新验证", isVerified({ exp: future, fp: fpB }, T0, fpA), false);
  // 老数据（裸 number → fp 为空）与当前指纹不符 → 重新验证一次
  check("老会话无指纹 → 需重新验证", isVerified({ exp: future, fp: "" }, T0, fpA), false);
  check("未配置验证词时老会话仍有效", isVerified({ exp: future, fp: "" }, T0, ""), true);
}
check("续期计算", nextExpiry(T0, HALF_H), T0 + HALF_H);
check("挑战文案", CHALLENGE_TEXT.includes("我要知道你是谁"), true);

// ---- 验证前命令暂存（shouldReplay / previewCmd）----
{
  const t = 1_700_000_000_000;
  check("暂存刚存的可重放", shouldReplay({ cmd: "git status", at: t }, t + 1000), true);
  check("暂存 9 分钟仍可", shouldReplay({ cmd: "ls", at: t }, t + 9 * 60_000), true);
  check("暂存 11 分钟过期", shouldReplay({ cmd: "ls", at: t }, t + 11 * 60_000), false);
  check("暂存空命令不重放", shouldReplay({ cmd: "   ", at: t }, t), false);
  check("暂存缺失不重放", shouldReplay(undefined, t), false);
  check("暂存坏结构不重放", shouldReplay({ at: t }, t), false);
  check("时间倒流不重放", shouldReplay({ cmd: "ls", at: t + 5000 }, t), false);

  check("预览短命令原样", previewCmd("git status"), "git status");
  check("预览多行折叠", previewCmd("cd /tmp\nls -la"), "cd /tmp ⏎ ls -la");
  check("预览超长截断", previewCmd("x".repeat(200)).endsWith("⋯"), true);
  check("预览截断长度", previewCmd("x".repeat(200), 10).length, 11);
  check("TTL 为 10 分钟", PENDING_CMD_TTL_MS, 10 * 60_000);
}

// ---- 像不像命令（决定验证后补不补执行）----
{
  check("像命令 pwd", looksLikeCommand("pwd"), true);
  check("像命令 git status", looksLikeCommand("git status"), true);
  check("像命令 cd /tmp", looksLikeCommand("cd /tmp"), true);
  check("像命令 开始开发（已非指令）", looksLikeCommand("开始开发"), false);
  check("像命令 开发机状态", looksLikeCommand("开发机状态"), true);
  check("像命令 /boot", looksLikeCommand("/boot"), true);
  check("不像命令 你好", looksLikeCommand("你好"), false);
  check("不像命令 爸爸", looksLikeCommand("爸爸"), false);
  check("不像命令 哈哈哈", looksLikeCommand("哈哈哈"), false);
  check("不像命令 空", looksLikeCommand("   "), false);
  check("不像命令 今天天气不错", looksLikeCommand("今天天气不错"), false);
}

// ---- 省额度看门狗（watch.ts）----
import { evalWatch, fmtDur, pushAlarm, drainAlarms } from "../src/watch.js";

const W = (over = {}) => ({
  running: true,
  now: 10_000_000,
  lastActivity: 10_000_000,
  bootAt: 10_000_000,
  botStarted: true,
  remindMin: 25,
  autostopMin: 55,
  autostopEnabled: true,
  reminded: false,
  ghLastUsedAt: null,
  ghFreshSince: null,
  capNotified: false,
  capNotifiedAt: null,
  ghCapMin: 180,
  ghCapAction: "stop",
  graceMin: 15,
  ...over,
});
const MIN = 60_000;

// 机器没跑 → 什么都不做
check("关机：不动作", evalWatch(W({ running: false })), {
  notify: null,
  stop: false,
  nextCheck: null,
  markReminded: false,
  ghFreshSince: null,
  capNotified: false,
  capNotifiedAt: null,
});

// 互动新鲜 → 静默，排到 remind 满点
{
  const d = evalWatch(W());
  check("新鲜互动：静默", d.notify, null);
  check("新鲜互动：排到 remind 点", d.nextCheck, 10_000_000 + 25 * MIN);
  check("新鲜互动：不标记提醒", d.markReminded, false);
}

// 提醒窗口：首次 → 发提醒 + 标记
{
  const d = evalWatch(W({ now: 10_000_000 + 30 * MIN }));
  check("30min：发提醒", d.notify !== null && d.notify.includes("没和我说过话"), true);
  check("30min：标记已提醒", d.markReminded, true);
  check("30min：不关机", d.stop, false);
  check("30min：排到 autostop 点", d.nextCheck, 10_000_000 + 55 * MIN);
}

// 提醒窗口：已提醒过 → 静默防轰炸
{
  const d = evalWatch(W({ now: 10_000_000 + 30 * MIN, reminded: true }));
  check("已提醒：静默", d.notify, null);
  check("已提醒：仍排 autostop", d.nextCheck, 10_000_000 + 55 * MIN);
}

// 超 autostop + bot 开机 → 自动关机
{
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN }));
  check("60min：自动关机", d.stop, true);
  check("60min：通知含说明", d.notify !== null && d.notify.includes("自动关机"), true);
  check("60min：不再排程", d.nextCheck, null);
}

// 超 autostop + observed（非 bot 开机）→ 只提醒不关
{
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, botStarted: false }));
  check("observed：不自动关", d.stop, false);
  check("observed：升级提醒", d.notify !== null && d.notify.includes("不敢自动关"), true);
  check("observed：2h 静默复查", d.nextCheck, 10_000_000 + 60 * MIN + 120 * MIN);
}

// observed 防刷屏：提醒过 → 静默 2h（不再发）
{
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, botStarted: false, reminded: true }));
  check("observed 已提醒：静默", d.notify, null);
  check("observed 已提醒：2h 后再查", d.nextCheck, 10_000_000 + 180 * MIN);
}

// ---- 双信号：GitHub last_used_at 交叉验证（防 VS Code 误杀）----
{
  // 超时但 GitHub 侧 5 分钟前刚用过（你在 VS Code 干活）→ 推迟不打扰
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, ghLastUsedAt: 10_000_000 + 55 * MIN }));
  check("GH 活跃：不关机", d.stop, false);
  check("GH 活跃：静默", d.notify, null);
  check("GH 活跃：推迟 30min", d.nextCheck, 10_000_000 + 90 * MIN);
}
{
  // GitHub 侧 10 分钟整 = 边界外（10min 前）→ 正常关机流程
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, ghLastUsedAt: 10_000_000 + 50 * MIN }));
  check("GH 恰好 10min 前：正常关机", d.stop, true);
}
{
  // GitHub 侧很旧（30 分钟没用）→ 正常关机
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, ghLastUsedAt: 10_000_000 + 30 * MIN }));
  check("GH 空闲：正常关机", d.stop, true);
}
{
  // observed + GH 活跃 → 也不提醒（你正在干别的，observed 提醒也推迟）
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, botStarted: false, ghLastUsedAt: 10_000_000 + 58 * MIN }));
  check("observed + GH 活跃：静默", d.notify, null);
  check("observed + GH 活跃：推迟 30min", d.nextCheck, 10_000_000 + 90 * MIN);
}

// ---- 第三信号：GH 连续活跃上限保险丝（防 dev server 刷日志无限续命）----
// 背景：last_used_at 无法区分「人在 VS Code 敲键盘」和「dev server 刷日志」，
// 两者在 GitHub API 上完全一样。所以不能无限信任它——必须给推迟加上硬上限。
{
  // GH 活跃、空闲刚过 autostop 但未达上限 → 静默推迟 30min，开始追踪
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, ghLastUsedAt: 10_000_000 + 55 * MIN }));
  check("cap：首次活跃开始追踪", d.ghFreshSince, 10_000_000 + 60 * MIN);
  check("cap：首次活跃不提醒", d.notify, null);
  check("cap：推迟 30min", d.nextCheck, 10_000_000 + 90 * MIN);
  check("cap：不关机", d.stop, false);
}
{
  // ★ 关键回归：已发过普通提醒（reminded=true）不能阻止上限警告。
  //   旧实现多了 !w.reminded 条件 → 25min 提醒一次后永远静默、机器无限续命，
  //   正是本次要修的失效模式。
  const d = evalWatch(W({
    now: 10_000_000 + 180 * MIN,
    ghLastUsedAt: 10_000_000 + 179 * MIN,
    ghFreshSince: 10_000_000 + 60 * MIN,
    reminded: true,
  }));
  check("cap：reminded 不阻塞上限警告", d.notify !== null && d.notify.includes("持续活跃"), true);
  check("cap：警告阶段不关机", d.stop, false);
  check("cap：标记 capNotified", d.capNotified, true);
  check("cap：记录警告时刻", d.capNotifiedAt, 10_000_000 + 180 * MIN);
  check("cap：宽限 15min 后复查", d.nextCheck, 10_000_000 + 195 * MIN);
}
{
  // 宽限期内仍未互动 → 静默等到宽限点（不重复轰炸）
  const d = evalWatch(W({
    now: 10_000_000 + 190 * MIN,
    ghLastUsedAt: 10_000_000 + 189 * MIN,
    ghFreshSince: 10_000_000 + 60 * MIN,
    capNotified: true,
    capNotifiedAt: 10_000_000 + 180 * MIN,
  }));
  check("cap：宽限期内静默", d.notify, null);
  check("cap：宽限期内不关机", d.stop, false);
  check("cap：排到宽限点", d.nextCheck, 10_000_000 + 195 * MIN);
}
{
  // 宽限期走完 → 强制关机。泄漏从此有硬上限（≤ ghCapMin + graceMin）
  const d = evalWatch(W({
    now: 10_000_000 + 196 * MIN,
    ghLastUsedAt: 10_000_000 + 195 * MIN,
    ghFreshSince: 10_000_000 + 60 * MIN,
    capNotified: true,
    capNotifiedAt: 10_000_000 + 180 * MIN,
  }));
  check("cap：宽限到 → 强制关机", d.stop, true);
  check("cap：关机后追踪清零", d.ghFreshSince, null);
  check("cap：关机后 capNotified 清零", d.capNotified, false);
}
{
  // notify 模式：触达上限只提醒一次，永不自动关
  const d = evalWatch(W({
    now: 10_000_000 + 200 * MIN,
    ghLastUsedAt: 10_000_000 + 199 * MIN,
    ghFreshSince: 10_000_000 + 60 * MIN,
    ghCapAction: "notify",
  }));
  check("cap：notify 模式提醒", d.notify !== null && d.notify.includes("持续活跃"), true);
  check("cap：notify 模式永不关机", d.stop, false);
  check("cap：notify 模式标记", d.capNotified, true);
}
{
  // notify 模式：不重复刷屏
  const d = evalWatch(W({
    now: 10_000_000 + 260 * MIN,
    ghLastUsedAt: 10_000_000 + 259 * MIN,
    ghFreshSince: 10_000_000 + 60 * MIN,
    ghCapAction: "notify",
    capNotified: true,
    capNotifiedAt: 10_000_000 + 200 * MIN,
  }));
  check("cap：notify 模式不重复", d.notify, null);
  check("cap：notify 模式仍不关机", d.stop, false);
}
{
  // 自动关机被关闭 → 即使触达上限也只提醒
  const d = evalWatch(W({
    now: 10_000_000 + 200 * MIN,
    ghLastUsedAt: 10_000_000 + 199 * MIN,
    ghFreshSince: 10_000_000 + 60 * MIN,
    autostopEnabled: false,
  }));
  check("cap：autostop 关 → 只提醒", d.notify !== null && d.notify.includes("只提醒"), true);
  check("cap：autostop 关 → 不关机", d.stop, false);
}
{
  // GH 转为空闲 → 追踪清零，走正常关机路径
  const d = evalWatch(W({
    now: 10_000_000 + 200 * MIN,
    ghLastUsedAt: 10_000_000 + 100 * MIN, // 100 分钟前，已不活跃
    ghFreshSince: 10_000_000 + 60 * MIN,
    capNotified: true,
  }));
  check("cap：GH 转空闲 → 关机", d.stop, true);
  check("cap：追踪清零", d.ghFreshSince, null);
}
{
  // 用户终端级互动 → 第三信号全部复位（宽限倒计时取消）
  const d = evalWatch(W({ now: 10_000_000 + 10 * MIN }));
  check("cap：互动新鲜重置追踪", d.ghFreshSince, null);
  check("cap：互动新鲜重置 capNotified", d.capNotified, false);
  check("cap：互动新鲜重置警告时刻", d.capNotifiedAt, null);
}

// 超 autostop + 自动关未启用 → 只提醒
{
  const d = evalWatch(W({ now: 10_000_000 + 60 * MIN, autostopEnabled: false }));
  check("autostop 关：不关机", d.stop, false);
  check("autostop 关：提醒引导手动", d.notify !== null && d.notify.includes("/halt"), true);
}

// 运行时长文案含本轮信息
{
  const d = evalWatch(W({ now: 10_000_000 + 30 * MIN, bootAt: 10_000_000 - 10 * MIN }));
  check("提醒含运行时长", d.notify !== null && d.notify.includes("40分钟"), true);
}

// ---- 联机 shell（shell.ts：输出清洗 / 分块 / marker 解析 / 队列）----
const {
  stripAnsi,
  sanitizeOutput,
  chunkOutput,
  capOutput,
  markerLine,
  parseMarkerLine,
  extractMarkers,
  ShellHub,
} = await import("../src/shell.js");
{
  const ESC2 = String.fromCharCode(27);
  check("stripAnsi CSI 颜色", stripAnsi(`${ESC2}[31m红${ESC2}[0m`), "红");
  check("stripAnsi OSC 标题", stripAnsi(`${ESC2}]0;标题${ESC2}\\after`), "after");
  check("sanitize CRLF", sanitizeOutput("a\r\nb\rc"), "a\nb\nc");
  check("sanitize 行尾空白", sanitizeOutput("x   \ny\t\n"), "x\ny\n");

  check("chunkOutput 短文本", chunkOutput("hi", 10), ["hi"]);
  check("chunkOutput 优先断行", chunkOutput("aaa\nbbb", 4), ["aaa", "bbb"]);
  check("chunkOutput 无换行硬切", chunkOutput("abcdefgh", 3), ["abc", "def", "gh"]);

  check("capOutput 不截断", capOutput("abc", 10), "abc");
  {
    const capped = capOutput("x".repeat(100), 20);
    check("capOutput 含省略标记", capped.includes("省略"), true);
    check("capOutput 保留尾", capped.endsWith("x".repeat(8)), true);
  }

  check("markerLine 拼接", markerLine(0, "/tmp"), "__WS__0__/tmp__");
  check("parseMarkerLine 正常", parseMarkerLine("__WS__0__/tmp__"), { exit: 0, cwd: "/tmp" });
  check("parseMarkerLine 非零退出码", parseMarkerLine("__WS__127__/workspaces/x__"), {
    exit: 127,
    cwd: "/workspaces/x",
  });
  // cwd 含下划线 / 空格也要能正确切分（贪婪匹配 + 末尾 __ 收尾）
  check("parseMarkerLine 含下划线 cwd", parseMarkerLine("__WS__0__/a/__b__"), { exit: 0, cwd: "/a/__b" });
  check("parseMarkerLine 普通行", parseMarkerLine("total 12"), null);

  {
    const r = extractMarkers("out1\n" + markerLine(0, "/tmp") + "\n");
    check("extractMarkers 文本", r.text, "out1\n");
    check("extractMarkers exit", r.exit, 0);
    check("extractMarkers cwd", r.cwd, "/tmp");
  }
}

// ---- ShellHub 状态机：离线/排队/输出刷写/串行 ----
{
  const sent = [];
  const hub = new ShellHub(async (chatId, text) => {
    sent.push({ chatId, text });
  }, { flushMs: 10, maxChars: 100 });

  check("初始离线", hub.online(), false);
  const e1 = hub.enqueue("c1", "ls");
  check("离线时拒绝排队", e1.ok, false);
  check("离线提示含引导", String(e1.message).includes("shell"), true);

  // 伪造一个 SSE 控制器（只记录写入的字节）
  const written = [];
  const ctl = { enqueue: (b) => written.push(new TextDecoder().decode(b)) };
  hub.attach(ctl);
  check("attach 后在线", hub.online(), true);
  check("attach 下发 hello", written.join("").includes('"t":"hello"'), true);

  const q1 = hub.enqueue("c1", "ls -la");
  check("排队成功", q1.ok, true);
  check("pending=1", hub.pending(), 1);
  check("下发 cmd 事件", written.some((w) => w.includes('"t":"cmd"') && w.includes("ls -la")), true);
  check("串行：第二条被拒", hub.enqueue("c1", "pwd").ok, false);

  // 增量输出：静默窗口到期后推一条（首条带 $ 回显）
  await hub.onOutput({ id: q1.id, text: "a.txt\n" });
  await new Promise((r) => setTimeout(r, 40));
  check("增量刷写出去了", sent.length >= 1, true);
  check("首条含命令回显", sent[0].text.includes("$ ls -la"), true);

  // 收尾：exit + cwd
  await hub.onOutput({ id: q1.id, text: "b.txt\n", done: true, exit: 0, cwd: "/tmp" });
  const last = sent[sent.length - 1];
  check("收尾含 exit", last.text.includes("exit 0"), true);
  check("收尾含 cwd", last.text.includes("/tmp"), true);
  check("命令完成后清空", hub.pending(), 0);

  // 输出超限截断
  const sent2 = [];
  const hub2 = new ShellHub(async (chatId, text) => {
    sent2.push(text);
  }, { flushMs: 5, maxChars: 50 });
  hub2.attach({ enqueue: () => {} });
  const q2 = hub2.enqueue("c1", "yes");
  await hub2.onOutput({ id: q2.id, text: "z".repeat(500), done: true, exit: 0, cwd: "/tmp" });
  check("超长输出被掐断", sent2.join("").includes("截断"), true);
}

// ---- ShellHub 心跳：tick 能恢复在线 ----
// 回归背景：agent 空闲时不 POST，lastSeen 会冻结在 attach 时刻；90s 后 online()
// 误判离线导致所有命令被拒。attach() 的 20s SSE 心跳写成功后必须 refresh lastSeen，
// 这里用 tick() 验证「刷新即恢复在线」这一核心机制。
{
  const hub = new ShellHub(async () => {}, { staleMs: 120 });
  hub.attach({ enqueue: () => {} });
  check("attach 后在线", hub.online(), true);

  await new Promise((r) => setTimeout(r, 200));
  check("超 staleMs 无心跳 → 离线", hub.online(), false);

  const stale = hub.seenAt();
  hub.tick();
  check("tick 推进 seenAt", hub.seenAt() > stale, true);
  check("tick 后恢复在线", hub.online(), true);

  hub.detach();
  check("detach 后离线", hub.online(), false);
}

// ---- fmtDur ----
check("fmtDur 0", fmtDur(0), "0分钟");
check("fmtDur 59", fmtDur(59), "59分钟");
check("fmtDur 60", fmtDur(60), "1小时");
check("fmtDur 155", fmtDur(155), "2小时35分");

// ---- alarm 队列 ----
{
  const calls = [];
  const store = {
    m: new Map(),
    async get(k) { return this.m.get(k); },
    async put(k, v) { this.m.set(k, v); },
    async delete(k) { this.m.delete(k); },
    async setAlarm(t) { calls.push(t); },
  };
  const t0 = Date.now();
  // 插入 watch（55min 后）→ alarm 设到该点
  await pushAlarm(store, { due: t0 + 55 * MIN, kind: "watch" });
  check("alarm1 设到 55min", calls[0] === t0 + 55 * MIN, true);
  // 插入 boot_check（30s 后）→ alarm 提前
  await pushAlarm(store, { due: t0 + 30_000, kind: "boot_check" });
  check("alarm2 提前到 30s", calls[1] === t0 + 30_000, true);
  check("队列长度 2", store.m.get("alarmq").length, 2);
  // 同 kind 覆盖
  await pushAlarm(store, { due: t0 + 40_000, kind: "boot_check" });
  check("同 kind 覆盖", store.m.get("alarmq").some((t) => t.kind === "boot_check" && t.due === t0 + 40_000), true);
  check("队列仍 2 项", store.m.get("alarmq").length, 2);
  // 时间前进：30s 的 boot_check 到期 → drain 只取它
  const realNow = Date.now;
  Date.now = () => t0 + 45_000;
  const due = await drainAlarms(store);
  check("drain 取 boot_check", due.map((d) => d.kind), ["boot_check"]);
  check("drain 后 alarm 重排到 watch", calls[calls.length - 1] === t0 + 55 * MIN, true);
  // 再前进：watch 到期 → drain 取走，alarm 清空
  Date.now = () => t0 + 56 * MIN;
  const due2 = await drainAlarms(store);
  check("drain 取 watch", due2.map((d) => d.kind), ["watch"]);
  check("alarm 清空", calls[calls.length - 1] === null, true);
  Date.now = realNow;
}

// ---- 开机二查的 chat_id 传递（回归：payload 曾经没被传下去，导致「成功」消息静默丢失）----
{
  const m = new Map();
  const store = {
    get: async (k) => m.get(k),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    setAlarm: async () => {},
  };
  await pushAlarm(store, { due: 0, kind: "boot_check", payload: { chat_id: "7618809103", attempt: 3 } });
  const got = (await drainAlarms(store)).find((t) => t.kind === "boot_check");
  check("boot_check 带 chat_id", got.payload.chat_id, "7618809103");
  check("boot_check 带 attempt", got.payload.attempt, 3);
}

// 重试预算：首查 30s + 8×15s = 150s ≈ 2.5 分钟（与 bootTimeoutReply 文案一致）
check("重试总时长 150s", 30 + BOOT_MAX_ATTEMPTS * (BOOT_RETRY_DELAY_MS / 1000), 150);

// ---- 指令注册表（commands.ts）：解析 / 帮助 / 菜单 ----
{
  // 斜杠形式
  check("cmd /boot", matchCommand("/boot")?.spec.name, "boot");
  check("cmd /BOOT 大小写", matchCommand("/BOOT")?.spec.name, "boot");
  check("cmd /cs", matchCommand("/cs")?.spec.name, "cs");
  // 中文口语形式
  // 中文开关机口语已停用（2026-10-27 用户要求：只有 /boot 能开机）
  check("cmd 开始开发（已停用）", matchCommand("开始开发"), null);
  check("cmd 开始开发。（已停用）", matchCommand("开始开发。"), null);
  check("cmd 开机（已停用）", matchCommand("开机"), null);
  check("cmd 关机（已停用）", matchCommand("关机"), null);
  check("cmd 停止开发（已停用）", matchCommand("停止开发"), null);
  check("cmd 帮助", matchCommand("帮助")?.spec.name, "help");
  // 验证词/开机口令不能撞上任何指令，否则会被指令派发抢走
  check("cmd 验证词不撞指令", matchCommand("哈哈"), null);
  check("cmd /? 符号别名", matchCommand("/?")?.spec.name, "help");
  check("cmd ？全角", matchCommand("？")?.spec.name, "help");
  // 带参数
  check("cmd /help boot args", matchCommand("/help boot")?.args, "boot");
  check("cmd /help 带斜杠参数", matchCommand("/help /boot")?.args, "/boot");
  // 不该命中的
  check("cmd 句中不命中", matchCommand("帮我开始开发"), null);
  check("cmd 普通命令不命中", matchCommand("git status"), null);
  check("cmd 空", matchCommand("   "), null);
  check("cmd 绝对路径不命中", matchCommand("/usr/bin/env"), null);

  // 打错的斜杠指令 vs 绝对路径
  check("unknown /hlep", looksLikeUnknownSlash("/hlep"), true);
  check("unknown /usr/bin/env", looksLikeUnknownSlash("/usr/bin/env"), false);
  check("unknown /tmp/a.sh", looksLikeUnknownSlash("/tmp/a.sh"), false);
  check("unknown 裸斜杠", looksLikeUnknownSlash("/"), false);
  check("unknown 非斜杠", looksLikeUnknownSlash("pwd"), false);

  // 纠错建议
  check("suggest /hlep → help", suggestCommand("/hlep"), "help");
  check("suggest boott → boot", suggestCommand("boott"), "boot");
  check("suggest 无解 → null", suggestCommand("zzzzzzzz"), null);

  // 帮助渲染
  const h = renderHelp();
  check("help 含全部指令", COMMANDS.every((c) => h.includes(`/${c.name}`)), true);
  check("help 含 shell 说明", h.includes("直接发文字"), true);
  check("help 含分组图标", h.includes("🖥") && h.includes("⌨️"), true);
  const one = renderCommandHelp("boot");
  check("单条帮助无别名则不显示别名行", one.includes("别名"), false);
  check("单条帮助有别名则显示", renderCommandHelp("help").includes("别名"), true);
  check("单条帮助认斜杠别名", renderCommandHelp("/halt")?.includes("/halt"), true);
  check("单条帮助认斜杠", renderCommandHelp("/halt")?.includes("/halt"), true);
  check("单条帮助不存在 → null", renderCommandHelp("nope"), null);

  // 注册表自检：名字唯一、别名不撞车、详情非空
  const names = COMMANDS.map((c) => c.name);
  check("指令名唯一", new Set(names).size, names.length);
  const allTokens = COMMANDS.flatMap((c) => [c.name, ...c.aliases]).map((s) => s.toLowerCase());
  check("名字与别名全局唯一", new Set(allTokens).size, allTokens.length);
  check("每条都有详情", COMMANDS.every((c) => c.detail.length > 0), true);

  // Telegram 菜单：命名必须符合 ^[a-z0-9_]{1,32}$
  const menu = menuCommands();
  check("菜单非空", menu.length >= 5, true);
  check("菜单命名合法", menu.every((m) => /^[a-z0-9_]{1,32}$/.test(m.command)), true);
  check("菜单描述非空", menu.every((m) => m.description.length > 0 && m.description.length <= 256), true);
  check("菜单无重复", new Set(menu.map((m) => m.command)).size, menu.length);
}

// ---- Gemini 接入层（src/gemini.ts）----
{
  // base64：中文必须能原样还原（btoa 只吃 latin1，实现里是按 UTF-8 字节转的）
  const cn = "帮我看下 README 的错别字，然后 git commit";
  check("base64 中文可还原", Buffer.from(b64Utf8(cn), "base64").toString("utf8"), cn);
  check("base64 空串", b64Utf8(""), "");

  // 模型白名单：拼进 shell 的命令片段必须挡住注入
  check("模型正常", sanitizeModel("flash"), "-m flash");
  check("模型带点", sanitizeModel("gemini-2.5-pro"), "-m gemini-2.5-pro");
  check("模型去前缀横杠", sanitizeModel("--yolo"), "-m yolo");
  check("模型注入被拒", sanitizeModel("flash; rm -rf /"), "");
  check("模型中文被拒", sanitizeModel("模型"), "");
  check("模型空", sanitizeModel(undefined), "");

  // 参数解析
  check("gem 空 → open", parseGeminiArgs("").kind, "open");
  check("gem off", parseGeminiArgs("off").kind, "off");
  check("gem exit 等价 off", parseGeminiArgs("exit").kind, "off");
  check("gem status", parseGeminiArgs("status").kind, "status");
  check("gem new", parseGeminiArgs("new").kind, "new");
  check("gem key 取值", parseGeminiArgs("key AIza123").key, "AIza123");
  check("gem key 无值 → help", parseGeminiArgs("key").kind, "help");
  check("gem model", parseGeminiArgs("model pro").model, "pro");
  const ask = parseGeminiArgs("把 README 第 3 节改成中文");
  check("gem 其它文本 → ask", ask.kind, "ask");
  check("gem ask 保留全文", ask.prompt, "把 README 第 3 节改成中文");

  // 脚本：整体包子 shell（顶层 exit 会杀掉长驻 bash）
  const prep = buildGeminiScript();
  check("脚本包子 shell", prep.startsWith("("), true);
  check("脚本以 ) 收尾", prep.trimEnd().endsWith(")"), true);
  check("脚本 cd 仓库", prep.includes("cd /workspaces/watch-ai-assistant"), true);
  check("无 key 时 exit 2", prep.includes("exit 2"), true);
  check("缺 CLI 才装", prep.includes("command -v gemini"), true);
  check("装的是官方包", prep.includes("@google/gemini-cli"), true);
  check("准备模式不跑 prompt", prep.includes("-p "), false);

  const run = buildGeminiScript({ prompt: "hi", model: "flash" });
  check("运行模式带 -p", run.includes('-p "$(cat /tmp/ws-gemini-prompt.txt)"'), true);
  check("运行模式带模型", run.includes("-m flash"), true);
  check("stdin 重定向 /dev/null（防偷吃后续命令行）", run.includes("</dev/null"), true);
  check("yolo 审批（无人值守没法按 y）", run.includes("--approval-mode=yolo"), true);
  check("跳过目录信任", run.includes("--skip-trust"), true);
  check("续会话受标记文件保护", run.includes("gemini-session"), true);
  check("成功后打标记", run.includes("touch"), true);
  check("prompt 不落明文进命令", run.includes("hi"), false);
  check(
    "prompt 能还原",
    Buffer.from(/printf %s '([^']+)'/.exec(run)[1], "base64").toString("utf8"),
    "hi",
  );

  // 写 key 的脚本绝不能出现明文
  const keyCmd = buildKeyScript("AIzaSECRET123");
  check("key 不落明文", keyCmd.includes("AIzaSECRET123"), false);
  check("key 落 chmod 600", keyCmd.includes("chmod 600"), true);
  check(
    "key 可还原",
    Buffer.from(/printf %s '([^']+)'/.exec(keyCmd)[1], "base64").toString("utf8"),
    "AIzaSECRET123",
  );

  check("状态脚本查 CLI", buildStatusScript().includes("command -v gemini"), true);
  check("状态脚本查 key", buildStatusScript().includes("GEMINI_API_KEY"), true);
  // 回归：不指定模型时 CLI 会用已停用的 2.5 系列 → 新 key 直接 404。
  // 所以 buildGeminiScript 必须把 -m 显式拼进去，且默认值不能是 2.5。
  check("默认模型非 2.5", DEFAULT_GEMINI_MODEL.startsWith("gemini-3"), true);
  check(
    "脚本显式带 -m",
    buildGeminiScript({ prompt: "hi", model: DEFAULT_GEMINI_MODEL }).includes(`-m ${DEFAULT_GEMINI_MODEL}`),
    true,
  );
  check("状态脚本报模型", buildStatusScript(DEFAULT_GEMINI_MODEL).includes(DEFAULT_GEMINI_MODEL), true);
  check("状态脚本未给模型也报兜底值", buildStatusScript().includes(DEFAULT_GEMINI_MODEL), true);
  check("状态脚本模型名经过白名单", buildStatusScript("a;rm -rf /").includes("rm -rf"), false);
  // 终端能力：不声明的话 CLI 每次回答前都会打一行 256 色警告（Telegram 里是噪音）
  {
    const sc = buildGeminiScript({ prompt: "hi" });
    check("声明 256 色终端", sc.includes("TERM=xterm-256color"), true);
    check("声明 truecolor", sc.includes("COLORTERM=truecolor"), true);
    check("过滤 YOLO 噪音", sc.includes("YOLO mode is enabled"), true);
    check("流式不过度缓冲", sc.includes("--line-buffered"), true);
    check("退出码取 gemini 而非 grep", sc.includes("PIPESTATUS[0]"), true);
  }
  check("新会话删标记", buildNewSessionScript().includes("rm -f"), true);

  check("prompt 预览压成一行", previewPrompt("a\nb\nc"), "a b c");
  check("prompt 预览截断", previewPrompt("x".repeat(200), 10).length, 11);
}

// ---- ShellHub：label / echo / quiet（Gemini 长脚本与密钥命令用）----
{
  const sent = [];
  const written = [];
  const hub = new ShellHub(
    async (chatId, text) => {
      sent.push(text);
    },
    { flushMs: 5 },
  );
  hub.attach({ enqueue: (b) => written.push(new TextDecoder().decode(b)) });

  const q = hub.enqueue("c1", "( echo hi )\n( echo bye )", { label: "🤖 打个招呼" });
  await hub.onOutput({ id: q.id, text: "hi\n", done: true, exit: 0, cwd: "/tmp" });
  const out = sent.join("\n");
  check("回显用 label 而非脚本", out.includes("$ 🤖 打个招呼"), true);
  check("回显不含脚本原文", out.includes("echo bye"), false);

  const q2 = hub.enqueue("c1", "printf %s 'x' > key", { echo: false, quiet: true });
  check("quiet 标记下发到 agent", written.some((w) => w.includes('"q":1')), true);
  await hub.onOutput({ id: q2.id, text: "ok\n", done: true, exit: 0, cwd: "/tmp" });
  check("echo:false 不带 $ 前缀", sent[sent.length - 1].includes("$ printf"), false);
}

// ---- /ctrlc 逃生：卡住的命令不能把人锁 45 分钟 ----
{
  const sent = [];
  const hub = new ShellHub(async (_c, t) => {
    sent.push(t);
  }, { flushMs: 5 });
  hub.attach({ enqueue: () => {} });

  check("首条命令可下发", hub.enqueue("c1", "( sleep 100 )", { label: "🤖 卡住的命令" }).ok, true);
  const blocked = hub.enqueue("c1", "echo hi");
  check("忙时拒绝第二条", blocked.ok, false);
  check("拒绝提示带出是哪条在跑", String(blocked.message).includes("🤖 卡住的命令"), true);
  check("拒绝提示给出逃生办法", String(blocked.message).includes("/ctrlc"), true);

  const dropped = hub.killAll();
  check("killAll 交出被丢的命令", dropped.length, 1);
  check("killAll 后队列为空", hub.pending(), 0);
  check("清空后立刻可再下发", hub.enqueue("c1", "echo hi").ok, true);
}

// ---- 打错的斜杠指令必须被当场纠正，不能当成 prompt / shell 命令 ----
{
  check("hault 被识别为未知斜杠指令", looksLikeUnknownSlash("/hault"), true);
  check("hault 能猜出 halt", suggestCommand("/hault"), "halt");
  check("绝对路径不算未知指令", looksLikeUnknownSlash("/etc/hosts"), false);
  check("带参的绝对路径也不算", looksLikeUnknownSlash("/tmp/a.sh -x"), false);
  check("hlep 能猜出 help", suggestCommand("/hlep"), "help");
}

// ---- Gemini 安装：三级降级，不需要用户去开全局 sudo ----
{
  const s = buildGeminiScript({ prompt: "hi" });
  check("安装有 sudo -n 这一级", s.includes("sudo -n"), true);
  check("sudo 之前先试普通 npm", s.indexOf("npm i -g @google/gemini-cli") < s.indexOf("sudo -n"), true);
  check("以 ~/.local 兜底", s.includes('--prefix "$HOME/.local"'), true);
  check("PATH 提前铺好", s.includes('export PATH="$HOME/.local/bin:$PATH"'), true);
  check("PATH 在安装判断之前", s.indexOf('export PATH="$HOME/.local/bin') < s.indexOf("if ! command -v gemini"), true);
  const st = buildStatusScript();
  check("status 报告 sudo 状态", st.includes("sudo -n true"), true);
  check("status 显示安装路径", st.includes("command -v gemini"), true);
}

// ---- agent 通道鉴权：HMAC 双向签名 / 时间窗 / 防重放 / 身份绑定 ----
{
  const A = await import("../src/agent-auth.js");
  const secret = "0123456789abcdef0123456789abcdef";

  // 基础原语（用公开测试向量，防止「两端各算各的」）
  check("sha256 空串", await A.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  check(
    "hmac-sha256 标准向量",
    await A.hmacHex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  check("定长比较 相等", A.timingSafeEq("abc", "abc"), true);
  check("定长比较 一字节差", A.timingSafeEq("abc", "abd"), false);
  check("定长比较 长度差", A.timingSafeEq("a", "ab"), false);
  check("定长比较 空值", A.timingSafeEq("", ""), false);

  // 时间窗
  const now = 1_700_000_000_000;
  check("时间戳 当前", A.tsFresh(String(now), now), true);
  check("时间戳 60s 前", A.tsFresh(String(now - 60_000), now), true);
  check("时间戳 5 分钟前", A.tsFresh(String(now - 300_000), now), false);
  check("时间戳 非数字", A.tsFresh("abc", now), false);

  // nonce 防重放
  const nc = new A.NonceCache();
  check("nonce 首见", nc.check("n1", now), false);
  check("nonce 重放", nc.check("n1", now), true);
  check("nonce 另一个", nc.check("n2", now), false);

  // 组装一次合法请求
  const mk = async (o = {}) => {
    const ts = String(o.ts ?? now);
    const nonce = o.nonce ?? "abcdef0123456789abcdef";
    const body = o.body ?? JSON.stringify({ id: "c1", text: "hi" });
    const sig = await A.signRequest(secret, { ts, nonce, method: "POST", path: "/shell/out", bodyText: body });
    const h = new Headers({
      "X-Agent-Sig": sig,
      "X-Agent-Ts": ts,
      "X-Agent-Nonce": nonce,
      "X-Agent-Id": o.id ?? "cs-1",
    });
    return { headers: h, bodyText: o.bodyText ?? body };
  };

  const base = { secret, legacyAllowed: false, method: "POST", path: "/shell/out", now, expectedId: "cs-1" };
  const okReq = await mk();
  const r1 = await A.verifyAgentRequest({ ...base, ...okReq, nonces: new A.NonceCache() });
  check("合法签名通过", r1.ok && r1.mode, "hmac");

  const r2 = await A.verifyAgentRequest({ ...base, ...okReq, bodyText: '{"id":"c1","text":"evil"}', nonces: new A.NonceCache() });
  check("改包体 → 拒绝", r2.ok, false);

  const nc2 = new A.NonceCache();
  await A.verifyAgentRequest({ ...base, ...okReq, nonces: nc2 });
  const r3 = await A.verifyAgentRequest({ ...base, ...okReq, nonces: nc2 });
  check("同签名重放 → 拒绝", r3.ok, false);

  const stale = await mk({ ts: now - 600_000, nonce: "stale0000000000" });
  check("过期时间戳 → 拒绝", (await A.verifyAgentRequest({ ...base, ...stale, nonces: new A.NonceCache() })).ok, false);

  const otherId = await mk({ nonce: "otherid00000000", id: "someone-else" });
  check("身份不符 → 拒绝", (await A.verifyAgentRequest({ ...base, ...otherId, nonces: new A.NonceCache() })).ok, false);

  check(
    "没配 AGENT_KEY → 一律拒绝",
    (await A.verifyAgentRequest({ ...base, secret: "", ...okReq, nonces: new A.NonceCache() })).ok,
    false,
  );

  // 旧的明文密钥：默认拒绝，只有显式放开过渡才通
  const legacyHeaders = new Headers({ "X-Agent-Key": secret });
  const l1 = await A.verifyAgentRequest({ ...base, headers: legacyHeaders, bodyText: "", nonces: new A.NonceCache() });
  check("明文密钥 默认拒绝", l1.ok, false);
  const l2 = await A.verifyAgentRequest({
    ...base,
    legacyAllowed: true,
    headers: legacyHeaders,
    bodyText: "",
    nonces: new A.NonceCache(),
  });
  check("过渡开关打开才放行", l2.ok && l2.mode, "legacy");

  // 下行命令签名：帧里必须带 sig，且等于 HMAC(v1\\n<id>\\n<cmd>)
  const frames = [];
  const hub = new ShellHub(async () => {}, { signer: (id, cmd) => A.signCommand(secret, id, cmd) });
  hub.attach({ enqueue: (u8) => frames.push(new TextDecoder().decode(u8)) });
  hub.enqueue("chat-1", "echo hi");
  await new Promise((r) => setTimeout(r, 30));
  const frame = frames.map((f) => f.replace(/^data: /, "").trim()).find((f) => f.includes('"t":"cmd"'));
  const ev = JSON.parse(frame);
  check("下行帧带签名", typeof ev.sig === "string" && ev.sig.length === 64, true);
  check("下行签名可复算", ev.sig, await A.signCommand(secret, ev.id, "echo hi"));

  // 跨实现一致性：agent 侧用 node:crypto 的 createHmac，Worker 用 WebCrypto subtle。
  // 两者必须逐字节相同，否则「签名对不上」会表现为通道永远连不上。
  const { createHmac } = await import("node:crypto");
  check(
    "node:crypto 与 WebCrypto 结果一致",
    createHmac("sha256", secret).update(`v1\n${ev.id}\necho hi`).digest("hex"),
    ev.sig,
  );
  hub.detach();

  // 没有 signer（老配置）时不下发 sig —— agent 那边按未签名处理
  const frames2 = [];
  const hub2 = new ShellHub(async () => {});
  hub2.attach({ enqueue: (u8) => frames2.push(new TextDecoder().decode(u8)) });
  hub2.enqueue("chat-2", "ls");
  await new Promise((r) => setTimeout(r, 10));
  const ev2 = JSON.parse(frames2.map((f) => f.replace(/^data: /, "").trim()).find((f) => f.includes('"t":"cmd"')));
  check("无 signer 时没有 sig 字段", "sig" in ev2, false);
  hub2.detach();
}

// ---- webhook 入口白名单：只认 Telegram 网段（网络层唯一入口）----
{
  const T = await import("../src/telegram-ip.js");

  check("官方网段常量", T.TELEGRAM_CIDRS, ["149.154.160.0/20", "91.108.4.0/22"]);
  check("归一化 IPv4-mapped", T.normalizeIp("::ffff:149.154.167.220"), "149.154.167.220");
  check("归一化 去空白", T.normalizeIp("  8.8.8.8 "), "8.8.8.8");

  // /20 边界：149.154.160.0 ~ 149.154.175.255
  check("网段起点", T.inCidr("149.154.160.0", "149.154.160.0/20"), true);
  check("网段内", T.inCidr("149.154.167.220", "149.154.160.0/20"), true);
  check("网段终点", T.inCidr("149.154.175.255", "149.154.160.0/20"), true);
  check("网段外（上界 +1）", T.inCidr("149.154.176.0", "149.154.160.0/20"), false);
  check("网段外（下界 -1）", T.inCidr("149.154.159.255", "149.154.160.0/20"), false);

  // 91.108.4.0/22 边界：.4.0 ~ .7.255
  check("第二网段 内", T.inCidr("91.108.6.6", "91.108.4.0/22"), true);
  check("第二网段 终点", T.inCidr("91.108.7.255", "91.108.4.0/22"), true);
  check("第二网段 外", T.inCidr("91.108.8.0", "91.108.4.0/22"), false);

  check("自定义 /32", T.inCidr("1.2.3.4", "1.2.3.4/32"), true);
  check("非法 CIDR", T.inCidr("1.2.3.4", "1.2.3.4/33"), false);
  check("非法 IP", T.inCidr("300.1.1.1", "149.154.160.0/20"), false);
  check("IPv6 一律不放行", T.isTelegramIp("2001:db8::1"), false);

  check("Telegram IP 判定", T.isTelegramIp("149.154.167.220"), true);
  check("Telegram IP 判定（mapped）", T.isTelegramIp("::ffff:91.108.4.5"), true);
  check("普通公网 IP", T.isTelegramIp("8.8.8.8"), false);
  check("空值", T.isTelegramIp(""), false);

  // 判定表：默认 on = 非 Telegram 直接拒
  check("on + Telegram → 放行", T.webhookVerdict("149.154.167.220", undefined).allow, true);
  check("on 是默认值", T.webhookVerdict("1.1.1.1", undefined).mode, "on");
  check("on + 非 Telegram → 拒绝", T.webhookVerdict("1.1.1.1", undefined).allow, false);
  check("on + 拒绝原因", T.webhookVerdict("1.1.1.1", undefined).reason, "not-telegram");
  check("on + 缺 IP → 拒绝（fail-closed）", T.webhookVerdict("", "on").allow, false);
  check("warn + 非 Telegram → 放行但标记", T.webhookVerdict("1.1.1.1", "warn").reason, "warn-only");
  check("warn + 非 Telegram 仍放行", T.webhookVerdict("1.1.1.1", "warn").allow, true);
  check("off 全放行", T.webhookVerdict("1.1.1.1", "off").reason, "guard-off");
  check("off 也放行空 IP", T.webhookVerdict("", "off").allow, true);
  check("只有显式 off 才关", T.guardMode("0"), "off");
  check("怪值回落到 on", T.guardMode("whatever"), "on");
}

// ---- Gemini key 三级解析（环境 → 持久卷文件 → .env-secrets）----
// 背景：Codespaces secret 只在 SSH 登录 shell 里由 profile.d 导出；agent 被手动/重启
// 拉起时环境里没有 GEMINI_API_KEY，而脚本又只认环境变量 + key 文件 → 误报「没有 key」。
{
  const lines = resolveKeyLines().join("\n");
  check("key 解析含 .env-secrets 兜底", lines.includes(GEMINI_SECRETS_FILE), true);
  check("兜底走 base64 解码", lines.includes("base64 -d"), true);
  check(
    "环境变量优先（不覆盖已有值）",
    lines.includes('if [ -n "${GEMINI_API_KEY:-}" ]; then GEMINI_KEY_SRC=env'),
    true,
  );
  check("有 none 兜底分支", lines.includes("GEMINI_KEY_SRC=none"), true);

  const run = buildGeminiScript({ prompt: "hi" });
  check("执行脚本带三级兜底", run.includes(".env-secrets"), true);
  check("执行脚本仍认持久卷文件", run.includes("gemini-key"), true);
  check("续会话标记仍在", run.includes("gemini-session"), true);

  const st = buildStatusScript();
  check("status 与执行共用同一套解析", st.includes("GEMINI_KEY_SRC"), true);
  check("status 说明 secrets 兜底来源", st.includes("从 .env-secrets 现取"), true);
  check("status 保留模型行（回归）", st.includes("模型："), true);
  check("status 无 key 时点明三处都空", st.includes("三处都没有 key"), true);

  // 报错文案必须「直接给出下一步」，不能只说没有 key
  check("报错点明三处来源", run.includes("三处都没有 key"), true);
  check("报错给出补 secret 的路径", run.includes("Settings → Codespaces → GEMINI_API_KEY"), true);
  check("报错给出临时替代命令", run.includes("/gemini key <KEY>"), true);
  check("报错不再说「还没有 Gemini API key」", run.includes("还没有 Gemini API key"), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
