# watch-ai-devbot

Telegram / Slack 开发指令 bot —— **手表/桌面语音文字 → 云端 AI 编程助手**的开发者控制面。

从 [watch-ai-assistant](https://github.com/shengqiu/watch-ai-assistant)（v16 聊天版）fork 而来，在此独立演进开发能力。

> **本目录只对应 `shengqiu/watch-ai-devbot`（Worker `watch-ai-devbot`）。**
> 同级 `../repo/` **不是本目录的镜像**：那是另一个仓库 `watch-ai-assistant`，仍在服务
> （chatbot 后端 worker `watch-ai-qqbot` + Codespace 宿主 `.devcontainer`/`shell-agent`）。
> 两边 `workers-impl` 已结构性分叉（v19 单文件版 vs 本目录 v4.x 模块化版），
> **不要互相复制文件**。分工与已知漂移见 `../README.md`。

## 核心能力

- **Codespace 远程开关**：对 bot 说「/boot」「/halt」「/cs」，远程控制 GitHub Codespaces 开发机（两次查询开机协议，DO alarm 30s 自动确认）
- **AI 编程助手**：语音/文字 → 转写 → 意图解析 → 多厂商 LLM 路由（Gemini 默认，fallback 链）→ 分段回包
- **联机 shell**：codespace 内 agent 反连（SSE），直接发文字 = 在开发机执行命令
- **双通道**（v4.22）：Telegram（手表主场景）与 Slack（桌面场景）**共用同一条 DO 流水线**，agent/codespace 通信零改动
- **CI/CD**：push → 测试（700 项）→ 自动部署 Cloudflare Workers

## 指令速查（两通道同名同义）

| 指令 | 别名 | 效果 |
|---|---|---|
| /boot | — | 唤醒 codespace（30s 后自动回报结果） |
| /halt | — | 停机 |
| /cs | 开发机状态 | 查询状态 |
| /gemini | /gem | Gemini 编程会话（自动开机/装 CLI/免费模型链） |
| /buddy | /cb | CodeBuddy 编程会话 |
| /ctrlc | 中断 | 中断当前命令 + 清队列 |
| /usage | 用量 | 本月运行时长 vs 免费额度 |
| /help | 帮助 | 全部指令 |

## 架构

```
Telegram Bot (webhook)  ─┐
                          ├→ Cloudflare Worker (watch-ai-devbot)
Slack App (Events API  ─┘      → 按通道验签 → 统一 Incoming
  + Slash Commands)            → DO handleMessage（同一流水线）
                                  → 意图路由（codespace 指令 / LLM 聊天 / shell）
                                  → GitHub Codespaces REST API（开机/停机/状态）
                                  → Durable Object alarm 30s 二次确认 → 回包
                                  → shell：codespace 内 agent 反连 SSE（HMAC 双向签名）
```

- **部署**：`workers-impl/`（wrangler.toml，worker 名 `watch-ai-devbot`）
- **Telegram 凭证**：`TELEGRAM_BOT_TOKEN`、`GH_CODESPACE_PAT`、`GEMINI_API_KEY`（secret）；`GH_CODESPACE_NAME`（var）
- **Slack 凭证**（v4.22，可选）：`SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`（secret）；`SLACK_ALLOWED_USERS`（白名单，独立于 Telegram）；配置清单 `workers-impl/slack-app-manifest.yml`，详见 `docs/DEPLOY.md`
- **CI**：`.github/workflows/deploy.yml`（push main → 测试 → 部署）；`e2e-telegram.yml`（手动触发，模拟 webhook 验证开关机链路）

## 本地开发

```bash
cd workers-impl && npm install
npm test          # 700 项逻辑测试（含 Slack 通道 37 项）
npx wrangler dev  # 本地联调
npx wrangler deploy
```

> fork 自 watch-ai-assistant v18（telegram-20261026-v18）；选型决策与从零部署手册见原仓库 docs/。
