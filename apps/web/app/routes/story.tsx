import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IntentLink } from "../components/ui/IntentLink";
import { useLoaderData, useLocation } from "react-router";
import type { Route } from "./+types/story";
import { STORY_INDEX_MIN_SOURCES, type StoryDetail, type StoryReportView } from "@aihot/contracts/site";
import { topicName } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { linkMentions } from "@aihot/contracts/mentions";
import { addressRuns } from "@aihot/contracts/addresses";
import { MentionText } from "../components/ui/MentionText";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, storyArticleLd, storyLd, titled } from "../lib/seo";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { byBeijingDay, monthDay, monthDayTime, relativeTime } from "../lib/format";
import { useCurrentSection } from "../lib/motion";
import { HeatChart } from "../features/story/HeatChart";
import { sessionCache } from "../lib/session-cache";
import { isReload } from "../lib/restore";
import { Badge, SelectedBadge } from "../components/ui/Badge";
import { PillTabs } from "../components/ui/Tabs";
import { Select } from "../components/ui/Controls";
import { IconArrowLeft, IconCalendar, IconChevronRight, IconClock, IconDoc, IconUsers } from "../components/icons";
import { PhoneBar } from "../components/shell/PhoneBar";
import { hotInNav, navUp } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";
import { Link } from "../lib/link";
import { L, localeOf, localizePath, translator, useLocale, useT } from "../lib/i18n";

// Stories are reached from the hot board, as long as the site shows it.
const UP = navUp("/hot");
export const handle: Screen = { home: UP.tab };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ params, request }: Route.LoaderArgs) {
  const story = await loadOr404<StoryDetail>(`/api/site/stories/${encodeURIComponent(params.publicId)}`, { signal: request.signal, merged: (id) => localizePath(`/story/${id}`, localeOf(pagePathname(request))) });
  return cachedPage(300, { story });
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  if (!loaderData) return [{ title: titled(t("事件不存在", "Story not found")) }, { name: "robots", content: "noindex" }];
  const s = loaderData.story;
  const article = storyArticleLd(s, locale);
  return pageMeta({
    locale,
    title: s.title,
    description: (s.digest ?? s.summary ?? s.excerpt?.text)?.slice(0, 150) ?? t(
      `${s.sourceCount} 个报道来源 ${s.reportCount} 篇报道，完整时间线与最新进展。`,
      `${s.reportCount} ${s.reportCount === 1 ? "report" : "reports"} from ${s.sourceCount} ${s.sourceCount === 1 ? "source" : "sources"}: the full timeline and the latest updates.`,
    ),
    path: `/story/${s.publicId}`,
    image: `/og/stories/${s.publicId}.png`,
    type: "article",
    // Single-source clusters only repeat that source's own pages, which stand in search instead.
    noindex: s.sourceCount < STORY_INDEX_MIN_SOURCES,
    jsonLd: [
      storyLd(s, locale),
      ...(article ? [article] : []),
      breadcrumbLd([{ name: SITE.name, path: "/" }, ...UP.crumbs, { name: s.title, path: `/story/${s.publicId}` }], locale),
    ],
  });
}

const STATUS = {
  active: { label: L("持续更新", "Developing"), tone: "hot" },
  watching: { label: L("观察中", "Watching"), tone: "amber" },
  settled: { label: L("历史事件", "Past story"), tone: "neutral" },
} as const;

// Section anchors keep the old page's ids so shared links still land in the right place.
const SECTIONS = { overview: "event-overview", reports: "event-reports", heat: "event-heat" } as const;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A main-column card: 17px title, 24px padding. */
function Panel({ id, title, sub, right, children, className = "" }: { id?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`card scroll-mt-[calc(var(--bar-h)+64px)] p-5 lg:p-6 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-ui-subheading-sm font-[650] leading-[1.5] text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-ui-caption-lg text-ink-4">{sub}</p>}
        </div>
        {right && <div className="shrink-0 text-ui-caption-md text-ink-4">{right}</div>}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/** A rail card: 14px title, 22px padding. */
function RailCard({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 lg:p-[22px] ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-ui-body-sm font-[650] text-ink">{title}</h2>
        {right && <span className="num text-ui-caption-md text-ink-4">{right}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** One report on the story timeline: time, source and marks, title, a summary that opens on demand. */
function TimelineRow({ r }: { r: StoryReportView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [r.summary, open]);
  return (
    <li className="grid gap-x-3 border-b border-line-soft py-4 last:border-b-0 lg:grid-cols-[48px_minmax(0,1fr)]">
      <time dateTime={r.publishedAt} className="mono text-ui-caption leading-[20px] text-ink-4">
        {beijingTime(r.publishedAt)}
      </time>
      <div className="min-w-0">
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-ui-caption leading-[20px] text-ink-4 lg:mt-0">
          <span className="min-w-0 truncate">{r.source.name}</span>
          {r.selected && <SelectedBadge />}
        </div>
        <IntentLink viewTransition to={`/items/${r.id}`} className="mt-1 block text-ui-body-lg font-[650] leading-[1.6] text-ink transition-colors hover:text-accent lg:text-ui-body-plus">
          {r.title}
        </IntentLink>
        {r.summary && (
          <>
            <p ref={ref} className={`mt-1 text-ui-body-sm leading-[1.75] text-ink-3 ${open ? "" : "line-clamp-2"}`}>
              <MentionText runs={addressRuns(r.summary)} />
            </p>
            {(clamped || open) && (
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-ui-caption-lg text-note transition-colors hover:text-accent">
                {open ? t("收起摘要", "Hide summary") : t("展开摘要", "Show summary")}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

type Filter = "all" | "official" | "selected";
type Order = "desc" | "asc";

// The report filter and shared reading order, per history entry: back from a report restores the view.
const viewCache = sessionCache<{ savedAt: number; filter: Filter; order: Order }>("aihot:story-view:", 30 * 60 * 1000);

export default function StoryPage() {
  const t = useT();
  const locale = useLocale();
  const { story } = useLoaderData<typeof loader>();
  const entry = useLocation().key;
  const [filter, setFilter] = useState<Filter>(() => viewCache.peek(entry)?.filter ?? "all");
  const [order, setOrder] = useState<Order>(() => viewCache.peek(entry)?.order ?? "desc");
  // A document the browser reloaded on back/forward gets the view back after hydration.
  useEffect(() => {
    if (viewCache.peek(entry) || isReload()) return;
    const saved = viewCache.read(entry);
    if (saved) {
      setFilter(saved.filter);
      setOrder(saved.order);
    }
  }, [entry]);
  useEffect(() => {
    if (filter !== "all" || order !== "desc" || viewCache.peek(entry)) viewCache.set(entry, { savedAt: Date.now(), filter, order });
  }, [entry, filter, order]);
  const status = STATUS[story.status];
  // A settled story nobody watched (history pages) has no heat to explain or chart.
  const observed = story.status !== "settled" || story.heat.length > 0 || story.whyHot.participants48h > 0 || story.whyHot.rank !== null;
  const sections = observed ? [SECTIONS.overview, SECTIONS.reports, SECTIONS.heat] : [SECTIONS.overview, SECTIONS.reports];
  const [reading, goSection] = useCurrentSection(sections);
  const counts = {
    all: story.timeline.length,
    official: story.timeline.filter((r) => r.source.firstParty).length,
    selected: story.timeline.filter((r) => r.selected).length,
  };
  const days = useMemo(() => {
    const list = story.timeline.filter((r) => (filter === "official" ? r.source.firstParty : filter === "selected" ? r.selected : true));
    const sorted = [...list].sort((a, b) => (order === "desc" ? Date.parse(b.publishedAt) - Date.parse(a.publishedAt) : Date.parse(a.publishedAt) - Date.parse(b.publishedAt)));
    return byBeijingDay(sorted, (r) => r.publishedAt);
  }, [story.timeline, filter, order]);
  const developments = useMemo(() => [...story.developments].sort((a, b) =>
    order === "desc" ? Date.parse(b.firstReportAt) - Date.parse(a.firstReportAt) : Date.parse(a.firstReportAt) - Date.parse(b.firstReportAt)
  ), [story.developments, order]);
  const newest = story.latestReport;
  const overview = story.digest
    ? {
        label: t("AI 综述", "AI summary"),
        text: story.digest,
        note: story.digestUpdatedAt
          ? t(`AI 根据报道生成 · ${relativeTime(story.digestUpdatedAt)}更新`, `Written by AI from the coverage · updated ${relativeTime(story.digestUpdatedAt, undefined, "en")}`)
          : t("AI 根据报道生成", "Written by AI from the coverage"),
      }
    : story.summary
      ? { label: t("事件摘要", "Story summary"), text: story.summary, note: null }
      : story.excerpt
        ? { label: t("报道摘要", "Report excerpt"), text: story.excerpt.text, note: t(`摘自 ${story.excerpt.sourceName}`, `From ${story.excerpt.sourceName}`) }
        : null;
  const officialCount = counts.official || story.officialReports.length;
  const [overviewRuns] = useMemo(() => linkMentions([overview?.text], story.mentions), [overview?.text, story.mentions]);
  const showOfficial = () => {
    setFilter("official");
    goSection(SECTIONS.reports);
  };

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <PhoneBar back={{ to: UP.to, label: UP.back }} title={story.title} />
      <nav aria-label={t("位置", "Breadcrumb")} className="hidden items-center gap-2.5 pb-5 pt-4 text-ui-caption text-ink-4 lg:flex">
        <Link to={UP.to} className="inline-flex items-center gap-1.5 transition-colors hover:text-ink">
          <IconArrowLeft size={15} /> {t(UP.name)}
        </Link>
        <span className="h-3 w-px bg-line-strong" aria-hidden="true" />
        <span>{t("事件详情", "Story details")}</span>
      </nav>

      <header className="max-w-[960px] pt-3 lg:pt-0">
        <div className="flex items-center gap-2 text-ui-caption text-ink-4">
          {t("热点事件", "Trending story")}
          <Badge tone={status.tone}>{t(status.label)}</Badge>
        </div>
        <h1 data-page-title="" className="mt-2.5 text-ui-title-3 font-bold leading-[1.5] tracking-[-0.01em] text-ink lg:mt-3 lg:text-ui-display-2 lg:font-[730]">{story.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-ui-caption-lg text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <IconDoc size={15} className="text-ink-4" />
            <b className="num font-semibold text-ink">{story.reportCount}</b>{t(" 篇报道", story.reportCount === 1 ? " report" : " reports")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconUsers size={15} className="text-ink-4" />
            <b className="num font-semibold text-ink">{story.sourceCount}</b>{t(" 个报道来源", story.sourceCount === 1 ? " source" : " sources")}
          </span>
          {story.firstReportAt && (
            <span className="inline-flex items-center gap-1.5">
              <IconCalendar size={15} className="text-ink-4" />
              {t(
                <>
                  <b className="num font-semibold text-ink">
                    <time dateTime={story.firstReportAt}>{monthDay(beijingDate(story.firstReportAt))}</time>
                  </b>
                  首报
                </>,
                <>
                  First reported
                  <b className="num font-semibold text-ink">
                    <time dateTime={story.firstReportAt}>{monthDay(beijingDate(story.firstReportAt), undefined, "en")}</time>
                  </b>
                </>,
              )}
            </span>
          )}
          {story.latestAt && (
            <span className="inline-flex items-center gap-1.5" suppressHydrationWarning>
              <IconClock size={15} className="text-ink-4" />
              {t(<>{relativeTime(story.latestAt)}更新</>, <>Updated {relativeTime(story.latestAt, undefined, "en")}</>)}
            </span>
          )}
        </div>
      </header>

      <div className="bleed sticky top-[var(--bar-h)] z-20 mt-5 bg-bg/90 py-2 backdrop-blur-md lg:mx-0 lg:px-0">
        <PillTabs
          size="sm"
          layoutId="story-sections"
          label={t("事件内容导航", "Story sections")}
          active={reading ?? SECTIONS.overview}
          onSelect={goSection}
          items={[
            { key: SECTIONS.overview, label: t("事件概览", "Overview") },
            { key: SECTIONS.reports, label: t("报道时间线", "Coverage timeline"), count: story.reportCount },
            ...(observed ? [{ key: SECTIONS.heat, label: t("热度走势", "Heat") }] : []),
          ]}
        />
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:mt-6 lg:gap-6 side:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Below side (phones and narrow desktops) the main column dissolves so the rail's cards can sit between its sections. */}
        <div className="contents side:flex side:min-w-0 side:flex-col side:gap-6">
          <Panel id={SECTIONS.overview} title={t("先了解这件事", "The story so far")} right={overview?.label} className="order-1">
            {overview ? (
              <>
                <p className="whitespace-pre-line text-ui-body leading-[1.85] text-ink-2"><MentionText runs={overviewRuns} /></p>
                {overview.note && (
                  <p className="mt-2 text-ui-caption text-ink-4" suppressHydrationWarning>
                    {overview.note}
                  </p>
                )}
              </>
            ) : (
              <p className="text-ui-label-lg text-ink-4">{t("暂时还没有综述，先看下面的报道时间线。", "No summary yet. Start with the coverage timeline below.")}</p>
            )}
            {story.latest && (
              <div className="-mx-5 mt-5 border-t border-line-soft px-5 pt-4 lg:-mx-6 lg:px-6">
                <div className="flex items-center gap-2.5 text-ui-caption">
                  <span className="font-semibold text-ink">{t("最新进展", "Latest update")}</span>
                  {story.latestAt && <span className="num text-ink-4">{monthDayTime(story.latestAt, locale)}</span>}
                </div>
                {newest ? (
                  <Link viewTransition to={`/items/${newest.id}`} className="group mt-1.5 inline text-ui-body-sm leading-[1.7] text-ink-2 transition-colors hover:text-accent">
                    {story.latest}
                    <IconChevronRight size={14} className="ml-0.5 inline -translate-y-px text-ink-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <p className="mt-1.5 text-ui-body-sm leading-[1.7] text-ink-2">{story.latest}</p>
                )}
              </div>
            )}
          </Panel>

          {story.developments.length > 1 && (
            <Panel title={t("事件进展", "Updates")} sub={t(`${story.developments.length} 个进展`, `${story.developments.length} updates`)} className="order-3" right={
              <Select value={order} onChange={(e) => setOrder(e.target.value as "desc" | "asc")} aria-label={t("事件进展排序", "Sort updates")}>
                <option value="desc">{t("最新在前", "Newest first")}</option>
                <option value="asc">{t("最早在前", "Oldest first")}</option>
              </Select>
            }>
              <ol className="relative space-y-4 pl-5 before:absolute before:bottom-2 before:left-[3px] before:top-2 before:w-px before:bg-line">
                {developments.map((d) => (
                  <li key={d.factId} className="relative">
                    <span className={`absolute -left-5 top-[7px] size-[7px] rounded-full ring-4 ring-surface ${d.factId === story.developments[0]?.factId ? "bg-accent" : "bg-line-strong"}`} aria-hidden="true" />
                    <div className="num text-ui-caption text-ink-4">
                      {monthDayTime(d.firstReportAt, locale)} · {d.reportCount}{t(" 篇报道", d.reportCount === 1 ? " report" : " reports")}
                    </div>
                    <Link viewTransition to={`/items/${d.representative.id}`} className="mt-0.5 block text-ui-body font-semibold leading-snug text-ink transition-colors hover:text-accent">
                      {d.title}
                    </Link>
                    <div className="mt-0.5 truncate text-ui-caption-lg text-ink-4">
                      {d.representative.source.name}{t("：", ": ")}{d.representative.title}
                    </div>
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          <Panel
            id={SECTIONS.reports}
            title={t("报道时间线", "Coverage timeline")}
            sub={t("沿着报道，了解事件的不同侧面。", "Follow the coverage to see the story from different sides.")}
            className="order-4"
            right={
              <Select value={order} onChange={(e) => setOrder(e.target.value as "desc" | "asc")} aria-label={t("报道时间线排序", "Sort coverage timeline")}>
                <option value="desc">{t("最新在前", "Newest first")}</option>
                <option value="asc">{t("最早在前", "Oldest first")}</option>
              </Select>
            }
          >
            <PillTabs
              size="xs"
              layoutId="story-report-filter"
              label={t("报道筛选", "Filter reports")}
              active={filter}
              onSelect={(k) => setFilter(k as Filter)}
              items={[
                { key: "all", label: t("全部报道", "All reports"), count: counts.all },
                { key: "official", label: t("官方一手", "Official"), count: counts.official },
                { key: "selected", label: t("精选报道", "Top picks"), count: counts.selected },
              ]}
            />
            {days.length === 0 ? (
              <p className="py-10 text-center text-ui-label text-ink-4">{t("这个筛选下没有报道。", "No reports match this filter.")}</p>
            ) : (
              days.map(({ day, entries: rows }) => (
                <div key={day}>
                  <div className="pb-0.5 pt-5 text-ui-body-sm font-semibold text-ink">{monthDay(day, undefined, locale)}</div>
                  <ol>
                    {rows.map((r) => (
                      <TimelineRow key={r.id} r={r} />
                    ))}
                  </ol>
                </div>
              ))
            )}
            {story.reportCount > story.timeline.length && (
              <p className="pt-3 text-center text-ui-caption text-ink-4">
                {t(<>显示最近 {story.timeline.length} 篇，共 {story.reportCount} 篇报道。</>, <>Showing the latest {story.timeline.length} of {story.reportCount} reports.</>)}
              </p>
            )}
          </Panel>

          {observed && (
            <Panel id={SECTIONS.heat} title={t("本事件热度走势", "Heat over time")} className="order-5">
              <HeatChart points={story.heat} />
            </Panel>
          )}

          {story.related.length > 0 && (
            <Panel title={t("关联事件", "Related stories")} className="order-6">
              <ul className="-my-1 divide-y divide-line-soft">
                {story.related.map((r) => (
                  <li key={r.publicId}>
                    <Link viewTransition to={`/story/${r.publicId}`} className="group flex items-baseline gap-3 py-3">
                      <span className="shrink-0 text-ui-caption text-ink-4">{r.relation === "storyline" ? t("同一故事线", "Same storyline") : t("相关事件", "Related")}</span>
                      <span className="min-w-0 flex-1 text-ui-body-sm-plus font-medium text-ink-2 transition-colors group-hover:text-accent">{r.title}</span>
                      <IconChevronRight size={14} className="shrink-0 self-center text-ink-4" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <aside className="order-2 flex min-w-0 flex-col gap-4 lg:gap-5 side:order-none">
          {observed && (
            <RailCard title={t("为什么热", "Why it's trending")}>
              <p className="text-ui-caption-lg leading-[1.75] text-ink-3">
                {t(
                  <>
                    过去 48 小时，有 <b className="num font-semibold text-ink">{story.whyHot.participants48h}</b> 个账号或机构报道、讨论了这件事，最近 6 小时新增{" "}
                    <b className="num font-semibold text-ink">{story.whyHot.newParticipants6h}</b> 个。
                  </>,
                  <>
                    In the last 48 hours, <b className="num font-semibold text-ink">{story.whyHot.participants48h.toLocaleString("en-US")}</b>{" "}
                    {story.whyHot.participants48h === 1 ? "account or organization" : "accounts or organizations"} covered or discussed this story,{" "}
                    <b className="num font-semibold text-ink">{story.whyHot.newParticipants6h.toLocaleString("en-US")}</b> of them new in the last 6 hours.
                  </>,
                )}
              </p>
              {!story.whyHot.observationComplete && <p className="mt-2 text-ui-caption leading-relaxed text-ink-4">{t("部分来源近期更新不完整，实际讨论范围可能更大。", "Some sources haven't updated fully recently, so the actual discussion may be larger.")}</p>}
              <p className="mt-2 text-ui-caption text-ink-4">
                <span className="num">{story.whyHot.recentReports24h}</span>{t(" 篇近期报道", story.whyHot.recentReports24h === 1 ? " recent report" : " recent reports")}
                {story.whyHot.rank && hotInNav && (
                  <>
                    <span className="mx-1">·</span>
                    <Link to="/hot" className="text-accent hover:underline">
                      {t(<>热点榜第 {story.whyHot.rank} 名</>, <>No. {story.whyHot.rank} on Trending</>)}
                    </Link>
                  </>
                )}
              </p>
            </RailCard>
          )}
          {story.officialReports.length > 0 && (
            <RailCard title={t("官方一手", "Official")} right={t(`${officialCount} 篇`, `${officialCount} ${officialCount === 1 ? "report" : "reports"}`)}>
              <p className="text-ui-caption text-ink-4">{t("直接了解当事方的说法", "Straight from those involved")}</p>
              <ul className="mt-1 divide-y divide-line-soft">
                {story.officialReports.slice(0, 5).map((r) => (
                  <li key={r.id} className="py-3">
                    <div className="truncate text-ui-caption-md text-ink-4">{r.source.name}</div>
                    <Link viewTransition to={`/items/${r.id}`} className="group mt-1 block text-ui-label-lg font-semibold leading-[1.6] text-ink transition-colors hover:text-accent">
                      {r.title}
                      <IconChevronRight size={13} className="ml-0.5 inline -translate-y-px text-ink-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
              {counts.official > 0 && (
                <button type="button" onClick={showOfficial} className="text-ui-caption text-ink-4 transition-colors hover:text-accent">
                  {t("在时间线筛选全部官方报道", "Show all official reports in the timeline")}
                </button>
              )}
            </RailCard>
          )}
          {story.topics.length > 0 && (
            <RailCard title={t("相关主题", "Related topics")}>
              <div className="flex flex-wrap gap-1.5">
                {story.topics.map((topic) => (
                  <Link viewTransition key={topic.slug} to={`/topics/${topic.slug}`} className="chip">
                    {topicName(topic.slug, topic.name, locale)}
                  </Link>
                ))}
              </div>
            </RailCard>
          )}
          <RailCard title={t("事件记录", "About this story")} className="hidden side:block">
            <dl className="space-y-2 text-ui-caption-lg">
              {story.firstReportAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-4">{t("最早报道", "First reported")}</dt>
                  <dd className="num text-ink-2">
                    <time dateTime={story.firstReportAt}>{monthDayTime(story.firstReportAt, locale)}</time>
                  </dd>
                </div>
              )}
              {story.latestAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-4">{t("最近更新", "Last updated")}</dt>
                  <dd className="num text-ink-2">
                    <time dateTime={story.latestAt}>{monthDayTime(story.latestAt, locale)}</time>
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-3 border-t border-line-soft pt-3 text-ui-caption leading-relaxed text-ink-4">{t("同一事件的报道集中在这里，新的进展会继续补充。", "All the reports on this story are gathered here, and new updates will be added as they come.")}</p>
          </RailCard>
        </aside>
      </div>
    </div>
  );
}
