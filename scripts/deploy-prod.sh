#!/usr/bin/env bash
# linguacraft 一键部署脚本 (docker compose 版)
# 用法: sudo bash scripts/deploy-prod.sh [--skip-backfill] [--skip-smoke] [--recreate-frontend]
#
# 流程: pull → 前端 build → 同步前端 → docker compose build+up backend → 数据回填 → smoke test
# 前置: 服务器已装 docker + docker compose plugin; $REPO_DIR/.env 已配好
# 部署路径: $REPO_DIR (默认 /root/linguacraft)
#
# 注意:
# - mongo / redis 容器不会被 recreate (只 up -d --build backend, 其他 service 保留)
# - 数据卷 mongo_data / redis_data 不动, 数据保留
# - 前端 dist 通过 host nginx (80 → /var/www/linguacraft) 提供, 不通过 frontend 容器

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
RECREATE_FRONTEND=0
REPO_DIR="${REPO_DIR:-/root/linguacraft}"
FRONTEND_DIR="$REPO_DIR/frontend"
WEB_ROOT="${WEB_ROOT:-/var/www/linguacraft}"
BRANCH="${BRANCH:-main}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backfill)    SKIP_BACKFILL=1; shift ;;
    --skip-smoke)       SKIP_SMOKE=1;    shift ;;
    --recreate-frontend) RECREATE_FRONTEND=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) err "未知参数: $1 (--help 看用法)" ;;
  esac
done

# ---- 前置检查 ----
[[ -d "$REPO_DIR" ]]     || err "仓库目录不存在: $REPO_DIR (设 REPO_DIR 或先 git clone)"
[[ -d "$FRONTEND_DIR" ]] || err "frontend/ 不存在, 请确认仓库结构"
command -v docker >/dev/null 2>&1 || err "docker 没装"
docker compose version >/dev/null 2>&1 || err "docker compose plugin 没装 (apt install docker-compose-plugin)"

if [[ ! -f "$REPO_DIR/.env" ]]; then
  err "$REPO_DIR/.env 不存在, docker compose 拿不到环境变量. 从 .env.example 拷一份填好再重跑."
fi

# 拉代码前确认容器在跑 (出问题好回滚)
if ! docker ps --format '{{.Names}}' | grep -q '^linguacraft-backend$'; then
  warn "linguacraft-backend 容器当前不在跑, 启动后没有旧版本可回滚"
fi

# ---- 1. 拉代码 ----
info "1/7 git pull origin $BRANCH"
cd "$REPO_DIR"
git fetch origin "$BRANCH" --prune
git reset --hard "origin/$BRANCH"
success "代码已同步到 origin/$BRANCH ($(git rev-parse --short HEAD))"

# ---- 2. 构建前端 (host 上跑, dist 要 sync 到 host nginx) ----
info "2/7 cd frontend && npm ci + npm run build"
cd "$FRONTEND_DIR"
npm ci
npm run build
success "前端 build 完, 产物在 $FRONTEND_DIR/dist/"

# ---- 3. 同步前端到 nginx ----
info "3/7 同步前端 dist/ -> $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete "$FRONTEND_DIR/dist/" "$WEB_ROOT/"
success "前端静态已就位"

# ---- 4. 重建并启动 backend 容器 (mongo/redis 不动) ----
info "4/7 cd $REPO_DIR && docker compose up -d --build backend"
cd "$REPO_DIR"
docker compose up -d --build backend
sleep 2
BACKEND_STATE=$(docker compose ps --format json backend 2>/dev/null | grep -oE '"State":"[^"]+"' | head -1 | cut -d'"' -f4)
if [[ "$BACKEND_STATE" == "running" ]]; then
  success "backend 容器已 running"
else
  err "backend 启动失败 (state=$BACKEND_STATE), docker compose logs backend 看日志"
fi

# ---- 4.5 可选: 重建 frontend 容器 ----
if [[ $RECREATE_FRONTEND -eq 1 ]]; then
  info "4.5/7 docker compose up -d --build frontend (--recreate-frontend)"
  docker compose up -d --build frontend
  sleep 1
  success "frontend 容器已重建"
fi

# ---- 5. 数据回填 (在 backend 容器内执行, scripts/ 已在镜像里) ----
if [[ $SKIP_BACKFILL -eq 0 ]]; then
  info "5/7 backfill-schema-defaults dry-run"
  docker compose exec -T backend npx ts-node scripts/backfill-schema-defaults.ts || warn "dry-run 异常, 继续"

  info "5/7 backfill-schema-defaults --apply"
  docker compose exec -T backend npx ts-node scripts/backfill-schema-defaults.ts --apply
  success "数据回填完"
else
  warn "5/7 数据回填已跳过 (--skip-backfill)"
fi

# ---- 6. smoke test (inline, 不依赖 smoke-test-prod.sh) ----
if [[ $SKIP_SMOKE -eq 0 ]]; then
  info "6/7 smoke test (inline curl)"
  PASS=0; FAIL=0
  check() {
    local name="$1"; shift
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$@")
    if [[ "$code" =~ ^2 ]]; then
      echo "  ✅ $name → $code"; PASS=$((PASS+1))
    elif [[ "$code" == "401" || "$code" == "400" ]]; then
      echo "  ✅ $name → $code (预期, 业务正常响应)"; PASS=$((PASS+1))
    else
      echo "  ❌ $name → $code (期望 2xx/400/401)"; FAIL=$((FAIL+1))
    fi
  }
  check "API health"     http://127.0.0.1:5500/api/health
  check "Frontend /"     http://127.0.0.1/
  check "API auth/me"    http://127.0.0.1:5500/api/auth/me
  check "API learning"   http://127.0.0.1:5500/api/learning/mastery/count
  check "API stats/me"   http://127.0.0.1:5500/api/stats/me
  echo
  if [[ $FAIL -eq 0 ]]; then
    success "smoke PASS ($PASS/5), PROD READY"
  else
    err "smoke FAIL ($PASS pass, $FAIL fail), 先看上面输出 (不要 reload nginx)"
  fi
else
  warn "6/7 smoke test 已跳过 (--skip-smoke)"
fi

# ---- 7. 完成 ----
echo
success "✅ 部署完成"
echo "  - 容器状态:  cd $REPO_DIR && docker compose ps"
echo "  - 后端日志:  cd $REPO_DIR && docker compose logs -f backend"
echo "  - 前端日志:  cd $REPO_DIR && docker compose logs -f frontend"
echo "  - 前端静态:  $WEB_ROOT (nginx reload: sudo nginx -s reload)"
echo "  - 下次部署:  sudo bash $REPO_DIR/scripts/deploy-prod.sh"
echo "  - 重建 frontend 容器: 加 --recreate-frontend"