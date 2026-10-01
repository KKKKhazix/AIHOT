# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
docker compose up -d --build
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分，入选的还要写标题摘要）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源、图片和模型榜数据时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

### 更新

首次升级包含 `0040_story_digest_context.sql` 的版本时，必须先按下面的“事件文字安全修复升级”执行协调停机，不能直接滚动更新。其余更新：

```bash
git pull
docker compose up -d --build
```

数据库迁移只做向后兼容的增量，更新时自动执行。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。也可以手动导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 事件文字安全修复升级

`0040_story_digest_context.sql` 会把已失效报道的事件文字回退为剩余公开报道，并把原文保留在私有审计。新增列虽然兼容旧表结构，旧 API/worker 却没有新的同步失效和写回校验：旧任务可能在修复后写回过期文字，旧进程也可能继续返回内存缓存。因此这次升级不支持新旧应用混跑。

1. 按上节备份数据库并确认可恢复。安排维护窗口，在入口暂停读写流量；盘点连接此数据库的全部 API、worker 和网页实例，包括其他主机、手动任务与进程守护器。
2. 拉取目标版本并构建镜像。停止所有旧应用实例，给在途任务留出正常退出时间；本仓库 worker 的退出预算为 195 秒，Compose 停止等待使用 210 秒。确认没有残留旧进程或自动拉起的旧副本后才迁移，数据库保持运行。
3. 用新镜像执行迁移。迁移成功后只启动同一版本的新 API、worker 和网页，确认健康检查、事件页面及剩余合法报道正常，再恢复入口流量。迁移失败时保持维护状态并排查，不带着旧写入进程重试。

单机 Compose 的核心命令如下；入口维护、备份和其他主机的停机需按自己的部署完成：

```bash
git pull
docker compose build
docker compose stop -t 210 web api worker
# 确认全部旧实例已经退出，且 db 正常运行后再执行迁移
docker compose run --rm --no-deps setup node scripts/migrate.ts
docker compose up -d --no-deps --force-recreate api worker web
```

不用 Docker 时，也要先通过 systemd/pm2 等停止并确认所有旧进程退出，在目标版本目录执行 `node --env-file=.env scripts/migrate.ts`，成功后再启动这一版本的三个进程。不要只停 worker 而保留旧 API，也不要用 `down -v` 删除数据卷。

安全保证针对完成协调升级后的源站读取；重启应用会清除旧进程缓存，但已经发给浏览器、CDN 或其他消费者的副本不能由数据库迁移收回。按自己的缓存清理流程处理可控副本，其余需等待已有缓存期限结束；不能把源站更新等同于所有外部副本即时撤回。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
