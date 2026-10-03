import { useEffect, useState, type ComponentType } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { MCP_TOOLS } from "@aihot/contracts/mcp";
import { SITE } from "@aihot/industry/site";
import { apiGet, edgeTtl } from "../lib/api.server";
import { listPath, pageMeta, siteUrl } from "../lib/seo";
import { IconArrowUpRight, IconChevronRight, IconCode, IconPlug, IconRss } from "../components/icons";
import { Kicker } from "../components/ui/Kicker";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { ApiPanel, McpPanel, RssPanel } from "../features/agent/panels";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: "Agent 接入" };

export function headers() {
  return edgeTtl(300);
}

const V = PUBLIC_INTERFACE_VERSION;

/** The ways in. The chooser's cards are the tabs: `?tab=` (the first is the default and not written). */
const TRACKS: Array<{ key: TrackKey; name: string; short: string; badge?: string; pitch: string; fit: string; icon: ComponentType<{ size?: number }> }> = [
  { key: "mcp", name: "MCP", short: "MCP", pitch: `填一个地址，多出 ${MCP_TOOLS.length} 个工具`, fit: "Claude 桌面版、Cursor 等远程 MCP 客户端", icon: IconPlug },
  { key: "rss", name: "RSS", short: "RSS", pitch: "复制地址，用阅读器订阅", fit: "Reeder、Folo、Inoreader、n8n", icon: IconRss },
  { key: "api", name: "REST API", short: "API", pitch: "匿名 GET，自己写程序取数", fit: "脚本、机器人、小程序、看板", icon: IconCode },
];
type TrackKey =
  | "mcp"
  | "rss"
  | "api";
const FIRST = TRACKS[0]!.key;
const hrefOf = (key: TrackKey) => (key === FIRST ? "/agent" : `/agent?tab=${key}`);
/** How many ways, as the copy counts them ("四种方式"). */
const WAYS = ["零", "一", "两", "三", "四", "五", "六"][TRACKS.length];

/** What reads the agent guide. */
const GUIDE_READERS = [
  "Agent 读了就能查",
];

/** Machine-readable entry points, with what each one is for. */
const RESOURCES: Array<[label: string, href: string, note: string]> = [
  ["llms.txt", "/llms.txt", "给大模型读的站点说明"],
  ["Agent 使用说明", "/api/v1/agent", GUIDE_READERS.join("，")],
  ["OpenAPI 3.1", "/openapi-v1.json", `REST API 的完整定义 · ${V}`],
];

export async function loader({ request }: Route.LoaderArgs) {
  const tab = new URL(request.url).searchParams.get("tab");
  // Only whether the api answers, within three seconds.
  const healthy = await apiGet("/api/health", { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) }).then(() => true, () => false);
  return {
    tab: (TRACKS.some((t) => t.key === tab) ? tab : FIRST) as TrackKey,
    healthy,
    // The examples show the configured public address, the same on the server and in the browser.
    base: siteUrl(),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath("/agent", { tab: loaderData && loaderData.tab !== FIRST ? loaderData.tab : null });
  return pageMeta({
    title: "Agent 接入",
    description: `把 ${SITE.name} 接进你的 Agent：${TRACKS.map((t) => t.name).join("、")} ${WAYS}种方式，匿名只读，无需 API Key，一分钟接好。`,
    path,
    image: "/og/pages/agent.png",
  });
}

export default function AgentPage() {
  const {
    tab: initialTab,
    healthy,
    base,
  } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TrackKey>(initialTab);

  useEffect(() => setTab((params.get("tab") as TrackKey) || FIRST), [params]);

  const select = (key: TrackKey) => {
    setTab(key);
    navigate(hrefOf(key), { replace: true, preventScrollReset: true });
  };

  const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] text-ink-3";
  const aside = (
    <>
      <AsideCard title="接入方式" className="hidden lg:block">
        <nav aria-label="接入方式" className="-mx-2 -mb-1 space-y-0.5">
          {TRACKS.map((t) => {
            const on = t.key === tab;
            return (
              <a
                key={t.key}
                href={hrefOf(t.key)}
                onClick={(e) => {
                  e.preventDefault();
                  select(t.key);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                aria-current={on ? "true" : undefined}
                className={`flex items-center gap-2.5 rounded-control px-2 py-2 text-[13.5px] transition-colors ${on ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-bg-sunk hover:text-ink"}`}
              >
                <t.icon size={16} />
                <span className="min-w-0 flex-1">{t.name}</span>
                {on && <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />}
              </a>
            );
          })}
        </nav>
      </AsideCard>
      <AsideCard title="接入资源">
        <nav aria-label="接入资源" className="-mx-2 -mb-1">
          {RESOURCES.map(([l, h, note]) => (
            <a key={h} href={h} target={h.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="group flex items-start gap-2 rounded-control px-2 py-2 transition-colors hover:bg-bg-sunk">
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
        <p className="text-[13px] leading-[1.75] text-ink-3">把平台、版本和报错写在反馈页，别发 token 或本地文件。</p>
        <Link viewTransition to="/feedback" prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          去反馈 <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );

  return (
    <>
    <PhoneBar back={{ to: "/more", label: "我的" }} title="Agent 接入" />
    <ReadingLayout aside={aside}>
      <header className="lg:pt-5">
        <Kicker>AGENT 接入</Kicker>
        <h1 data-page-title="" className="mt-4 text-[28px] font-semibold leading-[1.3] text-ink sm:text-[32px]">{`把 ${SITE.name} 接进你的 Agent`}</h1>
        <p className="mt-3 max-w-[40em] text-[15px] leading-[1.8] text-ink-3">{`${TRACKS.map((t) => t.short).join("、")} ${WAYS}种方式读的是同一份数据：精选、热点、日报、周报和月报，按你用的工具选一种就行。全部匿名只读，不用注册，也不用 API Key。`}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={`${chip} ${healthy ? "text-ok" : "text-hot"}`}>
            <span className={`size-1.5 rounded-full ${healthy ? "bg-ok" : "bg-hot"}`} aria-hidden="true" />
            {healthy ? "服务正常" : "服务异常"}
          </span>
          <span className={chip}>版本 <span className="mono text-ink-2">{V}</span></span>
          <span className={chip}>匿名只读 · 无需 Key</span>
        </div>
      </header>

      <div role="tablist" aria-label="接入方式" className="mt-8 grid grid-cols-2 gap-2.5 sm:gap-3 2xl:grid-cols-4">
        {TRACKS.map((t) => {
          const on = t.key === tab;
          return (
            <a
              key={t.key}
              href={hrefOf(t.key)}
              role="tab"
              id={`agent-tab-${t.key}`}
              aria-selected={on}
              aria-controls="agent-panel"
              onClick={(e) => {
                e.preventDefault();
                select(t.key);
              }}
              className={`group flex flex-col rounded-card border p-3.5 transition-[border-color,background-color,box-shadow] duration-200 sm:p-4 ${on ? "border-accent/50 bg-accent-softer shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line bg-surface shadow-[var(--shadow-card)] hover:border-line-strong hover:shadow-[var(--shadow-card-hover)]"}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className={`grid size-9 place-items-center rounded-control transition-colors ${on ? "bg-accent text-accent-contrast" : "bg-bg-sunk text-ink-3 group-hover:text-ink"}`}>
                  <t.icon size={18} />
                </span>
                {t.badge && <span className="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-2 text-[11px] font-medium text-accent">{t.badge}</span>}
              </span>
              <span className="mt-3 text-[15.5px] font-semibold text-ink">{t.name}</span>
              <span className="mt-1 text-[13px] leading-snug text-ink-2">{t.pitch}</span>
              <span className="mt-2 hidden text-[12px] leading-snug text-ink-4 sm:block">{t.fit}</span>
            </a>
          );
        })}
      </div>

      <section id="agent-panel" role="tabpanel" aria-labelledby={`agent-tab-${tab}`} className="mt-9">
        {tab === "mcp" && (
          <McpPanel
            base={base}
          />
        )}
        {tab === "rss" && (
          <RssPanel
            base={base}
          />
        )}
        {tab === "api" && (
          <ApiPanel
            base={base}
          />
        )}
      </section>
    </ReadingLayout>
    </>
  );
}
