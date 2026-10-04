# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动前检查 `.env` 的 `SITE_URL`：本机试用保留 `http://localhost:3000`；部署到服务器时改成读者实际访问的地址。例如通过服务器 IP 访问时（把示例 IP 换成自己的）：

```dotenv
SITE_URL=http://192.0.2.10:3000
```

RSS、分享链接、站点地图和 Agent Markdown 中的绝对链接都使用这个值，不会随浏览器访问的地址自动改变。使用域名和 HTTPS 时按下方「配域名和 HTTPS」设置。

配置完成后启动：

```bash
docker compose up -d --build
```

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分、结构化、写标题摘要，再归组）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。`web` 只接收网站地址、API 地址等网页配置，通过 HTTP 读取 API；数据库、模型和管理员密钥，以及数据卷，只交给后端容器。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源和图片时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `site/site.ts` 的 `icp`。

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

MCP 默认接受 `SITE_URL` 的主机以及 `localhost`、`127.0.0.1`、`[::1]`。额外主机用 `MCP_ALLOWED_HOSTS` 配置，以逗号分隔，例如 `extra.example:8443,[2001:db8::1]`。主机名不区分大小写，IPv6 必须加方括号；可带 0–65535 的十进制端口，匹配时忽略端口。包含路径、用户信息或非法端口的配置不会生效。`127.1` 等别名需要明确列入；此配置只影响 Host 校验，不扩大浏览器 Origin 许可。

### 更新

先按下节备份数据库。构建完成后停止旧服务，再运行迁移和新版服务：

```bash
git pull
docker compose build
docker compose stop api worker web
docker compose run --rm setup && docker compose up -d
```

迁移成功后再启动服务；迁移失败时先查看错误，不要继续启动。使用 HTTPS 配置的站点继续保留 `--profile https`。旧的 API 和 worker 要在迁移前停下：迁移可能删表删列，旧代码还在跑会出错；正常关闭 worker 会等进行中的付费调用收尾（最长三分多钟）。非 Docker 部署也按“备份、构建、停止 API/worker/web、迁移（`scripts/migrate.ts`）、种子数据（`scripts/seed.ts`）、启动”的顺序更新。

#### 社区修复与新资料的时间规则（2026 年 10 月 4 日）

公开接口版本仍是 4.0.0。迁移 `0055` 在线建一个索引，不锁表。

- **首次导入之后不再收信源的存档**：以前新信源首次导入后，第二次抓取会把订阅里剩下的旧条目全部当历史内容收进来，逐条付费分析（示范源一次就有上千条）。现在之后的抓取只收发布时间在信源加入前 48 小时以内或之后的条目；没有日期的照收，X 账号不受影响，见 [信源](sources.md) 的“旧文不刷屏”。升级前已经收进来的旧条目按原文时间归档，不进“今天”和日报，分析也早已跑完，不用处理。
- **没有可信发布时间的新资料先不公开**：先不进公开列表、精选、报告、热点和推送，从原信源或原文页读到日期后再判断新旧。日期未知时，文章页、结构化数据和 Agent Markdown 标“收录时间”，RSS 不写 `pubDate`；OpenAPI 注明事件时间线和日报快讯的 `publishedAt` 这时是收录时间。
- **推理模型的额度改成明确配置**：默认模型设 `LLM_REASONING_TOKENS`，具名模型在 `site/models.ts` 写 `reasoningTokens`。原来只有名字以 `-think` 结尾的具名模型会多给 4000，这个做法去掉了；自己加过这类模型的，补上 `reasoningTokens: 4000` 才保持原来的额度。推理模型把额度用光时，报错会写明 `finish_reason=length` 和该改哪一项。
- **`site.ts` 多了几项**，自己改过的站合并时对照新文件补上：
  - `EDITION_TIMES`、`EDITION_WHEN`：日报、周报、月报的出刊时间，原来写死在代码里；排程、日报的时间窗口、缺期告警和提到时间的文案都读它。`public/` 里的文件用占位 `{{dailyTime}}`、`{{weeklyTime}}`、`{{monthlyTime}}`。
  - `ITEM_COPY`：推荐理由叫什么，网页和分享图上显示不显示评分。
  - `REPORTS.descriptions`、`entry`、`metricUnits`、`shareUnit`：报告页面的描述和版面上的说法。
  - `ABOUT`、`CARDS` 里提到出刊时间和推荐理由的文案改成引用上面几项。
  - `DEPLOYMENT.directImageHosts` 改名为 `directFetchHosts`，采集和图片共用这份直连名单。
- **公开接口按类别筛选按 `PUBLIC_CATEGORIES` 走**：API、RSS 和 MCP 的 `category` 取所有在公开接口里算作这一类的类别。不合并分类的站（默认就是），按 `tip` 查不再带出观点；没有 `tip` 类别的行业也能通过类型检查。
- **JSON 接口里不带时区的时间**（如 `2026-09-30 17:43:58`）按信源的 `publishedAtUtcOffset` 读，默认 `+08:00`。以前按服务器时区读，Docker 里是 UTC，所以已有这类信源的新条目时间会提前 8 小时，变成正确值。
- **RSS**：声明了 `summaryIsBody` 的信源，摘要不论长短都当正文（Atom 的 `summary` 也算）；没有网页的播客单集，原文链接改为音频或视频文件，不再去抓网页。
- **迁移不能锁表**：新迁移不整表回填或重写，建索引用 `CREATE INDEX CONCURRENTLY`；CI 用 `scripts/check-migrations.ts` 检查。
- **修复**：信源请求成功却漏掉日期、标题或正文时会补全并记进信源健康；YouTube 视频页不再被当成图片；MCP 请求有大小上限，错误日志去掉凭据；桌面侧栏放大后显示细滚动条；测试按每一步实际的提示词认请求、从 `industry/selection.ts` 读门槛，换行业改写提示词和门槛后不再误报，架构测试在 Windows 上也能判对。

#### 站点文件搬进 `site/`（2026 年 10 月）

公开接口没有变化，版本仍是 4.0.0。

- **站点自己的文件从 `industry/` 搬到了 `site/`**：`site.ts`、`models.ts`、`brand/`、`pages/`、`public/`、`changelog.json`。`industry/` 只留行业知识：`taxonomy.ts`、`topics.json`、`sources.json`、`prompts/`、`selection.ts`。自己改过这些文件的，合并时把改动挪到 `site/` 下的同名文件。
- **`site.ts` 多了几项**，都可以不填：`SITE.github`、`SITE.llmsIntro`、`SITE.rootIcons`，`POLICY.terms.license`、`POLICY.terms.headers`，`ABOUT.termsAnchor`（二维码卡片可以写 `alias`），以及 `ACCESS`、`ADMIN`、`DEPLOYMENT`、`FEED_COPY`、`PUBLIC_CATEGORIES`，说明见 [把它改成你的行业](customize.md)。
- **`DEPLOYMENT.requiredSecrets`** 是生产 API 启动时额外检查的凭据清单，默认空；基本会话、图片签名和管理员登录校验仍然生效。只有你的部署要求某个可选集成必须配置时才填写。
- **只属于你这个站的功能可以做成模块**：放进 `modules/<名字>/`，在 `site/modules/` 的清单里启用，见 [架构](architecture.md) 的“模块”。框架本身不带模块。
- **Agent 接入页默认打开 MCP**，页面列出 MCP、RSS 和 API 三种接入方式。Agent Markdown 接口仍在 `/api/v1/agent`，可从页面下方“Agent 使用说明”进入。
- **图片代理可以设流量上限**：`IMGPROXY_UPSTREAM_MB_PER_MINUTE`、`IMGPROXY_UPSTREAM_GB_PER_DAY`（或 `site.ts` 的 `DEPLOYMENT.imageUpstreamBudget`），默认不设。
- **修复**：同样的数据每次给出同样的字节（排序遇到并列时补上唯一的次序，API 和 RSS 的 ETag 不再无故变化）；网页转给 api 的请求不再带上逐跳头，`Connection: close` 不再让下一个 POST 失败；`llms.txt` 的接入方式按实际数，不再写成四种。

#### 升级到公开接口 4.0.0

- **模型榜、Codex 重置监控和主题页的大事记不再是框架的一部分**，只留在 AIHOT 上。页面（`/leaderboard`、`/codex-reset`）、接口（`/api/v1/codex-resets`、`/api/v1/codex-resets/recent`、`/api/v1/agent/codex-resets`）和 MCP 工具 `<前缀>_get_codex_resets` 都去掉了，MCP 和 `/openapi-v1.json` 的版本号升到 4.0.0。迁移 `0053` 删掉它们的表（`lb_*`、`monitor_*`、`fx_rates`）和设置，定时任务及其执行队列在 worker 启动时自动撤掉，后台运行记录继续保留；要留这些数据的，升级前先备份。公司主题页的标志改成公司名的首字母。
- **行业包有几处变化**，自己改过 `industry/` 的站，合并时对照新文件补上：
  - `site.ts` 多了 `topicsTitle`、`feedbackExample`、`keywords`、`since`、`interfaceVersion`、`POLICY`（使用规则和隐私说明两页的名字与简介、X 帖子算不算全文）、`ABOUT.description`、`ABOUT.sourcesFallback`、`AGENT`、`REPORTS`、`ALERTS`、`SOURCE_DEFAULTS`、`COMMUNITY_FEEDS`、`CARDS`；作者块的两张二维码卡片加了 `kind`，`ABOUT.copyright` 改成反馈页链接前后的两段。
  - 新增 `models.ts`：具名的模型和每一步默认用哪个，原来写在代码里。
  - 网页左上角的标志从 `apps/web/app/components/Logo.tsx` 搬到 `industry/brand/Logo.tsx`。
  - 新增 `public/`：`robots.txt`、`manifest.webmanifest` 原来在代码里生成，OpenAPI 说明原来在 `reference/`，现在都是这里的文件。原来填了 `contactEmail` 就会生成的 `/.well-known/security.txt`，现在要自己放一份 `public/.well-known/security.txt`。
  - 删掉了 `features.ts`、`chronicle.ts` 和 `chronicles/`；`topics.json` 里的 `orgNames`、`leaderboardProvider`、`chronicleTerms` 不再使用，可以删掉。
  - `taxonomy.ts` 的类别可以写 `feedLabel`（分类 RSS 标题里的名字，示例站用“AI 模型”这样的说法）和 `publicAs`；`ENTITIES` 加了几家公司。
- **推送接口的限流可以设置**：`/api/ingest/items` 每个客户端每分钟最多推几次由 `INGEST_RATE_LIMIT` 决定，`docker compose` 默认 10，和以前一样；不用 Docker 时默认不限，前面没有代理限流的话在 `.env` 里设上。
- **不再使用的环境变量**：`ARTIFICIAL_ANALYSIS_API_KEY`、`MONITOR_MODEL`，可以从 `.env` 删掉。

#### 升级到公开接口 3.0.0

- **安全阀默认关**：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 只有写成 `true` 才打开，没写就是关。用 `scripts/init-env.ts` 生成的 `.env` 已经有这两行；自己写的 `.env` 没有的话要补上，否则升级后不再采集、不再调用模型。
- **周报月报接口换了形状**：`/api/v1/weeklies`、`/api/v1/monthlies` 的列表和每一期都带 `periodStart`、`periodEnd`，正文改成 `sections[]`（每栏 `label`、`summary`、`items`），不再有 `title`、`themes`，列表的 `limit` 最多 60。读这两个接口的程序要跟着改；MCP 和 `/openapi-v1.json` 的版本号随之升到 3.0.0。
- **精选的机器出口每条新闻一条**：API 的 `mode=selected`、同步接口和精选 RSS 里，同一条新闻只留代表报道，其他报道以 `remove` 出现在同步的变更里（`mode=all` 里还在）。升级前已经入选的旧报道不会被重新整理，等这条新闻再有报道发布时才归并。
- **精选要等去重确认**：分数够了的资料，要等归组确认它不是精选里已有新闻的重复、带来了新信息，才进精选；确认之前只在“全部动态”。归组用的模型回答不合格式时会停在那里，后台“运行”页能看到。
- **一手只看分级**：`T1` 就是一手，`first_party` 不再单独设置；以前单独标成一手的 `T1_5`、`T2` 信源不再算一手，要算就改成 `T1`。
- **行业包多了几项**：`taxonomy.ts` 新增 `RELEASE`、`PLAIN_TERMS`，评论类的类别标 `commentary: true`，`ENTITIES` 可以写 `otherNames`，`CATEGORY_BY_ITEM_TYPE` 不再使用。已经换成别的行业的站，合并时对照 [把它改成你的行业](customize.md) 补上。
- **主题只读 `industry/topics.json`**：迁移会删掉数据库里的 `topics` 表。只改过数据库、没改文件的主题，升级前先写进文件。公司主题只看 `entityId`，`related` 不再使用。
- **日报不再调用模型**：日报按规则编排，周报月报从日报汇编，模型只写总述和栏目导读；已经出过的各期不重写。
- **提示词有改动**：`industry/prompts/` 里的 `structure.md`、`group-*.md`、`story-digest.md`、`report-period.md` 换成了新的写法，`report-daily-lead.md` 删掉了，新加了 `report-period-sections.md`。改过这些提示词的，对照着把自己的改动搬过去。
- **删掉的脚本**：`scripts/delete-sources.ts`、`scripts/regroup-events.ts`、`scripts/enqueue-analysis.ts`。不要的信源在后台暂停；单篇的重新评估、重新归组在后台内容页。
- **3.x 的 `/agent` 默认打开 Agent Markdown**，MCP 的接入说明在 `/agent?tab=mcp`；当前接入页见上方“站点文件搬进 `site/`”。
- **飞书内容群只推 `T1`、`T1_5` 信源的精选。**

### 管理员会话与配置变更

会话绑定迁移排在 `0041`。此前已试用会话绑定迁移的数据库可直接升级，已有列和绑定会被保留，无需手动修改迁移记录。

会话绑定登录方式、登录时的管理员凭据或飞书身份。升级到会话绑定版本后，未绑定的旧会话需要重新登录。修改管理员密码、飞书管理员名单或会话密钥后，应重启所有 API 进程，使它们加载相同的新配置；只编辑配置文件不代表正在运行的进程已生效，混用旧代码或旧配置的进程不能提供统一撤权。

有效配置改变后，密码会话不再接受旧密码的授权，飞书会话按登录时实际取得的 union ID 或邮箱检查当前名单（两者任一仍获授权即可）。停用飞书登录应用或更换应用 ID 会使飞书会话失效；只轮换同一应用的 secret 不会使仍获授权的飞书会话退出。轮换或移除 SESSION_SECRET 会使两种会话都失效。

鉴权时确认失效的会话会被删除，恢复旧配置也不会让它复活。系统不记录全局凭据变更历史：某次配置变化若从未被进程加载，或在恢复前从未被会话检查观察到，不能据此追溯撤销会话。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。一次完整备份包含同一时间戳的数据库 `.dump` 和文件 `aihot-files-*.tar.gz`：文件包保留 `uploads/` 以及仍存本地的 `feedback-screenshots/`，不包含图片缓存或本地备份目录。已经转发到飞书的图片只保留数据库中的外部引用，文件包不保存飞书上的图片。

恢复时同时取回这一对文件：使用与数据库版本兼容的 `pg_restore` 将 `.dump` 恢复到空数据库，再把文件包解压到数据目录根目录（Docker 中为 `/data`，非 Docker 使用 `AIHOT_DATA_DIR`，默认 `.data`），保留包内的子目录结构，并确保运行进程可读取这些文件。只恢复数据库不能找回仍由 `local:` 引用的反馈截图；旧备份中没有包含的文件也无法凭数据库引用恢复。

下面的手动导出只包含数据库，不包含上述附件目录：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

- **模型**：每条新资料先预筛一次；过了预筛的再评两次分、做一次结构化、写一次标题摘要，然后归组（有相近的报道时才调用），另外还有事件综述、周报月报的总述和精选的全文翻译。日报按规则编排，不调用模型。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 付费请求上限”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17，系统用 Linux 或 macOS；Windows 上请在 WSL2 里运行，或者用上面的 Docker 方式。

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

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。停止 worker 时至少给它 210 秒（systemd 的 `TimeoutStopSec`、pm2 的 `kill_timeout`），让进行中的付费调用收尾；被提前杀掉的调用结果不明，要等至少半小时自动放行后才会重试。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
