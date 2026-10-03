import { useEffect, useState } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { SITE } from "@aihot/site";
import { apiGet, edgeTtl } from "../lib/api.server";
import { listPath, pageMeta, siteUrl } from "../lib/seo";
import { IconArrowUpRight, IconChevronRight, IconCode, IconPlug, IconRss } from "../components/icons";
import { Kicker } from "../components/ui/Kicker";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { AGENT_PARTS, GUIDE_CLIENTS, TAG } from "../features/agent/module-parts";
import { ApiPanel, McpPanel, mcpToolCount, RssPanel } from "../features/agent/panels";
import type { AgentTrack } from "../modules";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: "Agent 接入" };

export function headers() {
  return edgeTtl(300);
}

const V = PUBLIC_INTERFACE_VERSION;

/** The ways in, the modules' first. The chooser's cards are the tabs: `?tab=` (the first is the default and not written). */
const TRACKS: AgentTrack[] = [
  ...AGENT_PARTS.flatMap((p) => p.tracks ?? []),
  { key: "mcp", name: "MCP", short: "MCP", pitch: `填一个地址，多出 ${mcpToolCount()} 个工具`, fit: "Claude 桌面版、Cursor 等远程 MCP 客户端", icon: IconPlug, Panel: McpPanel },
  { key: "rss", name: "RSS", short: "RSS", pitch: "复制地址，用阅读器订阅", fit: "Reeder、Folo、Inoreader、n8n", icon: IconRss, Panel: RssPanel },
  { key: "api", name: "REST API", short: "API", pitch: "匿名 GET，自己写程序取数", fit: "脚本、机器人、小程序、看板", icon: IconCode, Panel: ApiPanel, anchors: ["agent-api-recovery"] },
];
const FIRST = TRACKS[0]!.key;
const hrefOf = (key: string) => (key === FIRST ? "/agent" : `/agent?tab=${key}`);
/** How many ways, as the copy counts them ("四种方式"). */
const WAYS = ["零", "一", "两", "三", "四", "五", "六"][TRACKS.length];

/** The modules' sections at the end of a panel. */
const BLOCKS = AGENT_PARTS.flatMap((p) => p.blocks ?? []);
/** Which tab each section that can be linked to is on: the tracks' own, then the modules'. */
const ANCHORS = new Map([
  ...TRACKS.flatMap((t) => (t.anchors ?? []).map((id) => [id, t.key] as const)),
  ...BLOCKS.map((b) => [b.anchor, b.track] as const),
]);
const anchorHref = (id: string) => `${hrefOf(ANCHORS.get(id)!)}#${id}`;

/** Machine-readable entry points, with what each one is for. */
const RESOURCES: Array<[label: string, href: string, note: string]> = [
  ["llms.txt", "/llms.txt", "给大模型读的站点说明"],
  ["Agent 使用说明", "/api/v1/agent", `Agent 读了就能查${GUIDE_CLIENTS ? `，${GUIDE_CLIENTS} 用的也是它` : ""}`],
  ["OpenAPI 3.1", "/openapi-v1.json", `REST API 的完整定义 · ${V}`],
  ...AGENT_PARTS.flatMap((p) => p.resources ?? []),
];

const BANNERS = AGENT_PARTS.flatMap((p) => (p.Banner ? [p.Banner] : []));
/** The tag's value: a hook, called on every render. */
const useTag = TAG?.useValue ?? (() => null);

export async function loader({ request }: Route.LoaderArgs) {
  const tab = new URL(request.url).searchParams.get("tab");
  // Only whether the api answers, within three seconds.
  const healthy = await apiGet("/api/health", { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) }).then(() => true, () => false);
  return {
    tab: tab && TRACKS.some((t) => t.key === tab) ? tab : FIRST,
    healthy,
    // The examples show the configured public address, the same on the server and in the browser; what
    // depends on the time reads the server's.
    base: siteUrl(),
    now: Date.now(),
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
  const { tab: initialTab, healthy, base, now } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tag = useTag();
  const [tab, setTab] = useState(initialTab);
  // A section to scroll to once its panel is on the page.
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => setTab(params.get("tab") || FIRST), [params]);
  // Opened at a section's anchor: show its tab and scroll there.
  useEffect(() => {
    const hash = location.hash.slice(1);
    const key = ANCHORS.get(hash);
    if (key) {
      setTab(key);
      setTarget(hash);
    }
  }, []);
  useEffect(() => {
    if (!target || tab !== ANCHORS.get(target)) return;
    document.getElementById(target)?.scrollIntoView({ block: "start" });
    setTarget(null);
  }, [target, tab]);

  const select = (key: string) => {
    setTab(key);
    navigate(hrefOf(key), { replace: true, preventScrollReset: true });
  };
  const open = (id: string) => {
    select(ANCHORS.get(id)!);
    setTarget(id);
  };
  const track = TRACKS.find((t) => t.key === tab);

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

      {BANNERS.map((Banner, i) => <Banner key={i} base={base} tag={tag} now={now} href={anchorHref} open={open} />)}

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
      {TAG && <TAG.Note />}

      <section id="agent-panel" role="tabpanel" aria-labelledby={`agent-tab-${tab}`} className="mt-9">
        {track && <track.Panel key={track.key} base={base} tag={tag} now={now} />}
        {BLOCKS.filter((b) => b.track === tab).map((b) => <b.Block key={b.anchor} base={base} tag={tag} now={now} />)}
      </section>
    </ReadingLayout>
    </>
  );
}
