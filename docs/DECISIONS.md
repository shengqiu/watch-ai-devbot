# 技术选型决策记录（ADR）

> 每条决策记录：背景 → 选项对比 → 结论 → 理由。日期 2026-10-24。
>
> 注：ADR-1 / ADR-2（微信通道选型、微信 ASR）随微信路线移除已于 2026-10-26 删除；
> ADR-7 / ADR-8（QQ 通道选型与实现）随 QQ 路线移除已于 2026-10-26 删除；
> ADR 编号保留不重排，避免既有引用失效。

## ADR-3 LLM 路由：MVP 自研薄路由，按需上前置 new-api / LiteLLM

| 方案 | Stars/活跃度 | 强项 | 弱项 |
|---|---|---|---|
| new-api | 4.2 万+，活跃 | Web 后台、多渠道 key 分发、额度计费、中文生态 | AGPL-3.0（改造后对外服务需开源） |
| LiteLLM | 5.4 万+，活跃 | 100+ 提供商、Python SDK 一体、负载均衡/fallback/成本追踪 | 后台偏轻，Proxy 模式配置曲线陡 |
| one-api | 3.6 万，停更 | 经典省心 | 2026-01 后无提交，新模型要自己补 |
| Portkey | 1.2 万，活跃 | 转发快、50+ 护栏 | 多用户分发弱 |
| **自研薄路由** | — | 零依赖、配置驱动、完全可控 | 无后台/计费，自己维护 |

**结论**：MVP 用自研薄路由（`workers-impl/src/router/`，`providers.json` 配置驱动，OpenAI 兼容客户端直连各家）；出现"管多个 key / 给多人分发 / 看消耗"需求时，前置 new-api（自用无 AGPL 顾虑）或 LiteLLM。
**理由**：三方案对外都是 OpenAI 兼容 `/chat/completions`，后置接入无痛，避免过早引入运维负担。

## ADR-4 编程执行体：LLM 直出为默认，Codex CLI / Claude Code CLI 为进阶

**结论**（2026-10-24 更新）：默认单轮/多轮 LLM 生成（带系统提示与仓库上下文）；复杂任务切 CLI 执行体子进程模式，工作目录锁定仓库——**Codex CLI 与 Claude Code CLI 二选一，接口同构**（需 VPS 自托管，当前仓库未内置）。
**理由**：LLM 直出覆盖 80% 手表场景（短代码、解释、重构片段）；CLI 执行体处理多文件改动且迭代闭环。OpenHands 留作 V2（容器资源需求高）。
**Codex CLI 落地参数**（2026-10 官方文档坐实）：`npm i -g @openai/codex`；非交互模式 `codex exec "<prompt>"`——最终消息走 stdout、进度走 stderr、零交互审批；改文件需 `--sandbox workspace-write`（默认只读；`--full-auto` 已是废弃兼容 flag）；非 Git 工作区必须 `--skip-git-repo-check` 否则退出 1；`-C <dir>` 指定工作目录；进阶接口有 `--json`（JSONL 事件流）、`-o`（最终消息落盘）、`--output-schema`（结构化输出）、`codex exec resume --last`（多阶段管道）。headless 认证 `codex login --device-auth`，CI 用 `CODEX_API_KEY`。
**边界（重要）**：CLI 执行体依赖子进程，**只能在 VPS/Docker 路径自建**；Cloudflare Workers 是 V8 isolate 无子进程能力，Workers 路径（`workers-impl/`，当前主实现）上执行体恒为 LLM 直出。
**计费差异**：Codex CLI 可用 ChatGPT 订阅（Plus/Pro 等，exec 计入计划额度）或 API key 计量；Claude Code CLI 需 Anthropic API key 或 Claude 订阅。按你已有的订阅选，避免双重付费。
**安全**：生成代码一律沙箱执行；破坏性操作回 IM 二次确认。

## ADR-5 部署：单机 Docker Compose 起步，国内云/海外 VPS 二选一

**结论**：个人自用单机足够（2C4G）。国内主体+国内模型 → 国内轻量云（域名需 ICP 备案）；重度 Claude/GPT → 海外 VPS（免备案，回调延迟可接受）。
**理由**：公网回调只要求公网 HTTPS，无地域限制；先跑起来再谈高可用。

## ADR-6 会话与状态：Redis（会话/去重/限流），Postgres 后置

**结论**：MVP 进程内内存实现（接口与 Redis 适配器同构），上生产换 Redis；任务记录/审计日志先落文件，V2 再上 Postgres。
**理由**：个人自用量级下内存足够，但 `SessionStore` 抽象保证迁移只换实现。

## ADR-9 计算平台终版：Cloudflare Workers + Durable Objects（2026-10-24）

**背景**：ADR-5 定的是「单机 Docker Compose + VPS」。用户要求先敲定云计算产品再动代码，并对「Oracle 之外的免费选项」做了全量调研（GCP e2-micro / Azure 12 个月 / CF Workers / HF Spaces / Render / Fly / Railway / Deno Deploy / 家里常开设备）。

**调研关键事实**：
- **Render Free 出局**：免费档无 background worker，且 15 分钟无请求即休眠——长连接 bot 永远算「空闲」。Fly.io / Railway / Heroku 免费档均已终结；HF Spaces 的 Docker/Gradio 自 2026-07 起需 PRO $9/月。
- **永久免费的 VPS 只剩 Oracle（2C12G，注册要国际信用卡+抢容量）与 GCP e2-micro（仅美国 3 区、1GB）**；Azure 是 12 个月过渡。
- **Cloudflare Workers 免费档**：10 万请求/天、13,000 GB-s/天、DO SQLite 5GB、**无需绑卡**；DO 事件驱动、按请求唤醒、事毕休眠，duration 成本近似为零——与「云端助手收事件→处理→回包」的形态天然匹配（事件接入模式见 ADR-9.1）。

**结论（用户已确认选 Cloudflare Workers）**：
1. 计算平台 = **Cloudflare Workers + Durable Objects**（`workers-impl/`，TypeScript，主实现）。
2. 状态（会话历史/去重/限流/日额度）全部落 DO SQLite；无常驻连接、无 cron 心跳依赖。
3. **失去的能力及对策**：本地 Whisper（无 Python/ffmpeg）→ OpenAI 兼容 STT API；Claude Code CLI（不能跑子进程）→ 仅 LLM 直出模式。
4. 成本：基础设施 ¥0（免卡），模型 API 按量。webhook 事件驱动下请求约几百/天（限额 10 万），DO duration 接近 0——免费档余量充足。
5. **自托管备选路径**（Oracle/Hetzner VPS）当前仓库未内置实现（Python 参考实现已于 2026-10-26 移除），需要时可按同一套意图路由/厂商 fallback 设计重建。

**理由**：¥0 + 免信用卡 + 零运维 + 边缘低延迟，且本架构「只需出站 HTTPS」的形态与 DO 休眠机制天然匹配；失去的「跑任意进程」能力有 API 级替代且不是 MVP 必需。
**代价**：相比 Python 方案整体改写为 TypeScript。

### ADR-9.1 事件接入模式修正：Webhook 优先（2026-10-24 晚间，实测后追加）

**背景**：ADR-9 初版按「长连接保活」设计（DO 常驻出站 WS + alarm 心跳）。实测验证后确认：聊天机器人的事件接入**默认 Webhook 模式**（平台主动 POST 推事件到开发者 HTTPS 端点），长连接只作备选。

**结论**：
1. 事件接入**默认 Webhook 模式**：Worker 收 `POST /webhook` → 解析事件 → 既有流水线（waitUntil 后台处理，立即 ACK）；回复走 REST 出站（CF 出口可达，已验证）。
2. **收益**：无常驻连接 → DO 按请求唤醒、不计 duration；无 alarm/cron 心跳依赖；代码路径更短；免费档 100k 请求/天对个人用量（日均几十条）绰绰有余。
3. 长连接客户端代码不作默认路径：CF Workers 的 fetch 原生不支持 `wss://`，且部分平台对出口 IP 有风控；其他部署环境（VPS/自托管）如需要可自行扩展。
4. ADR-9 初版「放哪台机器取决于长连接」的前提修正为：**平台选择不绑定连接形态，webhook 事件模式支撑 workers-impl 运行**。

## ADR-10 模型厂商主选：Google Gemini（2026-10-24）

**背景**：用户明确「不想用 Claude，要用 Google Gemini」。

**结论**：
1. 主厂商 = **Gemini**（`DEFAULT_CODING_PROVIDER=gemini`、`DEFAULT_CHAT_PROVIDER=gemini`）：default 档 `gemini-3.8-flash`、flagship 档 `gemini-3.1-pro`、fast 档 `gemini-3.1-flash-lite`。
2. 接入方式 = Gemini 官方 **OpenAI 兼容端点** `https://generativelanguage.googleapis.com/v1beta/openai/`（`Authorization: Bearer {GEMINI_API_KEY}`）——与其余厂商共用同一套 `/chat/completions` 路由代码，零额外适配。
3. **Claude 降级为可选**：`providers` 中 `anthropic` 置 `enabled: false`，填 key 后置 true 即恢复；意图别名表保留 `claude/anthropic/克劳德`。
4. 意图解析新增别名：`gemini / google / 谷歌 / gemini pro / gemini flash`；「pro 档」触发 flagship 档位。
5. 对架构的连带影响：Gemini 国内不可直连 → 计算侧必须出海 → 与 ADR-9（Cloudflare Workers）互相印证，国内 VPS 选项在 Gemini 为主的前提下不再适合。
6. 成本红利：AI Studio 免费档可覆盖个人轻度使用（~50 条/天），模型侧有机会 ¥0；超额按量计费。

**理由**：用户偏好；Gemini 3 档编程能力与 Claude/GPT 同档；OpenAI 兼容端点让「按需选厂商」的路由层零成本扩展；免费档进一步压低总成本。
**代价**：模型名随 Google 换代较快（`providers` 配置中集中管理，改名只改一处）；思考模型（3.x Pro）无法关闭思考，延迟高于 flash 档——fast 档用 flash-lite 规避。

## ADR-11 终端通道选型：Telegram 官方 Bot（2026-10-25）

**背景**：用户希望在常用 IM 里与云端助手对话。终端通道候选经逐一验证后收敛到 Telegram 官方 Bot。

**结论**：终端通道 = **Telegram 官方 Bot**。
1. 接入 = Webhook 模式：Telegram 主动 POST 事件到 `workers.dev/webhook`（**全球可达**，无备案、无 Ed25519 签名、无 intent 配置、无沙箱成员限制、免审核）；回复走 `sendMessage`，语音走 `getFile` + 下载。
2. 代码结构：`workers-impl/src/telegram/`（client/update/types）+ `src/bot-do.ts`（`AssistantDO`）；消息流水线（去重/白名单/限流/日额度/意图/路由/分段回包）与通道层解耦，换通道只换 client/update。wrangler 迁移 `v2 new_sqlite_classes=["AssistantDO"]`，cron 置空（无常驻连接需保活）。
3. 新增 `/setup` 端点：用请求的真实公网 origin 一次性 `setWebhook`。
4. 语音 ASR：走 OpenAI 兼容 STT 端点（默认推荐 Groq Whisper 免费档，`whisper-large-v3`）；不配则只能发文字。

**理由**：Telegram Bot API 是纯 HTTPS REST + webhook，与 Cloudflare Workers 事件驱动形态**天然绝配**——无备案、无签名、无审核、无意图配置的全部摩擦；@BotFather 30 秒出 token；无常驻连接、duration 成本≈0；Watch Telegram 手表版支持语音输入（听写/语音条均可）。
**代价**：**Telegram 在中国大陆被墙**——用户手机与 Apple Watch 需代理/VPN；语音需第三方 STT 转写（无平台内置免费 ASR）。

## ADR-12 编程执行体接入：非交互 CLI（/gemini、/buddy，2026-10-28）

**背景**：ADR-4 把「LLM 直出」定为默认、CLI 定为进阶。实际使用中用户希望在手表/手机上直接驱动真正的编码 agent（能改文件、跑命令），而开发机（GitHub Codespace）已经由 devbot 远程开关机。

**结论**：
1. 不做「把 TUI 塞进 Telegram」。两个 CLI 都走**非交互模式**：每条消息 = 一次 `-p "<问题>"`，stdout 逐行回传；交互式 Ink/全屏 TUI 每次按键重绘，硬灌进来只会得到重复碎片。
2. 会话续用靠 CLI 自己的 session（gemini `-r latest` / codebuddy `-c`），并用标记文件保护「首次没有 session 可续」的情况。
3. 无人值守必须自动批准：gemini `--approval-mode=yolo`、codebuddy `-y`。
4. 认证分两条路，都不经过聊天：`/gemini` 用 `GEMINI_API_KEY`（Codespaces secret 或 out-of-band 写的 `~/.config/watch-ai/gemini-key`）；`/buddy` 用 **CodeBuddy 自己的浏览器 OAuth**，登录态落在开发机 `~/.codebuddy`，chat 侧没有任何 key 可收（`/buddy key|login` 直接回帮助）。
5. 两个 provider 共用**一个**会话模式槽位（`ai_mode`）：普通文本只能给其中一个，「后来的覆盖先前的」，避免用户必须先 off 再开。
6. `/buddy` 固定工作目录 `/workspaces/codebuddy` 并 pre-trust（写进 `~/.codebuddy/settings.json` 的 `trustedDirectories`）：headless 下信任询问会直接卡住，且「允许 agent 在哪个目录动手」是安全边界，应当显式声明而不是靠 `--yes` 偷偷绕过。

**理由**：CLI 的会话/工具/权限模型已经成熟，复用它比自己写一个 agent 省钱省时；一键「开机 → 等 shell → 装 CLI → 发问题」的体验和 /boot 一致；两个 CLI 共用流程控制（模式开关、待发提问、prep alarm）只在生成脚本处分叉，避免复制整套等待/重试逻辑。
**代价**：单飞队列下一问一答串行，长任务会占住通道；CodeBuddy 登录失效时只能人工到开发机终端重新授权（headless 拿不到浏览器）；CLI 的 flag 随版本变动（如 `--model` 无短选项），改动需同步 `src/buddy.ts` / `src/gemini.ts`。

## ADR-13 长任务的生存与可观测性：进程证据驱动（/buddy，2026-10-28）

**背景**：用户问「CodeBuddy 长任务会不会被杀」。排查出 5 条会终止长任务的路径：① agent 看门狗（4/8 分钟零输出即 SIGKILL 整个进程组）；② 省额度看门狗（55 分钟无终端互动即关机）；③ Worker 命令 TTL（15 分钟从下发时刻起算）；④ DO 回收（输出静默丢弃）；⑤ GitHub idle timeout（30 分钟，免费套餐上限改不动）。①③②④ 可修，本版全部处理。

**结论**：
1. **杀不杀由进程证据决定，不由输出静默时长决定**（agent 新增 proc.mjs 探针）：zombie / never-moved（10 分钟零 CPU 增长）/ cpu-frozen（15 分钟 CPU 冻结）才杀；suspended（SIGSTOP）/ io（D 状态）只报不杀；其余继续等并每 2~5 分钟播报一次「仍在运行 + 进程状态行」。
2. CPU 轨迹按 pid 逐个比较而非整树求和（子进程退出会让总和跳变）；首探只记基线，否则 wrapper 启动 CPU 会被误当成进度。
3. **心跳带 proc 状态行**：`/cs` 与「仍在运行」提示共用；老 agent 不发该字段时明确提示「需 git pull」而不是含糊的未知。
4. **TTL 从最后一次活动起算**（心跳说在跑 = 活动），兜底 15 → 60 分钟。
5. **有命令在跑 = 正在用**：看门狗（evalWatch busy 分支）不提醒不关机，5 分钟后复查。
6. **幽灵输出不再黑洞**：登记被清后迟到的输出包会提示「它可能还在跑」（每条命令只提醒一次）。

**理由**：误杀的代价是正在写的文件只写一半、git 停在中间态；而「读不到证据」绝不能当成「卡死」。判据分级让 2026-10-27 那种「进程活着但 12 分钟零反应」仍能被回收（never-moved），同时 codebuddy 思考 10 分钟不再陪葬。

**代价**：探针只认 Linux /proc（macOS 退回纯时间判据）；`sleep >10 分钟` 这类真零 CPU 的命令会在 10 分钟被回收（旧版 4 分钟就会，严格更宽松）；`S` 状态无法区分「等一个会回来的响应」和「等一个不会回来的」，只能靠 CPU 增量旁证。

## ADR-14 多通道前端：Slack 与 Telegram 共用同一条 DO 流水线（2026-10-28）

**背景**：用户要求增加一个跟 cfworker 和 codespace 沟通的前端：Slack，且「所有更改均不需要更改 cfworker 和 codespace 的沟通，只需要建立 slack 和 cfworker 的沟通，保证和 telegram 线路的后端同质化」。即 Slack 是纯前端通道，agent/codespace 侧（/shell/*、HMAC 签名、SSE 反连、看门狗）零改动。

**结论**：
1. **同 Worker、同 DO、同流水线**：`/slack/events`（Events API）与 `/slack/commands`（Slash 指令）验签后进 `handleMessage`——去重、白名单、验证门（VERIFY_ANSWER 同词）、限流、额度、意图路由、指令派发、联机 shell 全部复用，一行不改 agent 协议。
2. **chatId 命名空间隔离**：Slack 消息的 chatId 带 `slack:<channel_id>` 前缀（Telegram 保持裸数字兼容历史 storage）。DO 内所有按 chatId 的状态（验证会话/历史/限流/暂存命令/看门狗推送目标）天然分通道；`reply()` / `sendShellChunk()` 按前缀选客户端（SlackClient vs TelegramClient）。
3. **回包通道同构**：Slack 侧 mrkdwn 渲染（`mdToSlack`，与 `mdToV2` 同策略）+ 发送失败降级纯文本 + 429 退避重试（Slack ~1msg/s；Telegram v4.21 的 retry_after 同问题）。
4. **白名单独立**：`SLACK_ALLOWED_USERS`（Slack user id 体系与 Telegram 数字 id 不同）；验证词共用（安全口令只有一个，换词两通道一起失效）。
5. **Slash 指令 = 指令注册表**：`/boot` 等去斜杠后与 text 拼接，走与 Telegram 完全相同的 `matchCommand`（commands.ts 仍是单一真相源）；另支持频道里直接发文本（message.im 私聊为主场景）。
6. **验签 fail-closed**：X-Slack-Signature（v0 HMAC）+ 5 分钟时间窗；secret 未配 = `/slack/*` 全拒 403。`url_verification` 握手回 challenge 完成配置。bot 自己的消息（bot_id）必须忽略——否则回包→自事件→再回包死循环。
7. **fail-open 边界**：`SLACK_BOT_TOKEN` 未配 = 通道整体关闭（404），Telegram 完全不受影响；两通道独立演进、互不拖累。

**理由**：DO 是单例状态机（会话/看门狗/shell 队列都在一个实例里），把通道判定收敛到「chatId 前缀 + reply 路由」两个点，是改动面最小、与既有架构最同质的接入方式；Slack 出站（chat.postMessage）与 Telegram 一样是纯 HTTPS REST，CF Workers 免费档零额外成本（Socket Mode 才需要常驻连接，已显式排除）。

**代价**：Slack 语音条（file share）v1 不转写（回提示让用户发文字；手表语音场景继续走 Telegram）；`url_verification` 只认配置那一刻的 secret（换 secret 后要到 App 页面重存一次 Request URL 触发重新握手）；Events API 免费版有少量投递延迟（秒级，无感知）。

**通道对比**：

| | Telegram（现役） | Slack（v4.22） |
|---|---|---|
| 事件入口 | /webhook（IP 网段 + secret_token） | /slack/events、/slack/commands（v0 HMAC 验签） |
| 后端流水线 | DO handleMessage | 同一个（chatId `slack:` 前缀隔离） |
| 渲染 | MarkdownV2 + 400 降级 | mrkdwn + 429 退避 |
| 语音 | OGG/Opus → STT | 不转写（提示发文字） |
| 指令 | 文本/slash 同注册表 | 同一张（slash + 私聊文本） |
| 白名单 | ALLOWED_USERS | SLACK_ALLOWED_USERS（独立） |
| agent/codespace | /shell/* HMAC+SSE | **零改动（共用）** |
