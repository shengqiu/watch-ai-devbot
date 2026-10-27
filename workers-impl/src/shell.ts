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
  return `${text.slice(0, head)}\n⋯⋯ 省略 ${text.length - max} 字符 ⋯⋯\n${text.slice(text.length - tail)}`;
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

// ------------------------------------------------------------------ 状态机

export interface ShellCmd {
  id: string;
  cmd: string;
  chatId: string;
  at: number;
  /** 回显给用户看的标题（缺省 = 命令原文）。长脚本/带密钥的命令用得上 */
  label?: string;
  /** false = 不回显 `$ 命令` 前缀（命令原文含敏感信息时） */
  echo?: boolean;
  /** true = 不把命令原文写进 agent 日志（含密钥时） */
  quiet?: boolean;
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
}

export interface ShellOutMsg {
  id: string;
  /** 增量输出片段（已清洗） */
  text?: string;
  /** true = 这条命令跑完了 */
  done?: boolean;
  exit?: number | null;
  cwd?: string | null;
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
   * 下行命令签名器（HMAC）。有它 → 每帧 cmd 带 sig，agent 验签后才执行。
   * 这是「只有这台 Worker 能让这台开发机干活」的落地方式：签名私钥只在
   * Cloudflare secret 里，agent 侧只需同一个密钥算出来的结果对得上。
   */
  signer?: (id: string, cmd: string) => Promise<string>;
}

type Sender = (chatId: string, text: string) => Promise<void>;

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

  private readonly flushMs: number;
  private readonly chunkLimit: number;
  private readonly maxChars: number;
  private readonly staleMs: number;
  private readonly cmdTtlMs: number;
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
    this.cmdTtlMs = opts.cmdTtlMs ?? 900_000;
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

  /** 诊断快照：agent 是否在线、上次心跳、排队数、最近 cwd。 */
  snapshot(): { online: boolean; seenAt: number; pending: number; cwd: string | null } {
    return { online: this.online(), seenAt: this.lastSeen, pending: this.queue.size, cwd: this.lastCwd };
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
    this.hb = setInterval(() => {
      this.write(": hb\n\n");
      if (this.ctl) this.lastSeen = Date.now();
    }, 20_000);
    this.write(`data: ${JSON.stringify({ t: "hello", at: Date.now() })}\n\n`);
    for (const c of this.queue.values()) this.push(c);
  }

  /** agent 断开（SSE cancel / 错误）后清理。 */
  detach(): void {
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = null;
    }
    this.ctl = null;
    // 未完成的命令要通知用户，否则消息永远等不到回音
    for (const [id, cmd] of this.queue) {
      void this.send(cmd.chatId, `⚠️ shell 连接断开，命令未执行完：${cmd.label ?? cmd.cmd}`);
      this.buf.delete(id);
    }
    this.queue.clear();
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
          "⌨️ shell 未连接：开发机里的 shell agent 没连上来。",
          "",
          "· 刚开机的话等 30 秒再试（postStart 自动拉起）",
          "· 若一直不在线，在 codespace 终端执行：node shell-agent/agent.mjs",
        ].join("\n"),
      };
    }
    // 单飞：一次只让一条命令在跑，避免输出交错难读
    if (this.queue.size > 0) {
      // 一定要说清「跑的是哪条」：只说「上一条还在跑」，用户根本不知道是
      // 刚才的 npm 安装、还是 gemini 在想、还是自己十几分钟前发的什么。
      const cur = [...this.queue.values()][0];
      const shown = cur.label ?? cur.cmd.split("\n")[0].slice(0, 60);
      return {
        ok: false,
        message: `⌨️ 上一条命令还在跑：${shown}\n等它结束，或发 /ctrlc 中断（会连同队列一起清掉）。`,
      };
    }
    const id = `c${++this.seq}_${Date.now().toString(36)}`;
    const rec: ShellCmd = { id, cmd: text, chatId, at: Date.now() };
    if (opts.label) rec.label = opts.label;
    if (opts.echo === false) rec.echo = false;
    if (opts.quiet) rec.quiet = true;
    this.queue.set(id, rec);
    this.buf.set(id, { parts: [], chars: 0, timer: null, echoed: false });
    this.push(rec);
    return { ok: true, id };
  }

  /**
   * 下发 Ctrl-C（中断当前前台命令）。
   *
   * 同样带签名：agent 对「未签名的控制帧」一律忽略。否则一条伪造的 ctrlc
   * 就能反复打断你正在跑的构建，属于低成本骚扰。
   */
  sendCtrlC(): string | null {
    if (!this.online()) return "⌨️ shell 未连接。";
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
      this.buf.delete(id);
    }
    this.queue.clear();
    return dropped;
  }

  /** agent 回传输出（可能是增量片段，也可能是 done 收尾包）。 */
  async onOutput(msg: ShellOutMsg): Promise<void> {
    const rec = this.queue.get(msg.id);
    if (!rec) return; // 命令已被清理/超时，忽略迟到的包
    const b = this.buf.get(msg.id);
    if (!b) return;

    if (msg.text) {
      b.chars += msg.text.length;
      if (b.chars <= this.maxChars) b.parts.push(msg.text);
      else if (b.chars - msg.text.length < this.maxChars) {
        b.parts.push("\n⋯⋯ 输出过长，已截断 ⋯⋯\n");
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

  /** 巡检时清掉超时的僵尸命令（agent 崩了 / 命令卡死无回音）。 */
  reapStale(now = Date.now()): number {
    let n = 0;
    for (const [id, cmd] of this.queue) {
      if (now - cmd.at > this.cmdTtlMs) {
        void this.send(
          cmd.chatId,
          `⚠️ 命令超过 ${Math.round(this.cmdTtlMs / 60_000)} 分钟无回音，已放弃：${cmd.label ?? cmd.cmd}`,
        );
        this.buf.delete(id);
        this.queue.delete(id);
        n++;
      }
    }
    return n;
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
      out += `\n— exit ${exit ?? "?"}${cwd ? ` · ${cwd}` : ""}`;
    }
    if (!out.trim()) {
      if (done) {
        this.buf.delete(id);
        this.queue.delete(id);
      }
      return;
    }

    for (const part of chunkOutput(capOutput(out, this.maxChars), this.chunkLimit)) {
      if (part.trim()) await this.send(cmd.chatId, part);
    }
    if (done) {
      this.buf.delete(id);
      this.queue.delete(id);
    }
  }
}
