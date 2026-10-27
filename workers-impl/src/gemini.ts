/**
 * Gemini CLI 接入层（纯函数：只生成 bash 脚本，不碰 Worker/DO）。
 *
 * 设计取舍：**不做「把 TUI 塞进 Telegram」**这件事。
 *   Gemini CLI 的交互模式是 Ink 画的整屏 TUI，每次按键都重绘；我们的通道是
 *   「按行抓 stdout + 去 ANSI」，硬灌进来只会得到一堆重复碎片。所以这里走
 *   **非交互模式**（`gemini -p`）：
 *     - 每条 Telegram 消息 = 一次 `gemini -p "<问题>"`，输出实时流式回传；
 *     - 上下文用 `-r latest` 续上（Gemini CLI 自己的 session 存在开发机上），
 *       第一条成功后打个标记文件，之后才加 `-r latest`，避免「无 session 可续」报错；
 *     - `--approval-mode=yolo` 让它能真正改文件 / 跑命令（无人值守下没人按 y）；
 *     - stdin 一律 `</dev/null`，防止它偷吃我们喂给 bash 的后续命令行。
 *
 * 认证只支持 headless 可行的两种：`GEMINI_API_KEY` 环境变量（Codespaces secret）
 * 或 `~/.config/watch-ai/gemini-key` 文件（/gemini key 写入，chmod 600）。
 * Google 账号 OAuth 需要浏览器，在 codespace 里没法点，故不实现。
 */

/** 固定工作目录：Gemini 的 session / GEMINI.md 都按项目目录归属。 */
export const GEMINI_REPO = "/workspaces/watch-ai-assistant";
/**
 * 默认模型。**不要在调用时省略 -m 交给 CLI 自己挑**：
 * CLI 的默认值（2.5 系列）对 2026 年新发的 key 已经返回
 * 「no longer available to new users」，不指定模型会直接 404。
 * 这里给一个当前可用的兜底，运行时可用 Worker 变量 GEMINI_MODEL 覆盖。
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
/**
 * 免费额度下的**备用模型链**（顺序 = 尝试顺序）。
 *
 * 为什么需要它：Google 的免费配额是**按模型分桶**的，一个模型当天用尽不影响别的。
 * 实测（2026-10-27，同一个 key）：
 *   gemini-3.6-flash / 3.5-flash / flash-lite-latest / 3.5-flash-lite / 3.1-flash-lite → 200
 *   gemini-3.7-flash → 503（高负载）
 *   gemini-3.8-flash、gemini-flash-latest → 20 秒零字节（**挂住**，不是报错）
 *   gemini-3.1-pro-preview / pro-latest / 4-argon → 429（免费额度不含）
 * 所以默认链只放「能真正返回」的模型；会挂住的那两个故意不进链——它们会让每次调用
 * 白等 20~60 秒，比直接失败更糟。想用可以 `/gemini model gemini-3.8-flash` 手动钉。
 */
export const DEFAULT_MODEL_CHAIN: string[] = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];
/** 上次成功的模型（持久卷）。下次优先从它开始，避免每次都从链头试错。 */
export const GEMINI_MODEL_FILE = "$HOME/.config/watch-ai/gemini-model";
/**
 * 解析 `GEMINI_MODELS` 环境变量（逗号/空格分隔）为链；非法名直接丢弃。
 * 空或全非法 → 返回默认链，绝不返回空数组（空数组等于「没有模型可跑」）。
 */
export function parseModelChain(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const piece of (raw ?? "").split(/[\s,]+/)) {
    const m = piece.trim();
    if (!m) continue;
    // 复用 sanitizeModel 的白名单（它返回 "-m xxx"，这里只要名字部分）
    const ok = sanitizeModel(m).replace(/^-m\s+/, "");
    if (ok && !out.includes(ok)) out.push(ok);
  }
  return out.length ? out : [...DEFAULT_MODEL_CHAIN];
}
/** API key 落盘位置（与 agent key 同目录，持久卷，重启不丢）。 */
export const GEMINI_KEY_FILE = "$HOME/.config/watch-ai/gemini-key";
/**
 * Codespaces secret 的原始存放处（值为 base64）。
 *
 * 为什么需要直接读它：secret 并不是容器的普通环境变量，而是由
 * `/etc/profile.d/codespaces.sh` 在**登录 shell 且 $SSH_CONNECTION 非空**时才导出。
 * agent 由 `post-start.sh` 拉起时，那里会主动补一次（见 post-start.sh 的 load_secret），
 * 但 agent 也可能是手动 `setsid` 拉起、或被杀后由 supervisor 重启的 —— 这两条路上
 * 环境里就没有 GEMINI_API_KEY，于是 `/gemini` 会误报「还没有 API key」。
 * 这里读同一份文件做兜底，跟启动方式解耦。
 */
export const GEMINI_SECRETS_FILE = "/workspaces/.codespaces/shared/.env-secrets";
/** 「已有会话」标记：只在一次成功调用后创建。 */
export const GEMINI_SESSION_MARK = "$HOME/.config/watch-ai/gemini-session";
/**
 * 免 sudo 的安装落点。npm 的全局 prefix 在多数镜像里归 root，`npm i -g` 会
 * EACCES；而 codespace 用户的 $HOME 一定可写。所以第二级兜底装到这里，
 * 脚本开头统一把 ~/.local/bin 提到 PATH 最前面。
 */
export const GEMINI_USER_PREFIX = "$HOME/.local";
export const GEMINI_PKG = "@google/gemini-cli";

/** UTF-8 → base64（Workers 的 btoa 只吃 latin1，必须自己按字节转）。 */
export function b64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x4000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 模型名白名单：直接拼进 shell 命令，必须挡住注入。
 * 允许 `flash`、`gemini-2.5-pro` 这类写法，长度也限制住。
 */
export function sanitizeModel(model: string | undefined): string {
  if (!model) return "";
  const m = model.trim().replace(/^--?/, "");
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(m)) return "";
  return `-m ${m}`;
}

export interface GeminiRunOpts {
  /** 要问的问题；不传 = 只做环境准备（装 CLI / 查 key） */
  prompt?: string;
  /** 用户手动钉死的模型。**设了就不自动切换**（用户的选择优先于我们的猜测）。 */
  model?: string;
  /** 免费模型链（按顺序尝试）。`model` 为空时才生效。 */
  chain?: string[];
  /** 是否允许续用上次会话（默认 true） */
  resume?: boolean;
}

/**
 * 解析 API key 的 bash 片段。三级来源，任一命中就 `export`：
 *   1. `$GEMINI_API_KEY`            —— post-start.sh 从 secret 注入的环境变量
 *   2. `~/.config/watch-ai/gemini-key` —— `/gemini key` 写入（持久卷，重启不丢）
 *   3. `.env-secrets`（base64）      —— 兜底：agent 被手动拉起时环境里没有 #1
 *
 * 抽成函数是为了让 buildGeminiScript 和 buildStatusScript 用**同一套**判定，
 * 否则会出现「真跑能拿到 key，status 却说没有」这种自相矛盾的诊断。
 */
export function resolveKeyLines(): string[] {
  return [
    `KEYF="${GEMINI_KEY_FILE}"`,
    `if [ -n "\${GEMINI_API_KEY:-}" ]; then GEMINI_KEY_SRC=env; else`,
    `  if [ -f "$KEYF" ]; then export GEMINI_API_KEY="$(cat "$KEYF")"; GEMINI_KEY_SRC=file; fi`,
    `  if [ -z "\${GEMINI_API_KEY:-}" ] && [ -r "${GEMINI_SECRETS_FILE}" ]; then`,
    `    __e=$(sed -n 's/^GEMINI_API_KEY=//p' "${GEMINI_SECRETS_FILE}" 2>/dev/null | head -1)`,
    `    if [ -n "\${__e:-}" ]; then export GEMINI_API_KEY="$(printf %s "$__e" | base64 -d 2>/dev/null)"; GEMINI_KEY_SRC=secrets; fi`,
    `    unset __e`,
    `  fi`,
    `fi`,
    `[ -n "\${GEMINI_KEY_SRC:-}" ] || GEMINI_KEY_SRC=none`,
  ];
}

/**
 * 生成一段「准备 + 执行」的 bash 脚本（整体包在子 shell 里）。
 *
 * 为什么包 `( … )`：脚本里要 `exit 2` 这类早退，而开发机里的 bash 是长驻的，
 * 顶层 exit 会把整个 shell 干掉（cwd/环境全丢）。子 shell 里 exit 只结束这一段，
 * 退出码照样通过 `$?` 传给外层，marker 仍是准的。
 */
export function buildGeminiScript(opts: GeminiRunOpts = {}): string {
  const model = sanitizeModel(opts.model);
  const resume = opts.resume !== false;
  const prompt = opts.prompt?.trim() ?? "";
  const L: string[] = ["("];

  L.push(`cd ${GEMINI_REPO} 2>/dev/null || { echo "❌ 仓库目录不存在：${GEMINI_REPO}"; exit 1; }`);
  // 用户级安装落点必须在最前面：全局 prefix 装不进去时 gemini 会落在 ~/.local/bin，
  // 不提前铺好 PATH 就会「明明装成功了却 command not found」。
  L.push(`export PATH="${GEMINI_USER_PREFIX}/bin:$PATH"`);
  // key 三级来源：环境变量 → 持久卷文件 → .env-secrets（见 resolveKeyLines 注释）
  L.push(...resolveKeyLines());
  L.push(`if [ -z "\${GEMINI_API_KEY:-}" ]; then`);
  // 走到这里 = 环境变量、持久卷文件、.env-secrets 三处都空。
  // 不要把「下一步该做什么」藏在提示里：三处都空只有一个现实原因（secret 被删/改名，
  // 或从来没配过），所以直接给出补 secret 的路径 + 临时替代方案，不再提「重启机器看看」。
  L.push(`  echo "❌ Gemini 没认证：三处都没有 key（环境变量 / ~/.config/watch-ai/gemini-key / .env-secrets）。"`);
  L.push(`  echo "   补 secret：GitHub → Settings → Codespaces → GEMINI_API_KEY（改完要重启这台机器才进容器）。"`);
  L.push(`  echo "   或者现在就发：/gemini key <KEY>（aistudio.google.com 申请）。"`);
  L.push(`  exit 2`);
  L.push(`fi`);

  // 终端能力声明：agent 的 bash 是 TERM=dumb，CLI 会在每次回答前打一行
  // 「Warning: 256-color support not detected…」，在 Telegram 里就是纯噪音。
  // 这两个变量只影响子 shell；ANSI 序列由 Worker 侧 stripAnsi 清掉。
  L.push(`export TERM=xterm-256color`);
  L.push(`export COLORTERM=truecolor`);

  // 首次安装：三级降级，全程不让用户去开 sudo 或敲密码
  //   ① `npm i -g`            —— 全局 prefix 可写时一步到位
  //   ② `sudo -n <npm> i -g`  —— codespace 默认免密 sudo；-n 保证不会卡在密码提示上
  //   ③ `npm i -g --prefix ~/.local` —— 完全免 sudo 的兜底，PATH 已在上面预先铺好
  // 三级都失败才报错，并把日志尾巴和手动命令一起打出来。
  L.push(`if ! command -v gemini >/dev/null 2>&1; then`);
  L.push(`  echo "⏳ 首次运行，正在安装 ${GEMINI_PKG}（约 1 分钟）…"`);
  L.push(`  LOG=/tmp/ws-gemini-install.log`);
  L.push(`  npm i -g ${GEMINI_PKG} </dev/null >"$LOG" 2>&1 || {`);
  L.push(`    echo "" >>"$LOG"; echo "--- 普通安装失败，试 sudo -n ---" >>"$LOG"`);
  L.push(`    NPMBIN="$(command -v npm)"`);
  L.push(`    command -v sudo >/dev/null 2>&1 && sudo -n "$NPMBIN" i -g ${GEMINI_PKG} </dev/null >>"$LOG" 2>&1`);
  L.push(`  }`);
  L.push(`  hash -r`);
  L.push(`  if ! command -v gemini >/dev/null 2>&1; then`);
  L.push(`    echo "   全局装不上，改装到 ${GEMINI_USER_PREFIX}（免 sudo）…" >>"$LOG"`);
  L.push(`    npm i -g --prefix "${GEMINI_USER_PREFIX}" ${GEMINI_PKG} </dev/null >>"$LOG" 2>&1 || true`);
  L.push(`    hash -r`);
  L.push(`  fi`);
  L.push(`  if ! command -v gemini >/dev/null 2>&1; then`);
  L.push(`    echo "❌ 安装失败，日志尾部："`);
  L.push(`    tail -12 "$LOG"`);
  L.push(`    echo "   可手动跑：sudo npm i -g ${GEMINI_PKG}"`);
  L.push(`    echo "   或免 sudo：npm i -g --prefix ${GEMINI_USER_PREFIX} ${GEMINI_PKG}"`);
  L.push(`    exit 3`);
  L.push(`  fi`);
  L.push(`fi`);

  if(!prompt) {
    L.push(`echo "✅ $(gemini --version 2>/dev/null | tail -1) 已就绪（认证 ✓）"`);
    L.push(`exit 0`);
    L.push(`)`);
    return L.join("\n");
  }

  // 问题走 base64 落临时文件：彻底避开引号 / 换行 / $ 变量展开的转义地狱
  L.push(`printf %s '${b64Utf8(prompt)}' | base64 -d > /tmp/ws-gemini-prompt.txt`);
  L.push(`P="$(cat /tmp/ws-gemini-prompt.txt)"`);

  // 输出过一道 grep：CLI 每次启动都会在 stderr 打「YOLO mode is enabled…」（还打两遍），
  // 在 Telegram 里就是每条回答前的两行噪音。-color / Ripgrep 那两条同理兜底。
  // --line-buffered 保住流式（否则 grep 会攒到进程退出才吐）；退出码用 PIPESTATUS[0] 取。
  const NOISE =
    "^(YOLO mode is enabled|Warning: .*-color support|Warning: True color|Ripgrep is not available|Attempt [0-9]+ failed)";

  if (model) {
    // 用户钉了模型：只跑它，不偷偷换（否则「我明明指定了 X」会变成扯不清的谜题）
    L.push(`OUT=/tmp/ws-gemini-out.txt`);
    L.push(`G=""`);
    if (resume) L.push(`[ -f "${GEMINI_SESSION_MARK}" ] && G="-r latest"`);
    L.push(`gemini $G ${model} --skip-trust --approval-mode=yolo -p "$P" </dev/null 2>&1 | grep --line-buffered -vE '${NOISE}' | tee "$OUT"`);
    L.push(`rc=\${PIPESTATUS[0]}`);
    L.push(`if [ $rc -eq 0 ]; then mkdir -p "$(dirname "${GEMINI_SESSION_MARK}")"; touch "${GEMINI_SESSION_MARK}"; printf %s '${model.replace(/^-m\s+/, "")}' > "${GEMINI_MODEL_FILE}"; fi`);
    L.push(`exit $rc`);
    L.push(`)`);
    return L.join("\n");
  }

  // 自动模式：按链依次尝试。可重试的失败（配额 / 过载 / 模型下线）就换下一个，
  // 其它失败（网络、代码问题）立刻停——换模型解决不了那些，只会让用户多等两个来回。
  const chain = (opts.chain?.length ? opts.chain : DEFAULT_MODEL_CHAIN).slice(0, 6);
  L.push(`CHAIN="${chain.join(" ")}"`);
  L.push(`MODELF="${GEMINI_MODEL_FILE}"`);
  // 上次成功的模型提到最前：稳定性靠它，避免每次都从链头试错
  L.push(`if [ -f "$MODELF" ]; then`);
  L.push(`  last="$(cat "$MODELF" 2>/dev/null)"`);
  L.push(`  case " $CHAIN " in *" $last "*) CHAIN="$last $(printf %s " $CHAIN " | sed "s/ $last / /")" ;; esac`);
  L.push(`fi`);
  L.push(`OUT=/tmp/ws-gemini-out.txt`);
  L.push(`rc=1; tried=""`);
  L.push(`for m in $CHAIN; do`);
  L.push(`  : > "$OUT"`);
  // 第一次尝试才续会话：换模型后旧 session 可能属于另一个模型，硬续容易再失败一次
  L.push(`  G=""; if [ -z "$tried" ] && [ -f "${GEMINI_SESSION_MARK}" ]; then G="-r latest"; fi`);
  L.push(`  gemini $G -m "$m" --skip-trust --approval-mode=yolo -p "$P" </dev/null 2>&1 | grep --line-buffered -vE '${NOISE}' | tee "$OUT"`);
  L.push(`  rc=\${PIPESTATUS[0]}`);
  L.push(`  if [ $rc -eq 0 ]; then`);
  L.push(`    mkdir -p "$(dirname "${GEMINI_SESSION_MARK}")"; touch "${GEMINI_SESSION_MARK}"`);
  L.push(`    printf %s "$m" > "$MODELF"`);
  L.push(`    [ -n "$tried" ] && echo "" && echo "✅ 本次由 $m 回答（前面试过：$tried）"`);
  L.push(`    break`);
  L.push(`  fi`);
  // 判定是否「换个模型就能好」：配额（429/RESOURCE_EXHAUSTED）、过载（503/UNAVAILABLE）、
  // 模型下线（404/NOT_FOUND/no longer available）。其余错误立即放弃。
  L.push(`  if grep -qiE 'RESOURCE_EXHAUSTED|exceeded your current quota|quota|429|UNAVAILABLE|overloaded|high demand|503|NOT_FOUND|not found|no longer available|404' "$OUT"; then`);
  // 第一次失败意味着「-r latest 续不上」，换的模型只能开新会话。不说清楚，
  // 用户会以为它忘了前面聊的内容——那是另一类 bug，不能混在一起。
  L.push(`    [ -z "$tried" ] && echo "   （换模型后是新会话，之前的对话上下文接不上）"`);
  L.push(`    tried="$tried $m"`);
  L.push(`    echo ""`);
  L.push(`    echo "⚠️ $m 不可用（配额 / 过载 / 下线），换下一个免费模型…"`);
  L.push(`    continue`);
  L.push(`  fi`);
  L.push(`  break`);
  L.push(`done`);
  L.push(`if [ $rc -ne 0 ] && [ -n "$tried" ]; then echo ""; echo "❌ 链上的免费模型都试过了：$tried"; echo "   过一会儿再试，或 /gemini model <名字> 指定一个。"; fi`);
  L.push(`exit $rc`);
  L.push(`)`);
  return L.join("\n");
}

/** 写入 API key 的脚本。整条命令不回显、不写日志（见 ShellHub 的 quiet 选项）。 */
export function buildKeyScript(key: string): string {
  const b64 = b64Utf8(key.trim());
  return [
    "(",
    `umask 077`,
    `mkdir -p "$HOME/.config/watch-ai"`,
    `printf %s '${b64}' | base64 -d > "${GEMINI_KEY_FILE}"`,
    `chmod 600 "${GEMINI_KEY_FILE}"`,
    `echo "🔑 已保存到 ~/.config/watch-ai/gemini-key（chmod 600，长度 $(wc -c <"${GEMINI_KEY_FILE}") 字节）"`,
    ")",
  ].join("\n");
}

/** 环境自检：装没装 / 有没有 key / 模型链 / 有没有可续的会话。 */
export function buildStatusScript(model?: string, chain?: string[]): string {
  const pinned = model ? sanitizeModel(model).replace(/^-m\s+/, "") : "";
  const list = chain?.length ? chain : DEFAULT_MODEL_CHAIN;
  return [
    "(",
    `cd ${GEMINI_REPO} 2>/dev/null || echo "⚠️ 仓库目录不存在：${GEMINI_REPO}"`,
    `export PATH="${GEMINI_USER_PREFIX}/bin:$PATH"`,
    `if command -v gemini >/dev/null 2>&1; then echo "CLI：✓ $(gemini --version 2>/dev/null | tail -1)（$(command -v gemini)）"; else echo "CLI：✗ 未安装（发 /gemini 自动装）"; fi`,
    `if sudo -n true 2>/dev/null; then echo "sudo：✓ 免密可用"; else echo "sudo：✗ 用不了（不影响 Gemini，安装并不需要它）"; fi`,
    // 与执行路径共用同一套解析，避免「能跑但 status 说没 key」
    ...resolveKeyLines(),
    `case "\${GEMINI_KEY_SRC:-none}" in`,
    `  env)     echo "认证：✓ 环境变量 GEMINI_API_KEY（$(printf %s "$GEMINI_API_KEY" | wc -c) 字节）" ;;`,
    `  file)    echo "认证：✓ 文件 $(ls -l "$KEYF" | awk '{print $1}')" ;;`,
    `  secrets) echo "认证：✓ 从 .env-secrets 现取（agent 未被 post-start 拉起，属正常兜底）" ;;`,
    `  *)       echo "认证：✗ 三处都没有 key（secret 被删了？补 GEMINI_API_KEY，或发 /gemini key <KEY>）" ;;`,
    `esac`,
    pinned
      ? `echo "模型：固定 ${pinned}（不自动切换；/gemini model auto 回到链）"`
      : `echo "模型：自动（链：${list.join(" → ")}）"; last="$(cat ${GEMINI_MODEL_FILE} 2>/dev/null)"; echo "优先：\${last:-${list[0]}}（上次成功的会提到最前）"`,
    `if [ -f "${GEMINI_SESSION_MARK}" ]; then echo "会话：有（下条会用 -r latest 续）"; else echo "会话：无（下条开新会话）"; fi`,
    `echo "目录：$(pwd)"`,
    ")",
  ].join("\n");
}

/**
 * 列出账号可见的对话模型，并标出哪些在当前链里（✅）。
 *
 * 为什么走 REST 而不是 CLI：CLI 没有列模型的子命令，而 `GET /v1beta/models`
 * 是同一个 key 就能查的权威来源。过滤掉明显不能聊天的（embedding / image / tts /
 * live / transcribe…），否则 60 多个名字里混着 nano-banana 只会更难选。
 */
export function buildModelsScript(chain?: string[]): string {
  const list = chain?.length ? chain : DEFAULT_MODEL_CHAIN;
  return [
    "(",
    ...resolveKeyLines(),
    `if [ -z "\${GEMINI_API_KEY:-}" ]; then echo "❌ 没有 key，先发 /gemini key <KEY>"; exit 2; fi`,
    `echo "链（自动切换顺序）：${list.join(" → ")}"`,
    `last="$(cat ${GEMINI_MODEL_FILE} 2>/dev/null)"; [ -n "$last" ] && echo "上次成功：$last"`,
    `echo ""; echo "账号可见的对话模型（✅ = 已在链中）："`,
    `curl -s --max-time 20 "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000" -H "x-goog-api-key: $GEMINI_API_KEY" \\`,
    `  | tr ',' '\\n' | grep -o '"name": *"models/[^"]*"' | sed 's|.*models/||; s|"||' \\`,
    `  | grep -viE 'embedding|aqa|imagen|veo|tts|live|audio|transcribe|lyria|nano-banana|robotics|computer-use|deep-research|antigravity|omni|image' \\`,
    `  | sort -u | while read -r m; do`,
    `      case " ${list.join(" ")} " in *" $m "*) echo "  ✅ $m" ;; *) echo "     $m" ;; esac`,
    `    done`,
    `echo ""; echo "用法：/gemini model <名字> 固定；/gemini model auto 回到链"`,
    ")",
  ].join("\n");
}

/** 清掉续用标记 = 开始新会话。 */
export function buildNewSessionScript(): string {
  return `rm -f "${GEMINI_SESSION_MARK}" && echo "🆕 已清空续用标记，下一条问题会开新会话"`;
}

// ------------------------------------------------------------------ 参数解析

export type GeminiAction =
  | { kind: "open" }
  | { kind: "ask"; prompt: string }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "new" }
  | { kind: "key"; key: string }
  | { kind: "model"; model: string }
  | { kind: "models" }
  | { kind: "help" };

/**
 * 解析 `/gemini` 后面的参数。
 *
 *   （空）           → 打开模式
 *   off / exit      → 关闭模式
 *   status          → 自检
 *   models          → 列出账号可见的模型（标出链中的）
 *   new / reset     → 新会话
 *   key <KEY>       → 写 key
 *   model <名字>    → 固定模型；`model auto` 回到自动链
 *   help            → 单条帮助
 *   其它任何文本     → 当作一次性提问
 */
export function parseGeminiArgs(args: string): GeminiAction {
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
  if (key === "key" || key === "auth") return tail ? { kind: "key", key: tail } : { kind: "help" };
  if (key === "model" || key === "m") {
    if (!tail) return { kind: "help" };
    // auto = 交还给免费链（与「固定某个模型」相对）
    return { kind: "model", model: /^(auto|reset|off|default|any)$/i.test(tail) ? "auto" : tail };
  }
  return { kind: "ask", prompt: raw };
}

/** 回显用：把问题压成一行并截断（Telegram 里当命令标题）。 */
export function previewPrompt(prompt: string, max = 80): string {
  const one = prompt.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}
