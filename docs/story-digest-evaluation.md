# 事件综述提示词评测

事件页的综述由 `industry/prompts/story-digest.md` 生成。改这份提示词之前，先在同一批事件上把现有提示词和候选提示词并排跑一遍，人工比较，不凭页面印象判断。

## 1. 准备案例

```bash
node --env-file=.env scripts/eval-story-digests.ts --stories <事件id>,<事件id> --out .data/story-digest-cases.jsonl
```

事件 id 是事件页地址 `/story/<id>` 里的那一段。导出只读数据库，不调用模型，不改动任何事件。报道按站点生成综述时的同一套规则取，只是顺带提及的、综合稿、撤下的和尚未公开的报道不算。已经有综述的事件按“更正后重写”组装（不带上一版综述），还没有综述的按首次撰写。找不到、已被合并或没有可用报道的事件会直接报错。

导出的文件每行一个事件，可以先审阅。想测有新报道时的增量更新，把 `inputMode` 改为 `incremental`，填上 `story.previousDigest` 和 `knownArticleIds`（上一版已包含的报道 id）。也可以手写案例，格式见 `industry/story-digest-eval.example.jsonl`（虚构示例）。

## 2. 并排对比

```bash
node --env-file=.env scripts/eval-story-digests.ts --cases .data/story-digest-cases.jsonl --system my-candidate.md
```

- 每个案例用现有提示词和候选提示词各跑一次：同一个模型（默认是“事件综述”这一步当前用的模型，`--models` 可指定），同一份输入。发给模型的系统提示词、输入和采样参数与站点生成综述时完全相同。
- 候选文件的写法与 `industry/prompts/` 相同：`{{siteName}}` 换成站名，`{{> 文件名}}` 插入共用规则，缺值会报错。候选与现有提示词渲染后完全相同时拒绝运行。不传 `--system` 时只跑现有提示词。
- 开始前打印调用次数（案例数 × 模型数 × 提示词数），超过 `--max-calls`（默认 18）一次都不发。每次调用和站点其他模型请求一样记录、计入预算；原样重跑复用已收到的结果，不再付费，所以改一版候选再跑，现有提示词那一半不花钱。

结果写到 `.data/eval/`（`--out-dir` 可改），一份 JSON、一份 Markdown：两边的标题和综述并排，附每次调用的 token 用量和记录编号，失败的调用写明原因。

## 3. 人工看什么

没有可靠的自动分数，这个工具也不让模型给模型打分。逐条看：

- 是否先讲清核心变化和当前结论，而不是按日期复述下方的时间线；
- 有没有空泛的宣传腔和套话；
- 条件、适用对象、收费与额度、地域等限制是否仍绑在对应对象上；
- 有没有报道和事实证据里没有的内容，有没有评论报道本身（“报道未披露……”）或把写作要求写进正文；
- 更正后重写时，失效的旧说法是否清掉了。

## 4. 改完提示词之后

提示词换版本本身不会重写已有事件的综述。一个事件只在它的报道变化时才重新生成，有新报道时以旧综述为上一版增量改写，所以新提示词随新报道逐步生效，不会一次性产生大量模型调用。

想让某几个事件立即用新提示词重写，在仓库根目录调用 `rewriteStoryDigest`（每个事件一次模型调用，记进后台审计）：

```bash
node --env-file=.env --input-type=module -e '
const { rewriteStoryDigest } = await import("@aihot/backend/events/corrections");
const { sql } = await import("@aihot/backend/db");
const [s] = await sql`SELECT id FROM stories WHERE public_id = ${"<事件id>"}`;
console.log(await rewriteStoryDigest(s.id, "综述提示词已更新", "ops-script"));
await sql.end();'
```
