# 事件归组与关系评测

站点先用标题和摘要召回最近两周的候选事实（配了向量服务时比向量，没配时比文字重合度），再让模型判断报道之间的关系，同时判断这篇报道相对精选里已有的内容有没有新信息（分数够了的报道要靠这一条才进精选，见 [精选与校准](selection.md)）。关系定义和生产提示词在 `industry/prompts/group-*.md`，代码入口在 `packages/backend/src/events/relate.ts` 和 `group.ts`。

四种关系是：

- `SAME_OCCURRENCE`：同一次真实发生，例如同一发布的官方原文和媒体报道。
- `SAME_STORY`：不是同一次发生，但属于同一具体事件的直接进展，例如发布后的上架、评测或回应。
- `UNRELATED`：不同的事，即使主体、产品或话题相同。
- `ROUNDUP`：其中一方是包含多个话题的汇总。

## 用自己的标注样本评测 pairwise judge

`scripts/eval-relations.ts` 只评测两篇报道之间的 pairwise relation judgement。它直接复用生产环境的 `PAIR_SYSTEM`、`pairUser()`、`PairSchema` 和 prompt version，因此提示词发生变化时，评测也会随之变化。它不重新跑候选召回，也不把结果写回事件归组。

把自己的标注数据放在 `.data/` 下（该目录不会提交到 Git）。`industry/relation-gold.example.jsonl` 给了四条虚构示例。每行一条：

```json
{"caseId":"release-001","a":{"title":"...","source":"...","firstParty":true,"publishedAt":"2026-09-01T09:00:00+08:00","summary":"..."},"b":{"title":"...","source":"...","firstParty":false,"publishedAt":"2026-09-01T09:20:00+08:00","summary":"..."},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"same-release"},"gold":{"relation":"SAME_OCCURRENCE"}}
```

`a`、`b` 也可以带和生产 `ReportView` 一致的可选 `frame`：

```json
{"subject":"Acme","action":"发布","object":"Acme-2","occurredAt":"2026-09-01"}
```

建议把容易混淆的边界样本放进开发集，再留一部分 `benchmarkSplit: "holdout"` 最后检查。`samplingStratum` 是可选的错误分析标签，不影响模型输入。

### 运行

先按正常部署方式配置数据库和模型，再运行：

```bash
node --env-file=.env scripts/eval-relations.ts \
  --gold .data/relation-gold.jsonl \
  --split development
```

默认使用当前 `groupReview` capability 选择的模型。也可以显式比较多个已配置模型：

```bash
node --env-file=.env scripts/eval-relations.ts \
  --gold .data/relation-gold.jsonl \
  --models default,deepseek-flash \
  --split development \
  --n 200 \
  --seed 7 \
  --thresholds 0.75,0.8
```

可用参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--gold` | `.data/relation-gold.jsonl` | JSONL gold set |
| `--models` | 当前 `groupReview` 模型 | 逗号分隔的模型 key |
| `--split` | `all` | `development`、`holdout` 或自定义 split |
| `--n` | `200` | 最多评测多少条 |
| `--seed` | `7` | deterministic sampling seed |
| `--concurrency` | `6` | 并发模型请求数 |
| `--thresholds` | `0.75,0.8` | story-level tie 的 confidence thresholds |

完整报告写到 `.data/eval/relations-*.json`。每个模型会得到：

- 4 × 4 confusion matrix；
- 每类 precision / recall / F1 / support；
- overall accuracy 和 macro-F1；
- `SAME_OCCURRENCE` 或 `SAME_STORY` 作为 positive relation 时，各 confidence threshold 的 binary precision / recall / F1；
- model errors、token usage、平均 provider latency 和 wall-clock time；
- 每条 case 的 decision、confidence、difference 和 receipt id。

模型调用走现有 receipt 和 budget 机制。相同模型、prompt 和输入的重复评测会复用已有 receipt；同次运行中输入相同的样本共享一次请求结果，各自按自己的 gold 计分，失败也共享，不在该次运行中重复请求。`reused` 包括共享结果及已有回执的复用。评测使用独立的 `eval_relation_pair` purpose，不混入 production grouping 的 capability 统计。

token usage 与平均 latency 按报告引用的回执所对应的全部请求尝试汇总，包括之前解析失败的响应；同一回执不会因多条样本重复计算。缓存重跑仍展示这些历史用量，不代表本次新增费用。

CI 验证 JSONL parsing、deterministic sampling、metrics，以及本地模型替身下的并发复用和重试用量统计，不访问外部模型服务。
