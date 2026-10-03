# 把它改成你的行业

这份仓库默认是一个“AI 行业”的示例站：示范信源是一批公开的 AI 资讯源，精选口味是 AIHOT 在 AI 领域调了很久的那一套。要把它变成“法律热点”“HR 热点”“黄金热点”，要改的东西几乎都在 [`industry/`](../industry/) 这一个文件夹里，代码基本不用动。

如果你用 Claude Code、Codex 这类 Agent，可以把下面这段直接发给它，然后回答它的问题：

```text
请读 AGENTS.md 和 docs/customize.md，把这个站改成「XX 行业」的热点站。
我关心的是：……（写你想盯的信源、你觉得什么消息重要、什么不重要，越具体越好）。
改完帮我跑 npm run typecheck、npm test 和 node scripts/smoke.ts，并告诉我还需要我自己决定哪些事。
```

下面是它（或者你）要做的事，按顺序。

## 1. 站名和文案：`industry/site.ts`

- `name`：站名。导航、标题、分享图、RSS、MCP、后台都用它。
- `subject`：行业词。页面上“AI 日报”“全部 AI 动态”会变成“法律日报”“全部法律动态”。
- `homeTitle`、`topicsTitle`、`description`、`tagline`、`keywords`：首页和主题目录页的标题、一句话介绍、分享图下方的小字、给搜索引擎的关键词。
- `mcpPrefix`：MCP 工具名前缀，比如 `lawhot` 会得到 `lawhot_get_latest`。有人接入以后不要再改。
- `interfaceVersion`：公开接口（MCP、OpenAPI、`llms.txt`）的版本号，只升不降；改了接口里已有的字段或含义时升主版本。
- `crawlerName`：抓取信源时报的名字，别用别人的站名。
- `icp`：中国大陆网站的备案号，填了就显示在页脚。
- `POLICY`：使用规则和隐私说明两页的名字和简介；`xPostIsFullText` 决定 X 帖子本身的文字算不算全文（算的话，只在信源允许全文时显示）。
- `ABOUT`：关于页的大标题、四个环节的说明、作者块（可选）、版权说明。
- `CARDS`：各页分享图上的文字。
- `ALERTS`、`SOURCE_DEFAULTS`、`COMMUNITY_FEEDS`：告警里随部署而变的说法，后台新建信源时默认展不展示全文，哪些社区站信源按发帖的账号算热度。

站点地址不写在这里，部署时用环境变量 `SITE_URL` 设置。

## 2. 分类、标签和主题：`industry/taxonomy.ts`、`industry/topics.json`

- `CATEGORIES`：首页和“全部动态”的筛选类别。`key` 会出现在网址和接口里（`/all?category=`、`/feed/category/<key>.xml`），上线后不要改；`label` 是显示名；`section` 是日报、周报、月报里的分节（几个类别可以共用一节）；`guide` 写这一类收什么、和相邻类别的边界在哪，结构化时给模型看（总的归类原则在 `prompts/structure.md`）；`commentary: true` 标出评论类（教程、观点）：报过的事件再有这类跟进，即使是当事方自己发的，日报也只放进快讯（除非有 4 家以上信源报道）；`feedLabel` 是分类 RSS 标题里的名字（不写就用 `label`）；`publicAs` 让这一类在公开接口、RSS 和 MCP 里并进另一类发布，网页上照样分开。
- `RELEASE`：这个行业最受关注的那类发布（AI 行业是新模型），类别和标签都对上才算。日报报头的“N 个新模型”按它数（后台改了分类，已出的日报会重算）；`unit` 是数字后面的说法。没有这样一类的行业设成 `null`，报头就不显示这个数。
- `PLAIN_TERMS`：周报月报的总述里可以直接写、不必在条目里找到出处的行业通用词（小写）。站名自动算在内。总述写了条目里没有的名字或数字就不用，见 [精选与校准](selection.md)。
- `CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITY_TAGS`：模型打标签时只能从这里选。第一个标签必须是“分类标签”。`prompts/structure.md` 里还写着 AI 行业的标签规则（比如什么才算“模型发布”），换行业时一起改。
- `ENTITIES`：行业里的主要公司或机构，用于“公司”类主题页。`aliases` 给结构化的模型看；`otherNames` 是公司自己的其他称呼（官方账号名、子品牌），把新闻的主体对到公司、判断标题有没有点名这家公司时也认它们。`IDENTITY_LEXICON`、`PUBLISHER_DOMAINS` 用来防止模型在标题摘要里写进原文没提到的公司，别的行业没有这个需要可以清空。
- `ITEM_TYPES`：内容类型，和评分提示词里的权重表对应，改了要一起改提示词。
- `topics.json`：主题目录（`/topics`）。站点启动时读取，改完重新构建（`docker compose up -d --build`）才生效。分三组：`company`（公司与机构）、`field`（方向）、`genre`（内容形态）。`slug` 上线后不要改。
  - `company` 主题用 `entityId`（`ENTITIES` 的 id）收以这家公司为主体的报道；一篇报道的主体有几家公司时，标题里点了它的名才算。可选：`aliases`（搜索框里只搜这个词，也能找出这家公司的报道）。
  - `field` 和 `genre` 主题用 `tags` 收打了这些标签的报道。

## 3. 信源：`industry/sources.json`

这是首次启动时导入的示范信源，已经存在的不会被覆盖；之后每次启动只补上文件里有、库里还没有的，从文件里删掉的不会从库里删（不要的在后台暂停）。上线后更常用的是后台“信源”页：能新建、试抓、调频率、暂停、看失败原因。

每个信源的关键字段：

| 字段 | 含义 |
|---|---|
| `kind` | `rss`、`web_list`（网页列表，配选择器）、`json_list`（JSON 接口）、`x_search`（X 账号，需要 SocialData）、`mp_account`（公众号，需要极致了）、`external`（外部推送） |
| `config` | 每种信源的配置，见 [信源](sources.md) |
| `tier` | 信源分级：`T1` 官方一手、`T1_5` 官方账号与准官方、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。不同分级的入选门槛不同。`T1` 就是“一手”，不用另外标 |
| `owner_entity_id` | 可选，这个信源属于哪家公司（`ENTITIES` 的 id）。同一家公司的几个信源在热度里只算一个参与方；`T1_5` 的官方账号要当代表报道，也要填它（见 [信源](sources.md)） |
| `participation_mode` | `editorial` 进精选和全部动态；`hot_signal` 只作热度证据；`isolated` 不进任何公开页面 |
| `site_fulltext` | 站内能不能展示全文。**默认关**：只展示摘要和原文链接。只有来源明确允许时才打开 |

中国大陆的很多行业，一手信息在公众号上。公众号信源需要极致了（Dajiala）的 key，按请求计费，有预算熔断。

## 4. 精选标准：`industry/prompts/`

这是最值得花时间的一步：你的行业 KnowHow 就写在这里。

| 文件 | 作用 |
|---|---|
| `prefilter.md` | 预筛：这条资料是不是这个行业的事。宽召回，只拦明显无关的 |
| `selection-score.md` | **评分标准**：给 0–100 分。里面有内容类型、五个维度、各类型的权重、必须正常评价的价值、必须压住的噪声 |
| `content-understanding.md` | 入选和接近入选内容的写法：中文标题、答案先行的摘要、推荐理由（它也会给标签，但页面上的分类和标签来自 `structure.md`） |
| `rules-domain.md` | 行业术语的翻译与保留规则（示例是 AI 术语：LLM 译作大语言模型、Token 保留英文……） |
| `summarize-*.md` | 其他内容的标题摘要写法 |
| `structure.md` | 分类、标签、主体公司，判断是一条具体新闻还是讲多件事的综合稿，抽出新闻的事实（谁、做了什么、对什么，附原文出处和前提条件）。页面上的分类和标签、主题页、事件归组和日报都靠它 |
| `group-*.md` | 事件归组：两篇报道是同一次发生、同一事件的后续，还是两件事；同时判断报道相对精选里已有的内容有没有新信息，没有的不进精选 |
| `story-digest.md` | 事件页的综述 |
| `report-period.md`、`report-period-sections.md` | 周报月报的总述和栏目导读（日报按规则编排，不用提示词） |
| `translate-*.md` | 全文翻译 |

提示词里用 `{{siteName}}` 指代站名，`{{> 文件名}}` 引用另一份提示词。改提示词不用改代码。

**建议的做法**：先保留结构（五个维度加权、噪声压制规则、安全边界），只把“什么算重要”“什么算噪声”的例子换成你的行业。比如法律行业，“新法规正式公布、重要判决、监管处罚”应该正常评价，“律所营销软文、课程广告”要压住。

## 5. 门槛与校准：`industry/selection.ts`

两次评分之和 ≥ 2 × 门槛才够分（够分的还要过归组时的去重，见 [精选与校准](selection.md)）。默认门槛（T1 60、T1_5 65、T2 76）是 AIHOT 在 AI 领域校准出来的，换了行业和提示词，需要重新校准：

1. 从你的信源里挑 100–200 条资料，自己标“该选 / 不该选”，存成 `.data/gold.jsonl`（格式见 [精选与校准](selection.md)，`industry/gold.example.jsonl` 有两条示例）。
2. 运行 `node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl`，看准确率、查准率、查全率，和不同门槛下的结果。
3. 在后台 SelectBench 里逐条看判错的资料，回去改评分提示词或门槛，再跑一遍。

这一步决定了你的站“选得准不准”。

## 6. 品牌：`industry/brand/`

- `logo.svg`、`icon.png`（512）、`icon-192.png`、`apple-icon.png`（180）、`favicon.ico`：站点图标。
- `Logo.tsx`：网页左上角的站名标志，默认用站名文字排出来；有自己的 Logo，把 `Wordmark` 换成你的 SVG，参数保持不变。
- `wordmark.svg`、`wordmark-dark.svg`（可选）：分享图和海报上的字标，深色版用在深色的分享图上；没有就用站名文字。
- `nameplates/`：日报、周报、月报页顶部的报头字（比如“AI日报”）。换了行业词以后重新生成：
  ```bash
  npm pack @fontsource/noto-sans-sc@5.3.0 && tar xzf fontsource-noto-sans-sc-5.3.0.tgz
  node scripts/nameplates.ts package
  ```
- 关于页的二维码：在后台“设置”里上传，或者把图片放进 `industry/brand/contact/`。

请不要使用 AIHOT 的名字和 Logo。

## 7. 页面文案：`industry/pages/`、`industry/public/`、`industry/changelog.json`

- `pages/terms.md`、`pages/privacy.md`：使用规则和隐私说明。**现在是模板**，上线前按你的实际情况改写，必要时请专业人士看一下。
- `public/`：原样发布在网站根目录的文件：`robots.txt`、`manifest.webmanifest`（装到手机桌面时的名字和图标）、`openapi-v1.json`（公开 API 的说明），以及可选的 `.well-known/security.txt`（安全问题的联系方式）。文件里的 `{{siteName}}`、`{{siteUrl}}`、`{{description}}`、`{{tagline}}`、`{{locale}}`、`{{version}}` 会换成这个站的值，OpenAPI 里的 `{{categories}}`、`{{categoryList}}` 换成公开的分类；没有的文件访问时是 404。
- `changelog.json`：更新日志。新条目写在最前面，把 `latestVersion` 改成它的日期和时间。`kind` 是“更新”“优化”“公告”“下线”之一；要读者一定看到的加 `"urgent": true`（红色，标“重要”）。

## 8. 模型和部署

- 模型：`.env` 里的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，任何 OpenAI 兼容接口都行，所有步骤默认都用它。`industry/models.ts` 列出具名的模型（各用自己的地址和密钥环境变量）和每一步默认用哪个；部署时还可以用环境变量（见 `.env.example`）或后台“模型”页逐步改选。
- 部署：见 [部署](deploy.md)。

## 改完以后检查

```bash
npm run typecheck
DATABASE_URL=postgres://…/myhot_test npm test     # 库名必须以 _test 或 _ci 结尾，数据库账号要能建库
node scripts/smoke.ts --base http://localhost:3000   # 站点跑起来以后
```

`tests/` 里有些测试用的是示例行业的分类、标签和公司（比如 `ai-models`、“模型发布”、Anthropic）。改了 `industry/taxonomy.ts` 以后这些测试会失败，把例子换成你行业里的对应项即可，测的规则本身不用改。

然后打开网站看一眼首页、全部动态、日报、主题页和关于页，再去后台“信源”页看信源是不是都抓成功了。
