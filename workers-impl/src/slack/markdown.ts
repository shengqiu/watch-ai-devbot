/**
 * LLM markdown → Slack mrkdwn 安全转换。
 *
 * 与 telegram/markdown.ts（mdToV2）同构的策略，但 Slack 的规则更宽松：
 *   - Slack mrkdwn **没有**强制转义字符集（不转义也不会 400），转义的目的是
 *     「让用户看到字面字符而不是被误渲染」。
 *   - 代码块语法相同：```lang ... ```（Slack 还支持 ``` 多行块，与 md 一致）。
 *   - 行内粗体 `*x*`、斜体 `_x_`、删除线 `~x~`、链接 `<url|text>`。
 *
 * 转换规则（保守，误判成本 > 漏判成本）：
 *   1. 围栏代码块 ```…``` → 原样保留（Slack 原生支持；语言标注也认）
 *   2. 行内代码 `x` → 原样保留
 *   3. **粗体** → *粗体*；~~删除线~~ → ~删除线~（Slack 同语法，保留）
 *   4. *斜体* → _斜体_
 *   5. [文字](url) → <url|文字>（Slack 链接语法）
 *   6. # 标题 → *粗体*（mrkdwn 无标题）
 *   7. 列表 / 引用 → 字面显示（mrkdwn 认 `>` 引用与 `•`，但保持原样最安全）
 *
 * 任何输入都不抛错；不认识的形态原样输出（Slack 最坏情况是显示原始字符，
 * 不会像 Telegram 那样 400 拒收）。
 */

/** 单行富文本转换：markdown 行内语法 → mrkdwn 实体。 */
function convertSpans(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m = /^\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/.exec(rest);
    if (m) {
      out += "*" + m[1] + "*";
      i += m[0].length;
      continue;
    }
    m = /^~~(?!\s)([^~\n]+?)(?<!\s)~~/.exec(rest);
    if (m) {
      out += "~" + m[1] + "~";
      i += m[0].length;
      continue;
    }
    m = /^\*(?!\s)([^*\n]+?)(?<!\s)\*/.exec(rest);
    if (m) {
      out += "_" + m[1] + "_";
      i += m[0].length;
      continue;
    }
    m = /^\[([^\]\n]+)\]\((\S+)\)/.exec(rest);
    if (m) {
      out += `<${m[2]}|${m[1]}>`;
      i += m[0].length;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** 标题行 → 粗体（mrkdwn 无标题实体）。 */
function convertRich(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      return h ? "*" + convertSpans(h[2]) + "*" : convertSpans(line);
    })
    .join("\n");
}

/** 行内代码 `x` 原样保留；其余部分转富文本。 */
function convertInline(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : convertRich(p))).join("");
}

/** LLM markdown → Slack mrkdwn。任何输入都不抛错。 */
export function mdToSlack(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : convertInline(part)))
    .join("");
}
