/** 环境绑定类型：vars 走 wrangler.toml [vars]，密钥走 wrangler secret put。 */
export interface Env {
  // Durable Object 绑定
  BOT: DurableObjectNamespace<AssistantDO>;

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
  ALLOWED_USERS?: string; // 逗号分隔的 chat_id 白名单；空 = 放开
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

  // 省额度看门狗（vars）
  CS_WATCH_REMIND_MIN?: string; // 空闲提醒阈值（分钟，默认 25）
  CS_WATCH_AUTOSTOP_MIN?: string; // 自动关机阈值（分钟，默认 55）
  CS_WATCH_AUTOSTOP?: string; // "0" = 只提醒不自动关（默认开）
  CS_MONTHLY_BUDGET_HOURS?: string; // 月免费额度小时数（默认 60；2 核 = 120 core-h ÷ 2）
  CS_GH_CAP_MIN?: string; // GH 连续活跃上限（分钟，默认 180）：防 dev server 刷日志无限续命
  CS_GH_CAP_ACTION?: string; // 触达上限后的动作：stop（默认，警告+宽限后关机）| notify（只提醒）
  CS_GH_CAP_GRACE_MIN?: string; // stop 模式下的宽限期（分钟，默认 15）

  // 部署身份标识（var）：主 bot 不设（显示 main）；devbot 部署设为 "devbot"
  BOT_IDENTITY?: string;

  // 身份验证会话：VERIFY_ANSWER 为 secret（必配，未配 = 服务锁定）；会话时长分钟（默认 30）
  VERIFY_ANSWER?: string;
  VERIFY_SESSION_MIN?: string;

  // 管理端点鉴权（/setup /send /csdebug）：secret；未配置 = 全部管理端点 403（默认安全）
  ADMIN_KEY?: string;

  /**
   * 部署后重载用的密钥（secret，只给 GitHub Actions）。
   * 部署完成后 CI 调一次 /admin/reload?key=... 让 DO 立刻换到新构建；
   * 不复用 ADMIN_KEY —— CI 不该拿到管理全站的那把钥匙。未配置 = 该端点 401。
   */
  DEPLOY_KEY?: string;

  // Shell 通道（Telegram ⇄ codespace 内持久 bash）
  AGENT_KEY?: string; // secret：agent 与 Worker 的共享密钥（只用于算 HMAC，不再上行文）
  AGENT_LEGACY_KEY?: string; // var："1" = 仍接受明文 X-Agent-Key（仅 agent 未升级时的过渡，默认关）
  AGENT_ID?: string; // var：期望的 agent 身份（codespace 名）；空 = 只记录不强制
  SHELL_ENABLED?: string; // var："1"（默认）启用；"0" = 未识别文本不做 shell 转发
  SHELL_FLUSH_MS?: string; // var：增量输出静默刷写窗口（毫秒，默认 1200）
  SHELL_MAX_CHARS?: string; // var：单条命令输出上限（字符，默认 24000）

  /**
   * 单例 DO 的名字（var，默认 "singleton"）。**改这个值 = 立刻换一个全新实例**。
   *
   * 为什么需要它：DO 一旦被 SSE 长连接（或密集 alarm）钉住，deploy 之后线上仍是
   * 旧代码——healthz 里能看到 build 一直不翻。正常恢复要等连接断开 + 平台回收，
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
