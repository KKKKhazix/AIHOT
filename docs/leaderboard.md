# 模型榜与 Codex 重置监控

这两个模块只对 AI 行业有意义。别的行业在 `industry/features.ts` 里关掉即可（见 [把它改成你的行业](customize.md#6-只对-ai-有意义的两个模块industryfeaturests)）。

## 模型榜（`/leaderboard`）

把多家公开评测（LMArena、LiveBench、Epoch、EQ-Bench、Vals 等）的成绩放在一起：先找出和各项共同评测冲突最少的参考位次，再在不打乱这个顺序的前提下，把共同成绩的分差拟合成 0–100 的评分；另有编程、推理、知识、专业办公四个分类榜。Artificial Analysis 的综合指数只作交叉参考，不参与计分。方法对读者公开：

- `/leaderboard/rules`：评分和位次怎么算（方法 v17：每项评测用冻结的参照尺度校准分差，加权不完整 Kemeny 排序定位次，再拟合评分）。
- `/leaderboard/sources`：每个评测来源测什么、状态如何、是否参与计分。

**筛选**：综合榜和各分类榜都可以叠加“国产模型”“开源模型”两个筛选（手机上在“排序与筛选”面板里）。先从完整排名中筛选，再取前 30 个；原榜位次与评分不变。国产模型按开发方归属判断，不保证每个版本都能在国内直接使用；开源模型须有明确型号对应的官方权重仓库，也不代表无条件商用。表格在这些模型旁给出“开源权重”链接，供读者查看许可和部署要求。

官方权重对应关系维护在 `packages/backend/src/leaderboard/model-weights.json`，只登记核验过的精确型号；厂商归属在同目录的 `providers.ts`（按评测给出的机构名或型号名认厂商），哪些厂商算国产在 `access.ts`。新模型未登记时不会自动认定为开源模型，无需重新计算排名即可更新这些展示信息。

下面是只勾“国产模型”时的综合榜，截图来自本地站点，不代表模型的实际排名和评测结果：

![综合榜只看国产模型：保留原榜位次 12、13、24、29，开源模型旁有“开源权重”链接](assets/board-filters.png)

**更新**：每天 02:05、08:05、14:05、20:05 检查一遍所有上游。某个来源抓取失败时隔一会儿再试一次，还不行就沿用它上一份快照；只有证据真的变了，才发布新的一轮。新装好的站在 worker 第一次启动时会立刻算一轮。`COLLECT_ENABLED` 不是 `true` 时不抓上游，只用已存的快照重算。

**需要的 key**：

- `ARTIFICIAL_ANALYSIS_API_KEY`（可选）：读 Artificial Analysis 要它自己的 key。没有时来源页上没有它的数据；它只作交叉参考，排名和评分不受影响。
- `GITHUB_TOKEN`（可选）：只读 token，提高读 GitHub 的配额。

**模型名录**：模型的显示名、厂商、发布日期，每家评测对同一个模型的不同叫法，以及每项评测冻结好的参照尺度，放在 `database/seeds/` 最新的 `lb-models-日期.json` 里，由 `scripts/seed.ts` 在 worker 算第一轮之前导入（Docker 的 `setup` 每次启动都先跑它）：只补本站还没有的模型、叫法和尺度，已有的不覆盖。这样新站抓到的成绩会归到和 AIHOT 一样的模型上，评分也用同一把尺子。尺度一旦冻结就不再变，新加的模型或刷新的成绩不会拉伸别人的分差。名录里没有的新模型，会按评测给出的名字自动建立，名字和厂商可能不够规整。

**价格**：表格里的官方 API 价格来自 `database/seeds/` 里按日期命名的价格文件（`lb-official-prices-日期.json`，同一个模型以较新的文件为准），每次刷新会给还没有价格的模型补上。厂商调价或者上了新模型，加一个新日期的文件，然后运行：

```bash
node --env-file=.env scripts/import-leaderboard-prices.ts
```

**代码**：

| 位置 | 内容 |
|---|---|
| `packages/backend/src/leaderboard/source-registry.json` | 评测来源对读者的说明：分组、名称、状态（计分或交叉参考）、用法与局限 |
| `packages/backend/src/leaderboard/fetch/sources/` | 每个上游一个读取器 |
| `packages/backend/src/leaderboard/method/` | 方法 v17：`consensus.ts`（哪些评测计分、八个能力维度的份额、入榜条件）、`calibration.ts`（参照模型与冻结尺度）、`kemeny.ts`（参考位次）、`score.ts`（0–100 评分）、`inputs.ts` 与 `run.ts`（读快照、算一轮、发布） |
| `apps/web/app/features/leaderboard/`、`apps/web/app/routes/leaderboard*.tsx` | 页面 |

**工具**：

```bash
node --env-file=.env scripts/lb-round.ts --fetch      # 立刻抓一遍并算一轮
node --env-file=.env scripts/lb-fetch-check.ts        # 只抓不写，和已存的快照逐行对比，检查读取器
```

**改方法**：`consensus.ts`、`calibration.ts`、`score.ts` 里的每个常数都是方法的一部分，改了会改变读者看到的位次和评分。改方法时，把 `/leaderboard/rules` 页面上的文字一起改掉，并升方法版本（`consensus.ts` 的 `METHOD_VERSION`）：页面上写的必须和实际算法一致。改的是参照尺度的校准规则，还要升 `calibration.ts` 的 `CALIBRATION_METHOD_VERSION`，尺度会按新规则重新冻结，模型名录里带的旧尺度就不再用。

## Codex 重置监控（`/codex-reset`）

盯 OpenAI Codex 团队的 Tibo（X 账号 @thsottiaux）发布的 Codex 用量重置消息：预告、进展、确认完成、撤回，给出预计生效时间和原帖链接。机器可读的接口是 `/api/v1/codex-resets`，轮询用更轻的 `/api/v1/codex-resets/recent`；Agent 读 `/api/v1/agent/codex-resets`，MCP 工具是 `<mcpPrefix>_get_codex_resets`。

- 需要 `SOCIALDATA_API_KEY` 读 X，并且 `COLLECT_ENABLED=true`。不满足时监控不运行，页面上只会显示“暂无重置记录”，这种情况建议把模块关掉。
- 每 10 分钟看一次，和上一次重叠 15 分钟，补上晚到的回复；每天 04:40 再回看过去 48 小时补漏。
- 帖子由模型识别（`MONITOR_MODEL`，默认用默认模型），但状态怎么变由代码决定：模型的措辞本身不能确认任何事。
- 拿不准的识别会停在后台“Codex 重置”页等人看，可以改归属、补充、撤回。
- 配置了飞书内容推送时，重置预告和确认会推送到群里。
