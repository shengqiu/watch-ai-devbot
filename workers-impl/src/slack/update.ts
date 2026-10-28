/**
 * Slack 事件/指令 → 统一 Incoming 提取（与 telegram/update.ts 同构）。
 *
 * 关键点：
 *   1. **chatId 用 `slack:<channel_id>` 前缀**——DO 内所有按 chatId 的状态
 *     （验证会话/历史/限流/暂存命令/看门狗推送目标）共用一套键空间，
 *     前缀隔离后 Telegram 与 Slack 各自独立，互不串台。
 *   2. **bot_id 过滤**：自己（或其它 app）发的消息必须忽略，否则「回包 →
 *      收到自己的回包 → 再处理 → 再回包」无限自言自语。
 *   3. **Slash Commands 天然是斜杠指令**：`/boot` 会被 Telegram 线路的
 *      matchCommand 认出（指令表里 name 就是 boot），text 作为参数拼回去。
 *   4. **message 子事件过滤**：只认新消息（无 subtype 或 subtype=message）；
 *      message_changed/message_deleted 是编辑回显，不处理。
 *   5. 语音：Slack 语音条是 file share（需另走 files.info + 下载，且多为 mp4/m4a
 *      容器）——v1 不做转写，回提示让用户发文字（手表场景本来就走 Telegram）。
 */
import type { SlackCommandForm, SlackEventWrapper, SlackUrlVerification } from "./types";

/** 统一入站消息（与 telegram/update.ts 的 Incoming 字段语义一致）。 */
export interface SlackIncoming {
  /** 去重键（event_id 或 command 的 ts 组合） */
  updateId: string;
  /** `slack:<channel_id>`——DO 状态键空间的命名空间隔离前缀 */
  chatId: string;
  /** 发送者 user id（白名单用） */
  userId: string;
  text: string;
}

/** url_verification 握手识别（配置 Request URL 时 Slack 发的唯一一种 GET 语义请求）。 */
export function isUrlVerification(body: unknown): body is SlackUrlVerification {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { type?: string }).type === "url_verification" &&
    typeof (body as { challenge?: unknown }).challenge === "string"
  );
}

/**
 * 从 Events API 包装里提取消息。非 message 事件 / bot 消息 / 空文本 → null。
 * 返回 null 时调用方应 200 空回（Slack 只认 HTTP 层，不 care 业务）。
 */
export function extractSlackEvent(wrapper: SlackEventWrapper): SlackIncoming | null {
  if (wrapper.type !== "event_callback") return null;
  const ev = wrapper.event;
  if (!ev || ev.channel === undefined || ev.channel === null || ev.channel === "") return null;
  // bot（含自己）的消息：忽略——自言自语死循环是 IM bot 的经典事故
  if (ev.bot_id) return null;
  // 只处理新消息；message_changed / message_deleted 等子事件不碰
  if (ev.subtype && ev.subtype !== "message") return null;
  const text = (ev.text ?? "").trim();
  if (!text) return null;
  const eid = wrapper.event_id || ev.ts || `${Date.now()}`;
  return {
    updateId: `slack:${eid}`,
    chatId: `slack:${ev.channel}`,
    userId: ev.user ?? "",
    text,
  };
}

/**
 * Slash Commands 表单 → SlackIncoming。
 * `command`（如 /boot）去掉斜杠后与 `text` 拼成一条文本，交给与 Telegram
 * 完全相同的 matchCommand 流水线（指令表是共享的单一真相源）。
 */
export function extractSlackCommand(form: SlackCommandForm): SlackIncoming | null {
  const cmd = (form.command ?? "").trim();
  const chan = (form.channel_id ?? "").trim();
  if (!cmd.startsWith("/") || !chan) return null;
  const text = `${cmd.slice(1)} ${(form.text ?? "").trim()}`.trim();
  return {
    updateId: `slack:cmd:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    chatId: `slack:${chan}`,
    userId: form.user_id ?? "",
    text,
  };
}

/**
 * Events API 的文本会带 <@U123ABC> 用户提及与 <!here> 特殊提及——
 * 原样进 shell/LLM 都是噪音。归一化：提及替换为 @用户名 占位（拿不到用户名时
 * 直接去掉尖括号）。纯函数、幂等，可单测。
 */
export function normalizeSlackText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)>/g, (_m, id: string) => `@user_${id}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<#([A-Z0-9]+)\|?[^>]*>/g, "#channel");
}
