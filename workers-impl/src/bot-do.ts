/**
 * AssistantDO：整个机器人的心脏——一个 Durable Object（Telegram 通道版）。
 *
 * 职责：
 *   1. 收：Telegram 主动 webhook POST 到 /webhook（HTTPS 入站，全球可达，
 *      无备案、无签名、无 WebSocket），事件驱动、无常驻连接、不计 duration；
 *   2. 消息流水线：去重 → 白名单 → 限流 → 日额度 → 文本/语音(ASR) → 意图解析
 *      → LLM 路由（多厂商 fallback）→ 分段回包；
 *   3. 全部状态（会话历史、去重、限流、额度）落 DO SQLite。
 *
 * DO 仍是单例：SQLite 状态需要单点。webhook 模式下 DO 按请求唤醒、处理完即休眠，
 * duration 成本近似为零——免费档 100k 请求/天对个人语音助手绰绰有余。
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { endpoints } from "./config";
import { TelegramClient } from "./telegram/client";
import { extractIncoming, type Incoming } from "./telegram/update";
import type { TgUpdate } from "./telegram/types";
import { parseIntent, effortFor, type Intent } from "./router/intent";
import { chatChain, loadProviders, type ChatResult } from "./router/providers";
import { chunkText, transcribeBytes } from "./asr";
import {
  CodespaceClient,
  beginBoot,
  checkBoot,
  stopCodespace,
  describeState,
  bootTimeoutReply,
  BOOT_CHECK_DELAY_MS,
  BOOT_RETRY_DELAY_MS,
  BOOT_MAX_ATTEMPTS,
  type CodespaceState,
} from "./codespace";
import {
  isVerified,
  isAnswerMatch,
  answerFingerprint,
  nextExpiry,
  CHALLENGE_TEXT,
  shouldReplay,
  previewCmd,
  looksLikeCommand,
  VERIFY_SESSION_DEFAULT_MIN,
  type VerifyState,
  type PendingCmd,
} from "./verify";
import {
  evalWatch,
  evalShellAlert,
  fmtDur,
  pushAlarm,
  drainAlarms,
  type AlarmStore,
  type AlarmTask,
  type ShellAlertDecision,
} from "./watch";
import { ShellHub, type ShellOutMsg, type ShellPing } from "./shell";
import { NonceCache, signCommand, timingSafeEq, verifyAgentRequest, parseAgentKeys } from "./agent-auth";
import { reloadVerdict, reloadErrorResponse } from "./admin-auth";
import {
  buildGeminiScript,
  buildStatusScript,
  buildModelsScript,
  buildNewSessionScript,
  parseGeminiArgs,
  parseModelChain,
  previewPrompt,
  sanitizeModel,
} from "./gemini";
import {
  buildBuddyScript,
  buildBuddyStatusScript,
  buildBuddyModelsScript,
  buildBuddyNewSessionScript,
  parseBuddyArgs,
  BUDDY_DIR,
} from "./buddy";
import {
  matchCommand,
  renderHelp,
  renderCommandHelp,
  menuCommands,
  looksLikeUnknownSlash,
  suggestCommand,
} from "./commands";

// 构建标记：每次改动后递增，方便确认线上跑的是不是最新包（curl /healthz 看 build 字段）。
// v2：Gemini 思考档位控制（reasoning_effort）+ 模型级降级 fallback + 分层超时。
//     背景：gemini-3.8-flash 默认思考预算拉满，手表端等到 68~104s 甚至超时。
// v3：闲聊主路直取 flash-lite（3.7/3.8 Flash 已移除 minimal 档，传了直接 400，
//     由 clampEffort 兜底降档 low）；主模型失败不再静默，打 [router] 警告日志。
// v4：回复以 Telegram MarkdownV2 渲染（代码块真正高亮）+ 400 自动降级纯文本；
//     chunkText 升级为代码块感知（不在围栏内切断）。
// v7：缩进代码块兜底——模型实测会输出 4 空格缩进代码块（Markdown 标准格式），
//     但 Telegram MarkdownV2 只认 ``` 围栏，导致代码渲染成普通文本。
//     现 mdToV2 先把缩进块提升为围栏（带列表/引用误判保护），
//     系统提示同步强制围栏输出，双管齐下。
// v8：新增「诊断」命令——回显最后一轮模型回复的原文格式（围栏/缩进可见化标记），
//     用于定位「高亮不生效」：区分模型输出格式问题 vs 发送降级 vs 客户端渲染。
// v9：正文富文本——markdown 行内语法转 MarkdownV2 实体（**粗体**→*粗体*、
//     *斜体*→_斜体_、~~删除线~~→~删除线~、## 标题→粗体、[文字](url)→链接）。
//     内容首尾空格约束防 "2 * 3" 数学式误判；V2 无实体的列表/引用/表格仍字面显示。
// v14：外部服务地址全部配置化——新增 src/config.ts 集中解析端点
//     （TELEGRAM_API_BASE，默认官方地址），客户端不再持有任何写死的 URL；
//     厂商地址走 providers.json。
// v15：移除微信路线——删除 reference-impl/（微信自托管实现）与 docs/ARCHITECTURE.md
//     （早期设计文档）；docs/ 各文档与 README 同步清理微信/reference-impl 表述。
//     端点配置化（v14）与全部功能逻辑不变。
// v16：移除 QQ 通道——删除 src/qq/、docs/HOSTING.md（早期选址文档）与 diagram.html
//     （早期架构图），env/config/路由/测试同步清理；仅保留 Telegram 单通道。
//     消息流水线、LLM 路由、状态存储逻辑不变。
// v17：Codespace 开发机远程开关——/boot、/halt、/cs 指令
//     （含 /boot /halt /cs 别名）。两次查询开机协议（30s 间隔、不循环、幂等停机），
//     GitHub REST 薄客户端见 src/codespace.ts；凭证 GH_CODESPACE_PAT（secret）。
// v1（devbot 独立版本线）：省额度看门狗——
//     ① 空闲提醒+自动关机（evalWatch 两层保险：25min 提醒 / 55min 自动关，可配）；
//     ② 互动即续命（白名单消息 touchWatchActivity），origin=bot 才自动关、observed 只提醒；
//     ③ DO alarm 软排队（boot 二查与看门狗共存）；
//     ④ 「用量」指令：本月累计运行时长 vs 免费额度（cs_runtime 表按日累计）；
//     ⑤ patrol 巡检（cron 半小时 + /patrol 手动）：发现漏网的运行中机器。
// v1.3：终端化定位——未识别的文本不再静默退化成 LLM 聊天（那会抛出
//       「所有模型都调用失败」这种跟终端毫无关系的报错）。未配 LLM key 时
//       直接回 TERMINAL_HINT，把 devbot 支持的指令列清楚。
// v2.0：devbot 成为真正的联机 shell——codespace 内跑一个零依赖 Node agent，
//       反连 Worker 建 SSE 长连接（CF 无法出站 SSH，只能让 agent 反向出来）。
//       agent 内 spawn 一个长驻 `bash -i`（优先用 script 分配 PTY），
//       命令走 stdin、输出走 stdout 增量回传，cwd/环境变量/后台进程跨消息保持。
// v2.1：补上身份验证门——所有指令（含 shell 命令）先过验证词挑战（secret VERIFY_ANSWER，
//       具体值不进代码、随时可换：npx wrangler secret put VERIFY_ANSWER），
//       通过后才进入 30 分钟滑动会话；未配 VERIFY_ANSWER 则服务锁定（默认安全）。
//       这是 root 级联机 shell 的必要防线：白名单只管「谁能发消息」，
//       验证门管「发来的东西能不能真的执行」。
// v2.2：修 shell 在线误判——agent 空闲不发 POST，lastSeen 冻结在 attach 时刻，
//       90s 后 online() 判离线 → 所有命令被拒（日志里连 exec 都看不到）。
//       改为 attach() 的 20s SSE 心跳写成功后刷新 lastSeen，并让 /shell/out 调 tick()。
// v3.0：Gemini CLI 接入——/gemini 一键「开机 → 等 shell 通道 → 装 CLI → 准备认证」，
//       之后普通文本即 prompt（非交互 `gemini -p`，`-r latest` 续上下文，
//       `--approval-mode=yolo` 让它能改文件）。不做 TUI 转发：Ink 整屏重绘塞进
//       Telegram 只会得到一堆碎片；见 src/gemini.ts 顶部说明。
// v3.5：Gemini 安装改成三级降级（npm → sudo -n → 装到 ~/.local），
//       **不再需要用户去开全局 sudo**；/gemini status 会顺带报告 sudo 是否免密。
// v4.0：agent 通道改成 HMAC 双向签名（src/agent-auth.ts）——密钥不再逐请求明文传输，
//       带时间窗 + nonce 防重放；下行命令由 Worker 签名、agent 验签后才执行，
//       并绑定 codespace 身份（X-Agent-Id）。另加失败次数封禁，回到「只有这台
//       Worker 能和这台开发机通信」。
// v4.6：修「上一条命令还在跑」锁死 —— 根因是下行帧**没有回执**：SSE 连接半死时
//       命令写进 controller 不报错、对面却根本没收，Worker 只能枯等 TTL。
//       现在三件套：① agent 收命令立刻 ack，超时未 ack 就重发（agent 侧幂等）；
//       ② agent 每 15s POST /shell/ping 报存活 + 在跑命令，Worker 的在线判定
//       只认它（不再信「写成功」），agent 重启就立即中断它手上的命令；
//       ③ 用户发下一条命令时若发现上一条已失联，当场解锁并放行，不用等 TTL。
// v4.15：每台机器独立密钥（安全审查：agent 身份自声明）。旧实现所有机器共用一把
//       AGENT_KEY、X-Agent-Id 由机器自己填、无法区分/吊销单台。现在按 id 查密钥
//       —— AGENT_KEYS 静态注册表（Worker secret，JSON id→key，扛得过 DO_KEY 换版）
//       + DO storage 运行期覆盖（POST/DELETE /admin/agents 即时增/吊销）。未知或
//       已吊销 id 一律 401；下行命令签名改用「已连接机器的那把密钥」，不再用共享密钥。
// v4.16：验证会话窗口 30 → 10 分钟（用户要求「严格的 10 分钟不交互就验证」）。
//       滑动语义不变（任何交互续期 10 分钟），只是连续 10 分钟没消息就失效、
//       下一条消息重新走验证词。默认值抽成 VERIFY_SESSION_DEFAULT_MIN 并有单测锁住，
//       防止以后被人顺手改回 30 —— 那样不会有任何测试变红。
// v4.17：新增 /buddy —— 用 CodeBuddy CLI 做同样的「编程会话」（非交互 -p、-c 续会话、
//       -y 跳过确认）。与 /gemini 的差别只在认证与目录：CodeBuddy 走浏览器 OAuth
//       （登录态在 ~/.codebuddy，不需要 API key），工作目录固定 /workspaces/codebuddy
//       并 pre-trust。两边共用同一套「模式开关 + 待发提问 + prep alarm」，只在生成
//       脚本处按 provider 分叉，避免复制一遍六百行流程控制。
// v4.18：AI 会话的收尾小注只留 `— exit 0`，不再附目录。那两个脚本整体跑在子 shell
//       里（避免 exit 杀掉长驻 shell），cd 不外泄，报出来的是父 shell 的位置，
//       跟「AI 在哪个目录干活」不是一回事 —— 用户确实问过「为什么显示
//       /workspaces/watch-ai-assistant」。普通 shell 命令仍保留目录（那是真的会变）。
// v4.19：修「刚开机就被看门狗关掉」。看门狗用 episode.lastActivity 算空闲时长，但那
//       个值只在开机成功（boot_check）时才刷新；/buddy 触发的开机在那之前就有几十秒
//       窗口，若此时一轮已到期的 watch alarm 落地，会拿上一轮的 lastActivity 算出
//       「空闲 90 分钟」→ 立刻自动关机 → agent 一行日志都来不及写，Telegram 永远停在
//       「机器在跑，但 shell 通道还没连上」。现在 evalWatch 里加了不变量
//       「空闲 ≤ 本轮已运行」（active = max(lastActivity, bootAt)），并有回归测试；
//       AI 等待通道时 60 秒也会先回一句，不再让人干等 5 分钟。
// v4.20：长任务生存 + 进程可见性（用户问「codebuddy 长任务会不会被杀」—— 会，一次
//       排出 5 条杀手路径，本版砍掉其中 3 条）：
//       · agent 侧（watch-ai-assistant 仓）：看门狗从「4/8 分钟零输出即杀」改为读
//         /proc 看证据（zombie/never-moved/cpu-frozen 才杀；suspended/io 只报不杀；
//         其余继续等并周期播报），心跳带 proc 状态行；
//       · 命令 TTL：从下发时刻 → 最后一次活动时刻（心跳说在跑 = 活动），兜底
//         15 → 60 分钟；
//       · 省额度看门狗：开发机上有命令在跑（busy）= 正在用，不打扰不关机；
//       · /cs：有命令在跑时显示进程状态行（agent 太老会明说需 git pull）；
//       · 幽灵输出：登记被清后迟到的输出不再静默丢弃，会提示「它可能还在跑」。
// v4.21：完整回传（用户要求「codebuddy 的 stdout 全部发给我」）。截断链路全开：
//       agent MAX_CHARS 6 万 → 200 万（旧值会把长输出的尾部整段丢掉）、
//       Worker SHELL_MAX_CHARS 2.4 万 → 200 万（旧值掐头尾丢中间）；Telegram
//       4096/条的分块保留（物理上限），sendMessage 429 限速改为按 retry_after
//       重试（完整回传后一次连发几十条是常态，429 从异常变成预期内）。
const BUILD = "devbot-20261028-v4.21";

/**
 * 「AI 编程会话」的两种 provider。/gemini 与 /buddy 除脚本生成外流程完全一致
 * （开机 → 等通道 → 装 CLI → 非交互 -p → 续会话），所以共用同一套模式开关、
 * 待发提问暂存和 prep alarm，只在生成脚本处按 provider 分叉。
 */
type AiProvider = "gemini" | "buddy";

/** provider → 等通道用的 alarm kind（两种各自独立，避免互相覆盖）。 */
const aiPrepKind = (p: AiProvider): "gemini_prep" | "buddy_prep" =>
  p === "buddy" ? "buddy_prep" : "gemini_prep";

/**
 * 未识别输入时的兜底提示。
 *
 * v2.6 起直接复用指令注册表渲染（commands.ts），不再手写一份列表——
 * 手写的版本一旦加指令就会忘记同步，帮助文本和实际行为立刻分叉。
 */
const terminalHint = (): string => renderHelp();

const SYSTEM_PROMPT = `你是一位资深软件工程师，通过用户的智能手表语音接收编程需求。
输出要求：
1. 先给结论或代码，再给必要解释——用户可能在手表上阅读，务必精炼
2. 代码必须放在 \`\`\` 围栏代码块中并标注语言（如 \`\`\`python），严禁使用 4 空格缩进代码块——Telegram 客户端不渲染缩进代码
3. 涉及多文件改动时，用清单列出「文件 → 改动点」
4. 信息不足时先说明你的假设，不要编造 API 或参数
5. 默认使用任务描述中指定的编程语言；未指定时用 Python`;

export class AssistantDO extends DurableObject<Env> {
  private readonly tg: TelegramClient;
  /** Shell 网关：agent SSE 连接 + 命令队列 + 输出缓冲（内存态，DO 驱逐即失效） */
  private readonly shell: ShellHub;
  /** 已用过的请求 nonce（防重放）。DO 驱逐即清空——那时连接也断了，窗口自然关闭。 */
  private readonly nonces = new NonceCache();
  /** 鉴权失败计数：同一 IP 短时间连续撞 401 就临时封禁，别让人把密钥试出来。 */
  private readonly authFails = new Map<string, { n: number; first: number; until: number }>();
  /** 最近一次通过鉴权的 agent 连接（诊断用：能看出走的是签名还是旧的明文密钥）。 */
  private lastAuth: { mode: "hmac" | "legacy"; at: number; id: string } | null = null;
  /** 当前已连接的机器 id（来自 /shell/stream 的 X-Agent-Id，经签名验证）。下行命令按它选密钥。 */
  private agentId = "";
  /** AGENT_KEYS 静态注册表解析结果（构造时解析一次；undefined = 尚未解析）。 */
  private agentKeysMapCache: Map<string, string> | null | undefined = undefined;
  /** 运行期密钥覆盖（DO storage 里的增/吊销），加载后常驻内存，增删时同步刷新。 */
  private agentOverridesLoaded = false;
  private agentOverrides = new Map<string, string | null>(); // null = 已吊销
  /** 最近一条 webhook 的来源 IP（应始终落在 Telegram 网段内，仅 /status（需 ADMIN_KEY）可见）。 */
  private lastWebhookIp = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 端点集中解析（默认官方地址，可用环境变量覆盖，见 src/config.ts）
    const ep = endpoints(env);
    this.tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN ?? "", ep.telegramApiBase);
    this.shell = new ShellHub((chatId, text) => this.sendShellChunk(chatId, text), {
      flushMs: Number(env.SHELL_FLUSH_MS ?? 1200),
      // 完整回传：用户要求「codebuddy 的 stdout 全部发给我」。旧默认 24000 会
      // 掐头尾丢中间。200 万 ≈ 实际不设限（单条命令输出到不了这个量级），
      // Telegram 4096/条的分块仍然保留（物理上限绕不开），429 由 sendShellChunk 重试。
      maxChars: Number(env.SHELL_MAX_CHARS ?? 2_000_000),
      // Gemini 会边想边改文件，一条命令跑十几分钟是正常的；15 分钟就放弃太急
      cmdTtlMs: 45 * 60_000,
      // 下行命令签名：agent 只执行签名对得上的命令，见 src/agent-auth.ts。
      // 按「当前已连接机器」的密钥签名（每台机器独立密钥），不再用共享密钥。
      signer: (cmdId, cmd) => this.signDownlink(cmdId, cmd),
    });
    // SQLite 建表（幂等）；schema 版本标记避免每次唤醒都跑 DDL。
    // v1→v2：新增 cs_runtime 表（看门狗运行时长账本）。DDL 全部 IF NOT EXISTS，
    // 升级标记即重跑一遍，老表不受影响。
    void this.ctx.storage.get("schema_v2").then((done) => {
      if (done) return;
      this.ctx.storage.sql.exec(SCHEMA_SQL);
      void this.ctx.storage.put("schema_v2", true);
    });
  }

  // ---------------------------------------------------------------- 入口

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/status":
          return Response.json(await this.status());
        case "/admin/reload": {
          // 部署后强制切到新代码。
          // 为什么需要：wrangler deploy 之后，已有 DO 实例仍跑旧构建（被 agent 的 SSE
          // 长连接钉住），于是「部署成功、线上版本号不变」。ctx.abort() 直接终止实例，
          // 下一次请求就会用新代码创建新实例 —— 这是 CI 里「部署完调一次」的那一步。
          // 鉴权用独立的 DEPLOY_KEY（只给 CI），不复用 ADMIN_KEY。
          // 安全（安全审查 #8）：只接受 POST，密钥走 Authorization: Bearer <DEPLOY_KEY>
          // 头（或 X-Deploy-Key 头）—— 绝不进 URL 查询串，避免被访问日志 / 代理遥测记录。
          // 判定逻辑抽到 admin-auth.ts（纯函数，有单测覆盖）。
          //
          // ⚠️ 改这个鉴权方式会踩「自举死锁」：正在跑的实例是旧代码，它只认旧方式，
          //    会拒绝新格式的 reload → 不自毁 → 永远停在旧版本，新代码上线不了。
          //    所以要改鉴权，必须同时 bump wrangler.toml 的 DO_KEY（换全新实例跑新代码），
          //    或让新旧两版同时兼容一段时间。本次 v4.10 就是这样靠 DO_KEY 换版的。
          {
            const v = reloadVerdict(this.env, request);
            if (!v.ok) return reloadErrorResponse(v);
          }
          // 先让响应发出去，再自毁：abort 会立刻中断所有在途请求（包括这个响应）
          setTimeout(() => {
            try {
              this.ctx.abort();
            } catch {
              /* 已被驱逐，无妨 */
            }
          }, 150);
          return Response.json({ ok: true, build: BUILD, reloading: true });
        }
        case "/csdebug": {
          // 调试：直接调 GitHub API 查 codespace 状态（绕过消息流水线，定位 PAT/网络问题）
          const client = this.codespaceClient();
          if (!client) return Response.json({ ok: false, error: "GH_CODESPACE_PAT 未配置" }, { status: 400 });
          try {
            const st = await client.status();
            return Response.json({ ok: true, state: st.state, name: st.name });
          } catch (e) {
            return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
          }
        }
        case "/patrol":
          // 看门狗巡检（cron 半小时触发 / 手动带 X-Admin-Key 头触发）：查机器状态并跑 evalWatch
          return Response.json(await this.patrol());
        case "/shell/stream": {
          // codespace 内 agent 的下行命令通道（SSE 长连接）。
          // 鉴权：HMAC 签名（见 src/agent-auth.ts），不走 ADMIN_KEY——agent 只需要
          // 收命令和回传输出，不给它任何管理权限。
          const bad = await this.guardAgent(request, "", url.pathname);
          if (bad) return bad;
          return this.shellStream();
        }
        case "/shell/out": {
          // agent 回传命令输出（增量片段 / done 收尾包）。
          // 先把原文读成字符串：签名覆盖 body，必须用**原始字节**算哈希，不能先 parse。
          const raw = await request.text();
          const bad = await this.guardAgent(request, raw, url.pathname);
          if (bad) return bad;
          let body: ShellOutMsg;
          try {
            body = JSON.parse(raw) as ShellOutMsg;
          } catch {
            return Response.json({ ok: false, error: "bad json" }, { status: 400 });
          }
          this.shell.tick(); // 收到回传 = agent 活着，刷新在线时间
          await this.shell.onOutput(body);
          return Response.json({ ok: true, pending: this.shell.pending() });
        }
        case "/shell/ping": {
          // agent 心跳：唯一可信的「通道真的活着」证据（SSE 写成功在连接半死时不可信）。
          const raw = await request.text();
          const bad = await this.guardAgent(request, raw, url.pathname);
          if (bad) return bad;
          let ping: ShellPing = {};
          try {
            ping = JSON.parse(raw) as ShellPing;
          } catch {
            /* 空 body 也允许：至少说明 agent 活着 */
          }
          this.shell.onPing(ping);
          void this.touchAgentSeen(this.agentId); // 刷新已连接机器的 last_seen（仅运行期管理的）
          return Response.json({ ok: true, pending: this.shell.pending() });
        }
        case "/shell/status":
          // 诊断：agent 在线状态 / 上次心跳 / 排队数 / 最近 cwd（需 ADMIN_KEY，走 index 鉴权）
          return Response.json({
            ok: true,
            shell: this.shell.snapshot(),
            auth: this.lastAuth ? { mode: this.lastAuth.mode, at: this.lastAuth.at, id: this.lastAuth.id } : null,
          });
        case "/webhook":
          return await this.handleWebhook(request);
        case "/send": {
          // 调试用：主动推一条文本到指定 chat_id
          const text = url.searchParams.get("text") ?? "";
          const chatId = url.searchParams.get("chat_id") ?? "";
          if (!text || !chatId) return new Response("need ?text=&chat_id=", { status: 400 });
          await this.reply(chatId, text);
          return Response.json({ ok: true });
        }
        case "/admin/agents": {
          // 机器密钥管理（列/增）。鉴权在 index.ts 用 ADMIN_KEY 完成，这里只管业务逻辑。
          // 吊销单台机器走 DELETE /admin/agents/:id（见 default 分支）—— 即时生效，
          // 不用重新部署，也不用等 DO_KEY 换版。
          if (request.method === "GET") return this.listAgents();
          if (request.method === "POST") return this.upsertAgent(request);
          return new Response("method not allowed", { status: 405 });
        }
        default:
          // /admin/agents/:id —— 吊销单台机器：把覆盖表里这条标记吊销，
          // agentKeyFor 下次请求就返回 undefined → 该机器立刻 401、再也连不上。
          if (url.pathname.startsWith("/admin/agents/")) {
            const id = decodeURIComponent(url.pathname.slice("/admin/agents/".length));
            if (request.method === "DELETE") return this.revokeAgent(id);
            return new Response("method not allowed", { status: 405 });
          }
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------- Webhook

  /**
   * DO alarm 回调：任务队列分发器（boot 二查 + 看门狗共用单一 alarm 槽位）。
   * setAlarm 持久化——即使 DO 在两次唤醒之间被驱逐，闹钟也会准时叫醒。
   */
  async alarm(): Promise<void> {
    try {
      const tasks = await drainAlarms(this.alarmStore());
      for (const t of tasks) {
        // 注意：payload 必须传下去——boot_check 的 chat_id 只在 payload 里，
        // 早期版本漏传导致「开机成功」那条消息永远发不出去（静默成功）。
        if (t.kind === "boot_check") await this.onBootCheckAlarm(t.payload);
        else if (t.kind === "watch") await this.onWatchAlarm();
        else if (t.kind === "gemini_prep") await this.onAiPrepAlarm("gemini", t.payload);
        else if (t.kind === "buddy_prep") await this.onAiPrepAlarm("buddy", t.payload);
      }
    } catch (e) {
      console.error("[alarm] 队列处理失败", e);
    }
  }

  /**
   * Telegram 事件推送入口：
   *   1. 可选校验 secret_token（X-Telegram-Bot-Api-Secret-Token，防伪请求）；
   *   2. 解析 Update，提取消息；
   *   3. 立即回 200（Telegram 要求快速应答），真正的处理放 waitUntil 后台跑。
   */
  private async handleWebhook(request: Request): Promise<Response> {
    // secret_token 是**必需**的：没配就等于没有密钥层防线，宁可全拒也不放行。
    // （早期版本是「配了才校验」，等于配置漏一项就静默裸奔，属于典型的 fail-open。）
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) {
      console.error("[webhook] TELEGRAM_WEBHOOK_SECRET 未配置 → 拒绝所有 webhook");
      return new Response("webhook secret not configured", { status: 403 });
    }
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!timingSafeEq(got, expected)) return new Response("forbidden", { status: 403 });
    // 记录来源 IP：确认「进来的流量确实来自 Telegram 网段」用，仅 /status（需 ADMIN_KEY）可见
    this.lastWebhookIp = request.headers.get("CF-Connecting-IP") ?? "";

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const incoming = extractIncoming(update);
    if (incoming) {
      this.ctx.waitUntil(this.handleMessage(incoming).catch((e) => console.error("[tg]", e)));
    }
    return Response.json({ ok: true });
  }

  // ---------------------------------------------------------------- 消息处理

  private async handleMessage(m: Incoming): Promise<void> {
    // 1) 去重：Telegram 重试时可能重推同一 update_id
    const key = `u${m.updateId}`;
    if (await this.seenMsg(key)) return;
    await this.markSeen(key);

    // 2) 白名单（未配置 = 放开，仅建议开发期）。**只认 user_id（from.id）**，
    //    不认 chat_id——群聊里 chat_id 是群号不是人，按 chat_id 放行会把整个群放进来。
    //    拒绝时回报 user_id，方便管理员把该号加白（只回一次/分钟，避免被刷屏）。
    const allowed = (this.env.ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(m.userId)) {
      console.log(`[tg] 非白名单 user=${m.userId}（chat=${m.chatId}），拒绝`);
      if (await this.allowRate(m.chatId)) {
        await this.reply(
          m.chatId,
          `未授权用户。你的 user_id 是 ${m.userId}，请联系管理员加入白名单。`,
        );
      }
      return;
    }

    // 2.5) 看门狗互动刷新——先只记 chat_id（patrol 推送目标；验证状态无关）。
    //      终端级续命判定需要 text，放到文本提取之后（见 5.5 前）。
    await this.touchWatchActivity(m.chatId, false);

    // 3) 限流
    if (!(await this.allowRate(m.chatId))) {
      await this.reply(m.chatId, `说话慢一点～每分钟最多 ${this.rateLimit()} 条。`);
      return;
    }

    // 4) 日额度（防失控烧钱）
    if (await this.overBudget()) {
      await this.reply(m.chatId, "今天的调用额度用完了，明天再战。");
      return;
    }

    // 5) 文本提取：文本直取；语音下载后走 STT 转写
    let text = m.text;
    let source = "text";
    if (!text && m.voiceFileId) {
      text = await this.transcribeVoice(m.voiceFileId, m.voiceMime);
      source = "stt-api";
    }
    if (!text) {
      await this.reply(m.chatId, "没听清⋯⋯换句话试试，或者直接发文字。");
      return;
    }
    console.log(`[tg] 消息 chat=${m.chatId} source=${source} text=${text.slice(0, 80)}`);

    // 5.5) 身份验证（10 分钟滑动会话）：
    //   - 未验证：一切问题/指令都不转发 LLM / Codespace，只回验证问题；
    //     若这条消息本身就是正确答案 → 通过并延续 10 分钟。
    //   - 未验证时收到的那条命令会暂存（10 分钟保鲜）→ 验证通过后自动补执行，
    //     用户不必重复输入（2026-10-27 用户要求）。
    //   - 已验证：任何交互把会话滑动延续 10 分钟；**连续 10 分钟不交互即失效**，
    //     下一条消息重新走验证（2026-10-28 用户要求「严格 10 分钟」，原为 30）。
    //   - 答案 VERIFY_ANSWER 走 secret（不在公开源码里）；未配置 = 服务锁定（默认安全）。
    //   - 设备限制由「白名单账号」达成（Telegram 不提供设备信息）。
    const now = Date.now();
    const verifyAnswer = this.env.VERIFY_ANSWER;
    const sessionMs = this.verifySessionMs();
    const fp = verifyAnswer ? answerFingerprint(verifyAnswer) : "";
    const state = await this.getVerify(m.chatId);
    if (!isVerified(state, now, fp)) {
      if (verifyAnswer && isAnswerMatch(text, verifyAnswer)) {
        await this.setVerify(m.chatId, nextExpiry(now, sessionMs), fp);
        const pending = await this.takePendingCmd(m.chatId, now);
        if (!pending) {
          await this.reply(m.chatId, "验证通过 ✓（10 分钟内互动免验证）");
          // 「哈哈」同时是开机口令（用户 2026-10-27 定）：验证完顺手把机器拉起来
          await this.bootOnPassword(m.chatId);
          return;
        }
        // 有暂存命令：告知 + 落回正常流水线执行（不 return）
        await this.reply(
          m.chatId,
          `验证通过 ✓（10 分钟内互动免验证）\n▶ 执行你刚才那条：${previewCmd(pending)}`,
        );
        text = pending; // 后面所有分支（开发机指令 / shell / 控制词）照常处理它
        source = `${source}+replay`;
        console.log(`[tg] 验证通过后补执行暂存命令 chat=${m.chatId} cmd=${previewCmd(pending, 60)}`);
      } else {
        // 未通过：像命令的才记下来（输错的验证词不该在验证后被当成命令执行）
        const remember = looksLikeCommand(text);
        if (remember) await this.rememberPendingCmd(m.chatId, text, now);
        await this.setVerify(m.chatId, 0); // 保持未验证
        await this.reply(
          m.chatId,
          verifyAnswer
            ? remember
              ? `${CHALLENGE_TEXT}\n\n（你这条我记着了，回验证词后自动执行）`
              : CHALLENGE_TEXT
            : `${CHALLENGE_TEXT}\n（管理员未配置验证答案，服务锁定中）`,
        );
        return;
      }
    }
    // 已验证（或刚验证通过）→ 滑动延续
    await this.setVerify(m.chatId, nextExpiry(now, sessionMs), fp);

    // 5.6) 终端级互动续命（在 text 就绪后判定）：只有开发机相关消息才刷新看门狗，
    //      纯聊天不续命——防止将来接 LLM 后「聊天把机器聊到永不关机」。
    //      判定依据来自指令注册表（commands.ts）的 touch 标记，与派发同源。
    const parsed = matchCommand(text);
    if (parsed?.spec.touch) await this.touchWatchActivity(m.chatId, true);

    // 5.7) 已验证状态下单独发验证词 = 开机口令（用户 2026-10-27 定：
    //      「哈哈」是除 /boot 外唯一能开机的方式）。机器在跑就只回一句确认。
    if (!parsed && verifyAnswer && isAnswerMatch(text, verifyAnswer)) {
      await this.bootOnPassword(m.chatId);
      return;
    }

    // 6.6) 指令派发（注册表驱动：解析、帮助、Telegram 菜单同源，见 commands.ts）
    const trimmed = text.trim();
    if (parsed) {
      const { spec, args } = parsed;
      switch (spec.name) {
        case "boot": {
          const reply = await this.handleBootDev(m.chatId);
          if (reply) await this.reply(m.chatId, reply);
          return;
        }
        case "gemini":
          await this.handleGemini(m.chatId, args, m.messageId);
          return;
        case "buddy":
          await this.handleBuddy(m.chatId, args, m.messageId);
          return;
        case "halt": {
          // 先停机（核心动作，不容失败），再落账（记账失败不应阻断停机）
          const reply = await this.handleStopDev();
          try {
            await this.closeEpisode();
          } catch (e) {
            console.error("[watch] closeEpisode 失败（不影响停机）", e);
          }
          await this.reply(m.chatId, reply);
          return;
        }
        case "cs":
          await this.reply(m.chatId, await this.handleDevStatus());
          return;
        case "usage":
          await this.reply(m.chatId, await this.handleUsage());
          return;
        case "ctrlc": {
          const err = this.shell.sendCtrlC();
          if (err) {
            await this.reply(m.chatId, err);
            return;
          }
          // 发完信号还要把队列清掉：只看 queue.size 的单飞锁，遇到「进程不理 SIGINT」
          // 或「marker 丢了」就会把人锁到 45 分钟 TTL，那等于唯一的逃生手段变成了关机。
          const dropped = this.shell.killAll();
          const lines =
            dropped.length === 0
              ? ["已发送 Ctrl-C ✓（队列本来就是空的）"]
              : [
                  `已发送 Ctrl-C，并清掉 ${dropped.length} 条挂着的命令：`,
                  ...dropped.map((d) => `· ${String(d.label ?? d.cmd.split("\n")[0]).slice(0, 60)}`),
                  "",
                  "若那个进程仍然不理中断，发 /halt 关机。",
                ];
          await this.reply(m.chatId, lines.join("\n"));
          return;
        }
        case "help": {
          // /help boot → 单条细节；/help 无参 → 全表
          const one = args ? renderCommandHelp(args.split(/\s+/)[0]) : null;
          if (args && !one) {
            const hint = suggestCommand(args.split(/\s+/)[0]);
            await this.reply(
              m.chatId,
              `没有这条指令：${args.split(/\s+/)[0]}${hint ? `\n你是不是要 /${hint}？` : ""}\n\n${renderHelp()}`,
            );
          } else {
            await this.reply(m.chatId, one ?? renderHelp());
          }
          void this.syncMenuOnce(); // 顺手把 Telegram 的「/」菜单对齐（一次性，失败不影响回复）
          return;
        }
        case "diag":
          await this.diagnose(m.chatId, (t) =>
            this.tg.call("sendMessage", {
              chat_id: m.chatId,
              text: t,
              disable_web_page_preview: true,
            }),
          );
          return;
      }
    }

    // 6.6a) 打错的斜杠指令（/hlep、/hault）：**必须排在 Gemini 会话模式之前**。
    //       原来这条在下面（6.7），于是 Gemini 模式里把 /hault 当成 prompt 发给了
    //       gemini -p —— 用户看到的是「shell 忙」，而不是「你把 halt 打错了」，
    //       连关机这种救命指令都变成哑弹。
    //       绝对路径（/usr/bin/env、/tmp/a.sh）不算，照常进 shell。
    if (!parsed && looksLikeUnknownSlash(trimmed)) {
      const hint = suggestCommand(trimmed.split(/\s+/)[0]);
      await this.reply(
        m.chatId,
        `未知指令 ${trimmed.split(/\s+/)[0]}${hint ? `，你是不是要 /${hint}？` : ""}\n发 /help 看全部指令。`,
      );
      return;
    }

    // 6.6b) AI 会话模式：普通文本 = 问当前 provider（gemini / buddy）；行首 `!` = 仍然走 shell。
    //       位置在指令派发之后 —— 会话模式里 /halt、/cs 这些指令照样能用。
    if (!parsed) {
      const mode = await this.aiMode(m.chatId);
      if (mode) {
        if (trimmed.startsWith("!")) {
          text = trimmed.slice(1).trim(); // 拆掉「!」后落回 shell
        } else if (mode === "buddy") {
          await this.startBuddy(m.chatId, text);
          return;
        } else {
          await this.startGemini(m.chatId, text);
          return;
        }
      }
    }

    // 6.9) 联机 shell：到这里还没匹配上的，一律当 shell 命令下发。
    //      开发机里的 bash 是长驻的：cd 过的目录、export 过的变量、
    //      & 起的后台进程，下一条消息里都还在。
    const shellRes = await this.dispatchShell(m.chatId, text);
    if (shellRes === "accepted") return; // 已下发，输出走 /shell/out 异步回传

    // 6) shell 用不了时才退回 LLM。没有可用厂商（未配 key）→ 不做无谓调用，
    //    直接把 shell 的不可用原因说清楚（原实现会抛「所有模型都调用失败」，
    //    对只想操作开发机的用户完全是噪音）。
    const providers = loadProviders(this.env);
    if (Object.keys(providers).length === 0) {
      await this.appendHistory(m.chatId, "user", text);
      await this.reply(m.chatId, shellRes === "disabled" ? terminalHint() : shellRes);
      console.log(`[tg] shell 不可用且无 LLM 厂商，已回提示 chat=${m.chatId}`);
      return;
    }

    // 7) 意图解析 + 会话历史 + LLM 路由
    const intent = parseIntent(text);
    const history = await this.getHistory(m.chatId);
    let answer: string;
    let via = "-";
    try {
      const result = await this.runAgent(intent, history);
      answer = result.text;
      via = `${result.provider}/${result.model} ${result.latencyMs}ms`;
    } catch (e) {
      console.error("[agent]", e);
      answer = `所有模型都调用失败了：${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`;
    }

    await this.appendHistory(m.chatId, "user", text);
    await this.appendHistory(m.chatId, "assistant", answer);
    await this.incrBudget();

    // 8) 分段回包
    await this.reply(m.chatId, answer);
    console.log(`[tg] 已回复 chat=${m.chatId} via ${via}`);
  }

  // ---------------------------------------------------------------- Codespace 开发机

  private codespaceClient(): CodespaceClient | null {
    const pat = this.env.GH_CODESPACE_PAT;
    if (!pat) return null;
    const name = this.env.GH_CODESPACE_NAME || "24h-977gg5v9vcp5wq";
    return new CodespaceClient(pat, name);
  }

  /**
   * 验证词当开机口令用（用户 2026-10-27 定）：
   * 单独发验证词 = 开机；这是除 /boot 外唯一能启动机器的路径。
   *
   * 机器已在跑时只回一句确认，避免每次验证都多一条「已在运行中」的噪音；
   * 没配 PAT 时静默（验证本身仍算成功，不该因为开不了机而报错）。
   */
  private async bootOnPassword(chatId: string): Promise<void> {
    const client = this.codespaceClient();
    if (!client) return;
    let state: string | null = null;
    try {
      state = (await client.status()).state;
    } catch {
      // 查询失败就交给 beginBoot 去报错，比这里静默吞掉更清楚
    }
    if (state === "Available") {
      await this.reply(chatId, "开发机已在运行中 ✓ 直接发命令就行");
      return;
    }
    const r = await this.handleBootDev(chatId);
    if (r) await this.reply(chatId, r);
  }

  /**
   * 「开始开发」阶段 1：同步检查 + 触发启动 + 即时回复 + 启动看门狗。
   * 二查走 DO alarm 队列（30 秒后）。返回 null = 已回复（后续阶段自己发）。
   *
   * opts.then：开机成功后自动排 gemini_prep / buddy_prep（/gemini、/buddy 触发的开机走这条）。
   * opts.silent：调用方已经发过自己的「正在启动」文案，这里不再重复。
   */
  private async handleBootDev(
    chatId: string,
    opts: { then?: AiProvider; silent?: boolean } = {},
  ): Promise<string | null> {
    const client = this.codespaceClient();
    if (!client) return "未配置 GH_CODESPACE_PAT，无法操作开发机（wrangler secret put GH_CODESPACE_PAT）。";
    const p1 = await beginBoot(client);
    if (!opts.silent) await this.reply(chatId, p1.reply); // 先发即时回复（用户要求：立刻知道「正在启动」）
    if (p1.scheduleCheck) {
      await pushAlarm(this.alarmStore(), {
        due: Date.now() + BOOT_CHECK_DELAY_MS,
        kind: "boot_check",
        payload: { chat_id: chatId, attempt: 1, then: opts.then },
      });
      // 开机指令已发出：看门狗从现在起算（origin=bot，超时未互动可自动关）
      await this.ensureWatch(chatId, "bot");
    } else if (p1.wasAvailable) {
      // 本来就在跑：看门狗起点重置（你刚确认过要用）
      await this.ensureWatch(chatId, "bot");
      // 机器本来就开着（只是 shell 还没连上）：直接进「等通道」流程
      if (opts.then) {
        await pushAlarm(this.alarmStore(), {
          due: Date.now() + 5_000,
          kind: aiPrepKind(opts.then),
          payload: { chat_id: chatId, attempt: 1 },
        });
      }
    }
    return null;
  }

  /** alarm 回调：开机 30 秒后的二次确认（含看门狗续排）。 */
  private async onBootCheckAlarm(payload?: Record<string, unknown>): Promise<void> {
    // chat_id 优先从 alarm payload 取（唯一可靠来源）；storage 里的老 key 仅作兼容兜底。
    const fromPayload = typeof payload?.chat_id === "string" ? payload.chat_id : "";
    const chatId =
      fromPayload || ((await this.ctx.storage.get<string>("boot_check_chat")) ?? "") || null;
    const attempt = Number(payload?.attempt ?? 1);
    await this.ctx.storage.delete("boot_check_chat");
    const client = this.codespaceClient();
    if (!client) return;

    const final = await checkBoot(client);

    // 还在 Provisioning/Queued：静默重排，别用「开机失败」误报骚扰用户。
    if (final.pending) {
      if (attempt < BOOT_MAX_ATTEMPTS) {
        await pushAlarm(this.alarmStore(), {
          due: Date.now() + BOOT_RETRY_DELAY_MS,
          kind: "boot_check",
          // then 必须一路带下去：丢了它，/gemini 触发的开机就不会自动接上准备流程
          payload: { chat_id: chatId ?? "", attempt: attempt + 1, then: payload?.then },
        });
      } else if (chatId) {
        await this.reply(chatId, bootTimeoutReply());
      }
      return;
    }

    if (!chatId) {
      console.error("[cs] 开机二查缺 chat_id，无法回包");
      return;
    }
    await this.reply(chatId, final.reply);
    console.log(`[cs] 开机二查 chat=${chatId} attempt=${attempt} → ${final.reply.slice(0, 60)}`);
    if (final.ok) {
      // 开机成功：刷新 episode 起点（从「确认运行」起算），并排首次看门狗检查
      await this.ensureWatch(chatId, "bot");
      // /gemini、/buddy 触发的开机：接着等 shell 连上，再做环境准备
      if (payload?.then === "gemini" || payload?.then === "buddy") {
        await pushAlarm(this.alarmStore(), {
          due: Date.now() + 5_000,
          kind: aiPrepKind(payload.then as AiProvider),
          payload: { chat_id: chatId, attempt: 1 },
        });
      }
    }
  }

  private async handleStopDev(): Promise<string> {
    const client = this.codespaceClient();
    if (!client) return "未配置 GH_CODESPACE_PAT，无法操作开发机（wrangler secret put GH_CODESPACE_PAT）。";
    return stopCodespace(client);
  }

  private async handleDevStatus(): Promise<string> {
    const client = this.codespaceClient();
    if (!client) return "未配置 GH_CODESPACE_PAT，无法查询开发机状态。";
    try {
      const st = await client.status();
      // 状态查询 = 互动：机器在跑时刷新看门狗起点（你刚看过，说明在用）
      if (st.state === "Available") await this.ensureWatch(null, "bot");
      // 顺带报联机通道：用户看完「运行中」的下一句必然是「那我能发命令了吗」
      const shell = this.shell.online() ? "已连接 ✓ 可以直接发命令" : "未连接（开机后约 10~30 秒自动连上）";
      const s = this.shell.snapshot();
      // 有命令在跑时把进程状态一并报出来：这才是「到底在等 / 被挂起 / 已死」的答案
      const proc = s.agentRunning ? `\n当前命令：${this.shell.procLine()}` : "";
      return `开发机状态：${describeState(st.state)}\nshell 通道：${shell}${proc}`;
    } catch (e) {
      return `查询失败：${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
    }
  }

  /** 「用量」：本月累计运行时长（cs_runtime 表）+ 当前窗口状态。 */
  private async handleUsage(): Promise<string> {
    const budgetH = this.monthlyBudgetHours();
    const lines: string[] = [];
    // 今日 + 本月
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const todayMin = this.runtimeMinutes(today, today);
    const monthMin = this.runtimeMinutes(`${month}-01`, `${month}-31`);
    lines.push(`📊 开发机用量（本月 ${month}）`);
    lines.push(`累计运行：${fmtDur(monthMin)} / 免费额度 ${budgetH} 小时`);
    const pct = Math.min(100, Math.round((monthMin / 60 / budgetH) * 100));
    lines.push(`额度消耗：${pct}%${pct >= 80 ? " ⚠️ 接近上限" : ""}`);
    lines.push(`今日运行：${fmtDur(todayMin)}`);
    // 当前窗口
    const ep = await this.getEpisode();
    if (ep && ep.running) {
      lines.push(`当前窗口：运行中，已 ${fmtDur((Date.now() - ep.bootAt) / 60_000)}${ep.botStarted ? "" : "（非 bot 开机）"}`);
    } else {
      lines.push("当前窗口：关机中");
    }
    lines.push(`看门狗：${this.autostopEnabled() ? `${this.watchRemindMin()}/${this.watchAutostopMin()} 分钟 提醒/自动关` : "仅提醒（自动关未启用）"}`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- AI 会话（gemini / buddy）

  /**
   * 当前会话模式（按 chat 存）。开启后普通文本 = 问对应 CLI。
   *
   * 只存一个槽位（`ai_mode`）而不是两个布尔：两个 AI 同时“打开”在语义上是矛盾的
   * —— 普通文本要么给 Gemini 要么给 CodeBuddy。后来的覆盖先前的，用户不用记着
   * 先 off 再开。
   * 兼容老 key：v4.17 之前只有 `gem_mode`（布尔），读到时按 gemini 处理，
   * 免得升级后正在聊的会话突然「发文字变成 shell 命令」。
   */
  private async aiMode(chatId: string): Promise<AiProvider | null> {
    const m = await this.ctx.storage.get<string>(`ai_mode:${chatId}`);
    if (m === "gemini" || m === "buddy") return m;
    return (await this.ctx.storage.get<boolean>(`gem_mode:${chatId}`)) === true ? "gemini" : null;
  }

  private async setAiMode(chatId: string, mode: AiProvider | null): Promise<void> {
    if (mode) await this.ctx.storage.put(`ai_mode:${chatId}`, mode);
    else await this.ctx.storage.delete(`ai_mode:${chatId}`);
    // 老 key 一并清掉：否则 ai_mode 删了之后 gem_mode=true 会把模式“复活”
    await this.ctx.storage.delete(`gem_mode:${chatId}`);
  }

  /** 兼容旧调用点（原先只有 gemini 一个 provider）。 */
  private async geminiModeOn(chatId: string): Promise<boolean> {
    return (await this.aiMode(chatId)) === "gemini";
  }

  private async buddyModeOn(chatId: string): Promise<boolean> {
    return (await this.aiMode(chatId)) === "buddy";
  }

  private async setGeminiMode(chatId: string, on: boolean): Promise<void> {
    await this.setAiMode(chatId, on ? "gemini" : null);
  }

  private async setBuddyMode(chatId: string, on: boolean): Promise<void> {
    await this.setAiMode(chatId, on ? "buddy" : null);
  }

  private async geminiModel(chatId: string): Promise<string | undefined> {
    return await this.ctx.storage.get<string>(`gem_model:${chatId}`);
  }

  /**
   * 用户是否钉死了模型（`/gemini model <名字>`）。空串 = 自动，按免费链尝试。
   * 钉死时不自动切换：用户显式指定就该照办，否则「我明明指定了 X」会变成谜题。
   */
  private async geminiPin(chatId: string): Promise<string> {
    return (await this.geminiModel(chatId))?.trim() ?? "";
  }

  /**
   * 免费模型链（尝试顺序）：
   *   `GEMINI_MODELS`（逗号/空格分隔）> 代码里的默认链；
   *   `GEMINI_MODEL` 作为链头保留兼容（老配置只写了一个模型）。
   * 配额是按模型分桶的，所以链上放多个不同型号才有意义——见 gemini.ts 的实测记录。
   */
  private geminiChain(): string[] {
    const list = parseModelChain(this.env.GEMINI_MODELS);
    const head = this.env.GEMINI_MODEL?.trim();
    if (head && !list.includes(head)) return [head, ...list];
    return list;
  }

  /**
   * 暂存「机器还没起来时你问的那句」：等 shell 连上再补发。
   * 10 分钟保鲜——半小时前的提问早就没意义了，补发反而是骚扰。
   */
  private async rememberGeminiPrompt(chatId: string, prompt: string): Promise<void> {
    await this.ctx.storage.put(`gem_pending:${chatId}`, { prompt, at: Date.now() });
  }

  private async takeGeminiPrompt(chatId: string): Promise<string | null> {
    const key = `gem_pending:${chatId}`;
    const p = await this.ctx.storage.get<{ prompt: string; at: number }>(key);
    if (p === undefined) return null;
    await this.ctx.storage.delete(key);
    return Date.now() - p.at <= 10 * 60_000 ? p.prompt : null;
  }

  // ---------------------------------------------------------------- CodeBuddy 会话

  private async buddyModel(chatId: string): Promise<string | undefined> {
    return await this.ctx.storage.get<string>(`buddy_model:${chatId}`);
  }

  /** 用户是否钉死了模型（`/buddy model <名字>`）。空串 = 用 CLI 默认。 */
  private async buddyPin(chatId: string): Promise<string> {
    return (await this.buddyModel(chatId))?.trim() ?? "";
  }

  /** 同 gemini 的待发提问暂存，独立 key：两个 provider 各留各的，互不踩。 */
  private async rememberBuddyPrompt(chatId: string, prompt: string): Promise<void> {
    await this.ctx.storage.put(`buddy_pending:${chatId}`, { prompt, at: Date.now() });
  }

  private async takeBuddyPrompt(chatId: string): Promise<string | null> {
    const key = `buddy_pending:${chatId}`;
    const p = await this.ctx.storage.get<{ prompt: string; at: number }>(key);
    if (p === undefined) return null;
    await this.ctx.storage.delete(key);
    return Date.now() - p.at <= 10 * 60_000 ? p.prompt : null;
  }

  private async enqueueBuddy(chatId: string, script: string, label: string): Promise<void> {
    const res = this.shell.enqueue(chatId, script, { label, hideCwd: true });
    if (res.ok) return;
    await this.reply(chatId, res.message ?? "shell 通道不可用。");
  }

  /** /buddy 的全部子命令在此分派（与 /gemini 一一对应）。 */
  private async handleBuddy(chatId: string, args: string, messageId: number | null): Promise<void> {
    const act = parseBuddyArgs(args);
    switch (act.kind) {
      case "help":
        await this.reply(chatId, renderCommandHelp("buddy") ?? "");
        return;
      case "off": {
        // 只在当前确实是 buddy 时才真的退出：否则「/buddy off」会把正在跑的
        // Gemini 会话也关掉，用户会以为 Gemini 自己断了。
        if (!(await this.buddyModeOn(chatId))) {
          const cur = await this.aiMode(chatId);
          await this.reply(
            chatId,
            cur === "gemini"
              ? "当前是 Gemini 会话模式（/gemini off 退出）。"
              : "现在没开会话模式，发文字 = 直接执行 shell 命令。",
          );
          return;
        }
        await this.setBuddyMode(chatId, false);
        await this.ctx.storage.delete(`buddy_pending:${chatId}`);
        await this.reply(
          chatId,
          "🧩 已退出 CodeBuddy 会话模式。之后发文字 = 直接在开发机执行命令；想再聊发 /buddy。",
        );
        return;
      }
      case "model": {
        const m = act.model.trim();
        if (m === "auto") {
          await this.ctx.storage.delete(`buddy_model:${chatId}`);
          await this.reply(chatId, "🧩 已回到 CLI 默认模型（/buddy models 看可选清单）。");
          return;
        }
        if (!sanitizeModel(m)) {
          await this.reply(
            chatId,
            `模型名不合法：${m}\n用法：/buddy model deepseek-v4.1-flash（或 auto 回到默认）\n看清单：/buddy models`,
          );
          return;
        }
        await this.ctx.storage.put(`buddy_model:${chatId}`, m);
        await this.reply(chatId, `🧩 已固定 ${m}（/buddy model auto 回到默认）`);
        return;
      }
      case "models":
        await this.enqueueBuddy(chatId, buildBuddyModelsScript(), "📚 buddy models");
        return;
      case "new":
        await this.enqueueBuddy(chatId, buildBuddyNewSessionScript(), "🆕 新会话");
        return;
      case "status":
        await this.enqueueBuddy(chatId, buildBuddyStatusScript(await this.buddyPin(chatId)), "🔍 buddy status");
        return;
      case "ask":
        await this.startBuddy(chatId, act.prompt);
        return;
      case "open":
        await this.setBuddyMode(chatId, true);
        await this.startBuddy(chatId);
        return;
    }
  }

  /**
   * 打开 / 提问的公共入口，结构与 startGemini 完全一致（三态：在线 / 没开机 / 在跑但通道没连）。
   * 唯一区别是「准备什么脚本」以及不需要查 key（CodeBuddy 用 OAuth 登录态）。
   */
  private async startBuddy(chatId: string, prompt?: string): Promise<void> {
    const modeHint = prompt
      ? null
      : `🧩 CodeBuddy 模式已开：直接发问题即可（目录 ${BUDDY_DIR}，/buddy off 退出，行首 ! 仍执行 shell）`;

    if (this.shell.online()) {
      const model = await this.buddyPin(chatId);
      const res = this.shell.enqueue(chatId, buildBuddyScript({ prompt, model }), {
        label: prompt ? `🧩 ${previewPrompt(prompt)}` : "🛠 准备 CodeBuddy 环境",
        hideCwd: true,
      });
      if (modeHint) await this.reply(chatId, modeHint);
      if (!res.ok) await this.reply(chatId, res.message ?? "下发失败，稍后再试。");
      return;
    }

    const client = this.codespaceClient();
    if (!client) {
      await this.reply(chatId, "未配置 GH_CODESPACE_PAT，无法操作开发机（wrangler secret put GH_CODESPACE_PAT）。");
      return;
    }
    if (modeHint) await this.reply(chatId, modeHint);

    let state: CodespaceState | null = null;
    try {
      state = (await client.status()).state;
    } catch {
      /* 查不动就按「没开」处理，交给 beginBoot 报错 */
    }
    if (state && state !== "Available") {
      await this.reply(
        chatId,
        `🖥 开发机没开（${describeState(state)}），正在启动…\n起来后我会自动接上它、准备好 CodeBuddy，然后${prompt ? "把你的问题发过去" : "告诉你一声"}。`,
      );
      if (prompt) await this.rememberBuddyPrompt(chatId, prompt);
      await this.handleBootDev(chatId, { then: "buddy", silent: true });
      return;
    }

    await this.reply(
      chatId,
      `⏳ 机器在跑，但 shell 通道还没连上（开机后约 10~30 秒）。\n连上我就${prompt ? "把这条问题发过去" : "开始准备 CodeBuddy 环境"}。`,
    );
    if (prompt) await this.rememberBuddyPrompt(chatId, prompt);
    await pushAlarm(this.alarmStore(), {
      due: Date.now() + 10_000,
      kind: "buddy_prep",
      payload: { chat_id: chatId, attempt: 1 },
    });
  }

  /** /gemini 的全部子命令在此分派。 */
  private async handleGemini(chatId: string, args: string, messageId: number | null): Promise<void> {
    const act = parseGeminiArgs(args);
    switch (act.kind) {
      case "help":
        await this.reply(chatId, renderCommandHelp("gemini") ?? "");
        return;
      case "off":
        // 对称保护：当前开的是 CodeBuddy 模式时，/gemini off 不该把它一起关掉
        if (!(await this.geminiModeOn(chatId))) {
          const cur = await this.aiMode(chatId);
          await this.reply(
            chatId,
            cur === "buddy"
              ? "当前是 CodeBuddy 会话模式（/buddy off 退出）。"
              : "现在没开会话模式，发文字 = 直接执行 shell 命令。",
          );
          return;
        }
        await this.setGeminiMode(chatId, false);
        await this.ctx.storage.delete(`gem_pending:${chatId}`);
        await this.reply(
          chatId,
          "🤖 已退出 Gemini 会话模式。之后发文字 = 直接在开发机执行命令；想再聊发 /gemini。",
        );
        return;
      case "model": {
        const m = act.model.trim();
        if (m === "auto") {
          await this.ctx.storage.delete(`gem_model:${chatId}`);
          await this.reply(
            chatId,
            `🤖 已回到自动：按免费链依次尝试，某个模型配额用尽会自己换下一个。\n链：${this.geminiChain().join(" → ")}`,
          );
          return;
        }
        if (!sanitizeModel(m)) {
          await this.reply(
            chatId,
            `模型名不合法：${m}\n用法：/gemini model gemini-3.6-flash（或 auto 回到自动链）\n看可用清单：/gemini models`,
          );
          return;
        }
        await this.ctx.storage.put(`gem_model:${chatId}`, m);
        await this.reply(chatId, `🤖 已固定 ${m}（固定后不自动切换；/gemini model auto 回到链）`);
        return;
      }
      case "models":
        await this.enqueueGemini(chatId, buildModelsScript(this.geminiChain()), "📚 模型清单");
        return;
      case "new":
        await this.enqueueGemini(chatId, buildNewSessionScript(), "🆕 新会话");
        return;
      case "status":
        await this.enqueueGemini(
          chatId,
          buildStatusScript(await this.geminiPin(chatId), this.geminiChain()),
          "🔍 gemini status",
        );
        return;
      case "ask":
        // 一次性提问不动模式开关：在会话里临时问一句不该把你踢出会话
        await this.startGemini(chatId, act.prompt);
        return;
      case "open":
        await this.setGeminiMode(chatId, true);
        await this.startGemini(chatId);
        return;
    }
  }

  /** 简单脚本（status / new）：通道不在线就别假装成功。 */
  private async enqueueGemini(chatId: string, script: string, label: string): Promise<void> {
    const res = this.shell.enqueue(chatId, script, { label, hideCwd: true });
    if (res.ok) return;
    await this.reply(chatId, res.message ?? "shell 通道不可用。");
  }

  /**
   * 打开 / 提问的公共入口：能跑就跑，跑不了就「开机 → 等通道 → 再跑」。
   * 必须分三种情况，因为处置完全不同：
   *   ① 通道在线     → 直接下发（脚本自带「装 CLI + 查 key」的前置步骤）
   *   ② 机器没开     → 开机，成功后由 gemini_prep alarm 接手
   *   ③ 机器在跑但通道没连 → 等 10~30 秒（agent 正连上来），gemini_prep 轮询重试
   */
  private async startGemini(chatId: string, prompt?: string): Promise<void> {
    const modeHint = prompt ? null : "🤖 Gemini 模式已开：直接发问题即可（/gemini off 退出，行首 ! 仍执行 shell）";

    if (this.shell.online()) {
      const model = await this.geminiPin(chatId);
      const res = this.shell.enqueue(chatId, buildGeminiScript({ prompt, model, chain: this.geminiChain() }), {
        label: prompt ? `🤖 ${previewPrompt(prompt)}` : "🛠 准备 Gemini 环境",
        hideCwd: true,
      });
      if (modeHint) await this.reply(chatId, modeHint);
      if (!res.ok) await this.reply(chatId, res.message ?? "下发失败，稍后再试。");
      return;
    }

    const client = this.codespaceClient();
    if (!client) {
      await this.reply(chatId, "未配置 GH_CODESPACE_PAT，无法操作开发机（wrangler secret put GH_CODESPACE_PAT）。");
      return;
    }
    if (modeHint) await this.reply(chatId, modeHint);

    let state: CodespaceState | null = null;
    try {
      state = (await client.status()).state;
    } catch {
      /* 查不动就按「没开」处理，交给 beginBoot 报错 */
    }
    if (state && state !== "Available") {
      // 这里**不要**再提「首次要装 CLI，约 1 分钟」：
      // 那是写死的文案，每开一次机就喊一遍，而 CLI 早就装在持久卷上了——
      // 属于「每次都吓一次」的假提醒。真实安装提示由脚本在*真正安装时*打
      // （buildGeminiScript 里的「⏳ 首次运行，正在安装…」），只在那一刻出现。
      await this.reply(
        chatId,
        `🖥 开发机没开（${describeState(state)}），正在启动…\n起来后我会自动接上它、准备好 Gemini，然后${prompt ? "把你的问题发过去" : "告诉你一声"}。`,
      );
      if (prompt) await this.rememberGeminiPrompt(chatId, prompt);
      await this.handleBootDev(chatId, { then: "gemini", silent: true });
      return;
    }

    await this.reply(
      chatId,
      `⏳ 机器在跑，但 shell 通道还没连上（开机后约 10~30 秒）。\n连上我就${prompt ? "把这条问题发过去" : "开始准备 Gemini 环境"}。`,
    );
    if (prompt) await this.rememberGeminiPrompt(chatId, prompt);
    await pushAlarm(this.alarmStore(), {
      due: Date.now() + 10_000,
      kind: "gemini_prep",
      payload: { chat_id: chatId, attempt: 1 },
    });
  }

  /**
   * alarm：等 shell 连上后下发对应的 AI 脚本（开机成功 / 通道未连都走这里）。
   * gemini 与 buddy 只差「取哪份待发提问 + 生成哪个脚本」，等待与重试逻辑完全共用。
   */
  private async onAiPrepAlarm(provider: AiProvider, payload?: Record<string, unknown>): Promise<void> {
    const chatId = typeof payload?.chat_id === "string" ? payload.chat_id : "";
    if (!chatId) return;
    const attempt = Number(payload?.attempt ?? 1);
    const client = this.codespaceClient();
    if (!client) return;
    const cmd = provider === "buddy" ? "/buddy" : "/gemini";

    let state: CodespaceState | null = null;
    try {
      state = (await client.status()).state;
    } catch {
      /* 网络抖动：当作「还没好」，继续等 */
    }
    if (state && state !== "Available") {
      if (attempt < 30) {
        await pushAlarm(this.alarmStore(), {
          due: Date.now() + 10_000,
          kind: aiPrepKind(provider),
          payload: { chat_id: chatId, attempt: attempt + 1 },
        });
      } else {
        await this.reply(chatId, `开发机一直没起来，先发 /cs 看看状态，或稍后再发 ${cmd}。`);
      }
      return;
    }
    if (!this.shell.online()) {
      if (attempt < 30) {
        // 60 秒还没连上就打个招呼：之前这段时间一个字都没有，用户只能干等 5 分钟，
        // 分不清「正在等」和「已经卡死」——2026-10-28 20:16 那次就是这么卡住的。
        if (attempt === 6) {
          await this.reply(
            chatId,
            "⏳ 机器起来了，但开发机里的 shell agent 还没连上（正常 10~30 秒）。\n" +
              "我继续等，最多再等 4 分钟；一直不通就在 codespace 终端跑一句：\n" +
              "bash .devcontainer/post-start.sh",
          );
        }
        await pushAlarm(this.alarmStore(), {
          due: Date.now() + 10_000,
          kind: aiPrepKind(provider),
          payload: { chat_id: chatId, attempt: attempt + 1 },
        });
      } else {
        await this.reply(
          chatId,
          "机器起来了，但 shell 通道 5 分钟没连上。\n" +
            "在 codespace 终端跑一句 bash .devcontainer/post-start.sh，然后重发 " +
            `${cmd}；也可以发 /cs 看状态。`,
        );
      }
      return;
    }

    if (provider === "buddy") {
      const prompt = await this.takeBuddyPrompt(chatId);
      const model = await this.buddyPin(chatId);
      const res = this.shell.enqueue(chatId, buildBuddyScript({ prompt: prompt ?? undefined, model }), {
        label: prompt ? `🧩 ${previewPrompt(prompt)}` : "🛠 准备 CodeBuddy 环境",
        hideCwd: true,
      });
      if (!res.ok) await this.reply(chatId, res.message ?? "下发失败，稍后再试。");
      return;
    }

    const prompt = await this.takeGeminiPrompt(chatId);
    const model = await this.geminiPin(chatId);
    const res = this.shell.enqueue(chatId, buildGeminiScript({ prompt: prompt ?? undefined, model, chain: this.geminiChain() }), {
      label: prompt ? `🤖 ${previewPrompt(prompt)}` : "🛠 准备 Gemini 环境",
      hideCwd: true,
    });
    if (!res.ok) await this.reply(chatId, res.message ?? "下发失败，稍后再试。");
  }

  /** 兼容入口：v4.17 之前入队的 alarm 里 kind 只有 gemini_prep，这里保持同名壳子。 */
  private async onGeminiPrepAlarm(payload?: Record<string, unknown>): Promise<void> {
    await this.onAiPrepAlarm("gemini", payload);
  }

  // ---------------------------------------------------------------- 看门狗（省额度）

  /** alarm 队列存储适配器（DO ctx.storage 的最小投影）。 */
  private alarmStore(): AlarmStore {
    const s = this.ctx.storage;
    return {
      get: <T>(k: string) => s.get<T>(k),
      put: (k: string, v: unknown) => s.put(k, v),
      delete: async (k: string) => {
        await s.delete(k);
      },
      setAlarm: async (t: number | null) => {
        if (t === null) await s.deleteAlarm();
        else await s.setAlarm(t);
      },
    };
  }

  /** 读取当前运行窗口状态。 */
  private async getEpisode(): Promise<Episode | null> {
    return (await this.ctx.storage.get<Episode>("cs_episode")) ?? null;
  }

  private async setEpisode(ep: Episode | null): Promise<void> {
    if (ep) await this.ctx.storage.put("cs_episode", ep);
    else await this.ctx.storage.delete("cs_episode");
  }

  /**
   * 开启/刷新看门狗窗口。origin：
   *   bot      = 你通过指令开机/查状态（允许自动关机）
   *   observed = 巡检发现机器在跑（只提醒）
   */
  private async ensureWatch(chatId: string | null, origin: "bot" | "observed"): Promise<void> {
    const prev = await this.getEpisode();
    const now = Date.now();
    const chat = chatId ?? prev?.chatId ?? null;
    const ep: Episode = {
      running: true,
      bootAt: prev?.running ? prev.bootAt : now, // 已在跑则保留原起点
      lastActivity: now,
      botStarted: origin === "bot" ? true : (prev?.botStarted ?? false),
      reminded: false,
      chatId: chat,
      ghFreshSince: null, // 新窗口：GH 追踪重置
      capNotified: false,
      capNotifiedAt: null,
    };
    await this.setEpisode(ep);
    if (chat) await this.putChatId(chat);
    await pushAlarm(this.alarmStore(), {
      due: now + this.watchRemindMin() * 60_000,
      kind: "watch",
    });
  }

  /** 互动刷新。terminal=true（终端/开发机相关消息）才续命；纯聊天只记 chat_id 不续命。 */
  private async touchWatchActivity(chatId: string, terminal: boolean): Promise<void> {
    await this.putChatId(chatId);
    const ep = await this.getEpisode();
    if (!ep || !ep.running) return; // 机器没跑：无需管理
    if (!terminal) return; // 纯聊天：不续命
    ep.lastActivity = Date.now();
    ep.reminded = false; // 你出现了：提醒状态复位（下次空闲重新提醒）
    // 第三信号一并清零：宽限倒计时取消，GH「持续活跃」重新计时
    ep.ghFreshSince = null;
    ep.capNotified = false;
    ep.capNotifiedAt = null;
    await this.setEpisode(ep);
    await pushAlarm(this.alarmStore(), {
      due: ep.lastActivity + this.watchRemindMin() * 60_000,
      kind: "watch",
    });
  }

  /** 关闭窗口（停止开发后调用）：落账运行时长、清 episode、撤看门狗 alarm。 */
  private async closeEpisode(): Promise<void> {
    const ep = await this.getEpisode();
    if (!ep) return;
    if (ep.running) {
      const now = Date.now();
      const day = new Date().toISOString().slice(0, 10);
      this.addRuntimeDay(day, Math.max(0, (now - ep.bootAt) / 60_000));
    }
    await this.setEpisode(null);
    // 从队列撤掉 watch 任务（boot_check 若有则保留）
    const q = (await this.ctx.storage.get<AlarmTask[]>("alarmq")) ?? [];
    const kept = q.filter((t) => t.kind !== "watch");
    if (kept.length > 0) {
      await this.ctx.storage.put("alarmq", kept);
      await this.ctx.storage.setAlarm(kept[0].due);
    } else {
      await this.ctx.storage.delete("alarmq");
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** alarm 回调：看门狗检查。 */
  private async onWatchAlarm(): Promise<void> {
    await this.runWatchCheck();
  }

  /** 看门狗核心执行：查状态（含 last_used_at）→ evalWatch → 提醒/自动关机 → 续排。 */
  private async runWatchCheck(): Promise<{ acted: boolean; note: string }> {
    const client = this.codespaceClient();
    const ep = await this.getEpisode();
    if (!client || !ep || !ep.running) return { acted: false, note: "no-episode" };
    let running: boolean;
    let ghLastUsedAt: number | null = null;
    try {
      const st = await client.status();
      running = st.state === "Available";
      ghLastUsedAt = st.lastUsedAt ? Date.parse(st.lastUsedAt) : null;
      if (Number.isNaN(ghLastUsedAt as number)) ghLastUsedAt = null;
    } catch (e) {
      // 状态查询失败（GitHub 抖动）：5 分钟后重试，不误判
      console.error("[watch] 状态查询失败", e);
      await pushAlarm(this.alarmStore(), { due: Date.now() + 5 * 60_000, kind: "watch" });
      return { acted: false, note: "status-error-retry" };
    }
    const decision = evalWatch({
      running,
      now: Date.now(),
      lastActivity: ep.lastActivity,
      bootAt: ep.bootAt,
      botStarted: ep.botStarted,
      remindMin: this.watchRemindMin(),
      autostopMin: this.watchAutostopMin(),
      autostopEnabled: this.autostopEnabled(),
      reminded: ep.reminded,
      ghLastUsedAt,
      ghFreshSince: ep.ghFreshSince,
      capNotified: ep.capNotified,
      capNotifiedAt: ep.capNotifiedAt,
      ghCapMin: this.ghCapMin(),
      ghCapAction: this.ghCapAction(),
      graceMin: this.watchGraceMin(),
      // 开发机上有命令在跑 = 正在用（长任务期间 Telegram 可能一条消息都没有）
      busy: this.shell.snapshot().agentRunning !== null,
    });
    // 写回第三信号追踪状态（ghFreshSince/capNotified/capNotifiedAt）
    ep.ghFreshSince = decision.ghFreshSince;
    ep.capNotified = decision.capNotified;
    ep.capNotifiedAt = decision.capNotifiedAt;
    const chat = ep.chatId ?? (await this.getChatId());
    if (decision.markReminded) {
      ep.reminded = true;
    }
    await this.setEpisode(ep);
    if (decision.stop) {
      try {
        await client.stop();
      } catch (e) {
        console.error("[watch] 自动关机失败", e);
        if (chat) await this.reply(chat, `⚠️ 看门狗自动关机失败：${e instanceof Error ? e.message.slice(0, 100) : "未知错误"}。稍后重试。`);
        await pushAlarm(this.alarmStore(), { due: Date.now() + 5 * 60_000, kind: "watch" });
        return { acted: false, note: "stop-failed-retry" };
      }
      // 落账 + 清窗口
      await this.closeEpisode();
      if (chat) await this.reply(chat, decision.notify ?? "已自动关机。");
      console.log("[watch] 自动关机完成");
      return { acted: true, note: "stopped" };
    }
    if (decision.notify && chat) {
      await this.reply(chat, decision.notify);
    }
    if (!running) {
      // 机器其实已经关了（GitHub 空闲超时先到）：落账清窗口
      await this.closeEpisode();
      return { acted: true, note: "already-off" };
    }
    if (decision.nextCheck) {
      await pushAlarm(this.alarmStore(), { due: decision.nextCheck, kind: "watch" });
    }
    return { acted: decision.notify !== null, note: decision.stop ? "stopped" : "ok" };
  }

  /**
   * 巡检（cron 每 30 分钟 + /patrol 手动）：
   * 弥补 alarm 只在「有 episode」时存在的盲区——机器在跑但 DO 无记录
   * （比如你直接从 VS Code/GitHub 网页开机，bot 不知道）。
   */
  private async patrol(): Promise<Record<string, unknown>> {
    const client = this.codespaceClient();
    if (!client) return { ok: false, error: "GH_CODESPACE_PAT 未配置" };
    // 顺手清掉卡死的 shell 命令（agent 崩了 / 命令永不返回）
    const reaped = this.shell.reapStale();
    if (reaped > 0) console.log(`[shell] 巡检清理僵尸命令 ${reaped} 条`);
    let state: string;
    try {
      state = (await client.status()).state;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // shell 离线告警：机器在跑但 agent 没连上 → 主动发 Telegram（否则只能你自己发现）。
    // 兜住异常：告警是「旁路」功能，绝不能因为它出错而毁掉巡检本身（看门狗也走这条路径）。
    let sa: { shellAlert: string | null } = { shellAlert: null };
    try {
      sa = await this.checkShellAlert(state === "Available");
    } catch (e) {
      console.error("[shell-alert] 检查失败（不影响巡检其它逻辑）", e);
      sa = { shellAlert: "error" };
    }
    const ep = await this.getEpisode();
    if (state === "Available") {
      if (!ep || !ep.running) {
        // 发现漏网运行：建 observed 窗口（只提醒，不自动关）
        await this.ensureWatch(null, "observed");
        const chat = await this.getChatId();
        if (chat) {
          await this.reply(chat, `👀 巡检发现开发机在运行（不是我开的）。不用了发 /halt，或在 GitHub 页面关机。`);
        }
        return { ok: true, state, note: "observed-new", ...sa };
      }
      // 有窗口：借巡检跑一次看门狗检查（双重保险，alarm 丢了这个也兜底）
      const r = await this.runWatchCheck();
      return { ok: true, state, ...r, ...sa };
    }
    // 机器没跑：若有残留 episode，落账清掉
    if (ep?.running) {
      await this.closeEpisode();
      return { ok: true, state, note: "episode-closed", ...sa };
    }
    return { ok: true, state, note: "idle", ...sa };
  }

  // ---------------------------------------------------------------- shell 离线告警

  /**
   * shell 离线告警状态（跨巡检持久化于 DO storage）。
   *
   * 为什么要持久化：shell 的心跳时刻是 DO 内存里的，DO 一被驱逐/重载就归零，
   * 而「离线起点」必须跨巡检记住，否则每次巡检都当成刚断线，宽限期永远走不完。
   */
  private async checkShellAlert(machineRunning: boolean): Promise<{ shellAlert: string | null }> {
    if (!this.shellAlertEnabled()) return { shellAlert: null };
    const key = "shell_alert";
    const prev =
      (await this.ctx.storage.get<Omit<ShellAlertDecision, "notify">>(key)) ??
      { offlineSince: null, alerted: false, alertedAt: null };
    const d = evalShellAlert({
      machineRunning,
      shellOnline: this.shell.online(),
      now: Date.now(),
      lastSeen: this.shell.seenAt(),
      offlineSince: prev.offlineSince,
      alerted: prev.alerted,
      alertedAt: prev.alertedAt,
      graceMin: this.shellAlertGraceMin(),
      repeatMin: this.shellAlertRepeatMin(),
    });
    await this.ctx.storage.put(key, {
      offlineSince: d.offlineSince,
      alerted: d.alerted,
      alertedAt: d.alertedAt,
    });
    if (!d.notify) return { shellAlert: null };
    const chat = await this.getChatId();
    if (!chat) {
      console.warn("[shell-alert] 无 chat_id，告警发不出去");
      return { shellAlert: "no-chat" };
    }
    await this.reply(chat, d.notify);
    console.log(`[shell-alert] 已告警（机器运行=${machineRunning}）`);
    return { shellAlert: "alerted" };
  }

  /** 离线告警开关（var CS_SHELL_ALERT，默认开） */
  private shellAlertEnabled(): boolean {
    return (this.env.CS_SHELL_ALERT ?? "1") !== "0";
  }
  /** 断线宽限（分钟，默认 5）：躲开 DO 重载 / agent 重启的瞬断 */
  private shellAlertGraceMin(): number {
    const v = Number(this.env.CS_SHELL_ALERT_GRACE_MIN ?? 5);
    return Number.isFinite(v) && v > 0 ? v : 5;
  }
  /** 持续离线时的重复告警间隔（分钟，默认 120；0 = 只告一次） */
  private shellAlertRepeatMin(): number {
    const v = Number(this.env.CS_SHELL_ALERT_REPEAT_MIN ?? 120);
    return Number.isFinite(v) && v >= 0 ? v : 120;
  }

  // ---------------------------------------------------------------- 运行时长账本

  /** 按日累计运行分钟（cs_runtime 表）。 */
  private addRuntimeDay(day: string, minutes: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO cs_runtime (day, minutes) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET minutes = minutes + ?",
      day,
      minutes,
      minutes,
    );
    this.ctx.storage.sql.exec("DELETE FROM cs_runtime WHERE day < ?", day.slice(0, 4) + "-01-01"); // 保留当年
  }

  /** 查询日期范围内的累计运行分钟。 */
  private runtimeMinutes(fromDay: string, toDay: string): number {
    const rows = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COALESCE(SUM(minutes), 0) AS total FROM cs_runtime WHERE day >= ? AND day <= ?",
      fromDay,
      toDay,
    ).toArray();
    return Math.round(rows[0]?.total ?? 0);
  }

  // ---------------------------------------------------------------- chat_id 记忆

  /** 记住最近的聊天对象（patrol/看门狗主动推送目标）。 */
  private async putChatId(chatId: string): Promise<void> {
    await this.ctx.storage.put("last_chat_id", chatId);
  }

  private async getChatId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("last_chat_id")) ?? null;
  }

  private async runAgent(intent: Intent, history: { role: string; content: string }[]): Promise<ChatResult> {
    const providers = loadProviders(this.env);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-this.maxTurns() * 2),
      { role: "user", content: intent.prompt },
    ];
    const chain = intent.chain.length > 0 ? intent.chain : [this.defaultProvider(intent)];
    const effort = effortFor(intent);
    // 旗舰档（high 思考）值得等，给足 120s；其余 45s 快速失败 → 降级 fast 模型
    const timeoutMs = effort === "high" ? 120_000 : 45_000;
    // 闲聊且没点名厂商 → 首选 flash-lite（默认不思考，实测 ~3s）。
    // 3.8-flash 不收 minimal（直接 400），所以闲聊不能把它放主路；
    // 降级路径上若落到 3.7/3.8 Flash，clampEffort 会自动把 minimal 兜底成 low。
    const preferFast =
      intent.taskType === "chat" && intent.modelTier !== "flagship" && intent.chain.length === 0;
    return chatChain(providers, chain, {
      messages,
      tier: intent.modelTier,
      maxTokens: Number(this.env.MAX_OUTPUT_TOKENS ?? 4096),
      reasoningEffort: effort,
      timeoutMs,
      preferFastModel: preferFast,
    });
  }

  private defaultProvider(intent: Intent): string {
    return intent.taskType === "code"
      ? this.env.DEFAULT_CODING_PROVIDER || "gemini"
      : this.env.DEFAULT_CHAT_PROVIDER || "gemini";
  }

  /** 下载 Telegram 语音文件并转写为文字。 */
  private async transcribeVoice(fileId: string, mime: string | null): Promise<string> {
    if (!this.env.STT_BASE_URL || !this.env.STT_API_KEY) {
      console.log("[tg] 语音消息但未配置 STT_BASE_URL/STT_API_KEY");
      return "";
    }
    try {
      const file = await this.tg.getFile(fileId);
      if (!file.file_path) return "";
      const audio = await fetch(this.tg.fileUrl(file.file_path), { signal: AbortSignal.timeout(30_000) });
      if (!audio.ok) return "";
      const buf = await audio.arrayBuffer();
      return await transcribeBytes(buf, mime ?? "audio/ogg", this.env);
    } catch (e) {
      console.error("[tg] 语音转写失败", e);
      return "";
    }
  }

  /** 分段发送（长回答拆成多条，手表端更好读）。 */
  private async reply(chatId: string, text: string): Promise<void> {
    const chunks = chunkText(text, Number(this.env.REPLY_CHUNK_SIZE ?? 800));
    for (const chunk of chunks) {
      await this.tg.sendMessage(chatId, chunk);
    }
  }

  // ---------------------------------------------------------------- Shell 通道

  /**
   * agent 请求的统一鉴权闸门。通过返回 null，否则返回该直接回给 agent 的响应。
   *
   * 三道关：
   *   ① 封禁表 —— 同一 IP 10 分钟内撞 8 次 401 就静默 10 分钟（防暴力试探密钥）；
   *   ② HMAC 签名 —— 密钥不上行文、带时间窗、带 nonce（见 src/agent-auth.ts）；
   *   ③ 按 id 选密钥 —— X-Agent-Id 决定用哪把密钥（每台机器独立）；未知 id 或已
   *      吊销 id 在 agentKeyFor 里就返回 undefined，签名根本不会验（防「一把密钥
   *      泄漏后所有机器跟着沦陷」，以及「冒充别人的机器 id 但没那把密钥」）。
   *
   * fail-closed：AGENT_KEYS 未配且 AGENT_KEY 也未配时，agentKeyFor 对所有 id 都返回
   * undefined → 一律 401，不存在「没配就放行」的分支。
   */
  private async guardAgent(request: Request, bodyText: string, path: string): Promise<Response | null> {
    await this.ensureAgentOverrides(); // 加载运行期密钥覆盖（含即时吊销）
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();
    const rec = this.authFails.get(ip);
    if (rec && rec.until > now) {
      return Response.json(
        { ok: false, error: "too many attempts" },
        { status: 429, headers: { "Retry-After": String(Math.ceil((rec.until - now) / 1000)) } },
      );
    }

    const r = await verifyAgentRequest({
      agentKeyFor: (id) => this.agentKeyFor(id),
      legacyKey: this.env.AGENT_KEY,
      legacyAllowed: this.env.AGENT_LEGACY_KEY === "1",
      headers: request.headers,
      method: request.method,
      path,
      bodyText,
      nonces: this.nonces,
    });

    if (!r.ok) {
      this.noteAuthFail(ip, r.reason);
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    this.authFails.delete(ip);
    this.agentId = request.headers.get("X-Agent-Id") ?? "";
    this.lastAuth = { mode: r.mode, at: now, id: this.agentId };
    return null;
  }

  // ---------------------------------------------------------------- 机器密钥解析

  /** 解析 AGENT_KEYS 静态注册表（构造时解析一次后缓存）。 */
  private agentKeysMap(): Map<string, string> | null {
    if (this.agentKeysMapCache === undefined) this.agentKeysMapCache = parseAgentKeys(this.env.AGENT_KEYS);
    return this.agentKeysMapCache;
  }

  /** 懒加载运行期密钥覆盖（DO storage 的 agent_keys 表）。加载一次后常驻内存。 */
  private async ensureAgentOverrides(): Promise<void> {
    if (this.agentOverridesLoaded) return;
    try {
      const rows = this.ctx.storage.sql.exec<{ agent_id: string; agent_key: string | null; revoked: number }>(
        "SELECT agent_id, agent_key, revoked FROM agent_keys",
      ).toArray();
      for (const r of rows) this.agentOverrides.set(r.agent_id, r.revoked ? null : (r.agent_key ?? null));
    } catch {
      // 表还没建（迁移前老实例）/ SQL 异常 → 视为无覆盖，不阻塞鉴权
    }
    this.agentOverridesLoaded = true;
  }

  /**
   * 按机器 id 解析该用的密钥（优先级从高到低）：
   *   ① 运行期覆盖（DO storage）—— 支持即时增/吊销；
   *   ② AGENT_KEYS 静态注册表（secret，扛得过 DO_KEY 换版）；
   *   ③ 过渡期：未配 AGENT_KEYS 时回退旧单共享密钥 AGENT_KEY（任何 id 都认）。
   * 返回 undefined = 这台机器无权连（未知 / 已吊销 / 没配任何密钥）。
   */
  private agentKeyFor(id: string): string | undefined {
    if (this.agentOverrides.has(id)) {
      const v = this.agentOverrides.get(id);
      if (v === null) return undefined; // 已吊销
      return v || undefined;
    }
    const map = this.agentKeysMap();
    if (map) return map.get(id);
    return this.env.AGENT_KEY; // 过渡期回退
  }

  /**
   * 下行命令签名：用「当前已连接机器」的密钥签名，agent 用它自己的同 id 密钥验签。
   * 每台机器独立密钥 → 一个机器的密钥泄漏不会让别的机器收到伪造命令。
   */
  private async signDownlink(cmdId: string, cmd: string): Promise<string> {
    const id = this.agentId;
    const key = id ? this.agentKeyFor(id) : undefined;
    if (!key) throw new Error("未识别已连接的机器，无法下发签名命令");
    return signCommand(key, cmdId, cmd);
  }

  /** 周期刷新已连接机器的 last_seen（仅运行期管理的机器，便于 /admin/agents 列出时看到）。 */
  private async touchAgentSeen(id: string): Promise<void> {
    if (!id || !this.agentOverrides.has(id)) return;
    try {
      this.ctx.storage.sql.exec(
        "UPDATE agent_keys SET last_seen = ? WHERE agent_id = ? AND revoked = 0",
        Date.now(),
        id,
      );
    } catch {
      /* 忽略：诊断信息而已 */
    }
  }

  // ---------------------------------------------------------------- 机器密钥管理（admin 端点）

  /** GET /admin/agents：列出所有已注册/已吊销的机器（不回显密钥）。 */
  private async listAgents(): Promise<Response> {
    await this.ensureAgentOverrides();
    const rows = this.ctx.storage.sql
      .exec<{ agent_id: string; label: string | null; created_at: number | null; last_seen: number | null; revoked: number }>(
        "SELECT agent_id, label, created_at, last_seen, revoked FROM agent_keys",
      )
      .toArray();
    const overrides = rows.map((r) => ({
      id: r.agent_id,
      label: r.label ?? null,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
      revoked: !!r.revoked,
      source: "override",
    }));
    const map = this.agentKeysMap();
    const staticEntries = map ? [...map.keys()].map((id) => ({ id, source: "static", revoked: false })) : [];
    const seen = new Set(overrides.map((o) => o.id));
    const all = [...overrides, ...staticEntries.filter((s) => !seen.has(s.id))];
    return Response.json({ ok: true, agents: all, connected: this.agentId || null, strictMode: !!map });
  }

  /** POST /admin/agents {id, key, label?}：注册或轮换一台机器的密钥。 */
  private async upsertAgent(request: Request): Promise<Response> {
    let body: { id?: unknown; key?: unknown; label?: unknown };
    try {
      body = (await request.json()) as { id?: unknown; key?: unknown; label?: unknown };
    } catch {
      return Response.json({ ok: false, error: "bad json" }, { status: 400 });
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const key = typeof body.key === "string" ? body.key : "";
    const label = typeof body.label === "string" ? body.label.trim() : null;
    if (!id || !key) return Response.json({ ok: false, error: "需要 {id, key}" }, { status: 400 });
    if (key.length < 32) return Response.json({ ok: false, error: "key 至少 32 字符" }, { status: 400 });
    await this.ensureAgentOverrides();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_keys (agent_id, agent_key, label, created_at, revoked)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(agent_id) DO UPDATE SET
         agent_key = excluded.agent_key,
         label = excluded.label,
         revoked = 0,
         created_at = COALESCE(agent_keys.created_at, excluded.created_at)`,
      id,
      key,
      label,
      now,
    );
    this.agentOverrides.set(id, key); // 同步内存缓存：立刻生效
    console.log(`[agent] 注册/轮换机器 ${id}`);
    return Response.json({ ok: true, id, label, createdAt: now });
  }

  /** DELETE /admin/agents/:id：吊销单台机器（即时生效，不用重新部署）。 */
  private async revokeAgent(id: string): Promise<Response> {
    if (!id) return Response.json({ ok: false, error: "missing id" }, { status: 400 });
    await this.ensureAgentOverrides();
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_keys (agent_id, agent_key, revoked) VALUES (?, ?, 1)
       ON CONFLICT(agent_id) DO UPDATE SET revoked = 1`,
      id,
      "",
    );
    this.agentOverrides.set(id, null); // 同步内存缓存：下次请求即 401
    console.log(`[agent] 吊销机器 ${id}`);
    return Response.json({ ok: true, id, revoked: true });
  }

  /** 记账一次鉴权失败；短时间内连续失败就临时封禁这个 IP。 */
  private noteAuthFail(ip: string, reason: string): void {
    const now = Date.now();
    const win = 10 * 60_000;
    const rec = this.authFails.get(ip);
    if (!rec || now - rec.first > win) {
      this.authFails.set(ip, { n: 1, first: now, until: 0 });
      console.log(`[shell] 鉴权失败（${ip}）：${reason}`);
      return;
    }
    rec.n++;
    if (rec.n >= 8) {
      rec.until = now + win;
      rec.n = 0;
      console.log(`[shell] 鉴权连续失败 → 封禁 ${ip} 10 分钟`);
    }
    // 表本身也要有上限：满 IP 灌进来不能无限涨内存
    if (this.authFails.size > 200) {
      for (const [k, v] of this.authFails) if (v.until < now && now - v.first > win) this.authFails.delete(k);
    }
  }

  /** shell 输出回传：纯文本发送，不走 MarkdownV2（命令输出里转义符太多，容易 400/渲染乱）。 */
  private async sendShellChunk(chatId: string, text: string): Promise<void> {
    // Telegram 对连续 sendMessage 限速（~1msg/s，突发 ~30）。完整回传长输出时
    // 一次可能连发几十条，429 是常态而不是异常 —— 按 retry_after 等待后重发。
    for (let attempt = 1; ; attempt++) {
      try {
        await this.tg.call("sendMessage", {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = /HTTP 429.*retry after (\d+)/i.exec(msg) ?? /HTTP 429/i.exec(msg) ? null : null;
        const retryAfter = /retry after (\d+)/i.exec(msg)?.[1];
        const waitMs = retryAfter ? Number(retryAfter) * 1000 + 500 : 1500;
        if (/HTTP 429/.test(msg) && attempt <= 5) {
          console.warn(`[shell] 429 限速，${waitMs}ms 后重发（第 ${attempt} 次）`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        console.error("[shell] 回传失败", e);
        return;
      }
    }
  }

  /**
   * agent 的 SSE 长连接：由 Worker 的 /shell/stream 直接把 ReadableStream 返回给 agent，
   * Worker 侧不缓冲（CF 支持流式响应）。连接一旦 cancel → detach()，等待 agent 重连。
   */
  private shellStream(): Response {
    const hub = this.shell;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        console.log("[shell] agent 断开 SSE");
        hub.detach();
      },
    });
    hub.attach(controller);
    console.log("[shell] agent 已连接 SSE");
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  /**
   * 未识别文本 → 下发到开发机的持久 bash。
   * 返回 "accepted" = 已排队（输出随后异步回传）；
   * 返回 "disabled" = 功能关着；其余 = 给用户看的提示文案。
   */
  private async dispatchShell(chatId: string, cmd: string): Promise<"accepted" | "disabled" | string> {
    if ((this.env.SHELL_ENABLED ?? "1") !== "1") return "disabled";
    const res = this.shell.enqueue(chatId, cmd);
    if (res.ok) return "accepted";
    if (!res.message) return "accepted"; // 空命令：静默忽略

    // shell 没连上时，先判断是不是「机器压根没开」——这两种情况的处置完全不同
    const client = this.codespaceClient();
    if (!client) return res.message;
    try {
      const st = await client.status();
      if (st.state !== "Available") {
        return `⌨️ 开发机没开机（当前：${describeState(st.state)}）。先发 /boot。`;
      }
    } catch {
      /* 状态查不动就回原始提示，别把异常抛给用户 */
    }
    return res.message;
  }

  // ---------------------------------------------------------------- 诊断

  /**
   * 诊断：回显最后一轮模型回复的原文，回答「高亮为什么不生效」。
   * 可能结论：① 模型没用围栏（含缩进=是/围栏=否 → 兜底漏了某种形态）
   * ② 模型用了围栏但 Telegram 侧渲染差异 ③ 发送被 400 降级（回复纯文本无样式）。
   */
  private async diagnose(chatId: string, send: (text: string) => Promise<void>): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ role: string; content: string }>(
        "SELECT role, content FROM history WHERE chat_id = ? ORDER BY ts DESC LIMIT 6",
        chatId,
      )
      .toArray();
    const lastUser = rows.find((r) => r.role === "user");
    const lastAssistant = rows.find((r) => r.role === "assistant"); // DESC 序，第一个即最新
    const raw = lastAssistant?.content ?? "";
    const visible = (s: string) =>
      s
        .replace(/```/g, "〔FENCE〕")
        .replace(/^( {4}|\t)/gm, "〔IND〕$&")
        .slice(0, 400);
    const report = [
      `诊断报告 build=${BUILD}`,
      `通道: tg=${this.tg ? "on" : "off"}`,
      `最近输入: ${(lastUser?.content ?? "无").slice(0, 80)}`,
      `模型回复含围栏: ${/```/.test(raw) ? "是" : "否"}`,
      `模型回复含缩进行: ${/^( {4}|\t)/m.test(raw) ? "是" : "否"}`,
      "模型回复原文（前400字，围栏→〔FENCE〕 缩进行→〔IND〕）:",
      visible(raw),
    ].join("\n");
    await send(report);
  }

  // ---------------------------------------------------------------- 状态存储

  private async seenMsg(key: string): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec<{ n: number }>("SELECT 1 AS n FROM seen_msgs WHERE msg_id = ?", key).toArray();
    return rows.length > 0;
  }

  private async markSeen(key: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO seen_msgs (msg_id, ts) VALUES (?, ?)", key, now);
    this.ctx.storage.sql.exec("DELETE FROM seen_msgs WHERE ts < ?", now - 3_600_000);
  }

  private async allowRate(chatId: string): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    this.ctx.storage.sql.exec(
      "INSERT INTO rate (chat_id, minute, n) VALUES (?, ?, 1) ON CONFLICT(chat_id, minute) DO UPDATE SET n = n + 1",
      chatId,
      minute,
    );
    const rows = this.ctx.storage
      .sql.exec<{ n: number }>("SELECT n FROM rate WHERE chat_id = ? AND minute = ?", chatId, minute)
      .toArray();
    this.ctx.storage.sql.exec("DELETE FROM rate WHERE minute < ?", minute - 10);
    return (rows[0]?.n ?? 1) <= this.rateLimit();
  }

  private async overBudget(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM budget WHERE day = ?", day).toArray();
    return (rows[0]?.n ?? 0) >= this.dailyBudget();
  }

  private async incrBudget(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(
      "INSERT INTO budget (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1",
      day,
    );
    this.ctx.storage.sql.exec("DELETE FROM budget WHERE day < ?", day);
  }

  private async getHistory(chatId: string): Promise<{ role: string; content: string }[]> {
    const limit = this.maxTurns() * 2;
    const rows = this.ctx.storage
      .sql.exec<{ role: string; content: string }>(
        "SELECT role, content FROM history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?",
        chatId,
        limit,
      )
      .toArray();
    return rows.reverse();
  }

  private async appendHistory(chatId: string, role: string, content: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO history (chat_id, role, content, ts) VALUES (?, ?, ?, ?)",
      chatId,
      role,
      content.slice(0, 4000),
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM history WHERE chat_id = ? AND ts < (
         SELECT MIN(ts) FROM (SELECT ts FROM history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?)
       )`,
      chatId,
      chatId,
      this.maxTurns() * 2,
    );
  }

  // ---------------------------------------------------------------- 配置读取

  private maxTurns(): number {
    return Number(this.env.SESSION_MAX_TURNS ?? 10);
  }
  private rateLimit(): number {
    return Number(this.env.RATE_LIMIT_PER_MIN ?? 20);
  }
  private dailyBudget(): number {
    return Number(this.env.DAILY_CALL_BUDGET ?? 200);
  }
  /** 验证会话时长（分钟，默认 10 = 无交互 10 分钟即失效，见 verify.ts） */
  private verifySessionMs(): number {
    const min = Number(this.env.VERIFY_SESSION_MIN ?? VERIFY_SESSION_DEFAULT_MIN);
    return (Number.isFinite(min) && min > 0 ? min : VERIFY_SESSION_DEFAULT_MIN) * 60_000;
  }

  // 看门狗配置（vars）
  /** 空闲提醒阈值（分钟，默认 25） */
  private watchRemindMin(): number {
    const v = Number(this.env.CS_WATCH_REMIND_MIN ?? 25);
    return Number.isFinite(v) && v > 0 ? v : 25;
  }
  /** 自动关机阈值（分钟，默认 55） */
  private watchAutostopMin(): number {
    const v = Number(this.env.CS_WATCH_AUTOSTOP_MIN ?? 55);
    return Number.isFinite(v) && v > this.watchRemindMin() ? v : 55;
  }
  /** 是否启用自动关机（CS_WATCH_AUTOSTOP=0 关闭，默认开） */
  private autostopEnabled(): boolean {
    return (this.env.CS_WATCH_AUTOSTOP ?? "1") !== "0";
  }
  /** GH 连续活跃上限（分钟，默认 180）：第三信号保险丝 */
  private ghCapMin(): number {
    const v = Number(this.env.CS_GH_CAP_MIN ?? 180);
    return Number.isFinite(v) && v >= 30 ? v : 180;
  }
  /**
   * 触达上限后的动作（默认 stop）：
   *   stop   = 警告一次 + 宽限倒计时，到期强制关机（有硬上限，杜绝无限泄漏）
   *   notify = 只提醒，永不自动关（保守；适合你经常在 VS Code 长会话干活的时期）
   */
  private ghCapAction(): "notify" | "stop" {
    return this.env.CS_GH_CAP_ACTION === "notify" ? "notify" : "stop";
  }
  /** "stop" 模式下的宽限期（分钟，默认 15） */
  private watchGraceMin(): number {
    const v = Number(this.env.CS_GH_CAP_GRACE_MIN ?? 15);
    return Number.isFinite(v) && v > 0 ? v : 15;
  }
  /** 月免费额度（小时，默认 60 = 2 核机的 120 core-hours） */
  private monthlyBudgetHours(): number {
    const v = Number(this.env.CS_MONTHLY_BUDGET_HOURS ?? 60);
    return Number.isFinite(v) && v > 0 ? v : 60;
  }

  // ---------------------------------------------------------------- 验证会话存储

  private async getVerify(chatId: string): Promise<VerifyState | undefined> {
    const key = `verify:${chatId}`;
    // 兼容两种历史格式：老数据是裸 number（无指纹），新数据是 { exp, fp }
    const v = await this.ctx.storage.get<number | VerifyState>(key);
    if (v === undefined) return undefined;
    if (typeof v === "number") return { exp: v, fp: "" };
    return v;
  }

  private async setVerify(chatId: string, exp: number, fp = ""): Promise<void> {
    this.ctx.storage.put(`verify:${chatId}`, { exp, fp } satisfies VerifyState);
  }

  /**
   * 暂存「验证前那条命令」。只存一条（最新优先）——用户不会一边等验证一边攒命令。
   * 超过 VERIFY_PENDING_MAX 的超长文本不存（多半是粘贴的代码/日志，不适合自动执行）。
   */
  private async rememberPendingCmd(chatId: string, cmd: string, now: number): Promise<void> {
    const t = cmd.trim();
    if (!t || t.length > 4000) return;
    await this.ctx.storage.put(`pending:${chatId}`, { cmd: t, at: now } satisfies PendingCmd);
  }

  /** 取出并清除暂存命令；过期/不存在返回 null。 */
  private async takePendingCmd(chatId: string, now: number): Promise<string | null> {
    const key = `pending:${chatId}`;
    const p = await this.ctx.storage.get<PendingCmd>(key);
    if (p === undefined) return null;
    await this.ctx.storage.delete(key); // 无论是否过期都清掉，避免反复补执行
    return shouldReplay(p, now) ? p.cmd : null;
  }

  /**
   * 把指令表同步到 Telegram 的「/」菜单（setMyCommands）。
   *
   * 只在第一次 /help 时做一次（storage 打标记），失败也不影响回复——
   * 菜单是锦上添花，指令本身靠文本解析，不依赖它。
   */
  private async syncMenuOnce(): Promise<void> {
    // 版本化 key：指令表变了就 +1，否则老 DO 里的 true 会永久压住同步、新指令进不了菜单
    const key = "menu_synced_v2";
    try {
      if (await this.ctx.storage.get<boolean>(key)) return;
      await this.tg.call("setMyCommands", { commands: menuCommands() });
      await this.ctx.storage.put(key, true);
      console.log(`[tg] 已同步 / 菜单（${menuCommands().length} 条）`);
    } catch (e) {
      console.error("[tg] setMyCommands 失败（不影响使用）", e);
    }
  }

  private async status(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      build: BUILD,
      channel: "telegram",
      // 部署身份（wrangler.toml [vars] BOT_IDENTITY）：主 bot 缺省 main；devbot 部署显示 devbot
      identity: this.env.BOT_IDENTITY || "main",
      // shell agent 是否反连在线（诊断用：不在线说明 codespace 里 agent 没起来）
      shell: this.shell.online() ? "online" : "offline",
      // 最近一次 agent 鉴权用的方式：hmac = 签名通道（正常）；legacy = 明文密钥（该升级了）
      agentAuth: this.lastAuth ? this.lastAuth.mode : "none",
      // 最近一条 webhook 的来源 IP（空 = 换实例后还没收到过消息）
      webhookIp: this.lastWebhookIp,
    };
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seen_msgs (msg_id TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS history (chat_id TEXT, role TEXT, content TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_history ON history(chat_id, ts);
CREATE TABLE IF NOT EXISTS rate (chat_id TEXT, minute INTEGER, n INTEGER, PRIMARY KEY(chat_id, minute));
CREATE TABLE IF NOT EXISTS budget (day TEXT, n INTEGER, PRIMARY KEY(day));
CREATE TABLE IF NOT EXISTS cs_runtime (day TEXT PRIMARY KEY, minutes REAL);
CREATE TABLE IF NOT EXISTS agent_keys (
  agent_id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  label TEXT,
  created_at INTEGER,
  last_seen INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
`;

/** 看门狗运行窗口：一次「开机→关机」的生命周期（DO storage 单值，键 cs_episode）。 */
interface Episode {
  /** 机器是否在运行（窗口打开） */
  running: boolean;
  /** 本轮开机时间戳（运行时长起算点） */
  bootAt: number;
  /** 最近一次终端级 Telegram 互动时间戳 */
  lastActivity: number;
  /** 是否由 bot 指令发起（决定可否自动关机） */
  botStarted: boolean;
  /** 本轮窗口是否已发过空闲提醒（防轰炸） */
  reminded: boolean;
  /** 关联 chat_id（推送目标；可为 null = 巡检发现，未关联聊天） */
  chatId: string | null;
  /** GH「连续活跃」追踪起点（第三信号：防 dev server 刷日志无限续命） */
  ghFreshSince: number | null;
  /** 本轮窗口是否已发过「持续活跃上限」警告 */
  capNotified: boolean;
  /** 上限警告发出的时刻（宽限倒计时起点） */
  capNotifiedAt: number | null;
}
