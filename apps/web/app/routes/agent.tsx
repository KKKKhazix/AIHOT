import { namesEn } from "@aihot/contracts/i18n";
import { useEffect, useState } from "react";
import { IntentLink } from "../components/ui/IntentLink";
import { useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { SEO_TITLES, SITE, withSubject } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { apiGet, cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, listPath, pageMeta, siteUrl } from "../lib/seo";
import { IconArrowUpRight, IconChevronRight, IconCode, IconPlug, IconRss } from "../components/icons";
import { Kicker } from "../components/ui/Kicker";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { AGENT_PARTS, GUIDE_CLIENTS, TAG } from "../features/agent/module-parts";
import { ApiPanel, McpPanel, mcpToolCount, RssPanel } from "../features/agent/panels";
import type { AgentTrack } from "../modules";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { useNavigate } from "../lib/link";
import { L, localeOf, localizePath, shownIn, translator, useLocale, useT, type Locale, type Text } from "../lib/i18n";

export const handle: Screen = { tab: "me", name: L("Agent 接入", "For Agents") };

export { pageHeaders as headers } from "../lib/api.server";

const V = PUBLIC_INTERFACE_VERSION;

/** The ways in, the modules' first. The chooser's cards are the tabs: `?tab=` (the first is the default and not written). */
const TRACKS: AgentTrack[] = [
  ...AGENT_PARTS.flatMap((p) => p.tracks ?? []),
  { key: "mcp", name: "MCP", short: "MCP", pitch: L(`填一个地址，多出 ${mcpToolCount()} 个工具`, `Add one URL, get ${mcpToolCount()} new tools`), fit: L("Claude 桌面版、Cursor 等远程 MCP 客户端", "Claude Desktop, Cursor and other remote MCP clients"), icon: IconPlug, Panel: McpPanel },
  { key: "rss", name: "RSS", short: "RSS", pitch: L("复制地址，用阅读器订阅", "Copy a feed URL into your reader"), fit: L("Reeder、Folo、Inoreader、n8n", "Reeder, Folo, Inoreader, n8n"), icon: IconRss, Panel: RssPanel },
  { key: "api", name: "REST API", short: "API", pitch: L("匿名 GET，自己写程序取数", "Anonymous GET requests from your own code"), fit: L("脚本、机器人、小程序、看板", "Scripts, bots, mini apps, dashboards"), icon: IconCode, Panel: ApiPanel, anchors: ["agent-api-recovery"] },
];
const FIRST = TRACKS[0]!.key;
const tabKey = (key: string | null) => key && TRACKS.some(w => w.key === key) ? key : FIRST;
const hrefOf = (key: string) => (key === FIRST ? "/agent" : `/agent?tab=${key}`);
/** How many ways, as the copy counts them ("四种方式", "four ways"). */
const WAYS = L(["零", "一", "两", "三", "四", "五", "六"][TRACKS.length], ["zero", "one", "two", "three", "four", "five", "six"][TRACKS.length]);

/** The modules' sections at the end of a panel. */
const BLOCKS = AGENT_PARTS.flatMap((p) => p.blocks ?? []);
/** Which tab each section that can be linked to is on: the tracks' own, then the modules'. */
const ANCHORS = new Map([
  ...TRACKS.flatMap((w) => (w.anchors ?? []).map((id) => [id, w.key] as const)),
  ...BLOCKS.map((b) => [b.anchor, b.track] as const),
]);
const anchorHref = (id: string) => `${hrefOf(ANCHORS.get(id)!)}#${id}`;

/** Machine-readable entry points, with what each one is for. */
const RESOURCES: Array<[label: Text, href: Text, note: Text]> = [
  ["llms.txt", "/llms.txt", L("给大模型读的站点说明", "The site explained for LLMs")],
  [L("Agent 使用说明", "Agent guide"), L("/api/v1/agent", "/api/v1/agent?lang=en"), L(`Agent 读了就能查${GUIDE_CLIENTS ? `，${GUIDE_CLIENTS.zh} 用的也是它` : ""}`, `Agents read it and can start querying${GUIDE_CLIENTS ? `; it also powers ${GUIDE_CLIENTS.en}` : ""}`)],
  ["OpenAPI 3.1", "/openapi-v1.json", L(`REST API 的完整定义 · ${V}`, `The full REST API definition · ${V}`)],
  ...AGENT_PARTS.flatMap((p) => p.resources ?? []),
];

const BANNERS = AGENT_PARTS.flatMap((p) => (p.Banner ? [p.Banner] : []));
/** The tag's value: a hook, called on every render. */
const useTag = TAG?.useValue ?? (() => null);

export async function loader({ request }: Route.LoaderArgs) {
  // Only whether the api answers, within three seconds.
  const healthy = await apiGet("/api/health", { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) }).then(() => true, () => false);
  return cachedPage(300, {
    healthy,
    // The examples show the configured public address, the same on the server and in the browser.
    base: siteUrl(),
  });
}

/** The tabs read one result, kept under the address without `tab`. */
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>((url) => {
  const params = new URLSearchParams(url.search);
  params.delete("tab");
  return url.pathname + (params.size ? `?${params}` : "");
});

function tabMeta(tab: string, track: AgentTrack | undefined, locale: Locale): { title: string; description: string } {
  const t = translator(locale);
  const title = t(SEO_TITLES.agent, ENGLISH?.seoTitles.agent ?? SEO_TITLES.agent);
  if (tab === FIRST) {
    return {
      title,
      description: t(
        `把 ${SITE.name} 接进你的 Agent：${TRACKS.map((w) => w.name).join("、")} ${WAYS.zh}种方式，匿名只读，无需 API Key，一分钟接好。`,
        `Plug ${SITE.name} into your agent: ${namesEn(TRACKS.map((w) => w.name))}, ${WAYS.en} ways in. Anonymous and read-only, no API key, set up in a minute.`,
      ),
    };
  }
  if (tab === "mcp") {
    return {
      title: t(`${withSubject("新闻")} MCP 服务：接入 Claude、Cursor 等客户端`, `${SITE.subject} News MCP Server: Connect Claude, Cursor and Other Clients`),
      description: t(
        `免费接入 ${SITE.name} 远程 MCP 服务（${mcpToolCount()} 个工具）：支持 Claude 桌面版、Cursor 等客户端，匿名只读、无需 API Key，实时获取${withSubject("精选")}、热点与日报。`,
        `Connect to ${SITE.name}'s remote MCP server for free (${mcpToolCount()} tools): works with Claude Desktop, Cursor and other clients. Anonymous and read-only, no API key. Get ${SITE.subject} top picks, trending stories and the ${SITE.subject} Daily as they happen.`,
      ),
    };
  }
  if (tab === "rss") {
    return {
      title: t(`${withSubject("新闻")} RSS 订阅：精选、全部动态与日报 Feed`, `${SITE.subject} News RSS Feeds: Top Picks, All ${SITE.subject} News and ${SITE.subject} Daily`),
      description: t(
        `订阅 ${SITE.name} 的${withSubject("资讯")} RSS（精选、全部动态、日报、周报、月报）：支持 Reeder、Folo、Inoreader、n8n，免费匿名订阅，无需注册。`,
        `Subscribe to ${SITE.name}'s ${SITE.subject} news via RSS (top picks, all news, and the daily, weekly and monthly reports): works with Reeder, Folo, Inoreader and n8n. Free and anonymous, no sign-up.`,
      ),
    };
  }
  if (tab === "api") {
    return {
      title: t(`${withSubject("新闻")}免费 REST API 与 OpenAPI 文档`, `Free ${SITE.subject} News REST API and OpenAPI Docs`),
      description: t(
        `${SITE.name} 公开只读 REST API（v${V}）：匿名 GET 请求，无需 API Key，提供${withSubject("精选动态")}、全文搜索、热点与日报 JSON 接口及 OpenAPI 3.1 定义。`,
        `${SITE.name}'s public read-only REST API (v${V}): anonymous GET requests, no API key. JSON endpoints for ${SITE.subject} top picks, full-text search, trending stories and daily reports, plus an OpenAPI 3.1 definition.`,
      ),
    };
  }
  return {
    title: track ? `${track.name} · ${title}` : title,
    description: track
      ? t(`${SITE.name} ${track.name} 接入：${t(track.pitch)}，适合${t(track.fit)}。匿名只读，无需 API Key。`, `${SITE.name} via ${track.name}: ${t(track.pitch)}. Good for: ${t(track.fit)}. Anonymous and read-only, no API key.`)
      : t(`把 ${SITE.name} 接进你的 Agent。`, `Plug ${SITE.name} into your agent.`),
  };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  const tab = tabKey(new URLSearchParams(location.search).get('tab'));
  const track = TRACKS.find((w) => w.key === tab);
  const path = listPath("/agent", { tab: tab !== FIRST ? tab : null });
  const copy = tabMeta(tab, track, locale);
  return pageMeta({
    locale,
    title: copy.title,
    description: copy.description,
    path,
    image: "/og/pages/agent.png",
    jsonLd: breadcrumbLd([
      { name: SITE.name, path: "/" },
      { name: t("Agent 接入", "For Agents"), path: "/agent" },
      ...(tab !== FIRST && track ? [{ name: track.name, path }] : []),
    ], locale),
  });
}

export default function AgentPage() {
  const { healthy, base } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const locale = useLocale();
  const tag = useTag();
  const tab = tabKey(params.get('tab'));
  // A section to scroll to once its panel is on the page.
  const [target, setTarget] = useState<string | null>(null);

  // Opened at a section's anchor: show its tab and scroll there.
  useEffect(() => {
    const hash = location.hash.slice(1);
    const key = ANCHORS.get(hash);
    if (key) {
      if (key !== tab) navigate(`${hrefOf(key)}#${hash}`, { replace: true, preventScrollReset: true });
      setTarget(hash);
    }
  }, []);
  useEffect(() => {
    if (!target || tab !== ANCHORS.get(target)) return;
    document.getElementById(target)?.scrollIntoView({ block: "start" });
    setTarget(null);
  }, [target, tab]);

  const select = (key: string) => {
    if (key === tab) return;
    navigate(hrefOf(key), { replace: true, preventScrollReset: true });
  };
  const open = (id: string) => {
    navigate(anchorHref(id), { replace: true, preventScrollReset: true });
    setTarget(id);
  };
  /** The plain links that switch tabs in place, at this page's address in its language (as `navigate` goes). */
  const here = (to: string) => localizePath(to, locale);
  const track = TRACKS.find((w) => w.key === tab);

  const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-ui-caption text-ink-3";
  const aside = (
    <>
      <AsideCard title={t("接入方式", "Ways to connect")} className="hidden side:block">
        <nav aria-label={t("接入方式", "Ways to connect")} className="-mx-2 -mb-1 space-y-0.5">
          {TRACKS.map((w) => {
            const on = w.key === tab;
            return (
              <a
                key={w.key}
                href={here(hrefOf(w.key))}
                onClick={(e) => {
                  e.preventDefault();
                  select(w.key);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                aria-current={on ? "true" : undefined}
                className={`flex items-center gap-2.5 rounded-control px-2 py-2 text-ui-label-lg transition-colors ${on ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-bg-sunk hover:text-ink"}`}
              >
                <w.icon size={16} />
                <span className="min-w-0 flex-1">{w.name}</span>
                {on && <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />}
              </a>
            );
          })}
        </nav>
      </AsideCard>
      <AsideCard title={t("接入资源", "Resources")}>
        <nav aria-label={t("接入资源", "Resources")} className="-mx-2 -mb-1">
          {shownIn(locale, RESOURCES, ([, , note]) => note).map(([l, href, note]) => [l, t(href), note] as const).map(([l, h, note]) => (
            <a key={h} href={h} target={h.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="group flex items-start gap-2 rounded-control px-2 py-2 transition-colors hover:bg-bg-sunk">
              <span className="min-w-0 flex-1">
                <span className="block text-ui-label-lg text-ink-2 group-hover:text-ink">{t(l)}</span>
                <span className="mt-0.5 block text-ui-caption text-ink-4">{t(note)}</span>
              </span>
              <IconArrowUpRight size={13} className="mt-1 shrink-0 text-ink-4" />
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title={t("没接上？", "Can't connect?")}>
        <p className="text-ui-label leading-[1.75] text-ink-3">{t("把平台、版本和报错写在反馈页，别发 token 或本地文件。", "Tell us your platform, version and the error on the feedback page. Don't send tokens or local files.")}</p>
        <IntentLink viewTransition to="/feedback" className="mt-3 inline-flex items-center gap-1 text-ui-label font-medium text-accent hover:underline">
          {t("去反馈 ", "Send feedback ")}<IconChevronRight size={14} />
        </IntentLink>
      </AsideCard>
    </>
  );

  return (
    <>
    <PhoneBar back={{ to: "/more", label: L("我的", "Me") }} title={t("Agent 接入", "For Agents")} />
    <ReadingLayout aside={aside}>
      <header className="lg:pt-5">
        <Kicker>{t("AGENT 接入", "For Agents")}</Kicker>
        <h1 data-page-title="" className="mt-4 text-ui-title-4 font-semibold leading-[1.3] text-ink sm:text-ui-title-6">{t(`把 ${SITE.name} 接进你的 Agent`, `Plug ${SITE.name} into your agent`)}</h1>
        <p className="mt-3 max-w-[40em] text-ui-body leading-[1.8] text-ink-3">{t(`${TRACKS.map((w) => w.short).join("、")} ${WAYS.zh}种方式读的是同一份数据：精选、热点、日报、周报和月报，按你用的工具选一种就行。全部匿名只读，不用注册，也不用 API Key。`, `${namesEn(TRACKS.map((w) => w.short))}: ${WAYS.en} ways to read the same data, from top picks and trending stories to the daily, weekly and monthly reports. Pick whichever suits the tools you use. All anonymous and read-only: no sign-up, no API key.`)}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={`${chip} ${healthy ? "text-ok" : "text-hot"}`}>
            <span className={`size-1.5 rounded-full ${healthy ? "bg-ok" : "bg-hot"}`} aria-hidden="true" />
            {healthy ? t("服务正常", "Service OK") : t("服务异常", "Service issues")}
          </span>
          <span className={chip}>{t("版本 ", "Version ")}<span className="mono text-ink-2">{V}</span></span>
          <span className={chip}>{t("匿名只读 · 无需 Key", "Anonymous, read-only · No API key needed")}</span>
        </div>
      </header>

      {BANNERS.map((Banner, i) => <Banner key={i} base={base} tag={tag} href={(id) => here(anchorHref(id))} open={open} />)}

      <div role="tablist" aria-label={t("接入方式", "Ways to connect")} className="mt-8 grid grid-cols-2 gap-2.5 sm:gap-3 2xl:grid-cols-4">
        {TRACKS.map((w) => {
          const on = w.key === tab;
          return (
            <a
              key={w.key}
              href={here(hrefOf(w.key))}
              role="tab"
              id={`agent-tab-${w.key}`}
              aria-selected={on}
              aria-controls="agent-panel"
              onClick={(e) => {
                e.preventDefault();
                select(w.key);
              }}
              className={`group flex flex-col rounded-card border p-3.5 transition-[border-color,background-color,box-shadow] duration-200 sm:p-4 ${on ? "border-accent/50 bg-accent-softer shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line bg-surface shadow-[var(--shadow-card)] hover:border-line-strong hover:shadow-[var(--shadow-card-hover)]"}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className={`grid size-9 place-items-center rounded-control transition-colors ${on ? "bg-accent text-accent-contrast" : "bg-bg-sunk text-ink-3 group-hover:text-ink"}`}>
                  <w.icon size={18} />
                </span>
                {w.badge && <span className="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-2 text-ui-caption-sm font-medium text-accent">{t(w.badge)}</span>}
              </span>
              <span className="mt-3 text-ui-body-plus font-semibold text-ink">{w.name}</span>
              <span className="mt-1 text-ui-label leading-snug text-ink-2">{t(w.pitch)}</span>
              <span className="mt-2 hidden text-ui-caption leading-snug text-ink-4 sm:block">{t(w.fit)}</span>
            </a>
          );
        })}
      </div>
      {TAG && <TAG.Note />}

      <section id="agent-panel" role="tabpanel" aria-labelledby={`agent-tab-${tab}`} className="mt-9">
        {track && <track.Panel key={track.key} base={base} tag={tag} />}
        {BLOCKS.filter((b) => b.track === tab).map((b) => <b.Block key={b.anchor} base={base} tag={tag} />)}
      </section>
    </ReadingLayout>
    </>
  );
}
