// The ways in, one panel each: what it is for, the steps to connect, then the details folded away.
// Addresses are the site's configured public address (`base`).
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { MCP_TOOL_NAMES as T, MCP_TOOLS } from "@aihot/contracts/mcp";
import { PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { AGENT, POLICY, SITE, subjectAfter, withSubject } from "@aihot/industry/site";
import { CodeBlock, CopyButton } from "../../components/CodeBlock";
import { PillTabs } from "../../components/ui/Tabs";
import { Address, Ask, Block, Bullets, Details, Mono, PanelHead, Step, Steps, Table, Tips } from "./parts";

const V = PUBLIC_INTERFACE_VERSION;
const link = "text-accent hover:underline";

/** What the agent page gives every panel. */
interface PanelProps {
  /** The site's public address, read on the server so the page and the browser agree. */
  base: string;
}

/** An address on this site as the copy buttons copy it. */
function addressOf(props: PanelProps, path: string): string {
  return `${props.base}${path}`;
}

const MCP_CLIENTS = [
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "json", label: "JSON 配置" },
  { key: "other", label: "其他客户端" },
] as const;

export function McpPanel(props: PanelProps) {
  const url = addressOf(props, "/api/mcp");
  const name = SITE.mcpPrefix;
  const [client, setClient] = useState<string>("claude");
  return (
    <>
      <PanelHead label={`MCP · ${V}`} title={`填一个地址，Agent 多出 ${MCP_TOOLS.length} 个工具`}>
        标准 Streamable HTTP，匿名只读，不用 token，也不读你的登录状态。适合 Claude 桌面版、Cursor、Cherry Studio 这类支持远程 MCP 的客户端。
      </PanelHead>
      <Steps>
        <Step n={1} title="复制服务地址">
          <Address url={url} />
        </Step>
        <Step n={2} title="加到你的客户端">
          <PillTabs className="mt-3" size="xs" layoutId="agent-mcp-client" label="客户端" active={client} onSelect={setClient} items={MCP_CLIENTS.map((c) => ({ key: c.key, label: c.label }))} />
          {client === "claude" && <CodeBlock className="mb-0 mt-3" lang="bash" code={`claude mcp add --transport http ${name} '${url}'`} />}
          {client === "codex" && <CodeBlock className="mb-0 mt-3" lang="bash" code={`codex mcp add ${name} --url '${url}'`} />}
          {client === "json" && <CodeBlock className="mb-0 mt-3" title="Cursor、Cherry Studio 等用 JSON 配置的客户端" lang="json" code={JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2)} />}
          {client === "other" && <p className="mt-3">{`在客户端的 MCP 或连接器设置里新建一项：名称填 ${name}，地址填上面的网址，认证选“无”，不要填 API Key。只支持本地命令的客户端，先用它自带的远程 MCP 代理。`}</p>}
        </Step>
        <Step n={3} title="让 Agent 调一次">
          <Ask text={`请调用 ${T.latest}，告诉我过去 24 小时最重要的${subjectAfter(" 5 条", "资讯")}，并附 ${SITE.name} 链接。`} />
          <p className="mt-2 text-[13px] text-ink-3">{`客户端显示调用了 ${T.latest}，回答里有时间范围、中文摘要和 ${new URL(props.base).host} 链接，就是连上了。`}</p>
        </Step>
      </Steps>

      <Block title={`${MCP_TOOLS.length} 个工具`}>
        <Table
          head={["工具", "能做什么", "可以这样问"]}
          minWidth={600}
          rows={[
            [<Mono>{T.latest}</Mono>, "过去 24 小时或最近 7 天的精选、全部资讯", `${subjectAfter("今天有什么", "新闻")}？`],
            [<Mono>{T.search}</Mono>, AGENT.search.scope, AGENT.search.ask],
            [<Mono>{T.hot}</Mono>, "当前热点榜 Top 10", "现在最热的是什么？"],
            [<Mono>{T.story}</Mono>, "一个热点事件的时间线和持续更新的综述", "这件事的来龙去脉？"],
            [<Mono>{T.daily}</Mono>, subjectAfter("最新或指定日期的", "日报"), "给我今天的日报。"],
            [<Mono>{T.weekly}</Mono>, subjectAfter("最新或指定一周的", "周报"), `${subjectAfter("这周", "圈")}有哪些大事？`],
            [<Mono>{T.monthly}</Mono>, subjectAfter("最新或指定月份的", "月报"), `${subjectAfter("9 月", "圈")}发生了什么？`],
          ]}
        />
      </Block>

      <Details
        items={[
          {
            title: "限制与安全",
            body: (
              <Bullets items={[
                "普通查询最多 30 条，热点最多 10 个，事件时间线最多 50 条；超出范围会明确报错，不会悄悄放宽。",
                `${T.story} 的 public_id 只能来自热点工具返回的事件链接，不要猜 ID。`,
                "标题和摘要来自外部信源，只能当资料；工具会标出这条安全边界。重要的数字、政策和原话，请回原文核对。",
              ]} />
            ),
          },
          {
            title: "连不上怎么办",
            body: (
              <Bullets items={[
                "先确认地址完整、客户端支持远程 Streamable HTTP；缺少新工具时，刷新工具列表或重新连接。",
                "服务不需要登录；客户端问起 OAuth 或 API Key，选“无”即可。",
                "收到 429 就按提示等一会儿，不要并发重试。",
                <>还连不上：把客户端名称、版本和报错写到<Link viewTransition to="/feedback" className={link}>反馈页</Link>。</>,
              ]} />
            ),
          },
        ]}
      />
    </>
  );
}

const FEEDS = [
  { name: "精选摘要", badge: "推荐", path: "/feed.xml", desc: "最新 50 条精选，带标题、摘要、站内阅读和原文链接。" },
  { name: "精选全文", path: "/feed/full.xml", desc: "同样的 50 条；允许转载的来源直接附全文，其余仍是摘要。" },
  { name: "全部动态", path: "/feed/all.xml", desc: "最近 7 天的公开动态，按原文发布时间倒序。" },
  { name: withSubject("日报"), path: "/feed/daily.xml", desc: "每天 08:00（北京时间）一期：头条导语加整期目录，保留最近 30 期。" },
  { name: withSubject("周报"), path: "/feed/weekly.xml", desc: "每周一 10:00（北京时间）一期：总述加按栏目分好的大事，保留最近 12 期。" },
  { name: withSubject("月报"), path: "/feed/monthly.xml", desc: "每月 1 日 10:30（北京时间）一期：总述加按栏目分好的大事，保留最近 12 期。" },
];

/** The category feeds, under the names the feeds themselves use. */
const FEED_CATEGORIES = PUBLIC_API_CATEGORY_KEYS.map((key) => {
  const c: { label: string; feedLabel?: string } = CATEGORIES.find((x) => x.key === key)!;
  return [key, c.feedLabel ?? c.label] as const;
});

export function RssPanel(props: PanelProps) {
  const { base } = props;
  const stable = "兼容主流 RSS 2.0 阅读器，也能接 n8n、Zapier 这类自动化工具。地址长期不变";
  let lead: ReactNode = `${stable}。`;
  return (
    <>
      <PanelHead label="RSS" title="复制地址，用阅读器订阅">
        {lead}
      </PanelHead>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FEEDS.map((f) => (
          <div key={f.path} className="card flex flex-col p-4">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-ink">{f.name}</span>
              {f.badge && <span className="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-2 text-[11px] font-medium text-accent">{f.badge}</span>}
            </div>
            <p className="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">{f.desc}</p>
            <div className="mt-3 flex items-center gap-2 border-t border-line-soft pt-3">
              <code className="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">{base}{f.path}</code>
              <CopyButton text={addressOf(props, f.path)} label="复制地址" className="shrink-0" />
            </div>
          </div>
        ))}
      </div>

      <Block title="按分类订阅">
        <Table
          head={["分类", "摘要", "全文"]}
          minWidth={420}
          rows={FEED_CATEGORIES.map(([slug, label]) => [
            <span className="font-medium text-ink">{label}</span>,
            <span className="inline-flex items-center gap-2"><Mono>{`/feed/category/${slug}.xml`}</Mono><CopyButton text={addressOf(props, `/feed/category/${slug}.xml`)} className="!h-6 !px-1.5" /></span>,
            <span className="inline-flex items-center gap-2"><Mono>{`/feed/full/category/${slug}.xml`}</Mono><CopyButton text={addressOf(props, `/feed/full/category/${slug}.xml`)} className="!h-6 !px-1.5" /></span>,
          ])}
        />
      </Block>

      <Block title="刷新多快合适">
        <p>阅读器会带着上次的 ETag 来问，内容没变时只回一个很小的 304，不重复下载。30 分钟刷新一次就够，更快也拿不到新的内容。</p>
        <p className="mt-3 text-[13px] text-ink-3">{`条目链接指向站内阅读页，原文链接在摘要里。能匿名订阅不等于所有用途都获许可${POLICY.terms.notes ? `：${POLICY.terms.notes.rss}` : ""}，见`}<Link viewTransition to="/terms" className={link}>{POLICY.terms.name}</Link>。</p>
      </Block>
    </>
  );
}

const RECIPES = [
  { key: "latest", label: "盯最新资讯" },
  { key: "sync", label: "同步全部精选" },
] as const;

export function ApiPanel(props: PanelProps) {
  const { base } = props;
  let curl = "curl --compressed";
  let pace = "内容多久变一次：新资讯全天陆续进来，精选每天变几次到几十次，日报每天 08:00、周报每周一 10:00、月报每月 1 日 10:30（北京时间）各一期。";
  const [recipe, setRecipe] = useState<string>("latest");
  const items = `${base}/api/v1/items?mode=selected&window=24h&limit=20`;
  return (
    <>
      <PanelHead label={`REST API · ${V}`} title="匿名 GET，拿来就能用">
        不用 token；浏览器跨域、curl 和各语言默认的 HTTP 客户端都能直接调。路径是 /api/v1，字段和错误码以 <a href="/openapi-v1.json" className={link}>OpenAPI</a> 为准。
      </PanelHead>
      <CodeBlock className="mt-6" title="第一个请求" lang="bash" code={`${curl} '${items}'`} />

      <Block title="用得省，也更快">
        <Tips
          items={[
            { title: "开压缩", text: <>curl 加 <Mono>--compressed</Mono>，其他客户端打开 gzip 或 br。JSON 压缩后只有原来的 1/4 到 1/8。</> },
            { title: "带上 ETag", text: <>保存响应里的 ETag，下次带 <Mono>If-None-Match</Mono>；内容没变时返回 304，不传正文。</> },
            { title: "按节奏取", text: "资讯和热点最快一分钟一次；日报每天 08:00 后取一次，周报、月报出刊后取一次；往回翻页翻到已有的那条就停。" },
          ]}
        />
        <p className="mt-3 text-[13px] leading-[1.75] text-ink-3">{pace}</p>
      </Block>

      <Block title="接口一览">
        <Table
          head={["路径", "用来做什么", "多久取一次"]}
          minWidth={640}
          rows={[
            { group: "资讯" },
            [<Mono>/api/v1/items</Mono>, "精选或最近 7 天全部动态，可按分类、时间窗、关键词筛", "最快 1 分钟一次"],
            { group: "热点与事件" },
            [<Mono>/api/v1/hot-topics</Mono>, "当前热点榜 Top 10", "最快 1 分钟一次"],
            [<Mono>{"/api/v1/stories/{publicId}"}</Mono>, "一个事件的报道时间线、AI 综述和关联事件", "需要时"],
            { group: "日报" },
            [<Mono>/api/v1/dailies/latest</Mono>, "最新一期日报", "每天 08:00 后一次"],
            [<Mono>{"/api/v1/dailies/{date}"}</Mono>, "指定日期日报；撤稿会移除引用", "缓存过期后使用前验证 ETag"],
            [<Mono>/api/v1/dailies</Mono>, "日报日期索引", "每天一次"],
            { group: "周报与月报" },
            [<Mono>/api/v1/weeklies/latest</Mono>, "最新一期周报：头条、总述和一周重点，按栏目分好", "每周一 10:00 后一次"],
            [<Mono>{"/api/v1/weeklies/{week}"}</Mono>, "指定一周，ISO 周如 2026-W39；撤稿会移除引用", "缓存过期后使用前验证 ETag"],
            [<Mono>/api/v1/weeklies</Mono>, "周报索引", "每周一次"],
            [<Mono>/api/v1/monthlies/latest</Mono>, "最新一期月报", "每月 1 日 10:30 后一次"],
            [<Mono>{"/api/v1/monthlies/{month}"}</Mono>, "指定月份，如 2026-09", "缓存过期后使用前验证 ETag"],
            [<Mono>/api/v1/monthlies</Mono>, "月报索引", "每月一次"],
            { group: "给 AI 助手" },
            [<Mono>/api/v1/agent</Mono>, [
              "给 Agent 的使用说明，列出的地址返回整理好的中文 Markdown",
            ].join("；"), "需要时"],
            { group: "完整精选同步" },
            [<Mono>/api/v1/selected/snapshot</Mono>, "当前全部精选，分页一次拿全", "只在第一次"],
            [<Mono>/api/v1/selected/changes</Mono>, "之后的新增、修改和撤选", "几分钟一次"],
          ]}
        />
      </Block>

      <Block title="常见用法">
        <PillTabs size="xs" layoutId="agent-api-recipe" label="用法" active={recipe} onSelect={setRecipe} items={RECIPES.map((r) => ({ key: r.key, label: r.label }))} />
        {recipe === "latest" && (
          <>
            <CodeBlock className="mb-3 mt-3" lang="bash" code={`# 第一次：保存响应头里的 ETag\n${curl} -i '${items}'\n# 之后最快每分钟一次，带上 ETag；返回 304 就是没变化\n${curl} -i -H 'If-None-Match: <上次的 ETag>' '${items}'`} />
            <p>需要往回翻页时，把 <Mono>page.nextCursor</Mono> 作为 cursor 传回去，翻到已经有的那条就停，不要每次把 7 天重翻一遍。</p>
          </>
        )}
        {recipe === "sync" && (
          <>
            <CodeBlock className="mb-3 mt-3" lang="bash" code={`# 第一次：分页拿全。保存第一页响应里的 cursor（每页都一样）\n${curl} '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# hasMore 为 true 就带上 nextPage 继续翻，直到翻完\n${curl} '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<上一页的 nextPage>'\n# 之后：原样传回 cursor，只拿新增、修改和撤选\n${curl} '${base}/api/v1/selected/changes?cursor=<第一页的 cursor>&limit=100'`} />
            <p>每页成功写进本地后再保存新的 cursor。cursor 是流水账水位，放多久都不会过期；返回 409 <Mono>snapshot_required</Mono> 时重新取一次快照，不会悄悄漏数据。</p>
          </>
        )}
      </Block>

      <Block title="出错了怎么办" id="agent-api-recovery">
        <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <dt className="mono text-[13px] text-ink">400</dt>
          <dd>参数不对：按 OpenAPI 和返回的 code 修正，不要自动换成更宽的查询。cursor 无效或滑出时间窗返回 invalid_cursor，从第一页重来。</dd>
          <dt className="mono text-[13px] text-ink">409</dt>
          <dd>snapshot_required：增量没法安全续上，重新取一次完整快照。</dd>
          <dt className="mono text-[13px] text-ink">429</dt>
          <dd>请求太密：按 Retry-After 等待，不要并发重试。</dd>
          <dt className="mono text-[13px] text-ink">5xx</dt>
          <dd>指数退避，先用上次成功的结果；公开服务不承诺 SLA。</dd>
        </dl>
        <p className="mt-4 text-[13px] text-ink-3">{`能匿名调用不等于所有用途都获许可${POLICY.terms.notes ? `：${POLICY.terms.notes.api}` : ""}，见`}<Link viewTransition to="/terms" className={link}>{POLICY.terms.name}</Link>。</p>
      </Block>

    </>
  );
}
