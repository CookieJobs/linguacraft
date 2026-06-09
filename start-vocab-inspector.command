#!/bin/bash
# ============================================================================
#  词库体检 · 一键启动
#  linguacraft vocab inspector
#
#  用法: 双击本文件,或在 Terminal 跑 ./start-vocab-inspector.command
#  行为:
#    1. 检查后端 5500 / 前端 3000 是否在跑,没跑就启(后台)
#    2. 等就绪后,自动打开浏览器
#    3. 显示状态 + URL
#
#  停止: 关闭两个后台进程 (lsof -ti:5500,3000 | xargs kill)
# ============================================================================

set -e
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
URL="http://localhost:3000/vocab-inspector.html"

# 颜色 (只在 Terminal 跑时生效)
if [ -t 1 ]; then
  G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'; N='\033[0m'
else
  G=''; Y=''; R=''; B=''; N=''
fi

ok()   { echo -e "${G}✓${N} $1"; }
warn() { echo -e "${Y}⚠${N}  $1"; }
err()  { echo -e "${R}✗${N} $1"; }
info() { echo -e "${B}→${N} $1"; }

echo ""
echo "  📚 词库体检 · 启动器"
echo "  ─────────────────────────────────────────"

# 1. 检查后端 5500
if lsof -nP -iTCP:5500 -sTCP:LISTEN >/dev/null 2>&1; then
  ok "后端 5500 已在跑 (跳过)"
else
  info "启动后端 (cd $BACKEND_DIR && npm run dev)..."
  cd "$BACKEND_DIR"
  nohup npm run dev > /tmp/linguacraft-backend.log 2>&1 &
  # 等就绪
  for i in {1..30}; do
    if curl -s -o /dev/null http://localhost:5500/api/health 2>/dev/null; then break; fi
    sleep 0.5
  done
  if lsof -nP -iTCP:5500 -sTCP:LISTEN >/dev/null 2>&1; then
    ok "后端 5500 已启动"
  else
    err "后端启动失败,看 /tmp/linguacraft-backend.log"
    tail -20 /tmp/linguacraft-backend.log
    exit 1
  fi
fi

# 2. 检查前端 3000
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  ok "前端 3000 已在跑 (跳过)"
else
  info "启动前端 (cd $FRONTEND_DIR && npm run dev)..."
  cd "$FRONTEND_DIR"
  nohup npm run dev > /tmp/linguacraft-frontend.log 2>&1 &
  for i in {1..30}; do
    if curl -s -o /dev/null http://localhost:3000/ 2>/dev/null; then break; fi
    sleep 0.5
  done
  if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    ok "前端 3000 已启动"
  else
    err "前端启动失败,看 /tmp/linguacraft-frontend.log"
    tail -20 /tmp/linguacraft-frontend.log
    exit 1
  fi
fi

# 3. 打开浏览器
info "打开浏览器 → $URL"
sleep 1
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "请手动打开: $URL"

echo ""
echo "  ─────────────────────────────────────────"
ok "完成 · 词库体检已就绪"
echo "  ${B}URL:${N}  $URL"
echo "  ${B}日志:${N}  /tmp/linguacraft-backend.log"
echo "         /tmp/linguacraft-frontend.log"
echo "  ${B}停止:${N}  lsof -ti:5500,3000 | xargs kill"
echo ""
