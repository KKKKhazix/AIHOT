// The engine's ways in, one panel each: what it is for, the steps to connect, then the details folded away.
// Addresses are the site's configured public address (`base`); what visitors copy carries the site's tag
// (CopyTag) when it has one.
import { Fragment, useState } from "react";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { MCP_TOOL_NAMES as T, MCP_TOOLS } from "@aihot/contracts/mcp";
import { feedCategoryLabel, feedCategoryLabelIn, PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { ACCESS, AGENT, EDITION_TIMES, EDITION_WHEN, POLICY, REPORTS, SITE, subjectAfter, withSubject } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { CodeBlock, CopyButton } from "./CodeBlock";
import { PillTabs } from "../../components/ui/Tabs";
import type { AgentPanelProps } from "../../modules";
import { AGENT_PARTS, GUIDE_CLIENTS, TAG } from "./module-parts";
import { Address, Ask, Block, Bullets, Details, Mono, PanelHead, Step, Steps, Table, Tips } from "./parts";
import { Link } from "../../lib/link";
import { feedPath, L, shownIn, useLocale, useT } from "../../lib/i18n";

const V = PUBLIC_INTERFACE_VERSION;

/** Every MCP tool: the engine's and the modules'. */
export const mcpToolCount = () => MCP_TOOLS.length + AGENT_PARTS.reduce((n, a) => n + (a.tools?.length ?? 0), 0);
const link = "text-accent hover:underline";

/** When each report comes out, in English: "daily at 08:00 (GMT+8)". */
const WHEN_EN = ENGLISH?.editionWhen ?? EDITION_WHEN;

/** An address on this site as the copy buttons copy it, with the tag. */
function addressOf({ base, tag }: AgentPanelProps, path: string): string {
  return TAG && tag ? `${base}${path}?${TAG.query}=${tag}` : `${base}${path}`;
}

const MCP_CLIENTS = [
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "json", label: L("JSON 配置", "JSON config") },
  { key: "other", label: L("其他客户端", "Other clients") },
] as const;

export function McpPanel(props: AgentPanelProps) {
  const t = useT();
  const locale = useLocale();
  const tools = shownIn(locale, AGENT_PARTS.flatMap((p) => p.tools ?? []), (tool) => tool.does);
  const url = addressOf(props, "/api/mcp");
  const name = SITE.mcpPrefix;
  const [client, setClient] = useState<string>("claude");
  return (
    <>
      <PanelHead label={`MCP · ${V}`} title={t(`填一个地址，Agent 多出 ${mcpToolCount()} 个工具`, `Add one URL and your agent gets ${mcpToolCount()} new tools`)}>
        {t("标准 Streamable HTTP，匿名只读，不用 token，也不读你的登录状态。适合 Claude 桌面版、Cursor、Cherry Studio 这类支持远程 MCP 的客户端。", `Standard Streamable HTTP, anonymous and read-only: no token needed, and it never accesses your account. Works with clients that support remote MCP, such as Claude Desktop, Cursor and Cherry Studio.${ENGLISH ? ` The news tools answer in English when your agent passes lang "en".` : ""}`)}
      </PanelHead>
      <Steps>
        <Step n={1} title={t("复制服务地址", "Copy the server URL")}>
          <Address url={url} />
          {TAG && <p className="mt-2 text-ui-label text-ink-3">{t(TAG.mcp)}</p>}
        </Step>
        <Step n={2} title={t("加到你的客户端", "Add it to your client")}>
          <PillTabs className="mt-3" size="xs" layoutId="agent-mcp-client" label={t("客户端", "Client")} active={client} onSelect={setClient} items={MCP_CLIENTS.map((c) => ({ key: c.key, label: t(c.label) }))} />
          {client === "claude" && <CodeBlock className="mb-0 mt-3" lang="bash" code={`claude mcp add --transport http ${name} '${url}'`} />}
          {client === "codex" && <CodeBlock className="mb-0 mt-3" lang="bash" code={`codex mcp add ${name} --url '${url}'`} />}
          {client === "json" && <CodeBlock className="mb-0 mt-3" title={t("Cursor、Cherry Studio 等用 JSON 配置的客户端", "Cursor, Cherry Studio and other clients set up with JSON")} lang="json" code={JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2)} />}
          {client === "other" && <p className="mt-3">{t(`在客户端的 MCP 或连接器设置里新建一项：名称填 ${name}，地址填上面的网址，认证选“无”，不要填 API Key。只支持本地命令的客户端，先用它自带的远程 MCP 代理。`, `In your client's MCP or connector settings, add a new entry: name it ${name}, paste the URL above, set authentication to "None", and leave the API key empty. If your client only runs local commands, go through its built-in remote MCP proxy.`)}</p>}
        </Step>
        <Step n={3} title={t("让 Agent 调一次", "Test it with your agent")}>
          <Ask text={t(`请调用 ${T.latest}，告诉我过去 24 小时最重要的${subjectAfter(" 5 条", "资讯")}，并附 ${SITE.name} 链接。`, `Call ${T.latest} with lang "en" and tell me the 5 most important ${SITE.subject} news stories of the past 24 hours, with ${SITE.name} links.`)} />
          <p className="mt-2 text-ui-label text-ink-3">{t(`客户端显示调用了 ${T.latest}，回答里有时间范围、中文摘要和 ${new URL(props.base).host} 链接，就是连上了。`, `If your client shows a call to ${T.latest} and the answer has a time range, summaries and ${new URL(props.base).host} links, you're connected. Without lang "en" the tool answers in Chinese.`)}</p>
        </Step>
      </Steps>

      <Block title={t(`${mcpToolCount()} 个工具`, `${MCP_TOOLS.length + tools.length} tools available in English`)}>
        <Table
          head={[t("工具", "Tool"), t("能做什么", "What it does"), t("可以这样问", "Try asking")]}
          minWidth={600}
          rows={[
            [<Mono>{T.latest}</Mono>, t("过去 24 小时或最近 7 天的精选、全部资讯", "Top picks or all news from the past 24 hours or the last 7 days"), t(`${subjectAfter("今天有什么", "新闻")}？`, `What's new in ${SITE.subject} today?`)],
            [<Mono>{T.search}</Mono>, t(AGENT.search.scope, ENGLISH?.agent.search.scope ?? AGENT.search.scope), t(AGENT.search.ask, ENGLISH?.agent.search.ask ?? AGENT.search.ask)],
            [<Mono>{T.hot}</Mono>, t("当前热点榜 Top 10", "The top 10 trending stories right now"), t("现在最热的是什么？", "What's trending right now?")],
            [<Mono>{T.story}</Mono>, t("一个热点事件的时间线和持续更新的综述", "A trending story's timeline and continuously updated AI summary"), t("这件事的来龙去脉？", "How did this story unfold?")],
            [<Mono>{T.daily}</Mono>, t(subjectAfter("最新或指定日期的", "日报"), `The latest ${SITE.subject} Daily, or the one for a given date`), t("给我今天的日报。", `Give me today's ${SITE.subject} Daily.`)],
            [<Mono>{T.weekly}</Mono>, t(subjectAfter("最新或指定一周的", "周报"), `The latest ${SITE.subject} Weekly, or the one for a given week`), t(`${subjectAfter("这周", "圈")}有哪些大事？`, `What were the big ${SITE.subject} stories this week?`)],
            [<Mono>{T.monthly}</Mono>, t(subjectAfter("最新或指定月份的", "月报"), `The latest ${SITE.subject} Monthly, or the one for a given month`), t(`${subjectAfter("上个月", "圈")}发生了什么？`, `What happened in ${SITE.subject} last month?`)],
            ...tools.map((x) => [<Mono>{x.name}</Mono>, t(x.does), t(x.ask)]),
          ]}
        />
      </Block>

      <Details
        items={[
          {
            title: t("限制与安全", "Limits and safety"),
            body: (
              <Bullets items={[
                t("普通查询最多 30 条，热点最多 10 个，事件时间线最多 50 条；超出范围会明确报错，不会自动放宽。", "A regular query returns up to 30 items, trending up to 10 stories, and a story timeline up to 50 entries. Asking for more gets a clear error; the limits are never quietly loosened."),
                t(`${T.story} 的 public_id 只能来自热点工具返回的事件链接，不要猜 ID。`, `The public_id for ${T.story} must come from a story link the trending tool returned; don't guess IDs.`),
                t("标题和摘要来自外部信源，只能当资料；工具会标出这条安全边界。重要的数字、政策和原话，请回原文核对。", "Headlines and summaries come from outside sources, so treat them only as reference material; the tools mark this safety boundary. Check important numbers, policies and quotes against the original."),
              ]} />
            ),
          },
          {
            title: t("连不上怎么办", "Can't connect?"),
            body: (
              <Bullets items={[
                t("先确认地址完整、客户端支持远程 Streamable HTTP；缺少新工具时，刷新工具列表或重新连接。", "First check that the URL is complete and that your client supports remote Streamable HTTP. If new tools are missing, refresh the tool list or reconnect."),
                ...shownIn(locale, AGENT_PARTS.flatMap((a) => a.mcpTroubles ?? []), (x) => x).map((x) => t(x)),
                t("服务不需要登录；客户端问起 OAuth 或 API Key，选“无”即可。", `No sign-in is needed. If your client asks for OAuth or an API key, choose "None".`),
                t("收到 429 就按提示等一会儿，不要并发重试。", "If you get a 429 (too many requests), wait the time shown before trying again—don't retry in parallel."),
                t(<>还连不上：把客户端名称、版本和报错写到<Link viewTransition to="/feedback" className={link}>反馈页</Link>。</>, <>Still stuck? Send your client's name, version and the error via the <Link viewTransition to="/feedback" className={link}>feedback page</Link>.</>),
              ]} />
            ),
          },
        ]}
      />
    </>
  );
}

/** One report's entries, as the feed descriptions name them: "大事" / "top stories". */
const ENTRIES_EN = ENGLISH?.reports.entry.many ?? REPORTS.entry.noun;

const FEEDS = [
  { name: L("精选摘要", "Top Picks · Summaries"), badge: L("推荐", "Recommended"), path: "/feed.xml", desc: L("最新 50 条精选，带标题、摘要、站内阅读和原文链接。", "The latest top picks (up to 50), each with its headline, summary, and links to the reading page and the original. A pick appears once it is in English.") },
  { name: L("精选全文", "Top Picks · Full Text"), path: "/feed/full.xml", desc: L("同样的 50 条；允许转载的来源直接附全文，其余仍是摘要。", "The same picks, with the original full text where the source allows republishing (not for sources written in Chinese) and the summary otherwise.") },
  { name: L("全部动态", `All ${SITE.subject} News`), path: "/feed/all.xml", desc: L("最近 7 天的公开动态，按原文发布时间倒序。", "Everything public from the last 7 days, newest first by original publish time, once it is in English.") },
  { name: L(withSubject("日报"), `${SITE.subject} Daily`), path: "/feed/daily.xml", desc: L(`${EDITION_WHEN.daily}（北京时间）一期：头条导语加整期目录，保留最近 30 期。`, `New issue ${WHEN_EN.daily}: the lead story's intro plus the full table of contents. Keeps the last 30 issues.`) },
  { name: L(withSubject("周报"), `${SITE.subject} Weekly`), path: "/feed/weekly.xml", desc: L(`${EDITION_WHEN.weekly}（北京时间）一期：总述加按栏目分好的${REPORTS.entry.noun}，保留最近 12 期。`, `New issue ${WHEN_EN.weekly}: an overview plus the ${ENTRIES_EN} grouped by section. Keeps the last 12 issues.`) },
  { name: L(withSubject("月报"), `${SITE.subject} Monthly`), path: "/feed/monthly.xml", desc: L(`${EDITION_WHEN.monthly}（北京时间）一期：总述加按栏目分好的${REPORTS.entry.noun}，保留最近 12 期。`, `New issue ${WHEN_EN.monthly}: an overview plus the ${ENTRIES_EN} grouped by section. Keeps the last 12 issues.`) },
];

/** The category feeds, under the names the feeds themselves use. */
const FEED_CATEGORIES = PUBLIC_API_CATEGORY_KEYS.map((key) => [key, L(feedCategoryLabel(key), feedCategoryLabelIn(key, "en"))] as const);

export function RssPanel(props: AgentPanelProps) {
  const t = useT();
  const locale = useLocale();
  const { base } = props;
  const lead = `${[t("兼容主流 RSS 2.0 阅读器，也能接 n8n、Zapier 这类自动化工具。地址长期不变", "Works with any mainstream RSS 2.0 reader, and with automation tools like n8n and Zapier. The feed URLs won't change"), ...shownIn(locale, AGENT_PARTS.flatMap((a) => a.rssLead ?? []), (x) => x).map((x) => t(x))].join(t("；", "; "))}${t("。", ".")}`;
  return (
    <>
      <PanelHead label="RSS" title={t("复制地址，用阅读器订阅", "Copy a feed URL into your reader")}>
        {lead}
      </PanelHead>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FEEDS.map((f) => ({ ...f, path: feedPath(f.path, locale) })).map((f) => (
          <div key={f.path} className="card flex flex-col p-4">
            <div className="flex items-center gap-2">
              <span className="text-ui-body font-semibold text-ink">{t(f.name)}</span>
              {f.badge && <span className="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-2 text-ui-caption-sm font-medium text-accent">{t(f.badge)}</span>}
            </div>
            <p className="mt-1 flex-1 text-ui-label leading-[1.7] text-ink-3">{t(f.desc)}</p>
            <div className="mt-3 flex items-center gap-2 border-t border-line-soft pt-3">
              <code className="mono min-w-0 flex-1 truncate text-ui-caption text-ink-4">{base}{f.path}</code>
              <CopyButton text={addressOf(props, f.path)} label={t("复制地址", "Copy feed URL")} className="shrink-0" />
            </div>
          </div>
        ))}
      </div>
      {TAG && <p className="mt-3 text-ui-caption-lg text-ink-4">{t(TAG.rss)}</p>}

      <Block title={t("按分类订阅", "Subscribe by category")}>
        <Table
          head={[t("分类", "Category"), t("摘要", "Summary"), t("全文", "Full text")]}
          minWidth={420}
          rows={FEED_CATEGORIES.map(([slug, label]) => [
            <span className="font-medium text-ink">{t(label)}</span>,
            ...[`/feed/category/${slug}.xml`, `/feed/full/category/${slug}.xml`].map((path) => feedPath(path, locale)).map((path) => (
              <span className="inline-flex items-center gap-2"><Mono>{path}</Mono><CopyButton text={addressOf(props, path)} className="!h-6 !px-1.5" /></span>
            )),
          ])}
        />
      </Block>

      <Block title={t("刷新多快合适", "How often to refresh")}>
        <p>{t("阅读器会带着上次的 ETag 来问，内容没变时只回一个很小的 304，不重复下载。30 分钟刷新一次就够，更快也拿不到新的内容。", "Your reader sends the ETag from its last check; if nothing has changed, it gets a tiny 304 response and skips downloading again. Refreshing every 30 minutes is plenty—faster checks won't bring newer items.")}</p>
        <p className="mt-3 text-ui-label text-ink-3">{t(`条目链接指向站内阅读页，原文链接在摘要里。能匿名订阅不等于所有用途都获许可${POLICY.terms.notes ? `：${POLICY.terms.notes.rss}` : ""}，见`, `Item links open the reading page on this site; the link to the original is in the summary. Subscribing anonymously doesn't mean every use is allowed${ENGLISH?.termsNotes ? `: ${ENGLISH.termsNotes.rss}` : ""}. See `)}<Link viewTransition to="/terms" className={link}>{t(POLICY.terms.name, ENGLISH?.policyLinks.terms ?? POLICY.terms.name)}</Link>{t("。", ".")}</p>
      </Block>
    </>
  );
}

const RECIPES = [
  { key: "latest", label: L("盯最新资讯", "Watch the latest news") },
  { key: "sync", label: L("同步全部精选", "Sync all top picks") },
];

export function ApiPanel(props: AgentPanelProps) {
  const t = useT();
  const locale = useLocale();
  const { base, tag } = props;
  const userAgent = [ACCESS.userAgent, TAG && tag ? TAG.userAgent(tag) : null].filter(Boolean).join(" ");
  const curl = `curl --compressed${userAgent ? ` -A '${userAgent}'` : ""}`;
  let pace = t(`内容多久变一次：新资讯全天陆续进来，精选每天变几次到几十次，日报${EDITION_WHEN.daily}、周报${EDITION_WHEN.weekly}、月报${EDITION_WHEN.monthly}（北京时间）各一期。`, `How often things change: new stories come in all day, top picks change from a few to dozens of times a day, and the Daily comes out ${WHEN_EN.daily}, the Weekly ${WHEN_EN.weekly} and the Monthly ${WHEN_EN.monthly}.`);
  if (ACCESS.ratePerMinute) pace += t(`同一个 IP 每分钟超过约 ${ACCESS.ratePerMinute} 次会收到 429，请按 Retry-After 等待，不要并发重试。`, ` More than about ${ACCESS.ratePerMinute} requests a minute from one IP get a 429: wait as Retry-After says, and don't retry in parallel.`);
  const [recipe, setRecipe] = useState<string>("latest");
  const recipes = shownIn(locale, AGENT_PARTS.flatMap((a) => a.recipes ?? []), (r) => r.label);
  // English pages show the English answer: lang=en on any reader's address.
  const items = `${base}/api/v1/items?mode=selected&window=24h&limit=20${locale === "en" && ENGLISH ? "&lang=en" : ""}`;
  return (
    <>
      <PanelHead label={`REST API · ${V}`} title={t("匿名 GET，拿来就能用", "Anonymous GET, ready to use")}>
        {t(<>不用 token；浏览器跨域、curl 和各语言默认的 HTTP 客户端都能直接调。路径是 /api/v1，字段和错误码以 <a href="/openapi-v1.json" className={link}>OpenAPI</a> 为准。</>, <>No token needed: call it straight from a browser (cross-origin works), curl or any language's standard HTTP client. The path is /api/v1, and the <a href="/openapi-v1.json" className={link}>OpenAPI</a> definition is the reference for fields and error codes.{ENGLISH ? " Add lang=en for titles, summaries and page links in English." : ""}</>)}
      </PanelHead>
      <CodeBlock className="mt-6" title={t("第一个请求", "Your first request")} lang="bash" code={`${curl} '${items}'`} />

      <Block title={t("按分类筛选", "Filter by category")}>
        <p>{t(<>在资讯请求中加上 <Mono>category</Mono>，只取对应分类；不传则包含全部分类。返回条目的 <Mono>category</Mono> 也使用下表中的值。</>, <>Add <Mono>category</Mono> to a news request to get only that category; leave it out to get all of them. The <Mono>category</Mono> of returned items uses the values below too.</>)}</p>
        <Table head={[t("分类", "Category"), t("请求参数", "Parameter")]} rows={FEED_CATEGORIES.map(([key, name]) => [t(name), <Mono>{`category=${key}`}</Mono>])} />
      </Block>

      <Block title={t("用得省，也更快", "Lighter and faster")}>
        <Tips
          items={[
            { title: t("开压缩", "Turn on compression"), text: t(<>curl 加 <Mono>--compressed</Mono>，其他客户端打开 gzip 或 br。JSON 压缩后只有原来的 1/4 到 1/8。</>, <>Add <Mono>--compressed</Mono> to curl, or turn on gzip or br in other clients. Compressed JSON is 1/4 to 1/8 of its original size.</>) },
            { title: t("带上 ETag", "Send the ETag"), text: t(<>保存响应里的 ETag，下次带 <Mono>If-None-Match</Mono>；内容没变时返回 304，不传正文。</>, <>Save the ETag from the response and send it back as <Mono>If-None-Match</Mono>; if nothing has changed, you get a 304 with no body.</>) },
            { title: t("按节奏取", "Fetch at the right pace"), text: t(`资讯和热点最快一分钟一次；日报${EDITION_WHEN.daily} 后取一次，周报、月报出刊后取一次；往回翻页翻到已有的那条就停。`, `News and trending at most once a minute; the Daily once a day after ${EDITION_TIMES.daily} (GMT+8), the Weekly and Monthly once after each new issue; when paging back, stop at the first item you already have.`) },
          ]}
        />
        <p className="mt-3 text-ui-label leading-[1.75] text-ink-3">{pace}</p>
      </Block>

      <Block title={t("接口一览", "All endpoints")}>
        <Table
          head={[t("路径", "Path"), t("用来做什么", "What it's for"), t("多久取一次", "How often to fetch")]}
          minWidth={640}
          rows={[
            { group: t("资讯", "News") },
            [<Mono>/api/v1/items</Mono>, t("精选或最近 7 天全部动态，可按分类、时间窗、关键词筛", "Top picks, or all news from the last 7 days; filter by category, time window or keyword"), t("最快 1 分钟一次", "At most once a minute")],
            { group: t("热点与事件", "Trending and stories") },
            [<Mono>/api/v1/hot-topics</Mono>, t("当前热点榜 Top 10", "The top 10 trending stories right now"), t("最快 1 分钟一次", "At most once a minute")],
            [<Mono>{"/api/v1/stories/{publicId}"}</Mono>, t("一个事件的报道时间线、AI 综述和关联事件", "A story's coverage timeline, AI summary and related stories"), t("需要时", "When needed")],
            { group: t("日报", "Daily") },
            [<Mono>/api/v1/dailies/latest</Mono>, t("最新一期日报", "The latest Daily"), t(`${EDITION_WHEN.daily} 后一次`, `Once a day, after ${EDITION_TIMES.daily} (GMT+8)`)],
            [<Mono>{"/api/v1/dailies/{date}"}</Mono>, t("指定日期日报；撤稿会移除引用", "The Daily for a given date; retracted stories are removed from it"), t("缓存过期后须带 ETag 验证更新", "Once the cache expires, check for updates with the ETag")],
            [<Mono>/api/v1/dailies</Mono>, t("日报日期索引", "Index of Daily dates"), t("每天一次", "Once a day")],
            { group: t("周报与月报", "Weekly and Monthly") },
            [<Mono>/api/v1/weeklies/latest</Mono>, t("最新一期周报：头条、总述和一周重点，按栏目分好", "The latest Weekly: the lead story, an overview and the week's key stories, grouped by section"), t(`${EDITION_WHEN.weekly} 后一次`, `Once a week, after ${EDITION_TIMES.weekly} on Mondays (GMT+8)`)],
            [<Mono>{"/api/v1/weeklies/{week}"}</Mono>, t("指定一周，ISO 周如 2026-W39；撤稿会移除引用", "A given week, as an ISO week like 2026-W39; retracted stories are removed from it"), t("缓存过期后须带 ETag 验证更新", "Once the cache expires, check for updates with the ETag")],
            [<Mono>/api/v1/weeklies</Mono>, t("周报索引", "Index of Weekly issues"), t("每周一次", "Once a week")],
            [<Mono>/api/v1/monthlies/latest</Mono>, t("最新一期月报", "The latest Monthly"), t(`${EDITION_WHEN.monthly} 后一次`, `Once a month, after ${EDITION_TIMES.monthly} on the 1st (GMT+8)`)],
            [<Mono>{"/api/v1/monthlies/{month}"}</Mono>, t("指定月份，如 2026-09", "A given month, like 2026-09"), t("缓存过期后须带 ETag 验证更新", "Once the cache expires, check for updates with the ETag")],
            [<Mono>/api/v1/monthlies</Mono>, t("月报索引", "Index of Monthly issues"), t("每月一次", "Once a month")],
            ...shownIn(locale, AGENT_PARTS.flatMap((a) => (a.api ? [a.api] : [])), (api) => api.group)
              .flatMap((api) => [{ group: t(api.group) }, ...api.rows.map(([path, does, often]) => [<Mono>{path}</Mono>, t(does), t(often)])]),
            { group: t("给 AI 助手", "For AI assistants") },
            [<Mono>/api/v1/agent</Mono>, t(`给 Agent 的使用说明，列出的地址返回整理好的中文 Markdown${GUIDE_CLIENTS ? `；${GUIDE_CLIENTS.zh} 用的就是它们` : ""}`, `Instructions for agents; the URLs it lists return clean Markdown, in English with lang=en${GUIDE_CLIENTS ? `, and they power ${GUIDE_CLIENTS.en}` : ""}`), t("需要时", "When needed")],
            { group: t("完整精选同步", "Full top picks sync") },
            [<Mono>/api/v1/selected/snapshot</Mono>, t("当前全部精选，分页一次拿全", "All current top picks, paginated so you can fetch the full set"), t("只在第一次", "Only the first time")],
            [<Mono>/api/v1/selected/changes</Mono>, t("之后的新增、修改和撤选", "What's been added, changed or dropped from top picks since"), t("几分钟一次", "Every few minutes")],
          ]}
        />
      </Block>

      <Block title={t("常见用法", "Common recipes")}>
        <PillTabs size="xs" layoutId="agent-api-recipe" label={t("用法", "Recipe")} active={recipe} onSelect={setRecipe} items={[...RECIPES, ...recipes].map((r) => ({ key: r.key, label: t(r.label) }))} />
        {recipe === "latest" && (
          <>
            <CodeBlock className="mb-3 mt-3" lang="bash" code={t(`# 第一次：保存响应头里的 ETag\n${curl} -i '${items}'\n# 之后最快每分钟一次，带上 ETag；返回 304 就是没变化\n${curl} -i -H 'If-None-Match: <上次的 ETag>' '${items}'`, `# First time: save the ETag from the response headers\n${curl} -i '${items}'\n# After that, at most once a minute, with the ETag; a 304 means nothing changed\n${curl} -i -H 'If-None-Match: <last ETag>' '${items}'`)} />
            <p>{t(<>需要往回翻页时，把 <Mono>page.nextCursor</Mono> 作为 cursor 传回去，翻到已经有的那条就停，不要每次把 7 天重翻一遍。</>, <>To page back, pass <Mono>page.nextCursor</Mono> back as cursor and stop at the first item you already have. Don't page through all 7 days every time.</>)}</p>
          </>
        )}
        {recipe === "sync" && (
          <>
            <CodeBlock className="mb-3 mt-3" lang="bash" code={t(`# 第一次：分页拿全。保存第一页响应里的 cursor（每页都一样）\n${curl} '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# hasMore 为 true 就带上 nextPage 继续翻，直到翻完\n${curl} '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<上一页的 nextPage>'\n# 之后：原样传回 cursor，只拿新增、修改和撤选\n${curl} '${base}/api/v1/selected/changes?cursor=<第一页的 cursor>&limit=100'`, `# First time: page through everything. Save the cursor from the first page's response (it's the same on every page)\n${curl} '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# While hasMore is true, keep paging with nextPage until you reach the end\n${curl} '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<nextPage from the previous page>'\n# After that: send the cursor back as it is to get only what's been added, changed or dropped\n${curl} '${base}/api/v1/selected/changes?cursor=<cursor from the first page>&limit=100'`)} />
            <p>{t(<>每页成功写进本地后再保存新的 cursor。cursor 是同步位置，不会自动过期；若返回 409 <Mono>snapshot_required</Mono>，说明增量无法续接，请重新拉取一次完整快照。</>, <>Save the new cursor only after each page is safely stored on your side. The cursor marks where your sync is and never expires on its own. If you get a 409 <Mono>snapshot_required</Mono>, incremental sync can't resume from there: fetch a full snapshot again.</>)}</p>
          </>
        )}
        {recipes.map((r) => recipe === r.key && <r.Body key={r.key} base={base} curl={curl} />)}
      </Block>

      <Block title={t("出错了怎么办", "When something goes wrong")} id="agent-api-recovery">
        <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <dt className="mono text-ui-label text-ink">400</dt>
          <dd>{t("参数不对：按 OpenAPI 和返回的 code 修正，不要自动换成更宽的查询。cursor 无效或滑出时间窗返回 invalid_cursor，从第一页重来。", "Bad parameters: fix them using the OpenAPI definition and the returned code, and don't automatically switch to a broader query. An invalid or expired cursor (outside the time window) returns invalid_cursor—start again from the first page.")}</dd>
          <dt className="mono text-ui-label text-ink">409</dt>
          <dd>{t("snapshot_required：增量没法安全续上，重新取一次完整快照。", "snapshot_required: incremental sync can't safely continue from here. Fetch a full snapshot again.")}</dd>
          <dt className="mono text-ui-label text-ink">429</dt>
          <dd>{t("请求太密：按 Retry-After 等待，不要并发重试。", "Too many requests: wait as Retry-After says, and don't retry in parallel.")}</dd>
          <dt className="mono text-ui-label text-ink">5xx</dt>
          <dd>{t("指数退避，先用上次成功的结果；公开服务不承诺 SLA。", "Back off exponentially and use your last good result in the meantime; the public service comes with no SLA.")}</dd>
          {shownIn(locale, AGENT_PARTS.flatMap((a) => a.apiErrors ?? []), ([status]) => status).map(([status, what]) => (
            <Fragment key={t(status)}>
              <dt className="mono text-ui-label text-ink">{t(status)}</dt>
              <dd>{what}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="mt-4 text-ui-label text-ink-3">{t(`能匿名调用不等于所有用途都获许可${POLICY.terms.notes ? `：${POLICY.terms.notes.api}` : ""}，见`, `Calling it anonymously doesn't mean every use is allowed${ENGLISH?.termsNotes ? `: ${ENGLISH.termsNotes.api}` : ""}. See `)}<Link viewTransition to="/terms" className={link}>{t(POLICY.terms.name, ENGLISH?.policyLinks.terms ?? POLICY.terms.name)}</Link>{t("。", ".")}</p>
      </Block>

    </>
  );
}
