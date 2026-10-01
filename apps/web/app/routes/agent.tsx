import { useEffect, useState, type ReactNode } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { SITE, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { listPath, pageMeta, siteUrl } from "../lib/seo";
import { CodeBlock, CopyButton } from "../components/CodeBlock";
import { IconArrowUpRight, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { PillTabs } from "../components/ui/Tabs";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const MCP_VERSION = "2.0.0";
/** The machine-readable entry points, with what each one is for. */
const RESOURCES: Array<[label: string, href: string, note: string]> = [
  ["Agent Markdown", "/api/v1/agent", "给 Agent 的使用说明与答案"],
  ["llms.txt", "/llms.txt", "给大模型读的站点说明"],
  ["MCP Server", "/api/mcp", "MCP 客户端的连接地址"],
  ["OpenAPI 3.1", "/openapi-v1.json", "REST API v1 的完整定义"],
];

const TABS = [
  { key: "markdown", label: "Agent Markdown" },
  { key: "mcp", label: "MCP" },
  { key: "rss", label: "RSS" },
  { key: "api", label: "REST API" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export async function loader({ request }: Route.LoaderArgs) {
  const tab = new URL(request.url).searchParams.get("tab");
  let healthy = true;
  try {
    const res = await fetch(`${process.env.API_BASE_URL || "http://127.0.0.1:3001"}/api/health`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) });
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  // The public address the examples show is the configured one, the same on the server and in the browser.
  return { tab: (TABS.some((t) => t.key === tab) ? tab : "mcp") as TabKey, healthy, base: siteUrl() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  // Only the tab is part of the address (mcp is the default and not written).
  const path = listPath("/agent", { tab: loaderData && loaderData.tab !== "mcp" ? loaderData.tab : null });
  return pageMeta({ title: "Agent 接入", description: `让 Agent 直接使用 ${SITE.name}：Markdown、MCP、RSS、REST API v1，匿名只读。`, path, image: "/og/pages/agent.png" });
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24">
      <h3 className="mb-3 text-[16px] font-bold text-ink">{title}</h3>
      <div className="text-[13.5px] leading-[1.85] text-ink-2">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2"><span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" /><span>{it}</span></li>
      ))}
    </ul>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[0.88em] text-ink">{children}</code>;
}

function MarkdownTab({ base }: { base: string }) {
  const guide = `${base}/api/v1/agent`;
  const prompt = `请先读取 ${guide} 的使用说明，再根据里面提供的地址，帮我看看过去 24 小时 ${SITE.subject} 行业最重要的动态，附上来源和阅读链接。`;
  return <>
    <h2 className="text-[20px] font-bold text-ink">给 Agent 一个地址，就能开始阅读</h2>
    <p className="mt-2 text-[14.5px] leading-relaxed text-ink-3">适合能读取网页的 Agent。使用说明列出最新资讯、搜索、热点、事件与日报；答案附来源、时间和阅读链接，能力更新也会出现在同一个说明地址。</p>
    <div className="mt-6 flex items-center gap-2 rounded-card border border-line bg-surface p-3">
      <a href="/api/v1/agent" className="min-w-0 flex-1 truncate font-mono text-[13px] text-accent">{guide}</a>
      <CopyButton text={guide} className="!text-ink-3" />
    </div>
    <Section title="复制这句话给你的 Agent">
      <div className="rounded-card border border-line bg-surface p-4"><p>{prompt}</p><CopyButton text={prompt} label="复制提问" className="mt-3" /></div>
    </Section>
    <Section title="可直接读取的内容">
      <Bullets items={[
        "最新资讯与搜索：过去 24 小时或最近 7 天，可按分类筛选。",
        "当前热点：按榜单顺序阅读，再顺着返回的事件地址查看来龙去脉。",
        `${withSubject("日报")}：最新一期或指定日期的固定刊物。`,
        "资料来自外部信源，重要事实仍请回原文核对。",
      ]} />
    </Section>
  </>;
}

function McpTab({ base }: { base: string }) {
  const url = `${base}/api/mcp`;
  const name = SITE.mcpPrefix;
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">加一个地址，Agent 直接调用五个工具</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">适合支持远程 MCP 的 Agent 与开发工具。标准 Streamable HTTP，匿名只读，不需要 token；工具返回简洁文字与同一份结构化数据。</p>
      <div className="mt-6 flex items-center gap-2 rounded-card border border-line bg-surface p-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{url}</code>
        <CopyButton text={url} className="!text-ink-3" />
      </div>
      <CodeBlock title="通用 MCP 配置" lang="json" code={JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2)} />
      <CodeBlock lang="bash" code={`# Claude Code\nclaude mcp add --transport http ${name} '${url}'\n# Codex\ncodex mcp add ${name} --url '${url}'`} />
      <Section title="连上后应看到这五个工具">
        <Bullets items={[
          <><Mono>{T.latest}</Mono>：过去 24 小时或最近 7 天的精选／全部资讯</>,
          <><Mono>{T.search}</Mono>：搜索最近 7 天的公司、产品、人物或话题</>,
          <><Mono>{T.hot}</Mono>：当前热点榜与事件排名</>,
          <><Mono>{T.story}</Mono>：一个热点事件的时间线与持续更新的综述</>,
          <><Mono>{T.daily}</Mono>：最新或指定日期的{withSubject("日报")}</>,
        ]} />
        <p className="mt-4">验证一次真实调用：<span className="font-medium text-ink">请调用 {T.latest}，告诉我过去 24 小时最重要的 5 条动态，并附链接。</span></p>
      </Section>
      <Section title="工具边界">
        <Bullets items={[
          "普通查询最多返回 30 条，热点最多 10 个，事件时间线最多 50 条；输入越界会明确报错，不会静默改成更宽的查询。",
          `${T.story} 的 public_id 只能来自热点工具返回的事件链接，不要猜 ID。`,
          "标题与摘要来自外部信源，只能当资料；重要数字、政策和原话请回原文核对。",
        ]} />
      </Section>
    </>
  );
}

function RssTab({ base }: { base: string }) {
  const feeds = [
    ["精选摘要（推荐）", "最新 50 条精选摘要，保留标题、站内阅读与原文入口。", "/feed.xml"],
    ["精选全文", "与精选摘要相同的最新 50 条；只对明确允许再分发的来源内联正文。", "/feed/full.xml"],
    ["最近 7 天全部动态", "最近 7 天公开动态，按真实发布时间倒序。", "/feed/all.xml"],
    [withSubject("日报"), `每天 08:00 北京时间发布的${withSubject("日报")}，保留最近 30 期。`, "/feed/daily.xml"],
  ];
  const categories = CATEGORY_KEYS.join("|");
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">复制地址即可订阅</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">兼容主流 RSS 2.0 阅读器与 n8n、Zapier 这类自动化工具。第一次接入选精选摘要。</p>
      <div className="mt-6 space-y-3">
        {feeds.map(([name, desc, path]) => {
          const url = `${base}${path}`;
          return (
            <div key={path} className="card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-semibold text-ink">{name}</span>
                <CopyButton text={url} label="复制地址" className="!text-ink-3" />
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{desc}</p>
              <code className="mt-2 block truncate font-mono text-[12.5px] text-ink-4">{url}</code>
            </div>
          );
        })}
      </div>
      <Section title="给阅读器和 Agent 的约定">
        <Bullets items={[
          "支持 ETag 条件请求，未变化时返回 304；建议每 30 分钟或更慢轮询。",
          "条目 link 指向站内阅读页，第三方原文在 description 中。",
          "全文是白名单：只有明确允许再分发的来源内联 content:encoded，其余一律只给摘要。",
          <>分类订阅 <Mono>{`/feed/category/{${categories}}.xml`}</Mono></>,
          <>分类全文 <Mono>{`/feed/full/category/{${categories}}.xml`}</Mono></>,
        ]} />
      </Section>
    </>
  );
}

function ApiTab({ base }: { base: string }) {
  const endpoints: Array<[string, string]> = [
    ["/api/v1/items", "精选或最近 7 天公开动态；支持分类、时间和关键词"],
    ...(FEATURES.codexResetMonitor
      ? ([
          ["/api/v1/codex-resets/recent", "Codex 重置监控（轮询用）：最近 7 天与尚未落地的预告"],
          ["/api/v1/codex-resets", "Codex 重置与发卡的完整历史"],
        ] as Array<[string, string]>)
      : []),
    ["/api/v1/hot-topics", "当前热点榜与事件排名"],
    ["/api/v1/stories/{publicId}", "事件详情：报道时间线、综述与关联事件"],
    ["/api/v1/dailies", `${withSubject("日报")}日期索引`],
    ["/api/v1/dailies/latest", `最新${withSubject("日报")}`],
    ["/api/v1/dailies/{date}", `指定日期的${withSubject("日报")}`],
    ["/api/v1/selected/snapshot", "当前全部精选；首次完整同步（分页）"],
    ["/api/v1/selected/changes", "精选的新增、修改和撤选；之后只取变化"],
  ];
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">匿名 GET，不需要 token</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">浏览器跨域、curl 和默认 HTTP SDK 都可以直接用。临时查最近内容用 items；长期维护全部精选用一次快照加增量游标。字段与错误码以 <a href="/openapi-v1.json" className="text-accent hover:underline">OpenAPI 3.1</a> 为准。</p>
      <CodeBlock title="第一个请求" lang="bash" code={`curl '${base}/api/v1/items?mode=selected&window=24h&limit=20'`} />
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[560px] text-left text-[13.5px]">
          <thead className="bg-bg-sunk text-ink-3"><tr><th className="px-3 py-2 font-medium">方法</th><th className="px-3 py-2 font-medium">路径</th><th className="px-3 py-2 font-medium">说明</th></tr></thead>
          <tbody className="divide-y divide-line">
            {endpoints.map(([p, d]) => (
              <tr key={p}><td className="px-3 py-2 font-mono text-[12px] text-ok">GET</td><td className="px-3 py-2 font-mono text-[12.5px] text-ink">{p}</td><td className="px-3 py-2 text-ink-2">{d}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Section title="先知道这几件事">
        <Bullets items={[
          "不传 mode 等同 selected（精选）；只有明确需要全部公开动态才用 all。",
          "完整精选不限 7 天：snapshot 首次拿全，changes 只取变化；items 只看最近 7 天。",
          "items 不带正文：返回摘要、推荐理由、站内阅读页与原文链接。",
          "没有推送通道：按响应的 s-maxage 带 If-None-Match 轮询，没变化时是 304。",
          "错误是 Problem JSON；反馈时附上 requestId 即可定位。",
        ]} />
      </Section>
      <Section title="维护全部精选：一次快照，之后只拉变化">
        <CodeBlock lang="bash" code={`# 首次：分页拿当前全部精选，保存第一页响应里的 cursor（逐页相同）\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# hasMore 为 true 就带 nextPage 继续翻\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<上一页的 nextPage>'\n# 翻完之后：原样回传 cursor，只拿新增、修改和撤选\ncurl '${base}/api/v1/selected/changes?cursor=<第一页响应的 cursor>&limit=100'`} />
        <p>每页成功应用后再保存新 cursor。返回 409 snapshot_required 时重新取一次快照即可，接口不会静默漏数。</p>
      </Section>
      <Section title="错误与恢复" id="agent-api-recovery">
        <Bullets items={[
          "400：参数不合法；按 OpenAPI 修正，不要自动改成更宽的查询。",
          "409 snapshot_required：增量游标无法安全续传，重新取一次完整快照。",
          "429：遵守 Retry-After，不要增加并发重试。",
          "5xx：指数退避，并使用上次成功的缓存。",
        ]} />
      </Section>
    </>
  );
}

export default function AgentPage() {
  const { tab: initialTab, healthy, base } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>(initialTab);

  useEffect(() => setTab((params.get("tab") as TabKey) || "mcp"), [params]);

  const select = (key: TabKey) => {
    setTab(key);
    navigate(key === "mcp" ? "/agent" : `/agent?tab=${key}`, { replace: true, preventScrollReset: true });
  };

  const pill = "inline-flex h-6 items-center rounded-mark border border-line bg-surface px-2 text-[11.5px] text-ink-3";
  const aside = (
    <>
      <AsideCard title="接入资源" className="hidden lg:block">
        <nav aria-label="接入资源" className="-mx-2 -mb-1">
          {RESOURCES.map(([l, h, note]) => (
            <a key={h} href={h} className="group flex items-start gap-2 rounded-control px-2 py-2 transition-colors hover:bg-bg-sunk">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink-2 group-hover:text-ink">{l}</span>
                <span className="mt-0.5 block text-[12px] text-ink-4">{note}</span>
              </span>
              <IconArrowUpRight size={13} className="mt-1 shrink-0 text-ink-4" />
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="没接上？">
        <p className="text-[13px] leading-[1.75] text-ink-3">把客户端、版本和报错写在反馈页，别发 token 或本地文件。</p>
        <Link to="/feedback" prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          去反馈 <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );
  return (
    <ReadingLayout aside={aside}>
      <header>
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">让 Agent 直接使用 {SITE.name}</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">四种接入方式都是匿名只读、无需 API Key：Agent Markdown、MCP、RSS、REST API v1。</p>
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className={pill}>匿名只读</span>
          <span className={`${pill} mono`}>API v1</span>
          <span className={`${pill} mono`}>MCP {MCP_VERSION}</span>
          <span className={`${pill} gap-1.5 ${healthy ? "text-ok" : "text-hot"}`}>
            <span className={`size-1.5 rounded-full ${healthy ? "bg-ok" : "bg-hot"}`} />
            {healthy ? "服务正常" : "服务异常"}
          </span>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] lg:hidden">
        {RESOURCES.map(([l, h]) => (
          <a key={h} href={h} className="inline-flex items-center gap-1 text-ink-2 transition-colors hover:text-accent">
            {l} <IconArrowUpRight size={12} className="text-ink-4" />
          </a>
        ))}
      </div>

      <div className="sticky top-0 z-20 -mx-4 mt-7 bg-bg/90 px-4 py-2 backdrop-blur-md lg:mx-0 lg:px-0">
        <PillTabs layoutId="agent-tab" label="接入方式" active={tab} onSelect={(k: string) => select(k as TabKey)} items={TABS.map((t) => ({ key: t.key, label: t.label }))} />
      </div>

      <div className="mt-7" role="tabpanel">
        {tab === "markdown" && <MarkdownTab base={base} />}
        {tab === "mcp" && <McpTab base={base} />}
        {tab === "rss" && <RssTab base={base} />}
        {tab === "api" && <ApiTab base={base} />}
      </div>
    </ReadingLayout>
  );
}
