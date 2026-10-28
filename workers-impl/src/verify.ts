/**
 * 身份验证会话（纯逻辑，可单测）。
 *
 * 设计（2026-10-26 用户定）：
 *   - 白名单用户长时间无互动后，须回答验证问题才恢复服务；
 *     未验证状态下的一切问题/指令都不转发给 LLM / Codespace。
 *   - 验证通过 → 会话有效 VERIFY_SESSION_MIN 分钟（默认 10，2026-10-28 由 30 收紧），
 *     期间任何交互自动滑动延续；**10 分钟无交互即失效**，须重新验证。
 *
 * 设备限制说明：Telegram Bot API 不提供发送设备信息——设备限制由
 * 「账号白名单（ALLOWED_USERS）+ 本验证问题」共同达成：
 * 只有登录了该 Telegram 账号的设备（iPhone/Watch/Mac 等）能发消息。
 */

export interface VerifyState {
  /** 验证会话到期时间戳（ms）；0/过去 = 未验证 */
  exp: number;
  /**
   * 验证词指纹（2026-10-27 加）：换词后旧会话立即失效，不用等滑动窗口走完。
   * 老数据没有这个字段（= 空）→ 与当前指纹不匹配 → 要求重新验证一次。
   */
  fp?: string;
}

/**
 * 验证会话默认时长（分钟）：**10 分钟无交互即失效**。
 *
 * 2026-10-28 用户要求「严格的 10 分钟不交互就验证」，由 30 收紧到 10。
 * 语义是**滑动窗口**：每次交互（含聊天）都把到期时间推后 10 分钟；
 * 只要连续 10 分钟没有任何消息，就必须重新回答验证词。
 *
 * 导出成常量而不是散落在 bot-do 里写死，是为了让单测能锁住这个值——
 * 否则「默认值被改回 30」这种回归没有任何测试会红。
 */
export const VERIFY_SESSION_DEFAULT_MIN = 10;

/**
 * 验证词指纹（djb2 变体，非加密用途）：只用来判断「验证词是否被换过」，
 * 不是防碰撞的凭证——真正的凭证是那个不在源码里的 secret 本身。
 * 纯函数、无依赖，方便单测。
 */
export function answerFingerprint(answer: string): string {
  let h = 5381;
  const s = normalizeAnswer(answer);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function isVerified(state: VerifyState | undefined, now: number, fp = ""): boolean {
  if ((state?.exp ?? 0) <= now) return false;
  return (state?.fp ?? "") === fp;
}

/** 下一次到期时间（滑动窗口）。 */
export function nextExpiry(now: number, sessionMs: number): number {
  return now + sessionMs;
}

/** 归一化验证答案：去首尾空白与标点（「答案。」「 答案！」→「答案」）。 */
export function normalizeAnswer(text: string): string {
  return text
    .trim()
    .replace(/^[。．.!！?？,，、~～\s]+/, "")
    .replace(/[。．.!！?？,，、~～\s]+$/, "");
}

/**
 * 验证答案匹配（2026-10-27 用户要求：**严格**，只允许答案本身通过）。
 *
 * 规则：仅忽略首尾空白（手机输入法/复制粘贴常带空格），其余一律按**完整字符串**比较。
 *   ✓ 「哈哈」  「 哈哈 」
 *   ✗ 「哈哈。」「哈哈！」「哈哈哈」「哈 哈」「哈」「妈妈」「」…
 *
 * 之前的实现会把首尾标点也剥掉，等于放行了 `哈哈。`/`哈哈！` 这类变体——
 * 用户明确表示只要那一个词能过，所以收紧为精确匹配。
 */
export function isAnswerMatch(text: string, answer: string): boolean {
  const a = text.trim();
  const b = answer.trim();
  return a.length > 0 && a === b;
}

/** 验证问题文案（用户指定）。 */
export const CHALLENGE_TEXT = "我可以回答你的问题，但我要知道你是谁...";

/**
 * 「验证前那条命令」的暂存（2026-10-27 用户要求）：
 *
 * 场景——会话过期后你先发了一条命令，bot 要求验证；以前验证通过后你还得把命令重发一遍。
 * 现在未验证时收到的那条消息会被暂存，验证通过后自动补执行，用户只需输验证词。
 *
 * 只有 10 分钟保鲜期：隔夜的那条命令不该在你第二天验证时突然跑起来。
 */
export const PENDING_CMD_TTL_MS = 10 * 60_000;

export interface PendingCmd {
  /** 命令原文 */
  cmd: string;
  /** 收到时间戳（ms） */
  at: number;
}

/** 暂存命令是否仍可补执行（空内容、超时、结构不对都算不可）。 */
export function shouldReplay(p: PendingCmd | undefined | null, now: number): p is PendingCmd {
  if (!p || typeof p.cmd !== "string") return false;
  if (p.cmd.trim().length === 0) return false;
  const age = now - p.at;
  return age >= 0 && age <= PENDING_CMD_TTL_MS;
}

/** 暂存的命令要显示回用户（截断，避免长脚本刷屏）。 */
export function previewCmd(cmd: string, max = 120): string {
  const oneLine = cmd.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}⋯`;
}

/**
 * 中文指令词（仍需认出来，否则验证后不会补执行）。
 * 注意：开关机的口语词（开始开发 / 停止开发 / 关机）已按用户要求移除，
 * 现在只有 /boot 与 /halt —— 所以这里也不再包含它们。
 */
const CONTROL_WORDS = /^(开发机状态|用量|额度)([，。!！\s]*)$/;

/**
 * 这条消息像不像「要执行的命令」——决定验证后要不要补执行。
 *
 * 为什么要判断：验证失败的尝试（比如输错成「爸爸」）如果也被暂存，
 * 等你正确验证后就会去执行一句「爸爸」，回一堆 command not found，纯噪音。
 * 判断标准放宽（有 ASCII 字符就算），宁可多执行不可漏执行——真正的命令几乎都带
 * 字母/数字/斜杠/横杠；纯中文寒暄则不会被当命令跑起来。
 */
export function looksLikeCommand(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (CONTROL_WORDS.test(t)) return true;
  if (t.startsWith("/")) return true; // 斜杠指令（/boot /halt /ctrlc …）
  return /[A-Za-z0-9_./~$@%^*+=|<>-]/.test(t);
}
