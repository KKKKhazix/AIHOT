# 给 Agent 的说明

这是一个行业热点网站的框架：采集信源、用模型筛选和写作、归组事件、出日报周报月报，并通过网站、RSS、公开 API、Agent Markdown 和 MCP 对外提供。默认配置是一个 AI 行业的示例站。先读 README，再按任务读 `docs/` 里对应的文档。

## 最常见的任务：改成另一个行业

按 `docs/customize.md` 的顺序做。这个站自己的东西在 `site/`：站名文案（`site.ts`）、每一步的模型（`models.ts`）、品牌与 Logo（`brand/`）、条款页（`pages/`）、原样发布的根目录文件（`public/`）、更新日志（`changelog.json`）。行业知识在 `industry/`：分类标签（`taxonomy.ts`）、主题（`topics.json`）、示范信源（`sources.json`）、提示词（`prompts/`）、门槛（`selection.ts`）。通常不需要改 `apps/` 和 `packages/`；框架里没有、只有这个站要的功能，做成模块放进 `modules/`（`docs/architecture.md` 的“模块”）。

这些事要问使用者本人，不要替他决定：站名；要盯哪些信源；什么消息重要、什么是噪声；分类怎么分；条款和隐私说明的内容（`site/pages/` 是模板，上线前需要他本人确认）。

改评分标准时保留原有结构（内容类型、五个维度加权、噪声压制、安全边界），替换的是“什么算重要”“什么算噪声”的例子。门槛要用使用者标注的样本重新校准（`docs/selection.md`），不要凭感觉改数字。

## 运行与检查

- Node.js 24 直接运行 TypeScript，后端没有构建步骤。npm workspaces：`apps/*`、`packages/*`、`industry`、`site`、`modules/*`。
- 本机运行和 Docker 见 `docs/deploy.md`。
- 改完至少跑：
  ```bash
  npm run typecheck
  DATABASE_URL=postgres://127.0.0.1:5432/<名字>_test npm test   # 名字必须以 _test 或 _ci 结尾；没有会自动建好并迁移，账号要能建库
  npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
  node scripts/smoke.ts --base http://localhost:3000             # 站点跑起来以后
  ```
- `tests/` 里部分测试用的是示例行业的分类、标签和公司，改了 `industry/taxonomy.ts` 后把这些例子换成新行业的对应项。

## 要守住的规则

- 前端（`apps/web`）只通过 HTTP 读 `apps/api`，数据库、模型调用和密钥只在后端。
- 所有公开出口都从 `packages/backend/src/publication/` 这一个读取层读，新增公开出口也一样。
- 读者打开页面不触发模型调用；模型只在 worker 的任务里调用。
- 付费请求都经过回执（`providers/receipts.ts`）和预算熔断，不要绕开。
- 安全阀只有设成 `true` 才打开。开发时保持关闭：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`。测试里推送一直关着，采集和模型调用只连本地假服务，不访问任何外部服务。
- 信源默认只展示摘要和原文链接（`site_fulltext` 关）；只有来源明确允许时才打开全文。
- 公开内容匿名，管理员和访客看到的一样；后台只允许管理员。
- 停用或替换一个功能、机制时，同一个改动删掉它的代码、测试、文档和存下的状态（库表与列、定时任务、settings、环境变量和 `.env.example` 里的项）；会删掉使用者已有数据的，在 `docs/deploy.md` 的更新说明里写明。加锁、重试、兼容旧格式、开关和兜底，先要有证据：真实部署里发生过，或平台的语义决定它会发生。
- 数据库迁移放在 `database/migrations/`（只属于某个模块的表放在它的 `migrations/`），按完整文件名排序执行和记账；编号相同的不同文件分别执行，新增迁移使用新的文件名，已经发布的迁移不改。从 `0055` 起，每个文件只放一条允许在线执行的语句，PR 会检查；索引使用 `CONCURRENTLY IF NOT EXISTS`，大批数据回填不放进发布迁移。约束验证和破坏性变更先按 [迁移约定](docs/architecture.md#数据库迁移) 设计，不能修改历史文件或关闭检查绕过。
- 不要提交 `.env`、密钥和 `.data/`。
- 不要使用 AIHOT 的名字和 Logo。

## 写代码

匹配周围代码的写法、命名和注释密度。选能清楚解决问题的简单方案，只定义正在使用的抽象。验证改动涉及的重要行为，不为简单的样式改动写测试。
