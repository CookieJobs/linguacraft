#!/usr/bin/env bash
#
# linguacraft 旧 backup 清理脚本
#
# 目的: /tmp/linguacraft-backups/ 持续累积 dry-run 报告 (8.9MB / 数月), 30 天前的清理掉.
#
# 规则:
#   - 删除 /tmp/linguacraft-backups/ 下 30 天前的 *.json (dry-run 报告是 vocabwords-pre-XXX-DATE.json 格式)
#   - 保留 README.md, *.md, *.sh, *.log, .gitkeep (marker 文件)
#   - 目录不存在: 不报错, 静默退出 0 (cron 友好)
#
# 部署 (cron 选其一):
#
#   # macOS launchd (推荐 macOS 14+):
#   # ~/Library/LaunchAgents/com.linguacraft.backup-cleanup.plist
#   #   <StartCalendarInterval>
#   #     <Weekday>0</Weekday>      # 周日
#   #     <Hour>4</Hour>
#   #     <Minute>0</Minute>
#   #   </StartCalendarInterval>
#   #   <ProgramArguments>
#   #     <Program>/bin/bash</Program>
#   #     <Argument>/Users/liujin/Documents/myCraft/linguacraft/backend/scripts/cleanup-old-backups.sh</Argument>
#   #   </ProgramArguments>
#
#   # 经典 cron (Linux / 老 macOS):
#   # 0 4 * * 0 /Users/liujin/Documents/myCraft/linguacraft/backend/scripts/cleanup-old-backups.sh >> /tmp/linguacraft-backups/.cleanup.log 2>&1
#
#   # systemd timer (Linux 现代):
#   # /etc/systemd/system/linguacraft-backup-cleanup.timer
#   #   [Timer]
#   #   OnCalendar=Sun *-*-* 04:00:00
#   #   Persistent=true
#   #   Unit=linguacraft-backup-cleanup.service
#   # /etc/systemd/system/linguacraft-backup-cleanup.service
#   #   [Service]
#   #   Type=oneshot
#   #   ExecStart=/Users/liujin/Documents/myCraft/linguacraft/backend/scripts/cleanup-old-backups.sh
#
# 测试 (本地立刻试):
#   bash scripts/cleanup-old-backups.sh --dry-run           # 只看会删什么
#   bash scripts/cleanup-old-backups.sh --retention-days=7  # 7 天前的全删 (调试)
#
# 2026-06-12: 首次上线, 30 天阈值

set -euo pipefail

BACKUP_DIR="${LINGUACRAFT_BACKUP_DIR:-/tmp/linguacraft-backups}"
RETENTION_DAYS=30
DRY_RUN=false

# ---------- arg 解析 ----------
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --retention-days=*)
      RETENTION_DAYS="${arg#*=}"
      ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--retention-days=N]"
      exit 0
      ;;
    *)
      echo "[warn] unknown arg: $arg" >&2
      ;;
  esac
done

# ---------- 检查目录 ----------
if [ ! -d "$BACKUP_DIR" ]; then
  echo "[skip] $BACKUP_DIR does not exist, nothing to clean"
  exit 0
fi

# ---------- 统计 ----------
# find 前先快照: kept files (README / .md / .sh / .log / .gitkeep / marker 类)
# 注意: 这些不计入 "deleted" 也不计入 "kept", 它们是"永久保留" (因为不是日期化的 dry-run 报告)
KEEPERS=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  ! -name '*.json' \
  | wc -l | tr -d ' ')

# 找 30 天前的 .json
OLD_JSON=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.json' -mtime +"$RETENTION_DAYS")

DELETED_COUNT=0
if [ -n "$OLD_JSON" ]; then
  DELETED_COUNT=$(echo "$OLD_JSON" | wc -l | tr -d ' ')
fi

# 剩余的 .json (30 天内的) — 这就是 "kept"
TOTAL_JSON=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')
KEPT_JSON=$((TOTAL_JSON - DELETED_COUNT))
KEPT_TOTAL=$((KEPT_JSON + KEEPERS))

# ---------- 执行 ----------
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] would delete $DELETED_COUNT old *.json (>${RETENTION_DAYS}d) from $BACKUP_DIR"
  if [ -n "$OLD_JSON" ]; then
    echo "[dry-run] files:"
    echo "$OLD_JSON" | sed 's/^/  /'
  fi
else
  if [ -n "$OLD_JSON" ]; then
    # -print 让 find 同时输出删了什么, 方便日志
    echo "$OLD_JSON" | while read -r f; do
      rm -f -- "$f"
      echo "[delete] $f"
    done
  fi
fi

echo "Deleted $DELETED_COUNT old backups, kept $KEPT_TOTAL"
