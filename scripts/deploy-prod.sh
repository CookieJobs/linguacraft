#!/usr/bin/env bash
# linguacraft 一键部署脚本 — 服务器上跑
# 用法: sudo bash scripts/deploy-prod.sh [--skip-backfill] [--skip-smoke]
#
# 流程: pull -> 装依赖 -> 构建前端 -> 数据回填(可跳) -> 启服务 -> smoke test(可跳)
# 前置: 服务器已装 mongodb / redis / node 20+ / nginx; backend/.env 已配好且 chmod 600
# 可选: systemd 服务名 linguacraft-backend, 前端放 /var/www/linguacraft (nginx root)

set -euo pipefail

# ---- 颜色 / 输出 ----
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()     { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ---- 参数 ----
SKIP_BACKFILL=0
SKIP_SMOKE=0
REPO_DIR="${REPO_DIR:-/opt/linguacraft}"
BACKEND_DIR="$REPO_DIR/backend"
FRONTEND_DIR="$REPO_DIR/frontend"
WEB_ROOT="${WEB_ROOT:-/var/www/linguacraft}"
SERVICE_NAME="${SERVICE_NAME:-linguacraft-backend}"
BRANCH="${BRANCH:-main}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backfill) SKIP_BACKFILL=1; shift ;;
    --skip-smoke)    SKIP_SMOKE=1;    shift ;;
    -h|--help)
      sed -n '2,7p' "$0"; exit 0 ;;
    *) err "未知参数: $1 (--help 看用法)" ;;
  esac
done

# ---- 前置检查 ----
[[ -d "$REPO_DIR" ]]   || err "仓库目录不存在: $REPO_DIR (设 REPO_DIR 或先 git clone)"
[[ -d "$BACKEND_DIR" ]] || err "backend/ 不存在, 请确认仓库结构"
[[ -f "$BACKEND_DIR/.env" ]] || err "backend/.env 不存在, 先 cp .env.production.example .env 并填好 4 个必填 (JWT_SECRET/ALLOWED_ORIGINS/MONGO_URL/DEEPSEEK_API_KEY)"
command -v node  >/dev/null 2>&1 || err "node 没装"
command -v npm   >/dev/null 2>&1 || err "npm 没装"
command -v git   >/dev/null 2>&1 || err "git 没装"
NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+).*/\1/')
[[ "$NODE_MAJOR" -ge 20 ]] || warn "node 版本 $(node -v) 低于 20, 部分依赖可能装不上"
[[ -r "$BACKEND_DIR/.env" ]] || err "backend/.env 不可读 (chmod 600 + 当前用户有读权限)"

# 拉代码前确认环境健康
pgrep -f "mongod" >/dev/null 2>&1 || warn "mongod 没在跑, 启动前确认 mongodb 已起"
pgrep -f "redis-server" >/dev/null 2>&1 || warn "redis-server 没在跑, 启动前确认 redis 已起"

# ---- 1. 拉代码 ----
info "1/6 git pull origin $BRANCH"
cd "$REPO_DIR"
git fetch origin "$BRANCH" --prune
git reset --hard "origin/$BRANCH"
success "代码已同步到 origin/$BRANCH ($(git rev-parse --short HEAD))"

# ---- 2. 装后端依赖 ----
info "2/6 cd backend && npm ci --omit=dev"
cd "$BACKEND_DIR"
npm ci --omit=dev
success "后端依赖装完"

# ---- 3. 编译后端 + 装前端依赖 + 构建前端 ----
info "3/6 npm run build (后端) + 前端 build"
npm run build
success "后端编译完"

cd "$FRONTEND_DIR"
npm ci
npm run build
success "前端 build 完, 产物在 $FRONTEND_DIR/dist/"

# ---- 3.5 部署前端静态到 nginx 目录 ----
info "3.5 同步前端 dist/ -> $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete "$FRONTEND_DIR/dist/" "$WEB_ROOT/"
success "前端静态已就位"

# ---- 4. 数据回填 (可跳) ----
if [[ $SKIP_BACKFILL -eq 0 ]]; then
  info "4/6 backfill-schema-defaults dry-run"
  cd "$BACKEND_DIR"
  npx ts-node scripts/backfill-schema-defaults.ts || warn "dry-run 异常, 继续"

  info "4/6 backfill-schema-defaults --apply"
  npx ts-node scripts/backfill-schema-defaults.ts --apply
  success "数据回填完"
else
  warn "4/6 数据回填已跳过 (--skip-backfill)"
fi

# ---- 5. 重启后端 ----
info "5/6 重启后端 (systemd: $SERVICE_NAME)"
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    success "$SERVICE_NAME 已 active"
  else
    err "$SERVICE_NAME 启动失败, journalctl -u $SERVICE_NAME -n 50 看日志"
  fi
else
  warn "systemctl 不可用, 假设你用 pm2 / docker 自己起; 后端需要监听 $REPO_DIR/backend/dist/main.js"
fi

# ---- 6. smoke test (可跳) ----
if [[ $SKIP_SMOKE -eq 0 ]]; then
  info "6/6 bash scripts/smoke-test-prod.sh"
  cd "$BACKEND_DIR"
  if bash scripts/smoke-test-prod.sh; then
    success "smoke 8/8 PASS, PROD READY"
  else
    err "smoke 有失败, 先看上面输出 (不要 reload nginx / 切流量)"
  fi
else
  warn "6/6 smoke test 已跳过 (--skip-smoke)"
fi

echo
success "✅ 部署完成"
echo "  - 后端:  systemctl status $SERVICE_NAME"
echo "  - 日志:  journalctl -u $SERVICE_NAME -f"
echo "  - 前端:  $WEB_ROOT (nginx reload: sudo nginx -s reload)"
echo "  - 下次部署: sudo bash $REPO_DIR/scripts/deploy-prod.sh"
