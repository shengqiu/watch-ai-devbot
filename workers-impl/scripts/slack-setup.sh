#!/usr/bin/env bash
# Slack 通道一键配置（本地运行；token 不经过任何聊天/仓库）
#
# 用法：
#   1) Slack 后台 OAuth & Permissions → 点「Install to Workspace」→ 允许
#   2) 回到同一页 → Bot User OAuth Token 旁边点复制（xoxb-...）
#   3) 本地跑：./scripts/slack-setup.sh   （粘贴 token，粘贴时终端不回显）
#
# 做三件事：注入 bot token → 重新部署（secret 变更需部署才生效）→ 探测通道状态
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${WORKER_BASE_URL:-https://watch-ai-devbot.shengqiu-purdue.workers.dev}"

echo "==> 1/3 注入 SLACK_BOT_TOKEN（粘贴 xoxb-... 后回车；输入不回显）"
npx wrangler secret put SLACK_BOT_TOKEN

echo
echo "==> 2/3 重新部署（secret 改动必须部署才生效）"
npx wrangler deploy

echo
echo "==> 3/3 探测通道状态：$BASE/slack/events"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/slack/events" -d '{}' || echo 000)
case "$code" in
  403)
    echo "✅ 通道已就绪（403 = 签名缺失/不匹配，说明 token + secret 都已就位）"
    echo
    echo "剩下一步（只能在 Slack 后台做）："
    echo "  Event Subscriptions → 开启 → Request URL 填："
    echo "  $BASE/slack/events"
    echo "  → Subscribe to bot events 里勾 message.im → Save（显示 Verified 即通）"
    ;;
  404)
    echo "❌ 通道未配置：SLACK_BOT_TOKEN 或 SLACK_SIGNING_SECRET 缺失"
    echo "   （Signing Secret 若没配：npx wrangler secret put SLACK_SIGNING_SECRET）"
    ;;
  000)
    echo "⚠️  连不上 Worker（网络/代理问题？）—— 换个网络再试；"
    echo "   其它状态可用 curl -H \"X-Admin-Key: \$ADMIN_KEY\" $BASE/slackstatus 自检"
    ;;
  *)
    echo "⚠️  意外状态码 $code"
    ;;
esac
