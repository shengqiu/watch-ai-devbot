#!/usr/bin/env bash
# Slack 通道一键配置（本地运行；两个密钥都不经过任何聊天/仓库）
#
# 用法：
#   1) Slack 后台 Create New App → From an app manifest → 粘贴 slack-app-manifest.yml
#   2) OAuth & Permissions → Install to Workspace → Allow
#   3) Basic Information → App Credentials → 复制 Signing Secret
#      OAuth & Permissions → 复制 Bot User OAuth Token（xoxb-...）
#   4) 本地跑：./scripts/slack-setup.sh
#      （依次粘贴 Signing Secret 和 Bot Token，终端不回显）
#
# 做四件事：注入两个 secret → 重新部署（secret 变更需部署才生效）→ 探测通道状态
#          → 打印剩下只能在 Slack 后台做的两步（Event URL + App Home 消息权限）
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${WORKER_BASE_URL:-https://watch-ai-devbot.shengqiu-purdue.workers.dev}"

echo "==> 1/4 注入 SLACK_SIGNING_SECRET（Basic Information → App Credentials → Signing Secret）"
npx wrangler secret put SLACK_SIGNING_SECRET

echo
echo "==> 2/4 注入 SLACK_BOT_TOKEN（OAuth & Permissions → Bot User OAuth Token，xoxb-...）"
npx wrangler secret put SLACK_BOT_TOKEN

echo
echo "==> 3/4 重新部署（secret 改动必须部署才生效）"
npx wrangler deploy

echo
echo "==> 4/4 探测通道状态：$BASE/slack/events"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/slack/events" -d '{}' || echo 000)
case "$code" in
  403)
    echo "✅ 通道已就绪（403 = 签名缺失/不匹配，说明 token + secret 都已就位）"
    echo
    echo "剩下两步（只能在 Slack 后台做）："
    echo "  ① Event Subscriptions → 开启 → Request URL 填："
    echo "     $BASE/slack/events"
    echo "     → Subscribe to bot events 里勾 message.im → Save（显示 Verified 即通）"
    echo "  ② App Home → Messages Tab → 确认「Allow users to send messages」已勾"
    echo "     （不勾的话私聊发不出消息——最常见的「装好了却没反应」原因）"
    ;;
  404)
    echo "❌ 通道未配置：SLACK_BOT_TOKEN 或 SLACK_SIGNING_SECRET 缺失"
    ;;
  000)
    echo "⚠️  连不上 Worker（网络/代理问题？）—— 换个网络再试；"
    echo "   也可 curl -H \"X-Admin-Key: \$ADMIN_KEY\" $BASE/slackstatus 自检"
    ;;
  *)
    echo "⚠️  意外状态码 $code"
    ;;
esac
