#!/usr/bin/env bash
# OPCHOT 数据库自动备份：pg_dump 自定义格式 + 完整性校验 + 按天轮转。
# 由 systemd opchot-backup.timer 每日触发（root 运行，可访问 docker）。
# 异地备份：配置 .env 的 DB_BACKUP_STORE_* 后由框架自带任务推送到 S3/COS。
set -euo pipefail

BACKUP_DIR="${OPCHOT_BACKUP_DIR:-/opt/1panel/backup/opchot}"
RETAIN_DAYS="${OPCHOT_BACKUP_RETAIN_DAYS:-14}"
DB_CONTAINER="${OPCHOT_DB_CONTAINER:-opchot-db-1}"
DB_USER="${POSTGRES_USER:-opchot}"
DB_NAME="${POSTGRES_DB:-opchot}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/opchot-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "[backup] dumping $DB_NAME from $DB_CONTAINER ..."
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --compress=6 > "$OUT"

# 校验 dump 可列出内容（损坏会在此失败，避免留下坏备份）
docker exec -i "$DB_CONTAINER" pg_restore --list < "$OUT" > /dev/null
chmod 600 "$OUT"

# 轮转：删除超过保留期的备份
find "$BACKUP_DIR" -name 'opchot-*.dump' -type f -mtime +"$RETAIN_DAYS" -delete

SIZE="$(stat -c%s "$OUT" 2>/dev/null || echo 0)"
echo "[backup] ok $OUT ($SIZE bytes), retain ${RETAIN_DAYS}d"