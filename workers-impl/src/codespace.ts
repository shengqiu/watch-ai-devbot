/**
 * GitHub Codespaces REST 薄客户端（Worker 内运行）。
 *
 * 用途：Telegram 指令 /boot、/halt → 远程开关 codespace 开发机。
 * 端点（均需 Codespaces 用户权限的 fine-grained PAT 或 codespace scope）：
 *   GET  /user/codespaces/{name}        查询状态
 *   POST /user/codespaces/{name}/start  开机
 *   POST /user/codespaces/{name}/stop   停机
 *
 * 注意：单查必须用 codespace 的 name（形如 24h-977gg5v9vcp5wq），
 * 用数字 id 会 404（实测）。
 */

const API_BASE = "https://api.github.com";

export type CodespaceState =
  | "Shutdown"
  | "ShuttingDown"
  | "Queued"
  | "Available"
  | "Provisioning"
  | "ProvisioningWithWarning"
  | "Creating"
  | "Rebuilding"
  | "Deleted"
  | "Failed"
  | "Unknown";

export interface CodespaceStatus {
  name: string;
  state: CodespaceState;
  /** webhook 完整 URL（GitHub 预签的 codespace 内 SSH 通道入口），可能为 null */
  sshUrl: string | null;
  /** 最近使用时间（ISO8601；VS Code/网页/SSH 连接与交互都会刷新）——看门狗双信号用 */
  lastUsedAt: string | null;
}

export class CodespaceClient {
  constructor(
    private readonly token: string,
    private readonly name: string,
  ) {}

  private async call(path: string, method: "GET" | "POST" = "GET"): Promise<Record<string, unknown>> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub REST API 强制要求 User-Agent；CF Workers fetch 默认不发送（实测 403）
        "User-Agent": "watch-ai-assistant/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async status(): Promise<CodespaceStatus> {
    const d = await this.call(`/user/codespaces/${this.name}`);
    return {
      name: this.name,
      state: (d.state as CodespaceState) ?? "Unknown",
      sshUrl: (d.webshell_url ?? null) as string | null,
      lastUsedAt: (d.last_used_at ?? null) as string | null,
    };
  }

  async start(): Promise<CodespaceState> {
    const d = await this.call(`/user/codespaces/${this.name}/start`, "POST");
    return (d.state as CodespaceState) ?? "Unknown";
  }

  async stop(): Promise<CodespaceState> {
    const d = await this.call(`/user/codespaces/${this.name}/stop`, "POST");
    return (d.state as CodespaceState) ?? "Unknown";
  }
}

/** 状态 → 用户可读中文（Telegram 回包用）。 */
export function describeState(state: CodespaceState): string {
  switch (state) {
    case "Available":
      return "running";
    case "Shutdown":
      return "shut down";
    case "ShuttingDown":
      return "shutting down";
    case "Provisioning":
    case "ProvisioningWithWarning":
    case "Creating":
      return "starting";
    case "Queued":
      return "queued";
    case "Rebuilding":
      return "rebuilding";
    case "Deleted":
      return "deleted";
    case "Failed":
      return "failed to start";
    default:
      return `unknown(${state})`;
  }
}

/**
 * /boot 协议（两次查询、不循环）——分两阶段执行：
 *
 *   阶段 1（webhook 请求内同步完成）：
 *     查状态；已开机 → 回「已在运行」；未开机 → POST start → 立即回「正在启动」
 *   阶段 2（DO alarm 30 秒后唤醒执行）：
 *     二查状态 → 回「成功开机」或「开机失败」
 *
 * 为什么要 alarm 而不是 sleep：webhook 应答后 DO 可能被运行时驱逐，
 * sleep 中的 waitUntil 任务会随之中断；setAlarm 持久化、驱逐后也能准时唤醒。
 */
export const BOOT_CHECK_DELAY_MS = 30_000;
/** 启动未完成时的重查间隔（Provisioning/Queued 都属于「还没好」，不能判失败）。 */
export const BOOT_RETRY_DELAY_MS = 15_000;
/** 最多重查次数：30s 首查 + 8×15s ≈ 2.5 分钟，足够冷启动一台 2 核机。 */
export const BOOT_MAX_ATTEMPTS = 8;

/** 仍在上机中的状态：既不算成功也不算失败，继续等。 */
const BOOTING_STATES: ReadonlySet<CodespaceState> = new Set<CodespaceState>([
  "Queued",
  "Provisioning",
  "ProvisioningWithWarning",
  "Creating",
]);

export interface BootPhase1 {
  /** 立即回复（发给用户） */
  reply: string;
  /** true → 调用方需安排 30s 后的二次确认 */
  scheduleCheck: boolean;
  /** true → 本来就已开机（无需安排二查；用于看门狗起点判定） */
  wasAvailable: boolean;
}

/** 阶段 1：状态检查 + 触发启动 + 即时回复。 */
export async function beginBoot(client: CodespaceClient): Promise<BootPhase1> {
  let st: CodespaceStatus;
  try {
    st = await client.status();
  } catch (e) {
    return { reply: `Failed to query codespace state: ${errBrief(e)}`, scheduleCheck: false, wasAvailable: false };
  }

  if (st.state === "Available") {
    return { reply: "Dev machine already running ✓", scheduleCheck: false, wasAvailable: true };
  }
  if (st.state === "Deleted" || st.state === "Failed") {
    return { reply: `Dev machine in an odd state (${describeState(st.state)}); handle it on the GitHub page.`, scheduleCheck: false, wasAvailable: false };
  }
  // 已经在启动途中（连发两次 /boot / GitHub 侧刚拉起）：不要再 POST start（会 409），
  // 直接进入观察模式——用户真正想要的是「好了没」的答案。
  if (BOOTING_STATES.has(st.state)) {
    return {
      reply: `Dev machine ${describeState(st.state)} ⏳ I'll report once it's up.`,
      scheduleCheck: true,
      wasAvailable: false,
    };
  }

  try {
    await client.start();
  } catch (e) {
    return { reply: `Boot request failed: ${errBrief(e)}`, scheduleCheck: false, wasAvailable: false };
  }
  return { reply: "Dev machine was off; boot requested, starting ⏳ (I'll tell you when it's up)", scheduleCheck: true, wasAvailable: false };
}

export interface BootCheck {
  /** 给用户的最终文案；pending=true 时为空串（此时不要发消息） */
  reply: string;
  /** true = 确认已在运行 */
  ok: boolean;
  /** true = 还在启动途中，调用方应稍后重查（不是失败） */
  pending: boolean;
}

/**
 * 阶段 2（alarm 回调）：二查状态。
 *
 * 三种结局：Available → 成功（发消息）；仍在启动 → pending（静默重排，别骚扰用户）；
 * 其余 → 失败（发消息）。早期版本只有「成功/失败」两态，30 秒时机器常卡在
 * Provisioning，会被误报成开机失败。
 */
export async function checkBoot(client: CodespaceClient): Promise<BootCheck> {
  let state: CodespaceState;
  try {
    state = (await client.status()).state;
  } catch {
    return { reply: "Boot confirmation query failed; check /cs manually in a bit.", ok: false, pending: false };
  }
  if (state === "Available") {
    return { reply: "Dev machine is up ✓ running; send commands (the shell connects in ~10-30s)", ok: true, pending: false };
  }
  if (BOOTING_STATES.has(state)) {
    return { reply: "", ok: false, pending: true };
  }
  return { reply: `Boot failed: still '${describeState(state)}'; try /boot once more.`, ok: false, pending: false };
}

/** 等太久仍未好时的收尾文案。 */
export function bootTimeoutReply(): string {
  return "Dev machine is still starting (~2.5 min waited). Check /cs in a bit, or send /boot once more.";
}

/** /halt：幂等停机。 */
export async function stopCodespace(client: CodespaceClient): Promise<string> {
  let st: CodespaceStatus;
  try {
    st = await client.status();
  } catch (e) {
    return `Failed to query codespace state: ${errBrief(e)}`;
  }
  if (st.state === "Shutdown") return "Dev machine already shut down ✓";
  if (st.state === "Deleted") return "Dev machine was deleted; nothing to stop.";
  try {
    await client.stop();
    return "Stop requested ✓ (done in ~40s in the background; confirm with /cs)";
  } catch (e) {
    return `Stop request failed: ${errBrief(e)}`;
  }
}

function errBrief(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 120);
}
