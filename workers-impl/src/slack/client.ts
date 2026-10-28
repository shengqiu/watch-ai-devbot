/**
 * Slack Web API 客户端（极薄封装），与 telegram/client.ts 同构。
 *
 * 纯 HTTPS REST（chat.postMessage / chat.delete / auth.test），
 * 无 WebSocket（Socket Mode 需要常驻连接，与 CF Workers 免费档冲突），
 * 无签名——出站请求带 Bot User OAuth Token 即可。
 *
 * 发送端限速：Slack 按方法限速，chat.postMessage 是 ~1 msg/s（短时突发放宽），
 * 收到 429 按 Retry-After 头等待重试（与 v4.21 的 Telegram 重试同策略）。
 *
 * 文档：https://api.slack.com/methods
 */
import type { SlackPostResult } from "./types";
import { mdToSlack } from "./markdown";

/** 单个 chunk 的字符上限（Slack chat.postMessage text 上限约 40000 字符，留余量） */
export const SLACK_CHUNK_LIMIT = 3800;

export class SlackClient {
  constructor(
    /** Bot User OAuth Token（xoxb-...） */
    private readonly token: string,
    /** API 根地址，默认官方 https://slack.com/api；由 src/config.ts 注入 */
    private readonly apiBase: string = "https://slack.com/api",
  ) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    const resp = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await resp.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!j.ok) {
      // 抛错文案带上 error code（rate_limited 等），上层好按它重试
      throw new Error(`slack ${method} 失败: ${j.error ?? resp.status}`);
    }
    return j as T;
  }

  /**
   * 发消息（带 Slack mrkdwn 渲染 + 429 限速重试）。
   * 与 TelegramClient.sendMessage 的 MarkdownV2 + 400 降级策略同构：
   *   - 文本先经 mdToSlack 安全转换（LLM 的 ``` 代码块 → Slack 代码块）
   *   - mrkdwn 渲染失败（4xx internal_error 等）→ 纯文本重发
   *   - opts.markdown=false（普通 shell 命令输出，任意字节流）→ 直接纯文本，
   *     不做转换（与 Telegram 侧 ShellCmd.markdown 标志语义一致，v4.23）
   */
  async sendMessage(channel: string, text: string, opts?: { markdown?: boolean }): Promise<SlackPostResult> {
    const rich = opts?.markdown !== false; // 默认富文本（reply 路径的 LLM 回答）；显式 false 才纯文本
    const payload = rich ? mdToSlack(text) : text;
    const chunks = this.chunk(payload);
    let last: SlackPostResult = { ok: true };
    for (const c of chunks) {
      last = await this.postWithRetry(channel, c, rich);
    }
    return last;
  }

  private async postWithRetry(channel: string, text: string, mrkdwn: boolean): Promise<SlackPostResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call<SlackPostResult>("chat.postMessage", {
          channel,
          text,
          mrkdwn,
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 限速：完整回传长输出时连发几十条是常态（v4.21 同款问题），按退避等
        const ra = /rate_limited/i.test(msg);
        if (ra && attempt <= 5) {
          const waitMs = 1200 * attempt; // Slack 不在 error 文本里带秒数，保守退避
          console.warn(`[slack] 429 限速，${waitMs}ms 后重发（第 ${attempt} 次）`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        // 渲染类失败：降级纯文本重发一次（与 Telegram 的 MarkdownV2 降级同构）
        if (attempt === 1 && !ra && /HTTP 4|internal_error/i.test(msg)) {
          console.warn(`[slack] mrkdwn 发送被拒，降级纯文本重发：${msg.slice(0, 150)}`);
          try {
            return await this.call<SlackPostResult>("chat.postMessage", {
              channel,
              text,
              unfurl_links: false,
              unfurl_media: false,
            });
          } catch {
            /* 降级也失败 → 走外层日志 */
          }
        }
        console.error(`[slack] 发送失败：${msg.slice(0, 200)}`);
        return { ok: false, error: msg.slice(0, 200) };
      }
    }
  }

  /** 按 Slack 上限分块（换行优先，其次空格，最后硬切）。 */
  private chunk(text: string, limit = SLACK_CHUNK_LIMIT): string[] {
    if (text.length <= limit) return text ? [text] : [];
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf("\n", limit);
      if (cut <= limit / 2) cut = rest.lastIndexOf(" ", limit);
      if (cut <= limit / 4) cut = limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest) out.push(rest);
    return out;
  }

  /** 验证 token 与 bot 身份（部署后自检用，等价 Telegram getMe）。 */
  authTest(): Promise<{ ok: boolean; user_id?: string; user?: string; team?: string }> {
    return this.call("auth.test", {});
  }
}
