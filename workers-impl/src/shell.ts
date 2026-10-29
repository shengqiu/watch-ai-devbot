/**
 * Shell 网关：Telegram ⇄ codespace 内「持久 bash」的双向桥。
 *
 * 为什么不用 tmux：
 *   tmux 的价值是「多路复用 + 可重连的终端会话」，但我们只需要「一个活着的
 *   bash」。直接 spawn 一个长驻 `bash -i` 子进程，把命令写进它的 stdin、
 *   从 stdout 增量捞输出，cwd / 环境变量 / 后台进程天然持久，心智负担更小，
 *   也少一层依赖。
 *
 * 传输方向（关键）：CF Worker **不能**主动连进 codespace（无出站 TCP/SSH），
 * 所以由 codespace 内的 agent **反向**连出来，建立一条 SSE 长连接：
 *   - 下行（命令）：Telegram → Worker DO → SSE → agent → bash stdin
 *   - 上行（输出）：bash stdout → agent → POST /shell/out → DO → Telegram
 * agent 只做出站 HTTPS，codespace 无需开放任何入站端口。
 *
 * 命令结束判定：agent 在每条命令后追加两行 marker（见 SHELL_MARKERS），
 * Worker 端用 parseMarkerLine 识别，拿到 exit code 与 cwd。
 */

/**
 * agent 在每条命令执行完后回写的**单行**收尾 marker：`__WS__<exit>__<cwd>__`
 *
 * 为什么合并成一行而不是 exit / pwd 两行：分两行时，exit 那行一到就把命令标记为
 * 结束并把状态清掉，随后到达的 cwd 行已经无处安放 → cwd 永远是 null，
 * 「cd 跨消息保持」就废了。单行一次带齐两个字段，天然无时序问题。
 */
export function markerLine(exit: number, cwd: string): string {
  return `__WS__${exit}__${cwd}__`;
}

const ESC = String.fromCharCode(27);

// ------------------------------------------------------------------ 纯逻辑

/** 去掉 ANSI 转义序列（CSI / OSC / 两字节序列），PTY 输出的必要清洗。 */
export function stripAnsi(s: string): string {
  return s
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "") // CSI: 颜色/光标
    .replace(new RegExp(`${ESC}\\][^${ESC}\\x07]*(\\x07|${ESC}\\\\)`, "g"), "") // OSC: 标题
    .replace(new RegExp(`${ESC}[()][0-9A-Za-z]`, "g"), "") // 字符集切换
    .replace(new RegExp(`${ESC}[=>]`, "g"), "") // 键盘模式
    .replace(new RegExp(`${ESC}.`, "g"), ""); // 兜底
}

/**
 * 归一化 PTY 输出：去 ANSI、CR/LF 统一成 LF、行尾空白裁掉。
 * 注意 \r（无 \n）在 PTY 里是「进度条重绘」，这里转成换行，
 * 宁可多几行也不要让用户看到一坨挤在一起的输出。
 */
export function sanitizeOutput(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

/**
 * 输出过长时掐头尾（保留开头和结尾，中间省略）。
 * 命令输出动辄几万字符，全量回传既刷屏又费额度。
 */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n⋯⋯ ${text.length - max} chars omitted ⋯⋯\n${text.slice(text.length - tail)}`;
}

/**
 * 按字节安全地把长文本切成多条消息（Telegram 上限 4096，留余量）。
 * 优先在换行处切断，避免把一行代码劈成两半。
 */
export function chunkOutput(text: string, limit = 3400): string[] {
  if (!text) return [];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export interface MarkerHit {
  exit: number;
  cwd: string;
}

/**
 * 识别 agent 回写的收尾 marker 行，一次拿到 exit code 和 cwd。
 * cwd 里可能有空格 / 下划线，所以末尾用贪婪匹配 + `__$` 收尾。
 */
export function parseMarkerLine(line: string): MarkerHit | null {
  const m = /^__WS__(-?\d+)__(.*)__$/.exec(line.trim());
  if (!m) return null;
  return { exit: Number(m[1]), cwd: m[2] };
}

/** 从一段输出里抽走所有 marker 行，返回 {text, exit, cwd}（供 agent 本地用）。 */
export function extractMarkers(text: string): { text: string; exit: number | null; cwd: string | null } {
  let exit: number | null = null;
  let cwd: string | null = null;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const hit = parseMarkerLine(line);
    if (hit) {
      exit = hit.exit;
      cwd = hit.cwd;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), exit, cwd };
}

/**
 * 收尾小注：`— exit 0 · /path`（成功与否 + shell 现在站在哪）。
 *
 * hideCwd 由 AI 会话（/gemini、/buddy）启用：那两个脚本整体包在子 shell 里，
 * 里面的 cd 不会改变长驻 shell 的目录，报出来的是父 shell 的位置，跟 AI 实际
 * 在哪个目录干活无关 —— 只留退出码，少一处要解释的地方。
 */
export function footerNote(exit: number | null, cwd: string | null, hideCwd = false): string {
  return `\n— exit ${exit ?? "?"}${cwd && !hideCwd ? ` · ${cwd}` : ""}`;
}

// ------------------------------------------------------------------ 状态机

export interface ShellCmd {
  id: string;
  cmd: string;
  chatId: string;
  at: number;
  /** 最近一次下发的时刻（重发会刷新）。用来算「发了多久还没人认领」。 */
  pushedAt?: number;
  /** 已下发次数（含首次）。用于限制重发，避免无限重试。 */
  tries?: number;
  /**
   * agent 确认「我收到了，开始跑」的时刻。
   *
   * 为什么必须有这个字段：SSE 是单向的，Worker 把帧写进 controller 只是在本地
   * 缓冲区里追加字节，**不代表对面收到了**。连接半死（TCP 没断、但对端进程已
   * 重启/网络黑洞）时，写操作不会报错，命令就石沉大海，而 Worker 会一直以为
   * 「还在跑」，直到 TTL 到期。2026-10-27 的「上一条命令还在跑：🛠 准备 Gemini
   * 环境」就是这条路径：agent 日志里连 exec 都没有。
   */
  ackedAt?: number;
  /** 最近一次有任何活动（ack / 输出）的时刻。判「僵尸命令」用。 */
  lastActivityAt?: number;
  /** 回显给用户看的标题（缺省 = 命令原文）。长脚本/带密钥的命令用得上 */
  label?: string;
  /** false = 不回显 `$ 命令` 前缀（命令原文含敏感信息时） */
  echo?: boolean;
  /** true = 不把命令原文写进 agent 日志（含密钥时） */
  quiet?: boolean;
  /**
   * true = 输出按 markdown 渲染（LLM 回答：代码块/粗体/斜体）。
   * AI 会话（/gemini、/buddy）的输出是 LLM 生成，走 MarkdownV2；
   * 普通 shell 命令的输出是任意字节流，保持纯文本（乱转义反而毁输出）。
   */
  markdown?: boolean;
  /**
   * true = 收尾小注只留 `— exit 0`，不报目录。给 AI 会话（/gemini、/buddy）用：
   * 它们的脚本整体跑在子 shell 里（避免 exit 杀掉长驻 shell），`cd` 不外泄，
   * 报出来的目录是**父 shell** 的位置，跟「AI 在哪个目录干活」不是一回事，
   * 只会让人以为跑错目录。
   */
  hideCwd?: boolean;
  /**
   * 下行命令的 HMAC 签名（Worker 用 AGENT_KEY 算，agent 验签后才执行）。
   * 缺省 = 没配 signer（老实例/单测），此时不下发 sig 字段，agent 按兼容模式处理。
   */
  sig?: string;
}

export interface ShellOpts {
  /** 回显标题（Telegram 里显示的「$ xxx」） */
  label?: string;
  /** 是否回显命令行（默认 true） */
  echo?: boolean;
  /** 是否允许 agent 记录命令原文（默认 true；含密钥时传 false） */
  quiet?: boolean;
  /** 收尾小注里不报目录（只留 `— exit 0`），见 ShellCmd.hideCwd */
  hideCwd?: boolean;
  /** 输出按 markdown 渲染（AI 会话），见 ShellCmd.markdown */
  markdown?: boolean;
}

export interface ShellOutMsg {
  id: string;
  /** 增量输出片段（已清洗） */
  text?: string;
  /** true = 这条命令跑完了 */
  done?: boolean;
  exit?: number | null;
  cwd?: string | null;
  /**
   * true = agent 确认收到命令、已交给 bash（不代表跑完，也可能带一行拒绝原因）。
   * Worker 用它把「已送达」和「写进虚空」区分开。
   */
  ack?: boolean;
}

/** agent 心跳（POST /shell/ping）。 */
export interface ShellPing {
  /** agent 进程启动时刻（ms）。变了 = agent 重启过，它手上的命令全丢了。 */
  epoch?: number;
  /** 当前 bash 世代号（重启 bash 会 +1，仅诊断用）。 */
  gen?: number;
  /** 此刻真正在跑的命令 id；null = 空闲。 */
  running?: string | null;
  /**
   * 在跑的那条命令的进程状态（一行人话，由 agent 读 /proc 拼出来）。
   * 例：`codebuddy[8341] S 睡眠（等 IO/网络，正常）· 等 ep_poll · CPU 3.4s`
   * 老 agent 不发这个字段 → 显示「进程状态未知（agent 版本太老）」。
   */
  proc?: string | null;
}

export interface ShellHubOpts {
  /** 增量输出静默多久就推一条（毫秒） */
  flushMs?: number;
  /** 单条 Telegram 消息字符上限 */
  chunkLimit?: number;
  /** 单条命令累计输出上限 */
  maxChars?: number;
  /** agent 心跳超时判定（毫秒） */
  staleMs?: number;
  /** 命令排队多久没任何回音就放弃（毫秒） */
  cmdTtlMs?: number;
  /**
   * 下发后多久没收到 agent 的 ack 就重发（毫秒）。默认 12 秒——
   * 正常通道上 ack 在 100ms 内就回来，12 秒还没动静基本可以确定丢了。
   */
  ackMs?: number;
  /** 最多下发几次（含首次）。默认 3。 */
  maxTries?: number;
  /**
   * agent 明确「不在跑这条」之后，再等多久判定中断（毫秒）。默认 45 秒。
   * 不设更小的值是因为 ping 本身 15 秒一次，判断天然有延迟。
   */
  idleMs?: number;
  /**
   * 下行命令签名器（HMAC）。有它 → 每帧 cmd 带 sig，agent 验签后才执行。
   * 这是「只有这台 Worker 能让这台开发机干活」的落地方式：签名私钥只在
   * Cloudflare secret 里，agent 侧只需同一个密钥算出来的结果对得上。
   */
  signer?: (id: string, cmd: string) => Promise<string>;
}

/**
 * 输出发送端。opts.markdown = 该条命令标记了 markdown（AI 会话），
 * 发送端应按 MarkdownV2 渲染（TelegramClient.sendMessage 自带转义和降级兜底）。
 */
type Sender = (chatId: string, text: string, opts?: { markdown?: boolean }) => Promise<void>;

const enc = new TextEncoder();

/**
 * 一个 DO 实例持有一个 ShellHub：维护 agent 的 SSE 连接、待下发命令队列、
 * 以及「按命令 id 聚合输出、静默窗口后刷一条」的输出缓冲。
 *
 * 全部为内存态：DO 被驱逐时连接断开、队列丢弃，此时 online=false，
 * Telegram 侧会明确提示「shell 未连接」而不是假装成功。
 */
export class ShellHub {
  private ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private readonly queue = new Map<string, ShellCmd>();
  private readonly buf = new Map<
    string,
    { parts: string[]; chars: number; timer: ReturnType<typeof setTimeout> | null; echoed: boolean }
  >();
  private lastSeen = 0;
  private seq = 0;
  /** 最近一次命令结束后的 cwd（诊断用；真正的持久性在 agent 侧的 bash 里） */
  private lastCwd: string | null = null;
  /** 未收到 ack 的重发定时器（命令 id → timer） */
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 「已经清理掉、但机器上可能还在跑」的命令（id → 记录）。
   * 只保留最近 20 条：用途是给迟到的输出包一个能通知到的人，不是审计日志。
   */
  private readonly ghosts = new Map<
    string,
    { chatId: string; label: string; at: number; notified: boolean }
  >();
  /**
   * 是否见过 agent 的心跳。
   *
   * 老版本 agent 不会 ping，此时只能沿用「SSE 写成功 = 在线」的旧判据；
   * 一旦见过一次 ping，就切到严格模式（只认 agent 主动 POST），
   * 因为「写得进去」在连接半死时完全不可信。
   */
  private pingSeen = false;
  /** agent 进程的启动时刻（来自 ping）。变化 = 它重启过。 */
  private agentEpoch = 0;
  /** agent 最近一次心跳里报告的在跑命令（null = 空闲）。 */
  private agentRunning: string | null = null;
  /** agent 最近一次心跳里报告的进程状态（一行人话；null = 没在跑 / 老 agent）。 */
  private agentProc: string | null = null;
  /** 是否见过带 proc 字段的心跳（用来区分「老 agent」和「当前没在跑」）。 */
  private procSeen = false;

  private readonly flushMs: number;
  private readonly chunkLimit: number;
  private readonly maxChars: number;
  private readonly staleMs: number;
  private readonly cmdTtlMs: number;
  private readonly ackMs: number;
  private readonly maxTries: number;
  private readonly idleMs: number;
  private readonly signer?: (id: string, cmd: string) => Promise<string>;
  /** 下行帧串行化：签名是异步的，若并发写会让帧乱序（attach 重发多条时尤其明显）。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: Sender,
    opts: ShellHubOpts = {},
  ) {
    this.flushMs = opts.flushMs ?? 1200;
    this.chunkLimit = opts.chunkLimit ?? 3400;
    this.maxChars = opts.maxChars ?? 24000;
    this.staleMs = opts.staleMs ?? 90_000;
    // 60 分钟：长任务（codebuddy 改一整个项目）必须活得过它。
    // 真正的卡死由 agent 侧的进程探针判定，这里只兜「彻底失联」。
    this.cmdTtlMs = opts.cmdTtlMs ?? 3_600_000;
    this.ackMs = opts.ackMs ?? 12_000;
    this.maxTries = opts.maxTries ?? 3;
    this.idleMs = opts.idleMs ?? 45_000;
    this.signer = opts.signer;
  }

  /** agent 是否在线（有 SSE 连接 + 心跳未超时）。 */
  online(): boolean {
    if (!this.ctl) return false;
    return Date.now() - this.lastSeen < this.staleMs;
  }

  /** agent 上次心跳时间（0 = 从未连接）。 */
  seenAt(): number {
    return this.lastSeen;
  }

  /** 在跑/排队的命令数。 */
  pending(): number {
    return this.queue.size;
  }

  /** 诊断快照：agent 是否在线、上次心跳、排队数、最近 cwd、心跳里的在跑命令。 */
  snapshot(): {
    online: boolean;
    seenAt: number;
    pending: number;
    cwd: string | null;
    pingSeen: boolean;
    agentRunning: string | null;
    proc: string | null;
    procSeen: boolean;
  } {
    return {
      online: this.online(),
      seenAt: this.lastSeen,
      pending: this.queue.size,
      cwd: this.lastCwd,
      pingSeen: this.pingSeen,
      agentRunning: this.agentRunning,
      proc: this.agentProc,
      procSeen: this.procSeen,
    };
  }

  /**
   * 当前命令的进程状态说明（给 /cs 用）。
   * 区分三种「不知道」：没在跑、agent 太老、真的读不到 —— 别混成一句话。
   */
  procLine(): string {
    if (!this.agentRunning) return "(no command running)";
    if (this.agentProc) return this.agentProc;
    return this.procSeen ? "(agent did not report; probably just started)" : "process state unknown (agent too old; git pull on the machine)";
  }

  /**
   * agent 建立 SSE 长连接。同 id 重连会覆盖旧控制器（旧的随后被 cancel）。
   * 重连时把队列里尚未完成的命令重发一次——避免「DO 驱逐期间的命令石沉大海」。
   */
  attach(ctl: ReadableStreamDefaultController<Uint8Array>): void {
    this.ctl = ctl;
    this.lastSeen = Date.now();
    if (this.hb) clearInterval(this.hb);
    // 心跳：① 让 agent 侧能感知断线；② 阻止中间设备掐掉空闲连接
    // ③ 写成功 = SSE 管道还活着 → 刷新 lastSeen。
    //    漏了 ③ 会出致命 bug：agent 空闲时不 POST，lastSeen 冻结在 attach 时刻，
    //    90s 后 online() 误判离线，所有 shell 命令被拒（日志里完全看不到 exec）。
    // 心跳：① 让 agent 侧能感知断线；② 阻止中间设备掐掉空闲连接
    // ③ 刷新 lastSeen —— **只在老 agent（没有 ping）时才这么做**。
    //    见过 ping 之后就不刷新了：连接半死时 write 照样成功，用它当存活证据
    //    会把「对面已经死了」判成「在线」，命令于是被写进虚空（2026-10-27 事故）。
    this.hb = setInterval(() => {
      this.write(": hb\n\n");
      if (this.ctl && !this.pingSeen) this.lastSeen = Date.now();
    }, 20_000);
    this.write(`data: ${JSON.stringify({ t: "hello", at: Date.now() })}\n\n`);
    // 重连后把未完成的命令重发一次（记一次 tries，让 ack 超时算得准）
    for (const c of this.queue.values()) this.resend(c);
  }

  /** agent 断开（SSE cancel / 错误）后清理。 */
  detach(): void {
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = null;
    }
    this.ctl = null;
    // 分两种，处置完全不同：
    //   · **从没 ack** → agent 压根没收到，这条命令永远不会跑了，直接告知并清掉；
    //   · **已 ack** → bash 里可能还在跑，保留在队列里等重连重发（输出会接着回传）。
    //     以前一律清空，于是「SSE 抖一下」就等于把用户的构建/提问掐死，还只剩一句
    //     「命令未执行完」的含糊提示。
    for (const [id, cmd] of [...this.queue]) {
      if (cmd.ackedAt) {
        console.log(`[shell] 断开时保留在跑的命令 ${id}`);
        continue;
      }
      this.clearAck(id);
      void this.send(cmd.chatId, `⚠️ Shell connection dropped; the command never reached the machine: ${cmd.label ?? cmd.cmd}`);
      this.buf.delete(id);
      this.queue.delete(id);
    }
  }

  /**
   * 排队一条命令。ok=true 时返回命令 id（输出随后由 /shell/out 异步回传）；
   * ok=false 时 message 是给用户的提示（message=null 表示不需要回复，如空命令）。
   */
  enqueue(chatId: string, cmd: string, opts: ShellOpts = {}): { ok: boolean; id?: string; message?: string | null } {
    const text = cmd.trim();
    if (!text) return { ok: false, message: null };
    if (!this.online()) {
      return {
        ok: false,
        message: [
          "⌨️ Shell not connected: the shell agent on the dev machine is not connected.",
          "",
          "· Just booted? Wait 30s and retry (postStart launches it automatically)",
          "· Still offline? Run this in the codespace terminal: node shell-agent/agent.mjs",
        ].join("\n"),
      };
    }
    // 单飞：一次只让一条命令在跑，避免输出交错难读。
    //
    // 但「被上一条锁死」比「输出交错」糟得多，所以发现队列里那条其实已经死了
    // （从没送达 / agent 明说不在跑 / 超时），就当场清掉并继续入队——用户不需要
    // 知道 TTL、也不需要记得 /ctrlc，发下一条消息就自动恢复。
    if (this.queue.size > 0) {
      const lost = this.reapLost();
      if (this.queue.size > 0) {
        // 一定要说清「跑的是哪条」：只说「上一条还在跑」，用户根本不知道是
        // 刚才的 npm 安装、还是 gemini 在想、还是自己十几分钟前发的什么。
        const cur = [...this.queue.values()][0];
        const shown = cur.label ?? cur.cmd.split("\n")[0].slice(0, 60);
        const hint = lost.length > 0 ? "(just dropped a lost command)\n" : "\n";
        return {
          ok: false,
          message: `⌨️ Previous command still running: ${shown}${hint}Wait for it, or /ctrlc to interrupt (also clears the queue).`,
        };
      }
    }
    const id = `c${++this.seq}_${Date.now().toString(36)}`;
    const now = Date.now();
    const rec: ShellCmd = { id, cmd: text, chatId, at: now, pushedAt: now, tries: 1, lastActivityAt: now };
    if (opts.label) rec.label = opts.label;
    if (opts.echo === false) rec.echo = false;
    if (opts.quiet) rec.quiet = true;
    if (opts.hideCwd) rec.hideCwd = true;
    if (opts.markdown) rec.markdown = true;
    this.queue.set(id, rec);
    this.buf.set(id, { parts: [], chars: 0, timer: null, echoed: false });
    this.push(rec);
    this.armAck(id);
    return { ok: true, id };
  }

  /**
   * 下发 Ctrl-C（中断当前前台命令）。
   *
   * 同样带签名：agent 对「未签名的控制帧」一律忽略。否则一条伪造的 ctrlc
   * 就能反复打断你正在跑的构建，属于低成本骚扰。
   */
  sendCtrlC(): string | null {
    if (!this.online()) return "⌨️ Shell not connected.";
    this.chain = this.chain
      .then(async () => {
        if (!this.ctl) return;
        const payload: Record<string, unknown> = { t: "ctrlc" };
        if (this.signer) {
          try {
            payload.sig = await this.signer("__ctrlc__", "");
          } catch {
            return; // 签不出来就不发，宁可让用户重试
          }
        }
        this.write(`data: ${JSON.stringify(payload)}\n\n`);
      })
      .catch(() => {});
    return null;
  }

  /**
   * 强制清空队列，返回被丢弃的命令（/ctrlc 逃生用）。
   *
   * 为什么必须能强清：单飞锁只看 queue.size，而 queue 只有两个出口——收到
   * `done` marker，或等满 cmdTtlMs（45 分钟）。一旦进程对 SIGINT 没反应
   * （npm 卡在 fetch、gemini 卡在等工具返回、或 marker 被输出冲掉），
   * 用户就被自己的一条命令锁死 45 分钟，而这个通**道唯一能自救的手段是 /halt 关机**。
   * 用户明确说了「我要中断」，就不能只发个信号然后继续锁着他。
   */
  killAll(): ShellCmd[] {
    const dropped = [...this.queue.values()];
    for (const [id, b] of this.buf) {
      if (b.timer) clearTimeout(b.timer);
      this.clearAck(id);
      this.buf.delete(id);
    }
    // buf 里没有对应项的命令（极少见）也别漏掉定时器
    for (const id of [...this.ackTimers.keys()]) this.clearAck(id);
    this.queue.clear();
    return dropped;
  }

  /** 记住一条被清理掉的命令（上限 20 条，超出淘汰最老的）。 */
  private rememberGhost(id: string, chatId: string, label: string): void {
    this.ghosts.set(id, { chatId, label, at: Date.now(), notified: false });
    while (this.ghosts.size > 20) {
      const oldest = [...this.ghosts.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.ghosts.delete(oldest[0]);
    }
  }

  /**
   * 收到一条「已经不认识的命令」的输出。
   *
   * 以前这里直接 `return` —— 于是出现最难受的一类事故：命令在开发机上还活着，
   * Worker 侧的登记被清掉了（超时 / DO 回收），后面所有输出全部静默消失，
   * 用户盯着一个再也不会更新的气泡干等，而 Worker 一句话都不说。
   * 现在改为「至少告诉你发生了什么」。
   */
  private async onGhostOutput(msg: ShellOutMsg): Promise<void> {
    const g = this.ghosts.get(msg.id);
    if (!g || g.notified) return;
    g.notified = true;
    const chars = msg.text?.length ?? 0;
    await this.send(
      g.chatId,
      `⚠️ The record for '${g.label}' is gone (timeout cleanup or DO eviction), but it **may still be running on the machine** — ` +
        `just got ${chars} bytes of its output with nowhere to deliver it.\n` +
        `Check /cs for the process state; /ctrlc if it's stuck, or just resend.`,
    );
  }

  /** agent 回传输出（可能是增量片段，也可能是 done 收尾包）。 */
  async onOutput(msg: ShellOutMsg): Promise<void> {
    const rec = this.queue.get(msg.id);
    if (!rec) {
      await this.onGhostOutput(msg);
      return;
    }
    const b = this.buf.get(msg.id);
    if (!b) return;

    // 任何回传都是「agent 确实收到了」的证据：签收并停掉重发定时器。
    rec.lastActivityAt = Date.now();
    if (!rec.ackedAt) {
      rec.ackedAt = rec.lastActivityAt;
      this.clearAck(msg.id);
    }

    if (msg.text) {
      b.chars += msg.text.length;
      if (b.chars <= this.maxChars) b.parts.push(msg.text);
      else if (b.chars - msg.text.length < this.maxChars) {
        b.parts.push("\n⋯⋯ output too long, truncated ⋯⋯\n");
      }
    }
    if (msg.done) {
      await this.flush(msg.id, true, msg.exit ?? null, msg.cwd ?? null);
      return;
    }
    // 静默窗口后推一条；连续输出时不断重置，避免刷屏
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => void this.flush(msg.id), this.flushMs);
  }

  /**
   * agent 心跳。这是「通道真的活着」的唯一可信证据：
   *   · 刷新 lastSeen（严格模式下在线判定全靠它）；
   *   · 报告 running → 它说在跑的那条命令才是真在跑；
   *   · 报告 epoch 变化 → agent 重启过，它手上已 ack 的命令必然全部丢失，
   *     立刻清掉，不用等 TTL。
   */
  onPing(info: ShellPing = {}): void {
    this.tick();
    this.pingSeen = true;

    const epoch = Number(info.epoch ?? 0);
    if (epoch > 0) {
      if (this.agentEpoch > 0 && epoch !== this.agentEpoch) {
        for (const [id, cmd] of [...this.queue]) {
          if (cmd.ackedAt) void this.dropLost(id, "the agent restarted, so this one was interrupted");
        }
        this.agentRunning = null;
      }
      this.agentEpoch = epoch;
    }

    const run = typeof info.running === "string" && info.running ? info.running : null;
    this.agentRunning = run;
    if (typeof info.proc === "string" || info.proc === null) this.procSeen = true;
    this.agentProc = typeof info.proc === "string" && info.proc ? info.proc : null;
    if (run) {
      const c = this.queue.get(run);
      if (c) {
        // agent 说它在跑 → 续命 + 视为已签收（防止 ack 包丢了被误判未送达）
        c.lastActivityAt = Date.now();
        if (!c.ackedAt) c.ackedAt = c.lastActivityAt;
        this.clearAck(run);
      }
    }
  }

  /**
   * 清掉「已经不可能再回来」的命令，返回被清掉的列表。
   *
   * 三条判据，从强到弱：
   *   ① 从没 ack 且已超过 ackMs×3 → 那条 SSE 是半死的，永远送不到；
   *   ② 已 ack，但 agent 心跳明说「在跑的不是它」且已静默 idleMs → 中途被丢；
   *   ③ 超过 cmdTtlMs → 兜底。
   *
   * 只要 agent 心跳说 running === 这条 id，就一律不动——真在跑的长任务
   * （npm 静默几分钟）不能被误杀。
   */
  reapLost(now = Date.now()): ShellCmd[] {
    const lost: ShellCmd[] = [];
    for (const [id, c] of [...this.queue]) {
      const idle = now - (c.lastActivityAt ?? c.at);
      if (this.agentRunning === id) continue; // agent 明确说在跑
      const neverAcked = !c.ackedAt && now - c.at > this.ackMs * 3;
      // 老 agent 不发 ping：agentRunning 恒为 null，此时不能拿它当证据，
      // 只能退回「长时间无任何输出」（给足 10 分钟，别误杀静默安装）。
      const abandoned = c.ackedAt && idle > (this.pingSeen ? this.idleMs : Math.max(this.idleMs, 600_000));
      // 兜底从「最后一次有动静」起算，不再从下发时刻起算：
      // 以前一条 20 分钟的 codebuddy 长任务会在第 15 分钟被判超时（agent 明明还报着
      // 「在跑」，只是那 15 秒的 ping 还没到），队列被解锁、输出进黑洞。
      const expired = idle > this.cmdTtlMs;
      if (!neverAcked && !abandoned && !expired) continue;
      lost.push(c);
      const why = neverAcked
        ? "the agent never confirmed receipt (that connection was dead)"
        : expired
          ? `it ran over ${Math.round(this.cmdTtlMs / 60_000)} min without finishing`
          : "the agent is no longer running it (it was interrupted)";
      void this.dropLost(id, `「${c.label ?? c.cmd.split("\n")[0].slice(0, 40)}」${why}`);
    }
    return lost;
  }

  /** 丢掉一条命令并告知用户（同时解除单飞锁）。 */
  private async dropLost(id: string, reason: string): Promise<void> {
    const c = this.queue.get(id);
    if (!c) return;
    this.clearAck(id);
    // 留一张「名片」：万一它其实还在开发机上跑，迟到的输出能找到人通知
    this.rememberGhost(id, c.chatId, c.label ?? c.cmd.split("\n")[0].slice(0, 40));
    const b = this.buf.get(id);
    if (b?.timer) clearTimeout(b.timer);
    this.buf.delete(id);
    this.queue.delete(id);
    const partial = (b?.parts.join("") ?? "").trim();
    const name = c.label ?? c.cmd.split("\n")[0].slice(0, 40);
    await this.send(
      c.chatId,
      `${partial ? partial + "\n\n" : ""}⚠️ Auto-unlocked: ${name} — ${reason}.\nJust resend it.`,
    );
  }

  /**
   * ack 看门狗：发出后 ackMs 内没有 ack 就重发，最多 maxTries 次。
   *
   * 为什么重发是安全的：agent 侧对同一个 id 幂等——已经在跑就直接忽略，
   * 不会重复执行（见 agent.mjs 的 runCommand）。
   */
  private armAck(id: string, delay = this.ackMs): void {
    this.clearAck(id);
    const timer = setTimeout(() => {
      this.ackTimers.delete(id);
      const c = this.queue.get(id);
      if (!c || c.ackedAt) return;
      if (!this.ctl) {
        void this.dropLost(id, "the shell connection is down; the command never reached the machine");
        return;
      }
      const tries = c.tries ?? 1;
      if (tries >= this.maxTries) {
        void this.dropLost(id, `no agent ack in ${Math.round((this.ackMs * ((1 << tries) - 1)) / 1000)}s; the channel is half-dead`);
        return;
      }
      c.tries = tries + 1;
      c.pushedAt = Date.now();
      this.push(c);
      this.armAck(id, Math.min(this.ackMs * (1 << tries), 30_000));
    }, delay);
    this.ackTimers.set(id, timer);
  }

  private clearAck(id: string): void {
    const t = this.ackTimers.get(id);
    if (t) clearTimeout(t);
    this.ackTimers.delete(id);
  }

  /** 重发一条队列里的命令（attach 重连 / ack 超时都走这里），并重新武装 ack 看门狗。 */
  private resend(c: ShellCmd): void {
    c.pushedAt = Date.now();
    c.tries = (c.tries ?? 1) + 1;
    this.push(c);
    if (!c.ackedAt) this.armAck(c.id);
  }

  /** 巡检时清掉超时的僵尸命令（agent 崩了 / 命令卡死无回音）。 */
  reapStale(now = Date.now()): number {
    const before = this.queue.size;
    this.reapLost(now);
    return before - this.queue.size;
  }

  /** 心跳：agent 每次 POST（含空包）都刷新在线时间。 */
  tick(): void {
    this.lastSeen = Date.now();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 下发一帧 cmd。签名是异步的，所以整个写动作挂在 chain 上串行执行——
   * 否则 attach() 重发多条排队命令时会乱序（后发的先到，agent 会以为是先发的那条）。
   */
  private push(c: ShellCmd): void {
    if (!this.ctl) return;
    // 没配签名器 = 不需要异步，直接同步写（保持 attach 后帧立即可见的旧行为）
    if (!this.signer) {
      this.write(`data: ${JSON.stringify(this.frame(c))}\n\n`);
      return;
    }
    this.chain = this.chain
      .then(async () => {
        if (!this.ctl) return;
        if (!c.sig) {
          try {
            c.sig = await this.signer!(c.id, c.cmd);
          } catch {
            // 签不出来就不下发：agent 会按「未签名」拒绝，总好过发一条假签名
            return;
          }
        }
        this.write(`data: ${JSON.stringify(this.frame(c))}\n\n`);
      })
      .catch(() => {});
  }

  /** cmd 帧的载荷（quiet → q=1；有签名才带 sig 字段）。 */
  private frame(c: ShellCmd): Record<string, unknown> {
    const payload: Record<string, unknown> = { t: "cmd", id: c.id, cmd: c.cmd };
    if (c.quiet) payload.q = 1; // agent 不记录命令原文（含密钥）
    if (c.sig) payload.sig = c.sig;
    return payload;
  }

  private write(s: string): void {
    try {
      this.ctl?.enqueue(enc.encode(s));
    } catch {
      // 客户端已断开：标记离线，下次 attach 重新建立
      this.detach();
    }
  }

  /** 把缓冲的输出拼成一条消息推出去（done 时附 exit/cwd 收尾行）。 */
  private async flush(id: string, done = false, exit: number | null = null, cwd: string | null = null): Promise<void> {
    const cmd = this.queue.get(id);
    const b = this.buf.get(id);
    if (!cmd || !b) return;
    if (cwd) this.lastCwd = cwd;
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }

    let out = b.parts.join("").replace(/\n+$/, "");
    b.parts = [];

    if (!b.echoed) {
      b.echoed = true;
      // 有 label 用 label（Gemini 那种长脚本不该整段刷屏）；echo=false 完全不回显
      if (cmd.echo !== false) {
        const shown = cmd.label ?? cmd.cmd;
        out = out ? `$ ${shown}\n${out}` : `$ ${shown}`;
      }
    }
    if (done) {
      out += footerNote(exit, cwd, cmd.hideCwd === true);
    }
    if (!out.trim()) {
      if (done) {
        this.buf.delete(id);
        this.queue.delete(id);
      }
      return;
    }

    // markdown 命令（AI 会话）的输出走 MarkdownV2；代码块被 chunkOutput 劈开时
    // 单条消息里的未闭合 ``` 会被发送端的转义器当普通文本降级 —— sendMessage
    // 自带「V2 被拒 → 纯文本重发」兜底，不会 400，最差退化为字面量（与现状一致）。
    for (const part of chunkOutput(capOutput(out, this.maxChars), this.chunkLimit)) {
      if (part.trim()) await this.send(cmd.chatId, part, { markdown: cmd.markdown === true });
    }
    if (done) {
      this.clearAck(id);
      this.buf.delete(id);
      this.queue.delete(id);
    }
  }
}
