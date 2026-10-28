/**
 * Slack Events API / Slash Commands 的最小类型（只声明我们用到的字段）。
 *
 * 官方文档：
 *   https://api.slack.com/apis/connections/events-api
 *   https://api.slack.com/interactivity/slash-commands
 *
 * 设计与 telegram/types.ts 同构：类型只覆盖我们真正消费的字段，
 * 其余字段一律用宽松类型接住（不认识的字段不影响处理）。
 */

/** url_verification 握手（配置 Request URL 时 Slack 会发一次） */
export interface SlackUrlVerification {
  token?: string;
  challenge: string;
  type: "url_verification";
}

/** message 事件里的文本（简化） */
export interface SlackMessage {
  ts?: string;
  text?: string;
  /** 频道 id（C 开头） */
  channel?: string;
  /** 发送者 user id（U/W 开头） */
  user?: string;
  /** bot id（B 开头）：有它 = 消息来自 app/bot，必须忽略，否则会自言自语死循环 */
  bot_id?: string;
  /** app 对自己的 message 变更/删除子事件（message_changed 等）——只关心新消息 */
  subtype?: string;
  /** 文件分享（语音/文件上传）：voice 无法直接转写时提示用户 */
  files?: Array<{ id?: string; name?: string; mimetype?: string }>;
}

/** Events API 事件包装：{ team_id, event: {...} } */
export interface SlackEventWrapper {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  /** 事件 id（去重键） */
  event_id?: string;
  /** 事件类型（我们只处理 message） */
  type?: string;
  event?: SlackMessage;
}

/** Slash Commands 表单字段（application/x-www-form-urlencoded） */
export interface SlackCommandForm {
  token?: string;
  team_id?: string;
  /** 命令名（/boot 等，不带参数） */
  command?: string;
  text?: string;
  /** 响应 URL（3 秒内没回复时可用它异步补发；我们同步回，基本用不到） */
  response_url?: string;
  /** 触发者 user id */
  user_id?: string;
  channel_id?: string;
}

/** chat.postMessage 的响应（只关心 ok 与 error） */
export interface SlackPostResult {
  ok: boolean;
  error?: string;
  ts?: string;
}
