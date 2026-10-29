/**
 * 指令注册表（slash 指令体系的唯一真相源）。
 *
 * 设计目标（2026-10-27 用户要求「完整的 slash help 系统」）：
 *   1. 一处定义 → 三处复用：解析派发、/help 渲染、Telegram 的「/」菜单。
 *      以后加指令只改这个文件，帮助文本和菜单不会跟实现漂移。
 *   2. 中文口语与斜杠指令等价：「开始开发」和 `/boot` 是同一个东西
 *      （Apple Watch 上打字/语音说中文更自然，桌面上敲斜杠更快）。
 *   3. 纯函数、零依赖 —— 可在 node 里直接单测，不需要 Worker 运行时。
 */

export type CommandGroup = "Machine" | "Gemini" | "CodeBuddy" | "Shell" | "Other";

export interface CommandSpec {
  /** 主名（不含斜杠；同时用作 Telegram 菜单里的 command） */
  name: string;
  /** 中文口语别名 / 其它斜杠写法（不含斜杠） */
  aliases: string[];
  /** 一行说明（菜单与列表用，尽量短） */
  desc: string;
  /** 详细说明（/help <name> 用；纯文本多行） */
  detail: string[];
  group: CommandGroup;
  /** 是否算「终端级互动」——会刷新省额度看门狗的计时 */
  touch?: boolean;
  /** Telegram 菜单只接受 ^[a-z0-9_]{1,32}$，不满足的不进菜单 */
  menu?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "boot",
    // 2026-10-27 用户要求：开关机只认斜杠指令，中文口语一律不启动机器
    //（「开始开发」「开机」「开发」等口语词已移除，发了会被当成 shell 命令）
    aliases: [],
    desc: "Boot the dev machine (result in ~30s)",
    detail: [
      "Boot the dev machine; I'll report once it's up.",
      "Safe to send while shutdown / starting; repeated sends won't create duplicates.",
      "Each startup check runs in the background, up to 2.5 minutes total.",
      "Only /boot and the bare passphrase can boot; Chinese phrases no longer start the machine.",
    ],
    group: "Machine",
    touch: true,
    menu: true,
  },
  {
    name: "halt",
    // 同上：关机只认 /halt
    aliases: [],
    desc: "Shut down the dev machine (save quota)",
    detail: [
      "Shut down the dev machine, done in ~40s (idempotent, repeats are no-ops).",
      "Closes this session's runtime; see /usage for the monthly total.",
      "After shutdown the shell drops; further commands will say 'not connected'.",
      "Only /halt shuts down; Chinese phrases no longer work.",
    ],
    group: "Machine",
    touch: true,
    menu: true,
  },
  {
    name: "cs",
    aliases: ["status"],
    desc: "Machine status + shell channel",
    detail: [
      "Check whether the dev machine is running and the shell channel is connected.",
      "If running but shell not connected, wait 10-30s and try again.",
    ],
    group: "Machine",
    touch: true,
    menu: true,
  },
  {
    name: "usage",
    aliases: ["quota"],
    desc: "This month's runtime vs free allowance",
    detail: ["Monthly runtime total vs free allowance, so you don't go over."],
    group: "Machine",
    touch: true,
    menu: true,
  },
  {
    name: "gemini",
    aliases: ["gem"],
    desc: "Gemini coding session (auto boot / free model chain)",
    detail: [
      "/gemini — open a session: boots the machine if off, installs the CLI if missing, then just ask away.",
      "/gemini <question> — one-shot question, no session mode.",
      "/gemini off — leave session mode, back to 'text = shell command'.",
      "/gemini new — start a fresh session (clears the -r latest marker).",
      "/gemini model <name> — pin a model; /gemini model auto returns to the chain.",
      "/gemini models — list models visible to this account (✅ = in the free chain).",
      "/gemini status — check CLI install / auth / model chain / session.",
      "",
      "By default it rotates a free-model chain: on quota exhaustion (429), overload (503) or",
      "retirement (404) it moves to the next one and remembers the winner for next time.",
      "Pinning a model disables the rotation.",
      "In session mode: plain text = ask Gemini; a leading ! still runs a shell command.",
      "Runs with --approval-mode=yolo: it can edit files and run commands (nobody to press y).",
    ],
    group: "Gemini",
    touch: true,
    menu: true,
  },
  {
    name: "buddy",
    aliases: ["cb"],
    desc: "CodeBuddy coding session (fixed dir / browser OAuth login)",
    detail: [
      "/buddy — open a session: boots the machine if off, installs the CLI if missing, then just ask away.",
      "/buddy <question> — one-shot question, no session mode.",
      "/buddy off — leave session mode, back to 'text = shell command'.",
      "/buddy new — start a fresh session (clears the -c marker).",
      "/buddy model <name> — pin a model; /buddy model auto returns to the free chain.",
      "/buddy models — list CLI models (✅ = in the free chain).",
      "/buddy status — check CLI install / workdir / trust / session.",
      "",
      "By default it walks a free-quota-first chain: if the current model is unavailable (overloaded /",
      "out of quota), the CLI's own --fallback-model handles one hop, then the chain moves on (flash first).",
      "The last working model is remembered and moved to the front; pinning disables rotation.",
      "Workdir is fixed to /workspaces/codebuddy and pre-trusted (never stuck on a trust prompt).",
      "Auth is CodeBuddy's own browser OAuth (state in ~/.codebuddy), no API key needed;",
      "when it expires, headless calls fail with an auth error — rerun codebuddy once in the codespace terminal.",
      "Runs with -y (skip permission prompts): it can edit files and run commands (nobody to press y).",
      "In session mode: plain text = ask CodeBuddy; a leading ! still runs a shell command.",
    ],
    group: "CodeBuddy",
    touch: true,
    menu: true,
  },
  {
    name: "ctrlc",
    aliases: ["stop", "kill"],
    desc: "Interrupt the running command (Ctrl-C) and clear the queue",
    detail: [
      "Sends Ctrl-C to the foreground command and drops everything queued locally.",
      "Escape hatch for stuck commands, runaway output, an accidental sleep, etc.",
      "You can keep sending commands after; if the process ignores even this, /halt.",
    ],
    group: "Shell",
    menu: true,
  },
  {
    name: "verify",
    aliases: ["gate"],
    desc: "Verification gate (status; on / off)",
    detail: [
      "/verify — show current state: gate open/closed, when this session expires.",
      "/verify on — enable the challenge (default): after 10 min idle you must re-answer.",
      "/verify off — disable it: whitelisted messages go straight through, no passphrase.",
      "",
      "off is a security downgrade (your call): while off, any device logged into this account has full access.",
      "Turning it back on re-arms immediately (sessions from the off period are void).",
      "Only affects this chat's challenge; the account whitelist (ALLOWED_USERS) always applies.",
    ],
    group: "Other",
    menu: true,
  },
  {
    name: "help",
    aliases: ["?", "？", "commands", "menu"],
    desc: "Command list; /help <cmd> for details",
    detail: [
      "No argument: the full command list.",
      "With an argument: details for one command, e.g. /help boot.",
      "Anything else you type is run as a command on the dev machine.",
    ],
    group: "Other",
    menu: true,
  },
  {
    name: "diag",
    aliases: [],
    desc: "Diagnostics (troubleshooting)",
    detail: ["Prints build version, channel, shell state and other troubleshooting info."],
    group: "Other",
    menu: true,
  },
];

/** 把一行输入拆成「指令 + 参数」，认得出才返回。 */
export interface ParsedCommand {
  spec: CommandSpec;
  /** 指令后面的参数原文（可能为空串） */
  args: string;
  /** 用户实际输入的写法（回显用） */
  matched: string;
}

/**
 * 解析一条消息是否为指令。
 *
 * 容忍：前后空白、结尾标点（「开始开发。」）、大小写（/BOOT）、中文别名、`/?` 这类纯符号。
 * 不支持：指令夹在句子中间（「帮我开始开发」不会命中，避免误触）。
 *
 * 两轮匹配的原因：先剥掉结尾标点（「开始开发。」→「开始开发」），剥完变空/变残时
 * 再拿原文试一次——`/?` 剥完只剩「/」，只有原文才能匹配上 help 的 `?` 别名。
 */
export function matchCommand(text: string): ParsedCommand | null {
  const raw = text.trim();
  if (!raw) return null;
  const stripped = raw.replace(/[，。、!！?？~～\s]+$/u, "");
  const tries = stripped === raw || !stripped ? [raw] : [stripped, raw];
  for (const candidate of tries) {
    const hit = matchOne(candidate);
    if (hit) return hit;
  }
  return null;
}

function matchOne(cleaned: string): ParsedCommand | null {
  const parts = cleaned.split(/\s+/);
  const head = parts[0];
  const args = parts.slice(1).join(" ");
  const token = (head.startsWith("/") ? head.slice(1) : head).toLowerCase();
  if (!token) return null;

  for (const spec of COMMANDS) {
    const names = [spec.name, ...spec.aliases].map((n) => n.toLowerCase());
    if (names.includes(token)) return { spec, args, matched: head };
  }
  return null;
}

/**
 * 看起来像「打错的斜杠指令」，不像文件路径 / 命令。
 *
 * 判据：以 / 开头、只有一个词、词里没有第二个 / 也不含点号。
 *   /hlep → true（提示去看 /help）
 *   /usr/bin/env → false（这是绝对路径，应该交给 shell）
 *   /tmp/a.sh → false
 */
export function looksLikeUnknownSlash(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("/")) return false;
  const head = t.split(/\s+/)[0];
  const body = head.slice(1);
  if (!body) return false; // 单个 "/" 不算
  if (body.includes("/") || body.includes(".")) return false;
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(body);
}

/** 猜一个最接近的指令名（打错字时给建议）。没猜到返回 null。 */
export function suggestCommand(token: string): string | null {
  const t = token.replace(/^\//, "").toLowerCase();
  if (!t) return null;
  let best: { name: string; score: number } | null = null;
  for (const spec of COMMANDS) {
    for (const n of [spec.name, ...spec.aliases]) {
      const name = n.toLowerCase();
      const score =
        name === t
          ? 0
          : name.startsWith(t) || t.startsWith(name)
            ? 1
            : levenshtein(name, t) <= 2
              ? 2
              : 99;
      if (score < 99 && (!best || score < best.score)) best = { name: spec.name, score };
    }
  }
  return best ? best.name : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

const GROUP_ORDER: CommandGroup[] = ["Machine", "Gemini", "CodeBuddy", "Shell", "Other"];
const GROUP_ICON: Record<CommandGroup, string> = {
  Machine: "🖥",
  Gemini: "🤖",
  CodeBuddy: "🧩",
  Shell: "⌨️",
  Other: "🔐",
};

/** 完整指令表（/help 无参数时发这个）。 */
export function renderHelp(): string {
  const lines: string[] = ["📖 devbot commands", ""];
  for (const g of GROUP_ORDER) {
    const specs = COMMANDS.filter((c) => c.group === g);
    if (specs.length === 0) continue;
    lines.push(`${GROUP_ICON[g]} ${g}`);
    for (const c of specs) {
      const alias = c.aliases[0] ? ` (${c.aliases[0]})` : "";
      lines.push(`  /${c.name}${alias} — ${c.desc}`);
    }
    lines.push("");
  }
  lines.push("Plain text = run a command on the dev machine");
  lines.push("(persistent bash: cd / env vars / background jobs survive)");
  lines.push("");
  lines.push("The bare passphrase = boot phrase (just a confirmation if it's running);");
  lines.push("an expired session asks for the passphrase first, then it's good for 10 min");
  lines.push("of interaction (10 min silent = expired, next message re-verifies).");
  lines.push("A command sent before verifying is remembered and auto-run after.");
  lines.push("Tired of re-verifying? /verify off disables the gate (/verify on re-arms).");
  lines.push("");
  lines.push("Details: /help <command>, e.g. /help boot");
  return lines.join("\n");
}

/** 单条指令的详细说明（/help boot 用）；没有这条返回 null。 */
export function renderCommandHelp(nameOrAlias: string): string | null {
  const token = nameOrAlias.replace(/^\//, "").toLowerCase();
  const spec = COMMANDS.find((c) =>
    [c.name, ...c.aliases].some((n) => n.toLowerCase() === token),
  );
  if (!spec) return null;
  const lines = [`/${spec.name} — ${spec.desc}`, "", ...spec.detail];
  if (spec.aliases.length) lines.push("", `Aliases: ${spec.aliases.join(" / ")}`);
  return lines.join("\n");
}

/** Telegram 的「/」菜单条目（只取符合命名规则且标了 menu 的）。 */
export function menuCommands(): Array<{ command: string; description: string }> {
  return COMMANDS.filter((c) => c.menu && /^[a-z0-9_]{1,32}$/.test(c.name)).map((c) => ({
    command: c.name,
    // Telegram 限制描述 ≤ 256 字符，这里本来都很短
    description: c.desc.slice(0, 256),
  }));
}
