#!/usr/bin/env bash
# OPCHOT 本地看门狗：巡检健康/采集新鲜度/容器状态/近期错误，写状态文件与日志。
# 外部告警目的地（飞书 webhook）按用户决定延后；设置 OPCHOT_ALERT_WEBHOOK 后，
# 异常时会 POST 一条 JSON 到该地址（预留接口，默认禁用）。
# 由 systemd opchot-watchdog.timer 每 30 分钟触发（root 运行）。
set -uo pipefail

STATUS_DIR="${OPCHOT_STATUS_DIR:-/opt/1panel/backup/opchot/status}"
QUIET_MIN="${ALERT_QUIET_MINUTES:-360}"
API="http://127.0.0.1:3000"
mkdir -p "$STATUS_DIR"
chmod 700 "$STATUS_DIR" 2>/dev/null || true

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HEALTH="$(curl -s -m 10 "$API/api/health" 2>/dev/null || echo '{}')"
case "$HEALTH" in *'"ok":true'*) HEALTH_OK=true ;; *) HEALTH_OK=false ;; esac

# 采集新鲜度：最近一条内容的时间
LATEST="$(curl -s -m 10 "$API/api/v1/items?mode=all&window=30d&limit=1" 2>/dev/null || echo '{}')"
LATEST_AT="$(printf '%s' "$LATEST" | grep -o '"publishedAt":"[^"]*"' | head -1 | cut -d'"' -f4)"
FRESH_OK=true
AGE_MIN=""
if [ -n "$LATEST_AT" ]; then
  LATEST_TS="$(date -d "$LATEST_AT" +%s 2>/dev/null || echo 0)"
  NOW_TS="$(date +%s)"
  if [ "$LATEST_TS" -gt 0 ]; then
    AGE_MIN=$(( (NOW_TS - LATEST_TS) / 60 ))
    [ "$AGE_MIN" -gt "$QUIET_MIN" ] && FRESH_OK=false
  fi
else
  FRESH_OK=false
fi

CONTAINERS="$(docker ps --filter name=opchot --format '{{.Names}}={{.Status}}' 2>/dev/null | tr '\n' ';')"
ERR_COUNT="$(docker logs --since 24h opchot-worker-1 2>&1 | grep -ciE 'error|failed|429|rate.?limit' || true)"

STATUS="ok"
if [ "$HEALTH_OK" != "true" ] || [ "$FRESH_OK" != "true" ]; then STATUS="degraded"; fi

STATUS_FILE="$STATUS_DIR/watchdog.json"
cat > "$STATUS_FILE" <<JSON
{
  "checkedAt": "$NOW",
  "status": "$STATUS",
  "healthOk": $HEALTH_OK,
  "freshOk": $FRESH_OK,
  "latestPublishedAt": "${LATEST_AT:-}",
  "ageMinutes": ${AGE_MIN:-null},
  "quietThresholdMinutes": $QUIET_MIN,
  "containers": "$CONTAINERS",
  "workerErrors24h": ${ERR_COUNT:-0}
}
JSON
chmod 600 "$STATUS_FILE" 2>/dev/null || true
echo "[$NOW] watchdog status=$STATUS health=$HEALTH_OK fresh=$FRESH_OK age=${AGE_MIN:-?}m errors24h=${ERR_COUNT:-0}" >> "$STATUS_DIR/watchdog.log"

# 预留外部告警接口（默认禁用）。配置 OPCHOT_ALERT_WEBHOOK 后异常时推送。
if [ -n "${OPCHOT_ALERT_WEBHOOK:-}" ] && [ "$STATUS" != "ok" ]; then
  curl -s -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"OPCHOT 告警: $STATUS health=$HEALTH_OK fresh=$FRESH_OK age=${AGE_MIN:-?}m errors=${ERR_COUNT:-0}\"}}" \
    "$OPCHOT_ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi

# 日志轮转：保留最近 2000 行
tail -n 2000 "$STATUS_DIR/watchdog.log" > "$STATUS_DIR/watchdog.log.tmp" 2>/dev/null && mv "$STATUS_DIR/watchdog.log.tmp" "$STATUS_DIR/watchdog.log" || true