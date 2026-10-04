# 参与贡献

欢迎提交可复现的问题、文档修正，以及对其他行业也有用的改进。中文或英文都可以。

## 去哪里交流

- [Issues](https://github.com/KKKKhazix/AIHOT/issues/new/choose)：可复现的 Bug 和有明确场景的功能建议。
- [部署与使用问答](https://github.com/KKKKhazix/AIHOT/discussions/categories/q-a)：安装、配置、部署和使用问题；问题解决后可以标记答案。
- [想法交流](https://github.com/KKKKhazix/AIHOT/discussions/categories/ideas)：先讨论方向和使用场景。
- [作品展示](https://github.com/KKKKhazix/AIHOT/discussions/categories/show-and-tell)：分享你搭建的行业热点站和实践经验。
- 安全漏洞请按 [安全报告说明](SECURITY.md) 私密提交。

## 贡献范围

优先欢迎部署体验、通用采集能力、处理流程、公开接口、可访问性、文档和可复现故障的改进。大幅调整架构或产品行为前，先在 Issue 或讨论区说明场景和方案，避免投入后才发现方向不合适。

只适合你所在行业的信源和精选标准，在自己的仓库里改 `industry/`；站名、品牌和页面改 `site/`；只有你的站需要的功能做成模块放进 `modules/`（见 [架构](docs/architecture.md#模块)）。步骤参考 [定制文档](docs/customize.md)。出于合规和风险考虑，完整运营信源名单暂不分享；本仓库也不持续维护微博、小红书等平台的专用采集适配，可以按 [信源文档](docs/sources.md) 接入你自行维护的外部采集结果。

## 提交改动

1. Fork 本仓库，从最新的 `main` 创建自己的分支。若只是搭建一个独立站点，可以用 [Use this template](https://github.com/KKKKhazix/AIHOT/generate)；模板生成的项目没有共享提交历史，后续贡献代码或合并上游更新更适合用 Fork。
2. 阅读 [AGENTS.md](AGENTS.md) 和改动对应的文档。保持一次 PR 解决一个清楚的问题，不夹带无关重构。
3. 按 [部署文档](docs/deploy.md) 配置本地环境。使用独立测试库，开发时关闭采集、模型调用和外部推送；不使用生产数据库或真实付费服务做测试。
4. 验证改动涉及的行为，在 PR 中写明运行结果。代码改动执行 `npm run typecheck`、`npm test`、网页构建与网页测试；后端测试库名必须以 `_test` 或 `_ci` 结尾（没有会自动创建并迁移），每个测试文件在它的副本上并行运行，所以测试数据库账号要有 `CREATEDB` 权限。运行中的站点可用 `node scripts/smoke.ts --base http://localhost:3000` 检查。纯文档或模板改动核对链接、语法和实际展示即可，不需要为了凑数量新增测试。
   改数据库时，已经发布的迁移不改，修正放进新文件；新文件只放一条允许在线执行的语句，PR 会自动检查，本地可以先跑 `node scripts/check-migrations.ts --base main`。规则见 [迁移约定](docs/architecture.md#数据库迁移)。
   备份恢复测试还需要 `tar` 和与服务端版本兼容的 `pg_dump`/`pg_restore`；测试会创建并清理独立的临时恢复库和文件目录，不访问真实对象存储。
5. 向本仓库 `main` 提交 PR，关联相关 Issue。页面改动附截图；涉及配置或升级步骤时同步更新文档，已部署的站点升级时要做的事写进 [部署文档](docs/deploy.md) 的“更新”一节。

`main` 通过 PR 合并。准备合并时，请把 PR 分支整理成一个提交，保留正确的作者署名；更新已经推送的分支用 `git push --force-with-lease`。分支要包含最新的 `main`，GitHub 的 `check` 和 `docker` 在这个提交上通过后，维护者用 rebase 方式合并，保留你的作者信息。

请勿提交 `.env`、密钥、管理员密码、Cookie、生产数据或未获授权的素材；日志和截图也要先移除敏感信息。代码沿用 [MIT 许可证](LICENSE)，品牌和第三方素材说明见 [NOTICE](NOTICE)。
