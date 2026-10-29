/**
 * CodeBuddy CLI 接入层（纯函数：只生成 bash 脚本，不碰 Worker/DO）。
 *
 * 与 /gemini 的关系：**同一套模式**（非交互 `-p`、按行抓 stdout、`-c` 续会话），
 * 但认证方式完全不同 —— 这里不需要 API key：
 *   CodeBuddy 用浏览器 OAuth 登录，登录态落在机器的 `~/.codebuddy`（持久卷）。
 *   一次性在那台机器上跑一次交互式登录，之后所有 headless 调用都复用它。
 *   所以本文件里**没有** resolveKey 那套三级 key 兜底，也没有免费模型链
 *   （腾讯侧没有「按模型分桶的免费额度」，配额用尽就是整体不可用，换型号无意义）。
 *
 * 工作目录固定为 BUDDY_DIR（用户 2026-10-28 要求：单独开一个 codebuddy 文件夹，
 * 让 CodeBuddy 只在这个目录里开发，并且该目录要 pre-trust，免得 headless 卡在
 * 「是否信任此文件夹」）。脚本里会顺手补 mkdir 和 trustedDirectories ——
 * 持久卷万一被重置，第一次调用就能自愈，不需要人工去改 settings.json。
 */

// 复用 gemini.ts 的两个纯工具（UTF-8 base64、模型名白名单）——模型名会拼进 shell
// 命令，白名单只能有一份实现，否则改了一处另一处就成注入口。
// 这里写 `.js` 后缀：buddy 会被单测直接 import（node ESM 不做扩展名推断），
// 而 tsc(bundler)/esbuild 都会把 ./gemini.js 解析到 gemini.ts。
import { b64Utf8, sanitizeModel } from "./gemini.js";

/** 固定工作目录：CodeBuddy 的 session 是按项目目录归属的，改这里等于换会话空间。 */
export const BUDDY_DIR = "/workspaces/codebuddy";
/** npm 包名（注意：`codebuddy` / `codebuddy-cli` 这类短名在 npm 上是别人占的 Hello World 桩，装错会一脸懵）。 */
export const BUDDY_PKG = "@tencent-ai/codebuddy-code";
/**
 * 「已有会话」标记：只在一次成功调用后创建。
 * 为什么需要它：`-c`（continue）在「这个目录还没聊过」时行为不确定（旧版本会报错），
 * 所以第一条成功之前不加，之后才加 —— 和 /gemini 用 `-r latest` 的处理一致。
 */
export const BUDDY_SESSION_MARK = "$HOME/.config/watch-ai/buddy-session";
/** CodeBuddy 的用户级配置目录（登录态 + 信任目录都在这里）。 */
export const BUDDY_CONF_DIR = "$HOME/.codebuddy";
/**
 * 模型清单兜底：正常情况下 `/buddy models` 会现查 `codebuddy --help`（见 buildModelsScript），
 * 这里只是「help 文案改版了 / CLI 太老」时的兜底展示，不必跟版本严格同步。
 */
export const DEFAULT_BUDDY_MODELS: string[] = [
  "default",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "hy4-preview",
  "glm-5.3",
  "kimi-k3.1-pro",
  "minimax-m3",
];

/**
 * 免费额度优先链（2026-10-29 实测：16 个模型全部在免费额度内可用，含 pro 级）。
 *
 * 设计与 /gemini 的链同构，但机制不同：CodeBuddy 有原生的 `--fallback-model`
 * （「主模型过载时自动切换」，help 明说 only works with --print —— 正是我们的用法），
 * 所以链只有「当前首选 → 备选」两跳由 CLI 自己处理；跨多跳的降级由本脚本的外层
 * 循环完成（见 buildBuddyScript）。
 *
 * 排序原则：flash / lite 这类轻模型在前（响应快、免费池大），pro / 大参数殿后。
 * 顺序 = 自动降级的尝试顺序。
 */
export const DEFAULT_BUDDY_CHAIN: string[] = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "minimax-m3.1-flash",
  "hy4-preview",
  "glm-5.3",
  "kimi-k3.1-pro",
  "deepseek-v4-pro",
];
/** 上次成功的模型（持久卷）。下次从它开始，避免每次都从链头试错。 */
export const BUDDY_MODEL_FILE = "$HOME/.config/watch-ai/buddy-model";

/**
 * 解析 `BUDDY_MODELS` 环境变量（逗号/空格分隔）为链；非法名丢弃。
 * 空或全非法 → 默认链，绝不返回空数组。
 */
export function parseBuddyChain(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const piece of (raw ?? "").split(/[\s,]+/)) {
    const m = piece.trim();
    if (!m) continue;
    const ok = sanitizeModel(m).replace(/^-m\s+/, "");
    if (ok && !out.includes(ok)) out.push(ok);
  }
  return out.length ? out : [...DEFAULT_BUDDY_CHAIN];
}
/**
 * UTF-8 → base64。这里复用 gemini.ts 的实现（Workers 的 btoa 只吃 latin1）。
 * 保留一个本地别名，避免调用处出现 gemini 字样造成误解。
 */
const b64 = b64Utf8;

/**
 * 定位 codebuddy 可执行文件的 bash 片段。
 *
 * 为什么不能只靠 `command -v`：这台机器上的 CLI 是 nvm 装的
 * （`$HOME/nvm/current/bin/codebuddy`），而 agent 由 post-start/supervisor 拉起时
 * 往往不是登录 shell，nvm 的 PATH 根本不会注入 —— 于是「明明装了却 command not found」。
 * 所以先补两条 nvm 路径，再退回到全局搜索。
 */
export function locateLines(): string[] {
  return [
    `export PATH="$HOME/nvm/current/bin:/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"`,
    `if ! command -v codebuddy >/dev/null 2>&1; then`,
    `  for c in "$HOME"/nvm/versions/node/*/bin/codebuddy "$HOME"/.nvm/versions/node/*/bin/codebuddy /usr/local/share/nvm/versions/node/*/bin/codebuddy; do`,
    `    [ -x "$c" ] && PATH="$(dirname "$c"):$PATH" && hash -r && break`,
    `  done`,
    `fi`,
  ];
}

/**
 * 生成「准备 + 执行」的 bash 脚本（整体包在子 shell 里，理由同 gemini.ts：
 * 长驻 bash 里顶层 exit 会把整个 shell 干掉）。
 */
export function buildBuddyScript(
  opts: { prompt?: string; model?: string; chain?: string[]; resume?: boolean } = {},
): string {
  // 注意这里加 `--model` 前缀而不是复用 sanitizeModel 的 `-m`：CodeBuddy 的 help 里
  // 只声明了长选项 `--model`（不像 gemini 有 -m 短选项），短横线写错会被当成 prompt 文本。
  const modelName = opts.model ? sanitizeModel(opts.model).replace(/^-m\s+/, "") : "";
  const model = modelName ? `--model ${modelName}` : "";
  const resume = opts.resume !== false;
  const prompt = opts.prompt?.trim() ?? "";
  const L: string[] = ["("];

  L.push(`mkdir -p ${BUDDY_DIR} 2>/dev/null || true`);
  L.push(`cd ${BUDDY_DIR} 2>/dev/null || { echo "❌ 工作目录建不出来：${BUDDY_DIR}"; exit 1; }`);

  // 免信任：headless 下虽然不一定弹窗，但 TUI 会；而且「信任」是安全边界，
  // 应该显式、可见地声明（写进 settings.json），而不是靠 --yes 之类偷偷绕过。
  // 用 node 改 JSON（python3 也行，但 node 是 CLI 的运行时，一定存在）。
  L.push(`NS="${BUDDY_CONF_DIR}/settings.json"`);
  L.push(`mkdir -p "${BUDDY_CONF_DIR}" 2>/dev/null || true`);
  L.push(
    `if ! grep -q '${BUDDY_DIR}' "$NS" 2>/dev/null; then ` +
      `node -e 'const fs=require("fs"),p=process.env.HOME+"/.codebuddy/settings.json";` +
      `let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};` +
      `const t=new Set(s.trustedDirectories||[]);t.add("${BUDDY_DIR}");` +
      `s.trustedDirectories=Array.from(t);fs.writeFileSync(p,JSON.stringify(s,null,2)+"\\n")' 2>/dev/null ` +
      `&& echo "🔓 已把 ${BUDDY_DIR} 加进 trustedDirectories"; fi`,
  );

  L.push(...locateLines());

  // 首次安装：三级降级（和 /gemini 一样，全程不让用户开 sudo 或敲密码）
  L.push(`if ! command -v codebuddy >/dev/null 2>&1; then`);
  L.push(`  echo "⏳ 首次运行，正在安装 ${BUDDY_PKG}（约 1~2 分钟）…"`);
  L.push(`  LOG=/tmp/ws-buddy-install.log`);
  L.push(`  npm i -g ${BUDDY_PKG} </dev/null >"$LOG" 2>&1 || {`);
  L.push(`    echo "" >>"$LOG"; echo "--- 普通安装失败，试 sudo -n ---" >>"$LOG"`);
  L.push(`    NPMBIN="$(command -v npm)"`);
  L.push(`    command -v sudo >/dev/null 2>&1 && sudo -n "$NPMBIN" i -g ${BUDDY_PKG} </dev/null >>"$LOG" 2>&1`);
  L.push(`  }`);
  L.push(`  hash -r`);
  L.push(`  if ! command -v codebuddy >/dev/null 2>&1; then`);
  L.push(`    echo "   全局装不上，改装到 ~/.local（免 sudo）…" >>"$LOG"`);
  L.push(`    npm i -g --prefix "$HOME/.local" ${BUDDY_PKG} </dev/null >>"$LOG" 2>&1 || true`);
  L.push(`    hash -r`);
  L.push(`  fi`);
  L.push(`  if ! command -v codebuddy >/dev/null 2>&1; then`);
  L.push(`    echo "❌ 安装失败，日志尾部："`);
  L.push(`    tail -12 "$LOG"`);
  L.push(`    echo "   可手动跑：sudo npm i -g ${BUDDY_PKG}"`);
  L.push(`    exit 3`);
  L.push(`  fi`);
  L.push(`fi`);

  if (!prompt) {
    L.push(`echo "✅ $(codebuddy --version 2>/dev/null | tail -1) 已就绪"`);
    L.push(`echo "目录：$(pwd)"`);
    L.push(`exit 0`);
    L.push(`)`);
    return L.join("\n");
  }

  // 问题走 base64 落临时文件：彻底避开引号 / 换行 / $ 展开的转义地狱
  L.push(`printf %s '${b64(prompt)}' | base64 -d > /tmp/ws-buddy-prompt.txt`);
  L.push(`P="$(cat /tmp/ws-buddy-prompt.txt)"`);

  // -y = 跳过权限确认（无人值守没人按 y）；-c = 续最近一次会话。
  // 顺序按 CLI 的惯例把开关放前面、prompt 跟上，避免 `-p` 把后面的开关当成 prompt 文本。
  if (resume) L.push(`C=""; [ -f "${BUDDY_SESSION_MARK}" ] && C="-c"`);
  L.push(`OUT=/tmp/ws-buddy-out.txt`);

  if (model) {
    // 用户钉了模型：只跑它，不偷偷换（「我明明指定了 X」不能变成谜题）
    L.push(`codebuddy \${C:-} -y ${model} -p "$P" </dev/null 2>&1 | tee "$OUT"`);
    L.push(`rc=\${PIPESTATUS[0]}`);
  } else {
    // 自动模式：免费额度优先链。每跳 = `--model 当前 --fallback-model 下一跳`
    // （fallback 是 CLI 原生能力，只在「过载」时触发；外层循环处理跨多跳的降级：
    // 一跳彻底失败（rc≠0 且输出里没有 fallback 接管的迹象）就换下一跳从头试）。
    const chain = (opts.chain?.length ? opts.chain : DEFAULT_BUDDY_CHAIN).slice(0, 6);
    L.push(`CHAIN="${chain.join(" ")}"`);
    L.push(`MODELF="${BUDDY_MODEL_FILE}"`);
    // 上次成功的模型提到最前：稳定性靠它，别每条消息都从链头试错
    L.push(`if [ -f "$MODELF" ]; then`);
    L.push(`  last="$(cat "$MODELF" 2>/dev/null)"`);
    L.push(`  case " $CHAIN " in *" $last "*) CHAIN="$last $(printf %s " $CHAIN " | sed "s/ $last / /")" ;; esac`);
    L.push(`fi`);
    L.push(`rc=1; tried=""`);
    L.push(`for m in $CHAIN; do`);
    L.push(`  : > "$OUT"`);
    // 第一次尝试才续会话：换模型后旧会话可能属于另一个模型，硬续容易再失败一次
    L.push(`  G=""; if [ -z "$tried" ] && [ -f "${BUDDY_SESSION_MARK}" ]; then G="-c"; else G=""; fi`);
    // 下一跳作为本跳的原生 fallback：单次调用内 CLI 自己处理「过载 → 切换」
    L.push(`  next="$(printf %s " $CHAIN " | sed "s/^ *$m */ /" | awk "{print \\$1}" | grep . || true)"`);
    L.push(`  FB=""; [ -n "$next" ] && FB="--fallback-model $next"`);
    L.push(`  codebuddy \${G:-} -y --model "$m" $FB -p "$P" </dev/null 2>&1 | tee "$OUT"`);
    L.push(`  rc=\${PIPESTATUS[0]}`);
    L.push(`  if [ $rc -eq 0 ]; then`);
    L.push(`    mkdir -p "$(dirname "$MODELF")"; printf %s "$m" > "$MODELF"`);
    L.push(`    [ -n "$tried" ] && echo "" && echo "✅ 本次由 $m 回答（前面试过：$tried）"`);
    L.push(`    break`);
    L.push(`  fi`);
    L.push(`  tried="$tried $m"`);
    L.push(`  echo ""`);
    L.push(`  echo "⚠️ $m 不可用，换链上下一个免费模型…"`);
    L.push(`done`);
    L.push(`if [ $rc -ne 0 ] && [ -n "$tried" ]; then echo ""; echo "❌ 链上的模型都试过了：$tried"; echo "   可 /buddy model <名字> 手动指定。"; fi`);
  }
  // 成功才建会话标记：失败的那次没有可续的会话，提前建标记会让下一条报「无会话可续」
  L.push(`if [ $rc -eq 0 ]; then mkdir -p "$(dirname "${BUDDY_SESSION_MARK}")"; touch "${BUDDY_SESSION_MARK}"; fi`);
  L.push(`exit $rc`);
  L.push(`)`);
  return L.join("\n");
}

/** 环境自检：装没装 / 目录对不对 / 信任了没 / 有没有可续的会话。 */
export function buildBuddyStatusScript(model?: string, chain?: string[]): string {
  const pinned = model ? sanitizeModel(model).replace(/^-m\s+/, "") : "";
  const list = chain?.length ? chain : DEFAULT_BUDDY_CHAIN;
  return [
    "(",
    `mkdir -p ${BUDDY_DIR} 2>/dev/null || true`,
    `cd ${BUDDY_DIR} 2>/dev/null || echo "⚠️ 工作目录不存在：${BUDDY_DIR}"`,
    `export PATH="$HOME/nvm/current/bin:/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"`,
    ...locateLines(),
    `if command -v codebuddy >/dev/null 2>&1; then echo "CLI：✓ $(codebuddy --version 2>/dev/null | tail -1)（$(command -v codebuddy)）"; else echo "CLI：✗ 未安装（发 /buddy 自动装）"; fi`,
    `if grep -q '${BUDDY_DIR}' "${BUDDY_CONF_DIR}/settings.json" 2>/dev/null; then echo "信任：✓ ${BUDDY_DIR} 已在 trustedDirectories"; else echo "信任：✗ 未声明（下次调用会自动补上）"; fi`,
    // 登录态没法离线判定（token 存在 local_storage 的加密条目里），只能说清「在哪、怎么补」
    `if [ -d "${BUDDY_CONF_DIR}" ]; then echo "认证：✓ 已初始化 ~/.codebuddy（OAuth 登录态；失效时 headless 会直接报鉴权错误）"; else echo "认证：✗ 没登录过（需要在机器里交互式跑一次 codebuddy 完成浏览器授权）"; fi`,
    pinned
      ? `echo "模型：固定 ${pinned}（不自动切换；/buddy model auto 回到免费链）"`
      : `echo "模型：免费额度优先链（${list.join(" → ")}）"; last="$(cat ${BUDDY_MODEL_FILE} 2>/dev/null)"; echo "优先：\${last:-${list[0]}}（上次成功的提到最前）"`,
    `if [ -f "${BUDDY_SESSION_MARK}" ]; then echo "会话：有（下条会用 -c 续）"; else echo "会话：无（下条开新会话）"; fi`,
    `echo "目录：$(pwd)"`,
    ")",
  ].join("\n");
}

/** 列出 CLI 支持的模型：优先现查 help（跟版本走），查不到用兜底常量；标注哪些在免费链里。 */
export function buildBuddyModelsScript(chain?: string[]): string {
  const list = chain?.length ? chain : DEFAULT_BUDDY_CHAIN;
  return [
    "(",
    `export PATH="$HOME/nvm/current/bin:/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"`,
    ...locateLines(),
    `if ! command -v codebuddy >/dev/null 2>&1; then echo "CLI 还没装，发一次 /buddy 会自动装。"; exit 2; fi`,
    `echo "免费额度优先链（自动降级顺序）：${list.join(" → ")}"`,
    `last="$(cat ${BUDDY_MODEL_FILE} 2>/dev/null)"; [ -n "$last" ] && echo "上次成功：$last"`,
    `echo ""; echo "CLI 支持的模型（来自 codebuddy --help；✅ = 已在链中）："`,
    `LIST=$(codebuddy --help 2>/dev/null | tr ',' '\\n' | sed -n 's/.*Currently supported: *(//; s/[() ]//g' | grep -E '^[a-z0-9._-]+$')`,
    `if [ -z "$LIST" ]; then echo "  （help 里没解析出来，按内置清单显示）"; LIST="${DEFAULT_BUDDY_MODELS.join(" ")}"; fi`,
    `printf '%s\\n' $LIST | while read -r m; do`,
    `      case " ${list.join(" ")} " in *" $m "*) echo "  ✅ $m" ;; *) echo "     $m" ;; esac`,
    `    done`,
    `echo ""; echo "用法：/buddy model <名字> 固定；/buddy model auto 回到免费链"`,
    ")",
  ].join("\n");
}

/** 清掉续用标记 = 开始新会话。 */
export function buildBuddyNewSessionScript(): string {
  return `rm -f "${BUDDY_SESSION_MARK}" && echo "🆕 已清空续用标记，下一条问题会开新会话"`;
}

// ------------------------------------------------------------------ 参数解析

export type BuddyAction =
  | { kind: "open" }
  | { kind: "ask"; prompt: string }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "new" }
  | { kind: "model"; model: string }
  | { kind: "models" }
  | { kind: "help" };

/**
 * 解析 `/buddy` 后面的参数（与 /gemini 完全对齐，减少「两个 AI 指令行为不一样」的心智负担）。
 *
 *   （空）           → 打开模式
 *   off / exit      → 关闭模式
 *   status          → 自检
 *   models          → 列出 CLI 支持的模型
 *   new / reset     → 新会话
 *   model <名字>    → 固定模型；`model auto` 回到默认
 *   help            → 单条帮助
 *   其它任何文本     → 当作一次性提问
 */
export function parseBuddyArgs(args: string): BuddyAction {
  const raw = args.trim();
  if (!raw) return { kind: "open" };
  const [head, ...rest] = raw.split(/\s+/);
  const tail = rest.join(" ").trim();
  const key = head.toLowerCase();
  if (key === "off" || key === "exit" || key === "quit") return { kind: "off" };
  if (key === "status") return { kind: "status" };
  if (key === "models" || key === "ls") return { kind: "models" };
  if (key === "new" || key === "reset") return { kind: "new" };
  if (key === "help") return { kind: "help" };
  // 不通过聊天收任何凭证（OAuth 只在机器上做），`/buddy key` 直接回帮助
  if (key === "key" || key === "auth" || key === "login") return { kind: "help" };
  if (key === "model" || key === "m") {
    if (!tail) return { kind: "help" };
    return { kind: "model", model: /^(auto|reset|off|default|any)$/i.test(tail) ? "auto" : tail };
  }
  return { kind: "ask", prompt: raw };
}
