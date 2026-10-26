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
import { CodespaceClient, beginBoot, checkBoot, stopCodespace, describeState } from "./codespace";
import { isVerified, isAnswerMatch, nextExpiry, CHALLENGE_TEXT, type VerifyState } from "./verify";
import { evalWatch, fmtDur, pushAlarm, drainAlarms, type AlarmStore, type AlarmTask } from "./watch";

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
// v17：Codespace 开发机远程开关——「开始开发/停止开发/开发机状态」指令
//     （含 /boot /halt /cs 别名）。两次查询开机协议（30s 间隔、不循环、幂等停机），
//     GitHub REST 薄客户端见 src/codespace.ts；凭证 GH_CODESPACE_PAT（secret）。
// v1（devbot 独立版本线）：省额度看门狗——
//     ① 空闲提醒+自动关机（evalWatch 两层保险：25min 提醒 / 55min 自动关，可配）；
//     ② 互动即续命（白名单消息 touchWatchActivity），origin=bot 才自动关、observed 只提醒；
//     ③ DO alarm 软排队（boot 二查与看门狗共存）；
//     ④ 「用量」指令：本月累计运行时长 vs 免费额度（cs_runtime 表按日累计）；
//     ⑤ patrol 巡检（cron 半小时 + /patrol 手动）：发现漏网的运行中机器。
const BUILD = "devbot-20261026-v1";

const SYSTEM_PROMPT = `你是一位资深软件工程师，通过用户的智能手表语音接收编程需求。
输出要求：
1. 先给结论或代码，再给必要解释——用户可能在手表上阅读，务必精炼
2. 代码必须放在 \`\`\` 围栏代码块中并标注语言（如 \`\`\`python），严禁使用 4 空格缩进代码块——Telegram 客户端不渲染缩进代码
3. 涉及多文件改动时，用清单列出「文件 → 改动点」
4. 信息不足时先说明你的假设，不要编造 API 或参数
5. 默认使用任务描述中指定的编程语言；未指定时用 Python`;

export class AssistantDO extends DurableObject<Env> {
  private readonly tg: TelegramClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 端点集中解析（默认官方地址，可用环境变量覆盖，见 src/config.ts）
    const ep = endpoints(env);
    this.tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN ?? "", ep.telegramApiBase);
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
          // 看门狗巡检（cron 半小时触发 / 手动 ?key= 触发）：查机器状态并跑 evalWatch
          return Response.json(await this.patrol());
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
        default:
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
        if (t.kind === "boot_check") await this.onBootCheckAlarm();
        else if (t.kind === "watch") await this.onWatchAlarm();
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
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (got !== expected) return new Response("forbidden", { status: 403 });
    }

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

    // 2) 白名单（未配置 = 放开，仅建议开发期）。匹配 chat_id 或 user_id 任一即可。
    //    拒绝时回报 chat_id，方便管理员把自己加白（只回一次/分钟，避免被刷屏）。
    const allowed = (this.env.ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(m.chatId) && !allowed.includes(m.userId)) {
      console.log(`[tg] 非白名单 chat=${m.chatId}，拒绝`);
      if (await this.allowRate(m.chatId)) {
        await this.reply(
          m.chatId,
          `未授权用户。你的 chat_id 是 ${m.chatId}，请联系管理员加入白名单。`,
        );
      }
      return;
    }

    // 2.5) 看门狗互动刷新：白名单用户发的任何消息都算「你在用开发机」
    //      （放在验证之前——即使验证会话过期，你的出现本身就说明在场）
    await this.touchWatchActivity(m.chatId);

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

    // 5.5) 身份验证（30 分钟滑动会话）：
    //   - 未验证：一切问题/指令都不转发 LLM / Codespace，只回验证问题；
    //     若这条消息本身就是正确答案 → 通过并延续 30 分钟。
    //   - 已验证：任何交互把会话滑动延续 30 分钟。
    //   - 答案 VERIFY_ANSWER 走 secret（不在公开源码里）；未配置 = 服务锁定（默认安全）。
    //   - 设备限制由「白名单账号」达成（Telegram 不提供设备信息）。
    const now = Date.now();
    const verifyAnswer = this.env.VERIFY_ANSWER;
    const sessionMs = this.verifySessionMs();
    const state = await this.getVerify(m.chatId);
    if (!isVerified(state, now)) {
      if (verifyAnswer && isAnswerMatch(text, verifyAnswer)) {
        await this.setVerify(m.chatId, nextExpiry(now, sessionMs));
        await this.reply(m.chatId, "验证通过 ✓（半小时内互动免验证）");
        return;
      }
      await this.setVerify(m.chatId, 0); // 保持未验证
      await this.reply(
        m.chatId,
        verifyAnswer ? CHALLENGE_TEXT : `${CHALLENGE_TEXT}\n（管理员未配置验证答案，服务锁定中）`,
      );
      return;
    }
    // 已验证 → 滑动延续
    await this.setVerify(m.chatId, nextExpiry(now, sessionMs));

    // 6.5) 诊断命令：回显最后一轮模型回复的原文格式，定位「高亮不生效」问题。
    // 用可见标记替换围栏/缩进，纯文本发送（不走 mdToV2，避免二次转换干扰判断）。
    if (/^(诊断|\/diag)$/i.test(text.trim())) {
      await this.diagnose(m.chatId, (t) =>
        this.tg.call("sendMessage", { chat_id: m.chatId, text: t, disable_web_page_preview: true }),
      );
      return;
    }

    // 6.6) Codespace 开发机指令（正则先匹配，避免语音转写把「开始开发」识别歪）：
    //   开始开发 / /boot   → 两次查询开机协议（alarm 30s 二查，不循环）+ 启动看门狗
    //   停止开发 / /halt   → 幂等停机 + 关闭看门狗窗口
    //   开发机状态 / /cs   → 查询当前状态（也算互动，续命）
    //   用量 / /usage      → 本月累计运行时长 vs 免费额度
    const trimmed = text.trim();
    if (/^(开始开发|\/boot)[，。!！\s]*$/i.test(trimmed)) {
      const reply = await this.handleBootDev(m.chatId);
      if (reply) await this.reply(m.chatId, reply);
      return;
    }
    if (/^(停止开发|关掉开发机|\/halt)[，。!！\s]*$/i.test(trimmed)) {
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
    if (/^(开发机状态|\/cs)[，。!！\s]*$/i.test(trimmed)) {
      await this.reply(m.chatId, await this.handleDevStatus());
      return;
    }
    if (/^(用量|额度|\/usage)[，。!！\s]*$/i.test(trimmed)) {
      await this.reply(m.chatId, await this.handleUsage());
      return;
    }

    // 6) 意图解析 + 会话历史 + LLM 路由
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

    // 7) 分段回包
    await this.reply(m.chatId, answer);
    console.log(`[tg] 已回复 chat=${m.chatId} via ${via}`);
  }

  // ---------------------------------------------------------------- Codespace 开发机

  private codespaceClient(): CodespaceClient | null {
    const pat = this.env.GH_CODESPACE_PAT;
    if (!pat) return null;
    const name = this.env.GH_CODESPACE_NAME || "24h-jwp7vwxvx6hpp7";
    return new CodespaceClient(pat, name);
  }

  /**
   * 「开始开发」阶段 1：同步检查 + 触发启动 + 即时回复 + 启动看门狗。
   * 二查走 DO alarm 队列（30 秒后）。返回 null = 已回复（后续阶段自己发）。
   */
  private async handleBootDev(chatId: string): Promise<string | null> {
    const client = this.codespaceClient();
    if (!client) return "未配置 GH_CODESPACE_PAT，无法操作开发机（wrangler secret put GH_CODESPACE_PAT）。";
    const p1 = await beginBoot(client);
    await this.reply(chatId, p1.reply); // 先发即时回复（用户要求：立刻知道「正在启动」）
    if (p1.scheduleCheck) {
      await pushAlarm(this.alarmStore(), {
        due: Date.now() + 30_000,
        kind: "boot_check",
        payload: { chat_id: chatId },
      });
      // 开机指令已发出：看门狗从现在起算（origin=bot，超时未互动可自动关）
      await this.ensureWatch(chatId, "bot");
    } else if (p1.wasAvailable) {
      // 本来就在跑：看门狗起点重置（你刚确认过要用）
      await this.ensureWatch(chatId, "bot");
    }
    return null;
  }

  /** alarm 回调：开机 30 秒后的二次确认（含看门狗续排）。 */
  private async onBootCheckAlarm(): Promise<void> {
    const chatId = (await this.ctx.storage.get<string>("boot_check_chat")) ?? null;
    await this.ctx.storage.delete("boot_check_chat");
    const client = this.codespaceClient();
    if (!client) return;
    const final = await checkBoot(client);
    if (chatId) {
      await this.reply(chatId, final.reply);
      console.log(`[cs] 开机二查 chat=${chatId} → ${final.reply.slice(0, 60)}`);
      if (final.ok) {
        // 开机成功：刷新 episode 起点（从「确认运行」起算），并排首次看门狗检查
        await this.ensureWatch(chatId, "bot");
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
      return `开发机状态：${describeState(st.state)}`;
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
    };
    await this.setEpisode(ep);
    if (chat) await this.putChatId(chat);
    await pushAlarm(this.alarmStore(), {
      due: now + this.watchRemindMin() * 60_000,
      kind: "watch",
    });
  }

  /** 互动刷新：白名单用户的任何消息都算「在场」。不改变 bootAt/botStarted。 */
  private async touchWatchActivity(chatId: string): Promise<void> {
    await this.putChatId(chatId);
    const ep = await this.getEpisode();
    if (!ep || !ep.running) return; // 机器没跑：无需管理
    ep.lastActivity = Date.now();
    ep.reminded = false; // 你出现了：提醒状态复位（下次空闲重新提醒）
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

  /** 看门狗核心执行：查状态 → evalWatch → 提醒/自动关机 → 续排。 */
  private async runWatchCheck(): Promise<{ acted: boolean; note: string }> {
    const client = this.codespaceClient();
    const ep = await this.getEpisode();
    if (!client || !ep || !ep.running) return { acted: false, note: "no-episode" };
    let running: boolean;
    try {
      running = (await client.status()).state === "Available";
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
    });
    const chat = ep.chatId ?? (await this.getChatId());
    if (decision.markReminded) {
      ep.reminded = true;
      await this.setEpisode(ep);
    }
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
    let state: string;
    try {
      state = (await client.status()).state;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const ep = await this.getEpisode();
    if (state === "Available") {
      if (!ep || !ep.running) {
        // 发现漏网运行：建 observed 窗口（只提醒，不自动关）
        await this.ensureWatch(null, "observed");
        const chat = await this.getChatId();
        if (chat) {
          await this.reply(chat, `👀 巡检发现开发机在运行（不是我开的）。不用了发「停止开发」，或在 GitHub 页面关机。`);
        }
        return { ok: true, state, note: "observed-new" };
      }
      // 有窗口：借巡检跑一次看门狗检查（双重保险，alarm 丢了这个也兜底）
      const r = await this.runWatchCheck();
      return { ok: true, state, ...r };
    }
    // 机器没跑：若有残留 episode，落账清掉
    if (ep?.running) {
      await this.closeEpisode();
      return { ok: true, state, note: "episode-closed" };
    }
    return { ok: true, state, note: "idle" };
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
  /** 验证会话时长（分钟，默认 30） */
  private verifySessionMs(): number {
    const min = Number(this.env.VERIFY_SESSION_MIN ?? 30);
    return (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
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
  /** 月免费额度（小时，默认 60 = 2 核机的 120 core-hours） */
  private monthlyBudgetHours(): number {
    const v = Number(this.env.CS_MONTHLY_BUDGET_HOURS ?? 60);
    return Number.isFinite(v) && v > 0 ? v : 60;
  }

  // ---------------------------------------------------------------- 验证会话存储

  private async getVerify(chatId: string): Promise<VerifyState | undefined> {
    const key = `verify:${chatId}`;
    const v = await this.ctx.storage.get<number>(key);
    return v === undefined ? undefined : { exp: v };
  }

  private async setVerify(chatId: string, exp: number): Promise<void> {
    this.ctx.storage.put(`verify:${chatId}`, exp);
  }

  private async status(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      build: BUILD,
      channel: "telegram",
      // 部署身份（wrangler.toml [vars] BOT_IDENTITY）：主 bot 缺省 main；devbot 部署显示 devbot
      identity: this.env.BOT_IDENTITY || "main",
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
`;

/** 看门狗运行窗口：一次「开机→关机」的生命周期（DO storage 单值，键 cs_episode）。 */
interface Episode {
  /** 机器是否在运行（窗口打开） */
  running: boolean;
  /** 本轮开机时间戳（运行时长起算点） */
  bootAt: number;
  /** 最近一次 Telegram 互动时间戳 */
  lastActivity: number;
  /** 是否由 bot 指令发起（决定可否自动关机） */
  botStarted: boolean;
  /** 本轮窗口是否已发过空闲提醒（防轰炸） */
  reminded: boolean;
  /** 关联 chat_id（推送目标；可为 null = 巡检发现，未关联聊天） */
  chatId: string | null;
}
