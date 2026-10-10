# 把它改成你的行业

这份仓库默认是一个“AI 行业”的示例站：示范信源是一批公开的 AI 资讯源，精选口味是 AIHOT 在 AI 领域调了很久的那一套。要把它变成“法律热点”“HR 热点”“黄金热点”，要改的东西几乎都在 [`site/`](../site/)（这个站自己的名字、文案、品牌和页面）和 [`industry/`](../industry/)（行业的分类、信源、提示词和门槛）这两个文件夹里，代码基本不用动。

如果你用 Claude Code、Codex 这类 Agent，可以把下面这段直接发给它，然后回答它的问题：

```text
请读 AGENTS.md 和 docs/customize.md，把这个站改成「XX 行业」的热点站。
我关心的是：……（写你想盯的信源、你觉得什么消息重要、什么不重要，越具体越好）。
改完帮我跑 npm run typecheck、npm test 和 node scripts/smoke.ts，并告诉我还需要我自己决定哪些事。
```

下面是它（或者你）要做的事，按顺序。

## 1. 站名和文案：`site/site.ts`

- `name`：站名。导航、标题、分享图、RSS、MCP、后台都用它。`organization.name` 是结构化数据里的网站运营者（给搜索引擎看），默认也是站名，改站名时一起改；`organization.founder` 是创始人（选填）。
- `subject`：行业词。页面上“AI 日报”“全部 AI 动态”会变成“法律日报”“全部法律动态”。
- `homeTitle`、`topicsTitle`、`description`、`tagline`、`keywords`：首页和主题目录页的标题、一句话介绍、分享图下方的小字、给搜索引擎的关键词。
- `feedbackExample`：反馈表单输入框里的示例。
- `locale`：界面语言（网页的语言标记、分享卡片和结构化数据），`public/` 文件里的 `{{locale}}` 也换成它。
- `since`：网站开始收录的年份（结构化数据里的时间范围，选填）。
- `mcpPrefix`：MCP 工具名前缀，比如 `lawhot` 会得到 `lawhot_get_latest`。有人接入以后不要再改。
- `interfaceVersion`：公开接口（MCP、OpenAPI、`llms.txt`）的版本号，只升不降；改了接口里已有的字段或含义时升主版本。
- `crawlerName`：抓取信源时报的名字，别用别人的站名。
- `contactEmail`：对外联系邮箱（选填），填了就在 `llms.txt` 和给 Agent 的使用说明里写成授权联系方式。
- `footerNote`：关于页底部的一行小字。默认是一行框架署名“由 AIHOT 开源框架驱动”，可以留也可以删（设成 `null`）。
- `icp`：中国大陆网站的备案号，填了就显示在页脚。
- `github`：源码仓库的地址（选填），填了就在侧栏和“我的”页底部显示“GitHub 开源”。
- `llmsIntro`：`llms.txt` 里一句话介绍下面的一段详细介绍（选填）。
- `rootIcons`：标准图标以外也放在网站根目录的图标，`site/brand/` 里的文件名（选填）。
- `EDITION_TIMES`：日报、周报、月报的出刊时间（北京时间）。排程、日报收录的时间窗口、缺期告警和所有提到时间的文案都读它；排程每半小时检查一次，写整点或半点。`EDITION_WHEN` 是由它拼出来、写进句子里的说法（“每天 08:00”“每周一 10:00”“每月 1 日 10:30”），一般不用改。
- `POLICY`：使用规则和隐私说明两页的名字和简介；`terms.license` 是讲清哪些用途要先取得授权的话，`terms.headers` 是公开接口声明使用规则的响应头（都选填）；`xPostIsFullText` 决定 X 帖子本身的文字算不算全文（算的话，只在信源允许全文时显示）。
- `ABOUT`：关于页的大标题、四个环节的说明、作者块（可选）、版权说明，以及“使用规则”链接的锚点（`termsAnchor`，选填）。
- `CARDS`：各页分享图上的文字。
- `NAV`：`hidden` 写不放进导航的引擎入口，目前只支持热点榜（`"/hot"`）和主题（`"/topics"`）；例如来源还不多、热点榜常是空的站写 `"/hot"`。电脑侧栏、手机底栏和“我的”页都不放；页面照样能打开，直接打开这些页面时所属标签为精选，原来回到它的返回按钮和链接改回精选，给搜索引擎的页面层级（面包屑）也不经过它；写 `"/hot"` 时首页也不放当前热点，事件页不写热点榜名次。默认是空的，导航和原来一样。
  其他入口暂不开放：它们的返回按钮和页面内入口也需要一起支持，避免只隐藏侧栏、别处仍引导读者过去。
- `ITEM_COPY`：模型写的那句理由叫什么（`reasonLabel`，默认“推荐理由”），读者在网页和分享图上看不看得到 AI 评分（`showScore`；只管显示，公开 API 和 MCP 照样带分数）。
- `REPORTS.quiet`：日报时段里有资料经过评判、但没有新大事时的标题与导语；导语中的 `{start}`、`{end}` 会替换为时段起止。
- `REPORTS`：日报、周报、月报版面上的说法：报头的出版者一行和旁边的一个词、每种报告页面的描述、一期里的一条怎么称呼（`entry`，默认“件大事”）、报头上其余数字后面的单位、分享图上的条数说法。
- `ALERTS`、`SOURCE_DEFAULTS`、`COMMUNITY_FEEDS`：告警里随部署而变的说法，后台新建信源时默认展不展示全文，哪些社区站信源按发帖的账号算热度。
- `ACCESS`：给 Agent 的说明和 `llms.txt` 里的限流说法与建议的 User-Agent；前面的反向代理真的按 IP 限流了，再填 `ratePerMinute`。
- `ADMIN`：后台几处给管理员的提示（选填）。
- `AGENT`：Agent 接入页 MCP 工具表里“搜索”一行的说法：能搜什么、可以怎么问。
- `DEPLOYMENT`：这个部署自己的安排：凭据文件放在哪、生产 API 启动时额外检查哪些凭据（`requiredSecrets`，默认空）、CDN 回源用的域名、后台登录回跳用的请求头、图片代理的流量上限、采集和图片直连（不走出网代理）的域名、精选评测默认用的样本，都可以不填。
- `FEED_COPY`、`PUBLIC_CATEGORIES`：“全部动态”RSS 说明里补充的不含内容；公开接口（API、RSS、MCP）里和网页不同的类别：`merge` 把一类并进另一类发布，`feedLabels` 换掉分类 RSS 标题里的名字，上线后不要改。

站点地址不写在这里，部署时用环境变量 `SITE_URL` 设置。

## 2. 分类、标签和主题：`industry/taxonomy.ts`、`industry/topics.json`

- `CATEGORIES`：首页和“全部动态”的筛选类别。`key` 会出现在网址和接口里（`/all?category=`、`/feed/category/<key>.xml`），上线后不要改；`label` 是显示名；`section` 是日报、周报、月报里的分节（几个类别可以共用一节）；`guide` 写这一类收什么、和相邻类别的边界在哪，结构化时给模型看（总的归类原则在 `prompts/structure.md`）；`commentary: true` 标出评论类（教程、观点）：报过的事件再有这类跟进，即使是当事方自己发的，日报也只放进快讯（除非有 4 家以上信源报道）；`feedLabel` 是分类 RSS 标题里的名字（不写就用 `label`）。要让一类在公开接口、RSS 和 MCP 里并进另一类发布（网页上照样分开），写在 `site.ts` 的 `PUBLIC_CATEGORIES`。
- `RELEASE`：这个行业最受关注的那类发布（AI 行业是新模型），类别和标签都对上才算。日报报头的“N 个新模型”按它数（后台改了分类，已出的日报会重算）；`unit` 是数字后面的说法。没有这样一类的行业设成 `null`，报头就不显示这个数。
- `PLAIN_TERMS`：周报月报的总述里可以直接写、不必在条目里找到出处的行业通用词（小写）。站名自动算在内。总述写了条目里没有的名字或数字就不用，见 [精选与校准](selection.md)。
- `CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITY_TAGS`：模型打标签时只能从这里选。第一个标签必须是“分类标签”。`prompts/structure.md` 里还写着 AI 行业的标签规则（比如什么才算“模型发布”），换行业时一起改。
- `TAG_SYNONYMS`：模型常写的近义词，统一成词表里的写法（比如“融资”记成“行业动态”）。换了词表，这里也换成新词表的近义词。
- `ENTITIES`：行业里的主要公司或机构，用于“公司”类主题页。`aliases` 给结构化的模型看；`otherNames` 是公司自己的其他称呼（官方账号名、子品牌），把新闻的主体对到公司、判断标题有没有点名这家公司时也认它们。`IDENTITY_LEXICON`、`PUBLISHER_DOMAINS`、`IDENTITY_CONTEXT_ALIASES` 用来防止模型在标题摘要里写进原文没提到的公司：标题摘要里出现的公司，原文里也要出现过；`IDENTITY_CONTEXT_ALIASES` 列出原文里也算提到这家公司的写法（比如官方账号名）。别的行业没有这个需要可以清空。
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
| `syndicate_fulltext` | 全文 RSS 能不能带正文。**默认关**；只在站内也展示全文时生效，来源明确允许转载时才打开 |

中国大陆的很多行业，一手信息在公众号上。公众号信源需要极致了（Dajiala）的 key，按请求计费，有预算熔断。

## 4. 精选标准：`industry/prompts/`

这是最值得花时间的一步：你对这个行业的判断经验就写在这里。

| 文件 | 作用 |
|---|---|
| `prefilter.md` | 预筛：这条资料是不是这个行业的事。宽召回，只拦明显无关的 |
| `selection-score.md` | **评分标准**：给 0–100 分。里面有内容类型、五个维度、各类型的权重、必须正常评价的价值、必须压住的噪声 |
| `content-understanding.md` | 入选和接近入选内容的写法：中文标题、答案先行的摘要、推荐理由（它也会给标签，但页面上的分类和标签来自 `structure.md`） |
| `rules-domain.md` | 行业术语的翻译与保留规则（示例是 AI 术语：LLM 译作大语言模型、Token 保留英文……） |
| `mend-wording.md` | 改用词：标题、摘要、推荐理由用了 `industry/wording.ts` 里列出的词时，让模型只改这些词 |
| `summarize-*.md` | 其他内容的标题摘要写法 |
| `structure.md` | 分类、标签、主体公司，判断是一条具体新闻还是讲多件事的综合稿，抽出新闻的事实（谁、做了什么、对什么，附原文出处和前提条件）。页面上的分类和标签、主题页、事件归组和日报都靠它 |
| `group-*.md` | 事件归组：两篇报道是同一次发生、同一事件的后续，还是两件事；同时判断报道相对精选里已有的内容有没有新信息，没有的不进精选 |
| `story-digest.md` | 事件页的综述（改之前用 [综述评测](story-digest-evaluation.md) 并排比较） |
| `report-period.md`、`report-period-sections.md` | 周报月报的总述和栏目导读（日报按规则编排，不用提示词） |
| `translate-*.md` | 全文翻译 |

你的站有读者文字里不用的词（夸张的说法、方言词、读者看不懂的行话），写进 `industry/wording.ts`：每项是一个正则和改法。写完标题、摘要和推荐理由后逐个查，用了就让模型只改这些词一次（模型步骤“改用词”，环境变量 `WORDING_MODEL` 可以单独选模型）；改完数字有变、标题摘要变空，或模型服务拒绝改写，就保留原文字。词表空着就不查，也不多调用，模型服务拒绝服务时的告警里也不列这一步。

提示词里用 `{{siteName}}` 指代站名，`{{> 文件名}}` 引用另一份提示词。改提示词不用改代码。

**建议的做法**：先保留结构（五个维度加权、噪声压制规则、安全边界），只把“什么算重要”“什么算噪声”的例子换成你的行业。比如法律行业，“新法规正式公布、重要判决、监管处罚”应该正常评价，“律所营销软文、课程广告”要压住。

## 5. 门槛与校准：`industry/selection.ts`

两次评分之和 ≥ 2 × 门槛才够分（够分的还要过归组时的去重，见 [精选与校准](selection.md)）。默认门槛（T1 60、T1_5 65、T2 76）是 AIHOT 在 AI 领域校准出来的，换了行业和提示词，需要重新校准：

1. 从你的信源里挑 100–200 条资料，自己标“该选 / 不该选”，存成 `.data/gold.jsonl`（格式见 [精选与校准](selection.md)，`industry/gold.example.jsonl` 有两条示例）。
2. 运行 `node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl`，看准确率、查准率、查全率，和不同门槛下的结果。
3. 在后台 SelectBench 里逐条看判错的资料，回去改评分提示词或门槛，再跑一遍。

这一步决定了你的站“选得准不准”。

## 6. 品牌：`site/brand/`

- `logo.svg`、`icon.png`（512）、`icon-192.png`、`apple-icon.png`（180）、`favicon.ico`：站点图标。
- `Logo.tsx`：网页左上角的站名标志，默认用站名文字排出来；有自己的 Logo，把 `Wordmark` 换成你的 SVG，参数保持不变。
- `wordmark.svg`、`wordmark-dark.svg`（可选）：分享图和海报上的字标，深色版用在深色的分享图上；没有就用站名文字。
- `nameplates/`：日报、周报、月报页顶部的报头字（比如“AI日报”）。换了行业词以后重新生成：
  ```bash
  npm pack @fontsource/noto-sans-sc@5.3.0 && tar xzf fontsource-noto-sans-sc-5.3.0.tgz
  node scripts/nameplates.ts package
  ```
- 关于页的二维码：先在 `site.ts` 的 `ABOUT.maker` 写好作者块，并写上 `wechat`、`feishu` 卡片（标题和说明）；再在后台“设置 → 关于页二维码”上传图片，或者把图片放进 `site/brand/contact/`，文件名以 `qr-wechat`、`qr-feishu` 开头，格式是 png、jpg 或 webp。作者块、卡片或图片缺一样，那张二维码就不显示。

请不要使用 AIHOT 的名字和 Logo。

读者可以在“我的”页将字体从“默认字体”改为“浏览器默认字体”。后一项使用读者在浏览器中设置的标准字体，覆盖普通正文、表单和动态图表文字；代码仍用等宽字体，Logo、报头字和分享图片仍按站点品牌显示。字体选择只在当前浏览器保存，不转换简繁体。收藏页的版本 1 备份增加了可选的 `font` 字段，旧备份仍可导入；导入不会覆盖读者已经选择的浏览器字体。

## 7. 页面文案：`site/pages/`、`site/public/`、`site/changelog.json`

- `pages/terms.md`、`pages/privacy.md`：使用规则和隐私说明。**现在是模板**，上线前按你的实际情况改写，必要时请专业人士看一下。
- `public/`：网站根目录上的四个固定文件，替换占位符后发布：`robots.txt`、`manifest.webmanifest`（装到手机桌面时的名字和图标）、`openapi-v1.json`（公开 API 的说明），以及可选的 `.well-known/security.txt`（安全问题的联系方式）。只发布这四个文件，放进去的其他文件不会出现在网站上；没有的文件访问时是 404。文件里可以写这些占位符：`{{siteName}}`、`{{siteUrl}}`、`{{description}}`、`{{tagline}}`、`{{locale}}`，出刊时间 `{{dailyTime}}`、`{{weeklyTime}}`、`{{monthlyTime}}`，公开接口版本 `{{version}}`，逗号分隔的公开分类 `{{categoryList}}`；JSON 文件里 `enum` 或 `examples` 列表中的 `"{{categories}}"` 会换成公开分类的 key 列表。
- `changelog.json`：更新日志。自带一条“网站上线”示例，上线前把它的 `date`、`time` 和 `latestVersion` 改成你的上线时间；示例正文里的框架署名（“用 AIHOT 开源框架搭起了这个站”）同样可留可删。新条目写在最前面，把 `latestVersion` 改成它的日期和时间。`kind` 是“更新”“优化”“公告”“下线”之一；要读者一定看到的加 `"urgent": true`（红色，标“重要”）。

## 8. 模型和部署

- 模型：`.env` 里的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，任何 OpenAI 兼容接口都行，所有步骤默认都用它。`site/models.ts` 列出具名的模型（各用自己的地址和密钥环境变量）和每一步默认用哪个；部署时还可以用环境变量（见 `.env.example`）或后台“模型与评测”页逐步改选。用推理模型（先想再答）时给它留出推理的额度：默认模型设 `LLM_REASONING_TOKENS`，具名模型在 `site/models.ts` 里写 `reasoningTokens`；不留的话推理会把每一步的输出额度用光，答案为空，每次调用都失败。
- 部署：见 [部署](deploy.md)。

## 改完以后检查

```bash
npm run typecheck
DATABASE_URL=postgres://…/myhot_test npm test     # 库名必须以 _test 或 _ci 结尾，数据库账号要能建库
node scripts/smoke.ts --base http://localhost:3000   # 站点跑起来以后
```

改写提示词、重新校准门槛不会让测试失败：测试按每一步实际渲染出的提示词认请求，门槛从 `industry/selection.ts` 读。`tests/` 里有些测试用的是示例行业的分类、标签和公司（比如 `ai-models`、“模型发布”、Anthropic）。改了 `industry/taxonomy.ts` 以后这些测试会失败，把例子换成你行业里的对应项即可，测的规则本身不用改。

然后打开网站看一眼首页、全部动态、日报、主题页和关于页，再去后台“信源”页看信源是不是都抓成功了。
