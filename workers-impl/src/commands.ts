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

export type CommandGroup = "开发机" | "Gemini" | "CodeBuddy" | "联机 shell" | "其它";

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
    desc: "开机（30 秒后确认结果）",
    detail: [
      "开机，并在启动完成后主动告诉你结果。",
      "机器关机 / 启动中都可以发，重复发不会重复创建。",
      "启动中的每一轮检查都在后台跑，最多等 2.5 分钟。",
      "只有 /boot 和「单独发验证词」能开机；中文口语（开始开发 / 开机）已停用。",
    ],
    group: "开发机",
    touch: true,
    menu: true,
  },
  {
    name: "halt",
    // 同上：关机只认 /halt
    aliases: [],
    desc: "关机（省免费额度）",
    detail: [
      "关掉开发机，约 40 秒内完成（幂等，重复发不会报错）。",
      "同时结掉本轮运行时长，可用 /usage 查看本月累计。",
      "关机后 shell 会断开，再发命令会提示「未连接」。",
      "只有 /halt 能关机：中文口语（停止开发 / 关机）已停用。",
    ],
    group: "开发机",
    touch: true,
    menu: true,
  },
  {
    name: "cs",
    aliases: ["开发机状态", "状态"],
    desc: "机器状态 + shell 通道",
    detail: [
      "查询开发机是否在运行，并附带 shell 通道是否已连上。",
      "「运行中」但 shell 未连接时，等 10~30 秒再发命令。",
    ],
    group: "开发机",
    touch: true,
    menu: true,
  },
  {
    name: "usage",
    aliases: ["用量", "额度"],
    desc: "本月运行时长 / 免费额度",
    detail: ["本月累计运行时长与免费额度对比，避免超额。"],
    group: "开发机",
    touch: true,
    menu: true,
  },
  {
    name: "gemini",
    aliases: ["gem"],
    desc: "Gemini 编程会话（自动开机 / 免费模型自动切换）",
    detail: [
      "/gemini —— 打开会话：机器关了自动开机，没装自动装，然后直接发问题即可。",
      "/gemini <问题> —— 只问一次，不进入会话模式。",
      "/gemini off —— 退出会话模式，回到「发文字 = shell 命令」。",
      "/gemini new —— 开新会话（清掉 -r latest 续用标记）。",
      "/gemini model <名字> —— 固定某个模型；/gemini model auto 回到自动链。",
      "/gemini models —— 列出账号可见的模型（✅ = 已在自动链里）。",
      "/gemini status —— 查 CLI 安装 / 认证 / 模型链 / 会话状态。",
      "",
      "默认按「免费模型链」自动切换：某个模型配额用尽（429）、过载（503）或下线（404）时，",
      "自动换下一个并把成功那个记住，下一条从它开始。固定模型后不再自动切换。",
      "会话模式下：直接发文字 = 问 Gemini；行首加 ! = 仍然执行 shell 命令。",
      "Gemini 以 --approval-mode=yolo 运行：能直接改文件、跑命令（无人值守没法按 y）。",
    ],
    group: "Gemini",
    touch: true,
    menu: true,
  },
  {
    name: "buddy",
    aliases: ["cb"],
    desc: "CodeBuddy 编程会话（固定 codebuddy 目录 / 浏览器登录态）",
    detail: [
      "/buddy —— 打开会话：机器关了自动开机、没装自动装，之后直接发问题即可。",
      "/buddy <问题> —— 只问一次，不进入会话模式。",
      "/buddy off —— 退出会话模式，回到「发文字 = shell 命令」。",
      "/buddy new —— 开新会话（清掉 -c 续用标记）。",
      "/buddy model <名字> —— 固定模型；/buddy model auto 回到免费链。",
      "/buddy models —— 列出 CLI 支持的模型（✅ = 已在免费链里）。",
      "/buddy status —— 查 CLI 安装 / 工作目录 / 信任状态 / 会话状态。",
      "",
      "默认按「免费额度优先链」自动降级：当前模型不可用（过载/额度）时，",
      "先由 CLI 原生 --fallback-model 单跳切换，不够再沿链换下一个（flash 系优先）。",
      "上次成功的模型会记住并提到链头；固定模型后不再自动切换。",
      "工作目录固定为 /workspaces/codebuddy，并已 pre-trust（不会卡在「信任此文件夹」）。",
      "认证走 CodeBuddy 自己的浏览器 OAuth（登录态在 ~/.codebuddy），不需要 API key；",
      "登录失效时 headless 会直接报鉴权错误 —— 到 codespace 终端手动跑一次 codebuddy 重新授权。",
      "以 -y 运行（跳过权限确认）：能直接改文件、跑命令（无人值守没法按 y）。",
      "会话模式下：直接发文字 = 问 CodeBuddy；行首加 ! = 仍然执行 shell 命令。",
    ],
    group: "CodeBuddy",
    touch: true,
    menu: true,
  },
  {
    name: "ctrlc",
    aliases: ["中断", "停止命令"],
    desc: "中断当前命令（Ctrl-C），并清空卡住的队列",
    detail: [
      "给开发机里前台运行的命令发 Ctrl-C，并清掉本地排队的命令。",
      "命令卡住、输出刷屏、误跑了 sleep 等，用它逃生。",
      "清完队列后仍可继续发命令；若进程连中断都不理，再发 /halt 关机。",
    ],
    group: "联机 shell",
    menu: true,
  },
  {
    name: "verify",
    aliases: ["验证"],
    desc: "验证挑战开关（/verify 看状态；on / off 开关）",
    detail: [
      "/verify —— 查看当前状态：挑战开/关、本次会话何时过期。",
      "/verify on —— 开启验证挑战（默认）：闲置 10 分钟后要回答验证词。",
      "/verify off —— 关闭验证挑战：白名单账号的消息直达，不再要验证词。",
      "",
      "off 是安全降级开关（自己的选择）：关掉期间任何登录该账号的设备都能用全部功能。",
      "重新 on 会立即恢复挑战（关闭期间的会话作废，下一条消息重新验证）。",
      "只影响本 chat 的验证挑战；账号白名单（ALLOWED_USERS）始终生效。",
    ],
    group: "其它",
    menu: true,
  },
  {
    name: "help",
    aliases: ["帮助", "?", "？", "commands", "menu"],
    desc: "指令表；/help <指令> 看细节",
    detail: [
      "不带参数：列出全部指令。",
      "带参数：看某条指令的详细说明，例如 /help boot。",
      "除了这些指令，直接发文字就是在开发机里执行命令。",
    ],
    group: "其它",
    menu: true,
  },
  {
    name: "diag",
    aliases: ["诊断"],
    desc: "诊断信息（排查用）",
    detail: ["输出 build 版本、通道、shell 状态等排查信息。"],
    group: "其它",
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

const GROUP_ORDER: CommandGroup[] = ["开发机", "Gemini", "CodeBuddy", "联机 shell", "其它"];
const GROUP_ICON: Record<CommandGroup, string> = {
  开发机: "🖥",
  Gemini: "🤖",
  CodeBuddy: "🧩",
  "联机 shell": "⌨️",
  其它: "🔐",
};

/** 完整指令表（/help 无参数时发这个）。 */
export function renderHelp(): string {
  const lines: string[] = ["📖 devbot 指令", ""];
  for (const g of GROUP_ORDER) {
    const specs = COMMANDS.filter((c) => c.group === g);
    if (specs.length === 0) continue;
    lines.push(`${GROUP_ICON[g]} ${g}`);
    for (const c of specs) {
      const alias = c.aliases[0] ? `（${c.aliases[0]}）` : "";
      lines.push(`  /${c.name}${alias} — ${c.desc}`);
    }
    lines.push("");
  }
  lines.push("直接发文字 = 在开发机里执行命令");
  lines.push("（长驻 bash：cd / export / 后台进程都会保留）");
  lines.push("");
  lines.push("单独发验证词 = 开机口令（机器在跑就只回一句确认）；");
  lines.push("会话过期会先要验证词，通过后 10 分钟内互动免验证；");
  lines.push("（10 分钟不说话就失效，下一条消息要重新验证）");
  lines.push("验证前发的那条命令会自动补执行，不用重发。");
  lines.push("不想被反复要验证词：/verify off 关掉挑战（/verify on 恢复）。");
  lines.push("");
  lines.push("细节看 /help <指令>，例如 /help boot");
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
  if (spec.aliases.length) lines.push("", `别名：${spec.aliases.join(" / ")}`);
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
