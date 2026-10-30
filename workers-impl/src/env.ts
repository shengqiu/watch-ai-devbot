/** 环境绑定类型：vars 走 wrangler.toml [vars]，密钥走 wrangler secret put。 */
export interface Env {
  // Durable Object 绑定
  BOT: DurableObjectNamespace<AssistantDO>;

  /**
   * 运行时长账本的持久层（KV，可选）。
   *
   * 为什么不用 DO storage：DO 的名字由 DO_KEY 决定，「换版」就是换个新实例，
   * 旧 storage（含本月用量）全部作废 —— 这正是 /usage 每次部署后归零的原因。
   * KV 是账户级、与 DO 实例无关，换多少个 DO 都还在。
   * 未绑定（本地 dev / 老部署）时自动退回只写 DO storage，功能仍可用。
   */
  USAGE_KV?: KVNamespace;

  // Telegram 机器人令牌（secret，@BotFather 处获取）
  TELEGRAM_BOT_TOKEN: string;
  // 可选：webhook 防伪密钥（setWebhook 的 secret_token，自定义一串随机串即可）
  TELEGRAM_WEBHOOK_SECRET?: string;
  /**
   * webhook 来源 IP 白名单开关（var）：on（默认）| warn（只记日志）| off。
   * 只有 Telegram 官宣的两个网段能进来，见 src/telegram-ip.ts。
   * 官方哪天改网段（文档明说可能变），表现是 bot 收不到消息 —— 先切 warn 观察。
   */
  TELEGRAM_IP_GUARD?: string;

  // 外部服务地址（可选；默认官方地址，集中解析见 src/config.ts。
  // 换代理 / 换区域端点 / 内网联调时覆盖，无需改代码）
  TELEGRAM_API_BASE?: string; // 默认 https://api.telegram.org
  SLACK_API_BASE?: string; // 默认 https://slack.com/api（Slack Web API 根）

  // ---- Slack 通道（v4.22；与 Telegram 同一条 DO 流水线，agent 侧零改动）----
  /**
   * Slack App 的 Bot User OAuth Token（secret，xoxb-...）。
   * 未配置 = Slack 通道整体关闭（/slack/* 一律 404 语义的提示），Telegram 不受影响。
   */
  SLACK_BOT_TOKEN?: string;
  /**
   * Slack App 的 Signing Secret（secret，App Credentials 页）。
   * 验签 fail-closed：未配置时 /slack/* 一律 403（与 TELEGRAM_WEBHOOK_SECRET 同策略）。
   */
  SLACK_SIGNING_SECRET?: string;
  /**
   * Slack 通道开关（var）："0" = 关闭（即使配了 token 也不收消息）；
   * 默认开（配齐 token + secret 才真正生效）。
   */
  SLACK_ENABLED?: string;
  /**
   * Slack 白名单（var/secret，逗号分隔 user id）。语义与 ALLOWED_USERS 一致，
   * 但独立配置——两个通道的账号体系不同（Telegram 数字 id vs Slack Uxxxx）。
   * 空 = 放开（仅建议开发期）。
   */
  SLACK_ALLOWED_USERS?: string;

  // 模型厂商密钥（secret，按需填；未填的厂商自动跳过）
  GEMINI_API_KEY?: string;
  /** Gemini CLI 默认模型（var；不配则用代码兜底 DEFAULT_GEMINI_MODEL）。 */
  GEMINI_MODEL?: string;
  /**
   * 免费模型链（var；逗号/空格分隔，按顺序尝试）。
   * 配额是按模型分桶的，所以填多个不同型号才能真正「用完一个换下一个」。
   * 不配则用代码里的 DEFAULT_MODEL_CHAIN。
   */
  GEMINI_MODELS?: string;
  /**
   * CodeBuddy **付费兜底**顺序（var；逗号/空格分隔）。
   *
   * 免费清单不在这里配：那是运行时从机器上的价格表（CLI 缓存的 /v3/config）
   * 现读的，只有 `credits` 倍率为 0 的才算免费（2026-10-29 全表 29 个模型里
   * 只有 hy3）。这里只决定「免费全挂之后按什么顺序试付费模型」。
   * 不配则用代码里的 DEFAULT_PAID_FALLBACK。
   */
  BUDDY_MODELS?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  ZHIPU_API_KEY?: string;
  MOONSHOT_API_KEY?: string;

  // 语音识别（secret，可选）：Telegram 语音需经此转写。免费推荐 Groq Whisper
  STT_BASE_URL?: string;
  STT_API_KEY?: string;
  STT_MODEL?: string;

  // 行为配置（vars）
  ALLOWED_USERS?: string; // 逗号分隔的 user_id 白名单（from.id）；空 = 放开
  DEFAULT_CODING_PROVIDER?: string;
  DEFAULT_CHAT_PROVIDER?: string;
  MAX_OUTPUT_TOKENS?: string;
  SESSION_MAX_TURNS?: string;
  RATE_LIMIT_PER_MIN?: string;
  DAILY_CALL_BUDGET?: string;
  REPLY_CHUNK_SIZE?: string;

  // Codespace 开发机远程开关（/boot、/halt 指令）
  GH_CODESPACE_PAT?: string; // secret：fine-grained PAT，仅需 Codespaces 用户权限
  GH_CODESPACE_NAME?: string; // var：codespace 名称，默认 24h-977gg5v9vcp5wq
  /**
   * var：GitHub 用户名（默认 shengqiu）。
   * 只有「查官方用量」用得到：GET /users/{login}/settings/billing/usage。
   */
  GH_LOGIN?: string;
  /**
   * secret（可选）：只用来读计费的 PAT。设了就优先用它，否则退回 GH_CODESPACE_PAT。
   *
   * 为什么要单独一张：跑 codespace 的可以是 fine-grained，而 GitHub 对计费接口
   * 卡得很死（fine-grained 要 Plan:read，classic 要 `user` scope —— 实测要的是
   * `user`，不是 manage_billing:codespaces），拆开就不用为看用量放大跑机器那张的权限。
   */
  GH_BILLING_PAT?: string;

  // 省额度看门狗（vars）
  CS_WATCH_REMIND_MIN?: string; // 空闲提醒阈值（分钟，默认 25）
  CS_WATCH_AUTOSTOP_MIN?: string; // 自动关机阈值（分钟，默认 55）
  CS_WATCH_AUTOSTOP?: string; // "0" = 只提醒不自动关（默认开）
  CS_MONTHLY_BUDGET_HOURS?: string; // 月免费额度小时数（默认 60；2 核 = 120 core-h ÷ 2）
  /** 覆盖免费计算额度（core-hours）：Free=120 / Pro=180，不设则按账号 plan 自动判断 */
  CS_INCLUDED_CORE_HOURS?: string;
  CS_GH_CAP_MIN?: string; // GH 连续活跃上限（分钟，默认 180）：防 dev server 刷日志无限续命
  CS_GH_CAP_ACTION?: string; // 触达上限后的动作：stop（默认，警告+宽限后关机）| notify（只提醒）
  CS_GH_CAP_GRACE_MIN?: string; // stop 模式下的宽限期（分钟，默认 15）

  // 部署身份标识（var）：主 bot 不设（显示 main）；devbot 部署设为 "devbot"
  BOT_IDENTITY?: string;

  // 身份验证会话：VERIFY_ANSWER 为 secret（必配，未配 = 服务锁定）；
  // 会话时长分钟，默认 10（滑动窗口：连续 10 分钟不交互即失效，须重新验证）
  VERIFY_ANSWER?: string;
  VERIFY_SESSION_MIN?: string;

  // 管理端点鉴权（/setup /send /csdebug）：secret；未配置 = 全部管理端点 403（默认安全）
  ADMIN_KEY?: string;

  /**
   * 部署后重载用的密钥（secret，只给 GitHub Actions）。
   * 部署完成后 CI 用 POST + Authorization: Bearer <DEPLOY_KEY> 头调一次
   * /admin/reload 让 DO 立刻换到新构建；密钥绝不进 URL 查询串（安全审查 #8）。
   * 不复用 ADMIN_KEY —— CI 不该拿到管理全站的那把钥匙。未配置 = 该端点 401。
   */
  DEPLOY_KEY?: string;

  // Shell 通道（Telegram ⇄ codespace 内持久 bash）
  /**
   * 每台机器独立密钥的静态注册表（secret，JSON 对象 `{"machine-id":"key", ...}`，
   * 也支持行式 `machine-id:key` 每行一条）。这是「区分 / 吊销单台机器」的核心：
   * Worker 按 X-Agent-Id 在这里查这台机器专用的密钥，未知 id 或已吊销 id 一律 401。
   * 它存于 Worker secret（不是 DO storage），所以扛得过 DO_KEY 换版带来的 storage 清空。
   * 未配时回退到旧的单共享 AGENT_KEY（过渡期，不推荐长期保留）。
   */
  AGENT_KEYS?: string;
  AGENT_KEY?: string; // secret：过渡期单共享密钥（AGENT_KEYS 未配时作回退；配了 AGENT_KEYS 后应停用）
  AGENT_LEGACY_KEY?: string; // var："1" = 仍接受明文 X-Agent-Key（仅 agent 未升级时的过渡，默认关）
  // AGENT_ID 已由 AGENT_KEYS 注册表的成员资格取代：未知 id 直接拒，无需再单独声明期望 id。
  AGENT_ID?: string; // var（已废弃）：旧的单期望身份；保留字段仅为兼容，不再强制校验
  SHELL_ENABLED?: string; // var："1"（默认）启用；"0" = 未识别文本不做 shell 转发
  SHELL_FLUSH_MS?: string; // var：增量输出静默刷写窗口（毫秒，默认 1200）
  SHELL_MAX_CHARS?: string; // var：单条命令输出上限（字符，默认 24000）
  CS_SHELL_ALERT?: string; // var："1"（默认）机器在跑但 shell 断线时主动告警；"0" = 关闭
  CS_SHELL_ALERT_GRACE_MIN?: string; // var：断线宽限（分钟，默认 5）：躲开 DO 重载/agent 重启的瞬断
  CS_SHELL_ALERT_REPEAT_MIN?: string; // var：持续断线时的重复告警间隔（分钟，默认 120；0 = 只告一次）

  /**
   * 单例 DO 的名字（var，默认 "singleton"）。**改这个值 = 立刻换一个全新实例**。
   *
   * 为什么需要它：DO 一旦被 SSE 长连接（或密集 alarm）钉住，deploy 之后线上仍是
   * 旧代码——用 /status（需 ADMIN_KEY）能看到 build 一直不翻。正常恢复要等连接断开 + 平台回收，
   * 实测可以拖到 5 分钟以上，改一行文案都要等这么久完全不可接受。
   * 这个值是 index.ts 拼 idFromName 用的，在 DO 之外读，所以改完立刻生效。
   *
   * 代价：新实例没有旧实例的 storage —— 验证会话要重打一次、/gemini 会话模式
   * 与暂存的提问、看门狗计时都会清零。只在需要强制换版时改，别当常规配置。
   */
  DO_KEY?: string;
}

// DurableObjectNamespace 是 workers-types 的全局类型（v5 无需 import）。
// AssistantDO 仅作类型引用，用 import type 避免运行时环。
import type { AssistantDO } from "./bot-do";
