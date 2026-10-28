# watch-ai-devbot

Telegram 开发指令 bot —— **Apple Watch 语音 → 云端 AI 编程助手**的开发者控制面。

从 [watch-ai-assistant](https://github.com/shengqiu/watch-ai-assistant)（v16 聊天版）fork 而来，在此独立演进开发能力。

> **本目录只对应 `shengqiu/watch-ai-devbot`（Worker `watch-ai-devbot`）。**
> 同级 `../repo/` **不是本目录的镜像**：那是另一个仓库 `watch-ai-assistant`，仍在服务
> （chatbot 后端 worker `watch-ai-qqbot` + Codespace 宿主 `.devcontainer`/`shell-agent`）。
> 两边 `workers-impl` 已结构性分叉（v19 单文件版 vs 本目录 v4.x 模块化版），
> **不要互相复制文件**。分工与已知漂移见 `../README.md`。

## 核心能力

- **Codespace 远程开关**：手表/手机上对 bot 说「开始开发」「停止开发」「开发机状态」，远程控制 GitHub Codespaces 开发机（两次查询开机协议，DO alarm 30s 自动确认）
- **AI 编程助手**：语音 → 转写 → 意图解析 → 多厂商 LLM 路由（Gemini 默认，fallback 链）→ 分段回包
- **CI/CD**：push → 测试（99 项）→ 自动部署 Cloudflare Workers

## 指令速查

| 指令 | 别名 | 效果 |
|---|---|---|
| 开始开发 | `/boot` | 唤醒 codespace（30s 后自动回报结果） |
| 停止开发 | `/halt`、关掉开发机 | 停机 |
| 开发机状态 | `/cs` | 查询状态 |

## 架构

```
Telegram Bot (webhook)
  → Cloudflare Worker (watch-ai-devbot)
      → 意图路由（codespace 指令 / LLM 聊天）
      → GitHub Codespaces REST API（开机/停机/状态）
      → Durable Object alarm 30s 二次确认 → 回包
```

- **部署**：`workers-impl/`（wrangler.toml，worker 名 `watch-ai-devbot`）
- **凭证**：`TELEGRAM_BOT_TOKEN`、`GH_CODESPACE_PAT`、`GEMINI_API_KEY`（secret）；`GH_CODESPACE_NAME`（var）
- **CI**：`.github/workflows/deploy.yml`（push main → 测试 → 部署）；`e2e-telegram.yml`（手动触发，模拟 webhook 验证开关机链路）

## 本地开发

```bash
cd workers-impl && npm install
npm test          # 99 项逻辑测试
npx wrangler dev  # 本地联调
npx wrangler deploy
```

> fork 自 watch-ai-assistant v18（telegram-20261026-v18）；选型决策与从零部署手册见原仓库 docs/。
