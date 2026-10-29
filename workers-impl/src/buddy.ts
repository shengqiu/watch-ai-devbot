/**
 * CodeBuddy CLI 接入层（纯函数：只生成 bash 脚本，不碰 Worker/DO）。
 *
 * 与 /gemini 的关系：**同一套模式**（非交互 `-p`、按行抓 stdout、`-c` 续会话），
 * 但认证方式完全不同 —— 这里不需要 API key：
 *   CodeBuddy 用浏览器 OAuth 登录，登录态落在机器的 `~/.codebuddy`（持久卷）。
 *   一次性在那台机器上跑一次交互式登录，之后所有 headless 调用都复用它。
 *   所以本文件里**没有** resolveKey 那套三级 key 兜底。
 *
 * 点数（credits）另说：CLI 自己不报账 —— `--output-format json` 里的
 * `total_cost_usd` 恒为 0，也没有任何 points 字段（2026-10-29 实测）。
 * 但它每次启动都会把 `GET https://copilot.tencent.com/v3/config` 的响应
 * 明文缓存在 `~/.codebuddy/local_storage/*.info` 里，每个模型带一个
 * `credits` 倍率：`"x0.11 credits"`。**`x0.00 credits` 才是免费的**，
 * 其余全都扣点数 —— 这就是「哪个模型免费」的唯一可信来源，别再用印象猜。
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
 * 免费模型的**离线快照**（2026-10-29 取自 copilot.tencent.com/v3/config 全表）：
 * 29 个按倍率计费的模型里，只有 `hy3` 是 `x0.00 credits`。
 * 运行时以机器上的实时价格表为准，这里只是「表读不到」时的兜底，会过时会变。
 */
export const DEFAULT_FREE_MODELS: string[] = ["hy3"];

/**
 * 付费兜底顺序（质量优先，不是价格优先）。
 *
 * 只在「免费模型全都不通」且没设 `BUDDY_FREE_ONLY=1` 时才会用到；
 * 每当真的用上付费模型，脚本都会在 Telegram 里明说「这一跳 ×N 点数」，
 * 不会悄悄花钱。倍率：deepseek-v4.1-flash ×0.11 / glm-5.3-flash ×0.08 /
 * minimax-m3.1-flash ×0.08 / hy4-preview ×0.29。
 */
export const DEFAULT_PAID_FALLBACK: string[] = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "minimax-m3.1-flash",
  "hy4-preview",
];
/** 上次成功的模型（持久卷）。下次从它开始，避免每次都从链头试错。 */
export const BUDDY_MODEL_FILE = "$HOME/.config/watch-ai/buddy-model";

/** 机器上的实时价格表：每行 `模型id|点数倍率`（0 = 免费）。 */
export const BUDDY_CREDITS_TABLE = "/tmp/ws-buddy-credits.tsv";

/**
 * 从 CLI 的本地缓存里抽出「每个模型多少点数」的 node 小程序。
 *
 * 为什么读缓存而不是打接口：`/v3/config` 要 OAuth Bearer，那套 token 在
 * `~/.codebuddy` 里是压缩+编码的，Worker 侧既拿不到也不该碰；而 CLI 每次
 * 启动都会刷新这个缓存（mtime 就是新鲜度），读它零成本、零凭证。
 *
 * 约定：**不许出现单引号**（外面用 `node -e '...'` 包着），只用双引号。
 * 输出 `id|credits`，拿不到就非零退出，由 bash 侧决定兜底。
 */
export const CREDITS_NODE_PROGRAM = [
  'const fs=require("fs"),path=require("path"),os=require("os");',
  "const home=process.env.CB_HOME||os.homedir();",
  'const dir=path.join(home,".codebuddy","local_storage");',
  "let files=[];try{files=fs.readdirSync(dir);}catch(e){process.exit(3);}",
  'let best="",bt=-1;',
  "for(const f of files){",
  '  if(!f.endsWith(".info"))continue;',
  "  const p=path.join(dir,f);",
  "  try{const st=fs.statSync(p);",
  "    if(st.mtimeMs>bt){const s=fs.readFileSync(p,\"utf8\");",
  '      if(s.indexOf("credits")<0)continue;',
  "      best=p;bt=st.mtimeMs;}}catch(e){}",
  "}",
  "if(!best)process.exit(4);",
  "let arr;try{arr=JSON.parse(fs.readFileSync(best,\"utf8\"));}catch(e){process.exit(5);}",
  "const list=Array.isArray(arr)?arr:[arr];",
  "let models=null;",
  "for(const e of list){if(e&&e.data&&Array.isArray(e.data.models))models=e.data.models;}",
  "if(!models)process.exit(6);",
  "const out=[];",
  "for(const m of models){",
  '  const g=String(m.credits||"").match(/([0-9]+(?:\\.[0-9]+)?)/);',
  "  if(!m.id||!g)continue;",
  // 归一化：0.00 → 0（bash 侧只认字符串 "0" 当免费）
  '  out.push(m.id+"|"+Number(g[1]));',
  "}",
  "if(!out.length)process.exit(7);",
  'process.stdout.write(out.join("\\n")+"\\n");',
].join("");

/** 探测价格表的 bash 片段：写 `BUDDY_CREDITS_TABLE`，按 id 排序，失败也只是空文件。 */
export function creditsProbeLines(): string[] {
  return [
    `CREDF="${BUDDY_CREDITS_TABLE}"`,
    `: > "$CREDF"`,
    `node -e '${CREDITS_NODE_PROGRAM}' 2>/dev/null | sort -t'|' -k1,1 > "$CREDF" || true`,
  ];
}

/**
 * 由「免费清单 + 付费兜底」算出本次尝试顺序（纯函数，单测直接用）。
 * 免费在前（保持传入顺序），付费在后并去重；`freeOnly` 时只留免费。
 */
export function buildChain(free: string[], paid: string[], freeOnly = false): string[] {
  const out: string[] = [];
  const push = (m: string) => {
    const name = m.trim();
    if (name && !out.includes(name)) out.push(name);
  };
  for (const m of free) push(m);
  if (!freeOnly) for (const m of paid) push(m);
  return out;
}

/**
 * 解析 `BUDDY_MODELS` 环境变量（逗号/空格分隔）为**付费兜底**顺序；非法名丢弃。
 * 空或全非法 → 默认付费兜底。免费那一段永远由机器上的实时表决定，不从这里来。
 */
export function parseBuddyChain(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const piece of (raw ?? "").split(/[\s,]+/)) {
    const m = piece.trim();
    if (!m) continue;
    const ok = sanitizeModel(m).replace(/^-m\s+/, "");
    if (ok && !out.includes(ok)) out.push(ok);
  }
  return out.length ? out : [...DEFAULT_PAID_FALLBACK];
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

  // 工作目录可用 BUDDY_WORKDIR 覆盖（单测要能在临时目录里跑整条链）
  L.push(`BD="\${BUDDY_WORKDIR:-${BUDDY_DIR}}"`);
  L.push(`mkdir -p "$BD" 2>/dev/null || true`);
  L.push(`cd "$BD" 2>/dev/null || { echo "❌ 工作目录建不出来：$BD"; exit 1; }`);

  // 免信任：headless 下虽然不一定弹窗，但 TUI 会；而且「信任」是安全边界，
  // 应该显式、可见地声明（写进 settings.json），而不是靠 --yes 之类偷偷绕过。
  // 用 node 改 JSON（python3 也行，但 node 是 CLI 的运行时，一定存在）。
  L.push(`NS="${BUDDY_CONF_DIR}/settings.json"`);
  L.push(`mkdir -p "${BUDDY_CONF_DIR}" 2>/dev/null || true`);
  L.push(
    `if ! grep -q "$BD" "$NS" 2>/dev/null; then ` +
      `node -e 'const fs=require("fs"),p=process.env.HOME+"/.codebuddy/settings.json";` +
      `let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};` +
      `const t=new Set(s.trustedDirectories||[]);` +
      `t.add(process.env.BUDDY_WORKDIR||"${BUDDY_DIR}");` +
      `s.trustedDirectories=Array.from(t);fs.writeFileSync(p,JSON.stringify(s,null,2)+"\\n")' 2>/dev/null ` +
      `&& echo "🔓 已把 $BD 加进 trustedDirectories"; fi`,
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
    // 自动模式：**免费优先**。免费清单不再写死在代码里，而是每次现读机器上的
    // 价格表（CLI 启动时缓存下来的 /v3/config）——只有倍率 0 的算免费。
    const paid = (opts.chain?.length ? opts.chain : DEFAULT_PAID_FALLBACK).slice(0, 6);
    L.push(...creditsProbeLines());
    L.push(`FREE="$(awk -F'|' '$2+0==0{print $1}' "$CREDF" 2>/dev/null | tr '\\n' ' ')"`);
    L.push(`PAID="${paid.join(" ")}"`);
    // 免费全挂时要不要动付费模型，由环境变量决定（默认允许，但会明说花了点数）
    L.push(`[ -n "\${BUDDY_FREE_ONLY:-}" ] && PAID=""`);
    L.push(
      `CHAIN="$(printf '%s\\n' $FREE $PAID | awk 'NF&&!seen[$0]++' | tr '\\n' ' ')"`,
    );
    // 表读不到（CLI 还没跑过 / 缓存被清）才退回内置快照，并在输出里说明
    L.push(`if [ -z "$(printf %s "$FREE" | tr -d ' ')" ]; then`);
    L.push(`  echo "⚠️ 读不到 CodeBuddy 的价格表，先用内置快照：${DEFAULT_FREE_MODELS.join(" ")}"`);
    L.push(`  CHAIN="$(printf '%s\\n' ${DEFAULT_FREE_MODELS.join(" ")} $CHAIN | awk 'NF&&!seen[$0]++' | tr '\\n' ' ')"`);
    L.push(`fi`);
    L.push(`MODELF="${BUDDY_MODEL_FILE}"`);
    // 上次成功的模型提到最前：稳定性靠它，别每条消息都从链头试错
    L.push(`if [ -f "$MODELF" ]; then`);
    L.push(`  last="$(cat "$MODELF" 2>/dev/null)"`);
    L.push(`  case " $CHAIN " in *" $last "*) CHAIN="$last $(printf %s " $CHAIN " | sed "s/ $last / /")" ;; esac`);
    L.push(`fi`);
    L.push(`rc=1; tried=""`);
    L.push(`for m in $CHAIN; do`);
    L.push(`  : > "$OUT"`);
    // 本跳的点数倍率：0（或读不到）= 免费
    L.push(`  CR=$(awk -F'|' -v m="$m" '$1==m{print $2; exit}' "$CREDF" 2>/dev/null)`);
    L.push(`  [ -z "$CR" ] && CR="?"`);
    // 第一次尝试才续会话：换模型后旧会话可能属于另一个模型，硬续容易再失败一次
    L.push(`  G=""; if [ -z "$tried" ] && [ -f "${BUDDY_SESSION_MARK}" ]; then G="-c"; else G=""; fi`);
    L.push(`  next="$(printf %s " $CHAIN " | sed "s/^ *$m */ /" | awk "{print \\$1}" | grep . || true)"`);
    // 原生 fallback 只在「同一档位」之间开：free→paid 静默切换等于偷偷扣点数，
    // 那种降级交给外层循环，至少会打一行字告诉你「换成了 ×0.11 的模型」。
    L.push(`  FB=""`);
    L.push(`  if [ -n "$next" ]; then`);
    L.push(`    CRN=$(awk -F'|' -v m="$next" '$1==m{print $2; exit}' "$CREDF" 2>/dev/null)`);
    L.push(`    [ -z "$CRN" ] && CRN="?"`);
    L.push(`    if [ "$CR" = "0" ] && [ "$CRN" != "0" ]; then FB=""; else FB="--fallback-model $next"; fi`);
    L.push(`  fi`);
    L.push(`  codebuddy \${G:-} -y --model "$m" $FB -p "$P" </dev/null 2>&1 | tee "$OUT"`);
    L.push(`  rc=\${PIPESTATUS[0]}`);
    L.push(`  if [ $rc -eq 0 ]; then`);
    L.push(`    mkdir -p "$(dirname "$MODELF")"; printf %s "$m" > "$MODELF"`);
    L.push(`    if [ -n "$tried" ]; then echo ""; echo "✅ $m 接住了（前面试过：$tried）"; fi`);
    L.push(`    if [ "$CR" != "0" ] && [ "$CR" != "?" ]; then echo "💸 这一跳是付费模型：$m ×$CR 点数（免费的都没通）"; fi`);
    L.push(`    break`);
    L.push(`  fi`);
    L.push(`  tried="$tried $m"`);
    L.push(`  echo ""`);
    L.push(`  if [ "$CR" = "0" ]; then echo "⚠️ 免费模型 $m 不可用，换下一个…";`);
    L.push(`  elif [ "$CR" = "?" ]; then echo "⚠️ $m 不可用，换下一个…";`);
    L.push(`  else echo "⚠️ $m 不可用（×$CR 点数），换下一个…"; fi`);
    L.push(`done`);
    L.push(`if [ $rc -ne 0 ] && [ -n "$tried" ]; then echo ""; echo "❌ 链上的都试过了：$tried"; echo "   /buddy model <名字> 手动指定；/buddy models 看点数倍率。"; fi`);
  }
  // 成功才建会话标记：失败的那次没有可续的会话，提前建标记会让下一条报「无会话可续」
  L.push(`if [ $rc -eq 0 ]; then mkdir -p "$(dirname "${BUDDY_SESSION_MARK}")"; touch "${BUDDY_SESSION_MARK}"; fi`);
  L.push(`exit $rc`);
  L.push(`)`);
  return L.join("\n");
}

/** 环境自检：装没装 / 目录对不对 / 信任了没 / 有没有可续的会话 / 当前哪些模型免费。 */
export function buildBuddyStatusScript(model?: string, chain?: string[]): string {
  const pinned = model ? sanitizeModel(model).replace(/^-m\s+/, "") : "";
  const paid = chain?.length ? chain : DEFAULT_PAID_FALLBACK;
  return [
    "(",
    `BD="\${BUDDY_WORKDIR:-${BUDDY_DIR}}"`,
    `mkdir -p "$BD" 2>/dev/null || true`,
    `cd "$BD" 2>/dev/null || echo "⚠️ 工作目录不存在：$BD"`,
    `export PATH="$HOME/nvm/current/bin:/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"`,
    ...locateLines(),
    `if command -v codebuddy >/dev/null 2>&1; then echo "CLI：✓ $(codebuddy --version 2>/dev/null | tail -1)（$(command -v codebuddy)）"; else echo "CLI：✗ 未安装（发 /buddy 自动装）"; fi`,
    `if grep -q "$BD" "${BUDDY_CONF_DIR}/settings.json" 2>/dev/null; then echo "信任：✓ $BD 已在 trustedDirectories"; else echo "信任：✗ 未声明（下次调用会自动补上）"; fi`,
    // 登录态没法离线判定（token 存在 local_storage 的加密条目里），只能说清「在哪、怎么补」
    `if [ -d "${BUDDY_CONF_DIR}" ]; then echo "认证：✓ 已初始化 ~/.codebuddy（OAuth 登录态；失效时 headless 会直接报鉴权错误）"; else echo "认证：✗ 没登录过（需要在机器里交互式跑一次 codebuddy 完成浏览器授权）"; fi`,
    ...creditsProbeLines(),
    `FREE="$(awk -F'|' '$2+0==0{print $1}' "$CREDF" 2>/dev/null | tr '\\n' ' ')"`,
    pinned
      ? `echo "模型：固定 ${pinned}（不自动切换；/buddy model auto 回到免费优先）"`
      : `echo "模型：免费优先（免费清单现读价格表：\${FREE:-读不到，用内置快照 ${DEFAULT_FREE_MODELS.join(" ")}））"`,
    pinned ? null : `echo "免费等于倍率 0；免费全挂才试：${paid.join(" → ")}"`,
    `last="$(cat ${BUDDY_MODEL_FILE} 2>/dev/null)"; [ -n "$last" ] && echo "上次成功：$last"`,
    `if [ -s "$CREDF" ]; then echo "点数表：$(wc -l < "$CREDF" | tr -d ' ') 个模型（缓存 $(( ( $(date +%s) - $(stat -c %Y "$CREDF" 2>/dev/null || echo 0) ) / 60 )) 分钟前刷新）"; else echo "点数表：✗ 读不到（发一条 /buddy 会重新生成）"; fi`,
    `if [ -f "${BUDDY_SESSION_MARK}" ]; then echo "会话：有（下条会用 -c 续）"; else echo "会话：无（下条开新会话）"; fi`,
    `echo "目录：$(pwd)"`,
    ")",
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** 列出 CLI 支持的模型：优先现查 help（跟版本走），查不到用兜底常量；标注哪些在免费链里。 */
export function buildBuddyModelsScript(chain?: string[]): string {
  const paid = chain?.length ? chain : DEFAULT_PAID_FALLBACK;
  return [
    "(",
    `export PATH="$HOME/nvm/current/bin:/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"`,
    ...locateLines(),
    `if ! command -v codebuddy >/dev/null 2>&1; then echo "CLI 还没装，发一次 /buddy 会自动装。"; exit 2; fi`,
    ...creditsProbeLines(),
    `if [ -s "$CREDF" ]; then`,
    `  echo "点数倍率（来自 CodeBuddy 自己的价格表 /v3/config，0 = 免费）："`,
    `  sort -t'|' -k2,2g "$CREDF" | while IFS='|' read -r id cr; do`,
    `    if [ "$cr" = "0" ]; then tag="free  "; else tag="×$cr"; fi`,
    `    printf '  %-8s %s\\n' "$tag" "$id"`,
    `  done`,
    `else`,
    `  echo "⚠️ 读不到价格表（CLI 还没在这台机器上跑过？随手发一条 /buddy 就会生成）"`,
    `fi`,
    `last="$(cat ${BUDDY_MODEL_FILE} 2>/dev/null)"; [ -n "$last" ] && echo "" && echo "上次成功：$last"`,
    `echo ""`,
    `echo "免费优先；免费全挂时才按这个顺序试付费：${paid.join(" → ")}"`,
    `echo "用法：/buddy model <名字> 固定；/buddy model auto 回到免费优先"`,
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
