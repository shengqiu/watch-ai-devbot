/** 从 Telegram Update 里提取我们关心的信息（chat_id / user_id / 文本 / 语音）。 */
import type { TgUpdate } from "./types";

export interface Incoming {
  updateId: number;
  /** 会话 id（私聊即用户 id），用于回消息、白名单、历史、限流的键 */
  chatId: string;
  /** 发送者 id（群聊时与 chatId 不同） */
  userId: string;
  /** 消息 id（回执/编辑用；密钥不再经聊天发送，故不再有删除带密钥消息的逻辑） */
  messageId: number | null;
  /** 文本内容（text 或 caption），已 trim */
  text: string;
  /** 语音 file_id（有语音时非空） */
  voiceFileId: string | null;
  /** 语音 mime（audio/ogg 等） */
  voiceMime: string | null;
}

/** 提取消息；非消息类 update（如 callback_query）返回 null。 */
export function extractIncoming(update: TgUpdate): Incoming | null {
  const m = update.message;
  if (!m || !m.chat) return null;
  const voice = m.voice ?? m.audio;
  const chatId = String(m.chat.id);
  return {
    updateId: update.update_id,
    chatId,
    userId: m.from ? String(m.from.id) : chatId,
    messageId: typeof m.message_id === "number" ? m.message_id : null,
    text: (m.text ?? m.caption ?? "").trim(),
    voiceFileId: voice?.file_id ?? null,
    voiceMime: voice?.mime_type ?? null,
  };
}
