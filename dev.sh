#!/bin/zsh
# 一键启停开发模式的三个服务（api / worker / web）和本地 PostgreSQL。日志在 .data/dev/。
#   ./dev.sh start    起 PostgreSQL（没装就 brew install，没库就建库+迁移+种子），再起三个服务
#   ./dev.sh stop     停三个服务，最后停 PostgreSQL
#   ./dev.sh restart | logs
# 兼容 macOS 和 Linux：进程用 node 的 detached 起（内部即 setsid），自成进程组，
# 停止时按组发信号，npm 及其带起的 node --watch 一起收掉，不留孤儿。
# PostgreSQL：macOS 走 brew services（装的是 postgresql@14）；Linux 走系统的 pg_ctl。
set -u
cd -P "$(dirname "$0")"
DIR=.data/dev
mkdir -p "$DIR"

# 项目要求 Node >= 24。当前 node 版本不够时，找 nvm 里装好的 v24+ 并切过去。
node_major() { node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
if (( $(node_major 2>/dev/null || echo 0) < 24 )); then
  NVM_DIR=${NVM_DIR:-$HOME/.nvm}
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1
    nvm use --lts >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1
  fi
fi
if (( $(node_major 2>/dev/null || echo 0) < 24 )); then
  echo "需要 Node >= 24（当前 $(node --version 2>/dev/null || 未安装)）：nvm install 24 后重试"
  exit 1
fi

DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=$(node -e "const u=process.env.DATABASE_URL||'postgres://127.0.0.1:5432/aihot';const m=u.match(/\/([^/?]+)(\?|$)/);process.stdout.write(m?m[1]:'aihot')" 2>/dev/null)
DB_NAME=${DB_NAME:-aihot}

psql_ok() { pg_isready -h $DB_HOST -p $DB_PORT >/dev/null 2>&1; }

db_install() {  # 没装 PostgreSQL 就装（macOS: brew；Linux: 提示用包管理器，不自动 sudo）
  if command -v pg_ctl >/dev/null 2>&1 || command -v postgres >/dev/null 2>&1; then return 0; fi
  if command -v brew >/dev/null 2>&1; then
    echo "未检测到 PostgreSQL，brew install postgresql@14 …（首次约几分钟）"
    brew install postgresql@14 || { echo "brew 安装失败，请手动安装 PostgreSQL 14+"; exit 1; }
  else
    echo "未检测到 PostgreSQL，也不会自动 sudo 安装。请用系统包管理器装 PostgreSQL 14+（如 apt install postgresql）。"
    exit 1
  fi
}

db_start() {
  db_install
  if psql_ok; then echo "PostgreSQL 已在运行"; return 0; fi
  if command -v brew >/dev/null 2>&1 && brew list --formula 2>/dev/null | grep -q "^postgresql"; then
    brew services start postgresql@14 >/dev/null 2>&1 || brew services start postgresql >/dev/null 2>&1
  elif [ -x /opt/homebrew/opt/postgresql@14/bin/pg_ctl ]; then
    /opt/homebrew/opt/postgresql@14/bin/pg_ctl -D /opt/homebrew/var/postgresql@14 -l "$DIR/postgres.log" start
  else
    # Linux：按发行版习惯找数据目录
    local dir
    for dir in /var/lib/postgresql/*/main /var/lib/pgsql/data; do
      [ -d "$dir" ] && pg_ctl -D "$dir" -l "$DIR/postgres.log" start && break
    done || { echo "找不到 PostgreSQL 数据目录，请手动启动后重试"; exit 1; }
  fi
  local i
  for ((i = 1; i <= 30; i++)); do psql_ok && break; sleep 1; done
  psql_ok && echo "PostgreSQL 已启动" || { echo "PostgreSQL 启动失败，日志 $DIR/postgres.log"; exit 1; }
}

db_stop() {
  psql_ok || { echo "PostgreSQL 本来就没在跑"; return 0; }
  if command -v brew >/dev/null 2>&1 && brew list --formula 2>/dev/null | grep -q "^postgresql"; then
    brew services stop postgresql@14 >/dev/null 2>&1 || brew services stop postgresql >/dev/null 2>&1
  else
    pg_ctl -D /var/lib/postgresql/*/main stop 2>/dev/null || pg_ctl -D /var/lib/pgsql/data stop 2>/dev/null
  fi
  psql_ok && echo "PostgreSQL 停止失败" || echo "PostgreSQL 已停止"
}

db_ensure() {  # 建库（如缺）+ 迁移 + 种子，幂等
  if ! psql -h $DB_HOST -p $DB_PORT -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
    echo "数据库 $DB_NAME 不存在，创建…"
    createdb -h $DB_HOST -p $DB_PORT "$DB_NAME" || exit 1
    node --env-file-if-exists=.env scripts/migrate.ts || exit 1
    node --env-file-if-exists=.env scripts/seed.ts || exit 1
  fi
}

start() {
  db_start
  db_ensure
  for s in api worker web; do
    if [ -f "$DIR/$s.pid" ] && kill -0 "$(cat "$DIR/$s.pid")" 2>/dev/null; then
      echo "$s 已在运行（pid $(cat "$DIR/$s.pid")）"
      continue
    fi
    node -e '
      const [service, log, pidFile] = process.argv.slice(1);
      const { spawn } = require("node:child_process");
      const out = require("node:fs").openSync(log, "w");
      const child = spawn("npm", ["run", "dev:" + service], { detached: true, stdio: ["ignore", out, out], cwd: process.cwd() });
      require("node:fs").writeFileSync(pidFile, String(child.pid));
      child.unref();
    ' "$s" "$PWD/$DIR/$s.log" "$PWD/$DIR/$s.pid"
    local port=0
    case $s in web) port=3000 ;; api) port=3001 ;; esac
    echo "$s 启动（pid $(cat "$DIR/$s.pid")）→ http://127.0.0.1:$port  日志 $DIR/$s.log"
  done
}

stop() {
  for s in api worker web; do
    local pid
    pid=$(cat "$DIR/$s.pid" 2>/dev/null) || { echo "$s 没在跑"; continue; }
    # 按进程组停：npm 带起的 node --watch 一起收掉
    if kill -- -"$pid" 2>/dev/null; then
      echo "$s 已停止（pid $pid）"
    else
      kill "$pid" 2>/dev/null && echo "$s 已停止（单进程，pid $pid）" || echo "$s 没在跑"
    fi
    rm -f "$DIR/$s.pid"
  done
  db_stop
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  logs) tail -n 100 -f "$DIR"/{api,worker,web}.log ;;
  *) echo "用法: ./dev.sh start|stop|restart|logs" ;;
esac
