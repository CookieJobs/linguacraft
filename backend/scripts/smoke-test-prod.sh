#!/usr/bin/env bash
# 2026-06-12: linguacraft 上线前 smoke test (prod-hardened)
# 目的: 验证 prod 模式下
#   1) dev-only admin 端点 (vocab-dev / audit-snapshot) 都被 403 拒掉
#   2) /api/health 仍 200, 普通功能未坏
#   3) 启动时硬校验 (JWT_SECRET, ALLOWED_ORIGINS) 真的会失败
#
# 用法:
#   1) 先 mongod + redis 起来
#   2) bash backend/scripts/smoke-test-prod.sh
#   3) 退出码: 0 = 全过, 1 = 有 fail
#
# 副作用: 临时启一个后端进程绑 5500, 跑完会 kill, 不污染

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- 配色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
declare -a FAILS

# 强 secret (>= 32 字符, 不在 placeholder 列表)
export SECURE_JWT="prod-smoke-test-secret-$(openssl rand -base64 32 | tr -d '=+/' | head -c 48)"
export ALLOWED_ORIGINS_VALUE="https://app.linguacraft.com"
export MONGO_URL_VALUE="${MONGO_URL:-mongodb://localhost:27017/linguacraft_smoke}"
export REDIS_URL_VALUE="${REDIS_URL:-redis://localhost:6379}"
export API_PORT_VALUE="${API_PORT:-5501}"
export SMTP_HOST_VALUE="smtp.qq.com"
export SMTP_PORT_VALUE="587"
export SMTP_USER_VALUE="smoke@test.com"
export SMTP_PASS_VALUE="smoke"
export SMTP_FROM_VALUE="smoke@test.com"
export DEEPSEEK_API_KEY_VALUE="sk-smoke"
export DEEPSEEK_MODEL_VALUE="deepseek-chat"

mkdir -p /tmp/linguacraft-smoke
LOGFILE="/tmp/linguacraft-smoke/server.log"
PIDFILE="/tmp/linguacraft-smoke/server.pid"
> "$LOGFILE"

cleanup() {
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}
trap cleanup EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo -e "${GREEN}PASS${NC} $label  (expected=$expected, got=$actual)"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC} $label  (expected=$expected, got=$actual)"
    FAIL=$((FAIL+1))
    FAILS+=("$label")
  fi
}

extract_status() {
  # 从 "HTTP/1.1 403 Forbidden" 拿 403
  head -1 <<< "$1" | awk '{print $2}'
}

echo -e "${YELLOW}=== smoke-test-prod: 阶段 1/3 启动 prod 后端 ===${NC}"
NODE_ENV=production \
  JWT_SECRET="$SECURE_JWT" \
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS_VALUE" \
  MONGO_URL="$MONGO_URL_VALUE" \
  REDIS_URL="$REDIS_URL_VALUE" \
  API_PORT="$API_PORT_VALUE" \
  SMTP_HOST="$SMTP_HOST_VALUE" \
  SMTP_PORT="$SMTP_PORT_VALUE" \
  SMTP_USER="$SMTP_USER_VALUE" \
  SMTP_PASS="$SMTP_PASS_VALUE" \
  SMTP_FROM="$SMTP_FROM_VALUE" \
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY_VALUE" \
  DEEPSEEK_MODEL="$DEEPSEEK_MODEL_VALUE" \
  node -r ts-node/register src/main.ts > "$LOGFILE" 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$PIDFILE"

# 等启动 (mongoose + redis 握手 + 端口监听)
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 1
  if grep -q "^api:" "$LOGFILE" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${RED}FAIL${NC} 后端进程已退出, 日志:"
    cat "$LOGFILE"
    FAIL=$((FAIL+1))
    FAILS+=("server-startup")
    echo
    echo -e "${YELLOW}=== SUMMARY ===${NC}"
    echo "PASS=$PASS  FAIL=$FAIL"
    exit 1
  fi
done

if ! grep -q "^api:" "$LOGFILE"; then
  echo -e "${RED}FAIL${NC} 启动 15s 还没起来, 日志:"
  cat "$LOGFILE"
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi
echo -e "${GREEN}后端起来了:${NC}"
grep "^api:" "$LOGFILE" | head -1

# 等端口真的能 curl (再补 1s 防 race)
sleep 1

echo
echo -e "${YELLOW}=== smoke-test-prod: 阶段 2/3 端点黑/白名单 ===${NC}"

# --- 1) vocab-dev 期望 403 ---
RESP=$(curl -s -i "http://localhost:$API_PORT_VALUE/api/admin/vocab-dev" 2>&1)
STATUS=$(extract_status "$RESP")
assert_eq "/api/admin/vocab-dev returns 403" "403" "$STATUS"

# --- 2) audit-snapshot 期望 403 ---
RESP=$(curl -s -i "http://localhost:$API_PORT_VALUE/api/admin/audit-snapshot" 2>&1)
STATUS=$(extract_status "$RESP")
assert_eq "/api/admin/audit-snapshot returns 403" "403" "$STATUS"

# --- 3) /api/health 期望 200 ---
RESP=$(curl -s -i "http://localhost:$API_PORT_VALUE/api/health" 2>&1)
STATUS=$(extract_status "$RESP")
assert_eq "/api/health returns 200" "200" "$STATUS"

# --- 4) 关键日志: 不能出现 dev-warn ---
if grep -q "AdminDev.*ENABLED" "$LOGFILE"; then
  echo -e "${RED}FAIL${NC} prod 模式出现 dev-warn (说明 NODE_ENV 没传对)"
  FAIL=$((FAIL+1))
  FAILS+=("dev-warn-leaked")
else
  echo -e "${GREEN}PASS${NC} prod 日志无 dev-warn"
  PASS=$((PASS+1))
fi

# --- 5) CORS preflight: 允许 origin ---
RESP=$(curl -s -i -X OPTIONS \
  -H "Origin: https://app.linguacraft.com" \
  -H "Access-Control-Request-Method: GET" \
  "http://localhost:$API_PORT_VALUE/api/health" 2>&1)
if grep -qi "access-control-allow-origin: https://app.linguacraft.com" <<< "$RESP"; then
  echo -e "${GREEN}PASS${NC} CORS 允许白名单 origin"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC} CORS 未允许白名单 origin"
  echo "  preflight response:"
  head -20 <<< "$RESP" | sed 's/^/    /'
  FAIL=$((FAIL+1))
  FAILS+=("cors-allowlist")
fi

# --- 6) CORS preflight: 拒绝非白名单 origin ---
RESP=$(curl -s -i -X OPTIONS \
  -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: GET" \
  "http://localhost:$API_PORT_VALUE/api/health" 2>&1)
if grep -qi "access-control-allow-origin: https://evil.example.com" <<< "$RESP"; then
  echo -e "${RED}FAIL${NC} CORS 错误放行了 evil origin"
  FAIL=$((FAIL+1))
  FAILS+=("cors-rejected-origin")
else
  echo -e "${GREEN}PASS${NC} CORS 拒绝非白名单 origin"
  PASS=$((PASS+1))
fi

echo
echo -e "${YELLOW}=== smoke-test-prod: 阶段 3/3 fail-fast 反向验证 ===${NC}"
# 反向: 用 dev JWT_SECRET 重启, 期望进程 throw 退出
# (不杀原 server, 用 sub-shell 单独跑, 拿退出码)

(NODE_ENV=production \
  JWT_SECRET="dev_secret_change_me" \
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS_VALUE" \
  MONGO_URL="$MONGO_URL_VALUE" \
  REDIS_URL="$REDIS_URL_VALUE" \
  API_PORT=5511 \
  SMTP_HOST="$SMTP_HOST_VALUE" \
  SMTP_PORT="$SMTP_PORT_VALUE" \
  SMTP_USER="$SMTP_USER_VALUE" \
  SMTP_PASS="$SMTP_PASS_VALUE" \
  SMTP_FROM="$SMTP_FROM_VALUE" \
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY_VALUE" \
  DEEPSEEK_MODEL="$DEEPSEEK_MODEL_VALUE" \
  node -r ts-node/register src/main.ts 2>&1; echo "EXIT=$?") \
  > /tmp/linguacraft-smoke/insecure.log

if grep -q "JWT_SECRET insecure" /tmp/linguacraft-smoke/insecure.log \
  && tail -1 /tmp/linguacraft-smoke/insecure.log | grep -q "EXIT=1"; then
  echo -e "${GREEN}PASS${NC} dev-secret 启动被拒 (JWT_SECRET insecure)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC} dev-secret 启动没被拒"
  cat /tmp/linguacraft-smoke/insecure.log
  FAIL=$((FAIL+1))
  FAILS+=("fail-fast-jwt")
fi

# 反向: ALLOWED_ORIGINS=* 在 prod 应该被拒
(NODE_ENV=production \
  JWT_SECRET="$SECURE_JWT" \
  ALLOWED_ORIGINS="*" \
  MONGO_URL="$MONGO_URL_VALUE" \
  REDIS_URL="$REDIS_URL_VALUE" \
  API_PORT=5512 \
  SMTP_HOST="$SMTP_HOST_VALUE" \
  SMTP_PORT="$SMTP_PORT_VALUE" \
  SMTP_USER="$SMTP_USER_VALUE" \
  SMTP_PASS="$SMTP_PASS_VALUE" \
  SMTP_FROM="$SMTP_FROM_VALUE" \
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY_VALUE" \
  DEEPSEEK_MODEL="$DEEPSEEK_MODEL_VALUE" \
  node -r ts-node/register src/main.ts 2>&1; echo "EXIT=$?") \
  > /tmp/linguacraft-smoke/wildcard-cors.log

if grep -q "ALLOWED_ORIGINS must be set" /tmp/linguacraft-smoke/wildcard-cors.log \
  && tail -1 /tmp/linguacraft-smoke/wildcard-cors.log | grep -q "EXIT=1"; then
  echo -e "${GREEN}PASS${NC} ALLOWED_ORIGINS=* 启动被拒"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC} ALLOWED_ORIGINS=* 启动没被拒"
  cat /tmp/linguacraft-smoke/wildcard-cors.log
  FAIL=$((FAIL+1))
  FAILS+=("fail-fast-cors")
fi

echo
echo -e "${YELLOW}=== SUMMARY ===${NC}"
echo -e "PASS=${GREEN}$PASS${NC}  FAIL=${RED}$FAIL${NC}"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed checks:"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
  exit 1
fi
echo -e "${GREEN}ALL PASS${NC}"
exit 0
