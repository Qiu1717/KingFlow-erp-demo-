#!/bin/sh
# 每日备份：由 kingflow-backup.timer 触发（04:10，随机延迟 5 分钟）。
# 保留 14 天，超期自动清理。db:backup 内部会先做账实核对，核对不通过则拒绝备份。
set -eu
DEST=/var/backups/kingflow
mkdir -p "$DEST"
cd /opt/kingflow/current
export PATH=/opt/nodejs/bin:$PATH HOME=/opt/kingflow
# db:backup 拒绝覆盖已存在文件；同一天重跑（失败重试 / 手工补跑）时退回带时分的目标名。
TARGET="$DEST/erp-$(date +%Y%m%d).db"
if [ -e "$TARGET" ]; then TARGET="$DEST/erp-$(date +%Y%m%d-%H%M).db"; fi
pnpm db:backup "$TARGET"
find "$DEST" -name 'erp-*.db' -mtime +14 -delete
