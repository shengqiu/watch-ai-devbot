/**
 * GitHub Codespaces REST 薄客户端（Worker 内运行）。
 *
 * 用途：Telegram 指令「开始开发/停止开发」→ 远程开关 codespace 开发机。
 * 端点（均需 Codespaces 用户权限的 fine-grained PAT 或 codespace scope）：
 *   GET  /user/codespaces/{name}        查询状态
 *   POST /user/codespaces/{name}/start  开机
 *   POST /user/codespaces/{name}/stop   停机
 *
 * 注意：单查必须用 codespace 的 name（形如 24h-jwp7vwxvx6hpp7），
 * 用数字 id 会 404（实测）。
 */

const API_BASE = "https://api.github.com";

export type CodespaceState =
  | "Shutdown"
  | "ShuttingDown"
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
      return "运行中";
    case "Shutdown":
      return "已关机";
    case "ShuttingDown":
      return "正在关机";
    case "Provisioning":
    case "ProvisioningWithWarning":
    case "Creating":
      return "启动中";
    case "Rebuilding":
      return "重建中";
    case "Deleted":
      return "已删除";
    case "Failed":
      return "启动失败";
    default:
      return `未知(${state})`;
  }
}

/**
 * 「开始开发」协议（两次查询、不循环）——分两阶段执行：
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
    return { reply: `查询 codespace 状态失败：${errBrief(e)}`, scheduleCheck: false, wasAvailable: false };
  }

  if (st.state === "Available") {
    return { reply: "开发机已在运行中 ✓", scheduleCheck: false, wasAvailable: true };
  }
  if (st.state === "Deleted" || st.state === "Failed") {
    return { reply: `开发机状态异常（${describeState(st.state)}），需要到 GitHub 页面处理。`, scheduleCheck: false, wasAvailable: false };
  }

  try {
    await client.start();
  } catch (e) {
    return { reply: `启动请求失败：${errBrief(e)}`, scheduleCheck: false, wasAvailable: false };
  }
  return { reply: "开发机未开机，已发出启动指令，正在启动 ⏳（30 秒后自动确认）", scheduleCheck: true, wasAvailable: false };
}

/** 阶段 2（alarm 回调）：二查状态并产出最终回复。ok=true 表示确已开机。 */
export async function checkBoot(client: CodespaceClient): Promise<{ reply: string; ok: boolean }> {
  let state: CodespaceState;
  try {
    state = (await client.status()).state;
  } catch {
    return { reply: "开机确认查询失败，稍后发「开发机状态」手动确认。", ok: false };
  }
  return state === "Available"
    ? { reply: "开发机启动成功 ✓（运行中）", ok: true }
    : { reply: `开机失败：30 秒后仍为「${describeState(state)}」，可再发一次「开始开发」。`, ok: false };
}

/** 「停止开发」：幂等停机。 */
export async function stopCodespace(client: CodespaceClient): Promise<string> {
  let st: CodespaceStatus;
  try {
    st = await client.status();
  } catch (e) {
    return `查询 codespace 状态失败：${errBrief(e)}`;
  }
  if (st.state === "Shutdown") return "开发机已经是关机状态 ✓";
  if (st.state === "Deleted") return "开发机已删除，无需停机。";
  try {
    await client.stop();
    return "已发出停机指令 ✓（后台约 40 秒内完成，可用「开发机状态」确认）";
  } catch (e) {
    return `停机请求失败：${errBrief(e)}`;
  }
}

function errBrief(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 120);
}
