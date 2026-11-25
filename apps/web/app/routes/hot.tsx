import { useLoaderData } from "react-router";
import type { Route } from "./+types/hot";
import { IntentLink } from "../components/ui/IntentLink";
import type { HotEntryView, HotResponse } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { shortAddresses } from "@aihot/contracts/addresses";
import { SEO_TITLES, SITE, subjectAfter, withSubject } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { archiveLd, breadcrumbLd, pageMeta } from "../lib/seo";
import { monthDay, monthDayTime } from "../lib/format";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/Page";
import { IconChevronDown, IconInfo } from "../components/icons";
import { Sparkline } from "../features/hot/Sparkline";
import { Faces } from "../features/hot/Faces";
import { Delta } from "../features/hot/Delta";
import { PhoneBar } from "../components/shell/PhoneBar";
import { Picture } from "../components/ui/Picture";
import { navUp } from "../components/shell/nav";
import { scrollBehavior } from "../lib/motion";
import type { Screen } from "../components/shell/screens";
import { apiIn, L, localeOf, translator, useLocale, useT, type Locale, type Phrase } from "../lib/i18n";

export const handle: Screen = { tab: navUp("/hot").tab, name: L("热点", "Trending") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  return cachedPage(120, { hot: await loadOr404<HotResponse>(apiIn("/hot", localeOf(pagePathname(request))), { signal: request.signal }) });
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  const hot = loaderData?.hot;
  const entries = hot?.entries ?? [];
  const title = t(SEO_TITLES.hot, ENGLISH?.seoTitles.hot ?? SEO_TITLES.hot);
  // A search result answers "what is hot today" with the three events the page leads with, dated by the ranking.
  const lead = hot?.computedAt && entries.length
    ? t(
        `${subjectAfter(monthDay(beijingDate(hot.computedAt)), "热点")}：${entries.slice(0, 3).map((e) => e.story.title).join("；")}。`,
        `Trending in ${SITE.subject} on ${monthDay(beijingDate(hot.computedAt), undefined, "en")}: ${entries.slice(0, 3).map((e) => e.story.title).join("; ")}.`,
      )
    : "";
  return pageMeta({
    locale,
    title,
    description: t(
      `${lead}${subjectAfter("过去 48 小时", "圈")}讨论最多的 10 个事件：热度、走势，以及都有谁在报道。`,
      `${lead && `${lead} `}The 10 most-discussed ${SITE.subject} stories of the last 48 hours, with their heat, trend and who is covering them.`,
    ),
    path: "/hot",
    image: "/og/pages/hot.png",
    jsonLd: [
      ...(entries.length ? [archiveLd("/hot", title, entries.map((e) => ({ path: `/story/${e.story.publicId}`, name: e.story.title })), locale)] : []),
      breadcrumbLd([{ name: SITE.name, path: "/" }, { name: t(withSubject("热点榜"), `Trending in ${SITE.subject}`), path: "/hot" }], locale),
    ],
  });
}

const BADGES: Record<HotEntryView["badges"][number], { label: Phrase; tone: "hot" | "accent" | "amber"; hint: Phrase }> = {
  surge: { label: L("爆", "Surging"), tone: "hot", hint: L("讨论快速增加", "Discussion is growing fast") },
  new: { label: L("新", "Just in"), tone: "accent", hint: L("首报 6 小时内", "First reported in the last 6 hours") },
  rising: { label: L("发酵中", "Heating up"), tone: "amber", hint: L("讨论仍在增加", "Discussion is still growing") },
};

const RANK_COLOR = ["text-rank-1", "text-rank-2", "text-rank-3"];
const rankColor = (rank: number) => RANK_COLOR[rank - 1] ?? "text-rank-rest";
const pad = (rank: number) => String(rank).padStart(2, "0");
/** A number as the page's language writes it: 1240 in Chinese, 1,240 in English. */
const num = (n: number, locale: Locale) => (locale === "en" ? n.toLocaleString("en-US") : String(n));

/** "某媒体、某账号 等 4 个来源 · 7 位参与者". */
function Voices({ e }: { e: HotEntryView }) {
  const t = useT();
  const locale = useLocale();
  const names = e.sourceNames.slice(0, 2);
  const others = e.sourceCount - names.length;
  return (
    <span className="min-w-0 text-ui-caption-lg leading-snug text-ink-4">
      {/* Lines break between the phrases, never inside one. */}
      <span className="whitespace-nowrap">
        {t(
          <>
            {names.length > 0 && <span className="text-ink-3">{names.join("、")}</span>}
            {e.sourceCount > names.length ? ` 等 ${e.sourceCount} 个来源` : names.length ? " 报道" : `${e.sourceCount} 个来源`}
          </>,
          names.length === 0 ? (
            <>{e.sourceCount} {e.sourceCount === 1 ? "source" : "sources"}</>
          ) : others > 0 ? (
            <><span className="text-ink-3">{names.join(", ")}</span> and {others} more</>
          ) : (
            <>Covered by <span className="text-ink-3">{names.join(" and ")}</span></>
          ),
        )}
      </span>
      <span className="mx-1.5 text-line-strong">·</span>
      <span className="whitespace-nowrap">
        <span className="num">{num(e.participantCount, locale)}</span>{t(" 位参与者", e.participantCount === 1 ? " participant" : " participants")}
      </span>
    </span>
  );
}

function Badges({ e }: { e: HotEntryView }) {
  const t = useT();
  return e.badges.map((b) => (
    <Badge key={b} tone={BADGES[b].tone} title={t(BADGES[b].hint)}>
      {t(BADGES[b].label)}
    </Badge>
  ));
}

/** The whole card opens the event; the title carries the link and stretches over the card. */
function StoryLink({ e, className }: { e: HotEntryView; className: string }) {
  return (
    <IntentLink viewTransition to={`/story/${e.story.publicId}`} className={`transition-colors after:absolute after:inset-0 after:content-[''] ${className}`}>
      {e.story.title}
    </IntentLink>
  );
}

/**
 * The lead card's picture slot when the story has no picture of its own: its day of heat, drawn large
 * on a faint wash, with where it peaked. Without enough comparable hours the text takes the width.
 */
function HeatPanel({ e }: { e: HotEntryView }) {
  const t = useT();
  const locale = useLocale();
  const seen = e.spark.filter((v): v is number => v !== null);
  const peak = Math.max(...seen);
  const peakAt = e.spark.findIndex((v) => v === peak);
  return (
    <div className="order-first flex aspect-[2/1] flex-col rounded-panel bg-accent-softer p-4 ring-1 ring-inset ring-line-soft xl:order-none xl:aspect-[16/10] dark:bg-accent-soft">
      <div className="flex items-baseline justify-between text-ui-caption-md text-ink-4">
        <span className="font-semibold text-ink-3">{t("24 小时热度", "24-hour heat")}</span>
        <span>
          {t("峰值 ", "Peak ")}<span className="mono text-ink-2">{num(Math.round(peak), locale)}</span>
          {peakAt >= 0 && <span> · {peakAt === e.spark.length - 1 ? t("当前", "now") : t(`${e.spark.length - 1 - peakAt} 小时前`, `${e.spark.length - 1 - peakAt}h ago`)}</span>}
        </span>
      </div>
      <Sparkline values={e.spark} className="mt-3 min-h-0 w-full flex-1" />
      <div className="mt-2 flex justify-between text-ui-caption-sm text-ink-4">
        <span>{t("24 小时前", "24h ago")}</span>
        <span>{t("现在", "Now")}</span>
      </div>
    </div>
  );
}

/** No. 1: the event people are talking about most, with its picture, digest, latest turn and day of heat. */
function Lead({ e }: { e: HotEntryView }) {
  const t = useT();
  const locale = useLocale();
  const panel = !e.cover && e.spark.filter((v) => v !== null).length >= 3;
  return (
    <article className="card card-hover group relative flex flex-col overflow-hidden p-5 sm:p-6">
      <div className="flex items-center gap-2.5">
        <span className={`mono text-ui-caption font-bold tracking-[0.16em] ${rankColor(e.rank)}`}>NO.{pad(e.rank)}</span>
        <Badges e={e} />
        <Delta trend={e.trend} pct={e.trendPct} className="ml-auto" />
      </div>
      <div className={`mt-4 grid gap-5 ${e.cover || panel ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)] xl:gap-7" : ""}`}>
        <div className="min-w-0">
          <h2 className="text-ui-heading-plus font-bold leading-[1.4] tracking-[-0.01em] text-ink sm:text-ui-heading-lg-md lg:text-ui-title-1 lg:leading-[1.38]">
            <StoryLink e={e} className="group-hover:text-accent" />
          </h2>
          {e.summary && <p className="mt-3 line-clamp-3 text-ui-body-sm leading-[1.75] text-ink-3">{shortAddresses(e.summary)}</p>}
        </div>
        {e.cover ? (
          <div className="order-first overflow-hidden well rounded-panel xl:order-none">
            <Picture src={e.cover.url} srcSet={e.cover.srcSet} sizes="(min-width: 1280px) calc(28vw - 96px), (min-width: 1024px) calc(58vw - 180px), (min-width: 640px) 568px, calc(100vw - 74px)" width={e.cover.width ?? undefined} height={e.cover.height ?? undefined} alt="" loading="eager" fetchPriority="high" decoding="async" className="aspect-[16/9] size-full object-cover transition-transform duration-500 group-hover:scale-[1.02] xl:aspect-[16/10]" />
          </div>
        ) : (
          panel && <HeatPanel e={e} />
        )}
      </div>
      {/* Side by side while the card is wide enough; on a narrow card the day of heat and the index
          move under the voices, to the right, instead of squeezing them into a column. */}
      <div className="mt-auto flex flex-wrap items-end gap-x-6 gap-y-4 pt-5">
        <div className="min-w-0 flex-[1_1_18rem] space-y-2.5">
          {e.latest && (
            <p className="line-clamp-2 text-ui-label leading-[1.7] text-ink-2">
              <span className="mr-2 text-ui-caption font-semibold text-accent">{t("最新进展", "Latest update")}</span>
              {e.latest}
            </p>
          )}
          {/* The voices drop under the faces when the card is too narrow for both (small phones). */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Faces participants={e.participants} total={e.participantCount} size={24} />
            <Voices e={e} />
          </div>
        </div>
        <div className="flex w-full shrink-0 items-end justify-between gap-5 sm:ml-auto sm:w-auto sm:justify-end">
          {!panel && <Sparkline values={e.spark} className="h-10 w-[140px]" />}
          <div className="text-right">
            <div className="mono text-ui-display-1 font-semibold leading-none tracking-[-0.03em] text-ink">{num(Math.round(e.heat), locale)}</div>
            <div className="mt-1 text-ui-caption-md text-ink-4">{t("热度指数", "Heat index")}</div>
          </div>
        </div>
      </div>
    </article>
  );
}

/** No. 2 and 3: the same card, smaller, without the picture. */
function Runner({ e }: { e: HotEntryView }) {
  const t = useT();
  const locale = useLocale();
  return (
    <article className="card card-hover group relative flex flex-col px-5 py-4">
      <div className="flex items-center gap-2.5">
        <span className={`mono text-ui-caption font-bold tracking-[0.16em] ${rankColor(e.rank)}`}>NO.{pad(e.rank)}</span>
        <Badges e={e} />
        <Delta trend={e.trend} pct={e.trendPct} className="ml-auto" />
      </div>
      <h2 className="mt-2.5 line-clamp-2 text-ui-body-lg font-[650] leading-[1.5] text-ink">
        <StoryLink e={e} className="group-hover:text-accent" />
      </h2>
      {e.summary && <p className="mt-1.5 line-clamp-2 text-ui-label leading-[1.7] text-ink-3 lg:line-clamp-1">{shortAddresses(e.summary)}</p>}
      <div className="mt-auto flex flex-wrap items-end justify-between gap-x-4 gap-y-2 pt-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Faces participants={e.participants} total={e.participantCount} size={20} />
          <span className="text-ui-caption text-ink-4">
            <span className="whitespace-nowrap"><span className="num">{e.sourceCount}</span>{t(" 个来源", e.sourceCount === 1 ? " source" : " sources")}</span> ·{" "}
            <span className="whitespace-nowrap"><span className="num">{num(e.participantCount, locale)}</span>{t(" 位参与者", e.participantCount === 1 ? " participant" : " participants")}</span>
          </span>
        </div>
        <div className="ml-auto flex items-end gap-3">
          <Sparkline values={e.spark} className="h-7 w-[92px]" />
          <span className="mono text-ui-heading-lg font-semibold leading-none tracking-[-0.02em] text-ink">{num(Math.round(e.heat), locale)}</span>
        </div>
      </div>
    </article>
  );
}

/** No. 4–10: a row each, with a line of the digest, faces, the day of heat and the index. */
function Row({ e }: { e: HotEntryView }) {
  const t = useT();
  const locale = useLocale();
  return (
    <li className="group relative grid grid-cols-[30px_minmax(0,1fr)] items-start gap-x-3 px-4 py-3 transition-colors hover:bg-bg-sunk/70 sm:px-5 wide:grid-cols-[44px_minmax(0,1fr)_auto_104px_76px] wide:items-center wide:gap-x-6 wide:px-6 wide:py-3.5 dark:hover:bg-bg-muted/40">
      <span className={`mono text-ui-body-lg font-semibold leading-[24px] wide:text-ui-subheading-sm ${rankColor(e.rank)}`} aria-label={t(`热度排名第 ${e.rank} 位`, `No. ${e.rank} by heat`)}>
        {pad(e.rank)}
      </span>
      <div className="min-w-0">
        <h3 className="text-ui-body font-[650] leading-[1.55] text-ink">
          <StoryLink e={e} className="group-hover:text-accent" />
          {e.badges.length > 0 && (
            <span className="ml-2 inline-flex translate-y-[-2px] gap-1 align-middle">
              <Badges e={e} />
            </span>
          )}
        </h3>
        {e.summary && <p className="mt-0.5 line-clamp-2 text-ui-label leading-[1.65] text-ink-4 wide:line-clamp-1">{shortAddresses(e.summary)}</p>}
        <div className="mt-2 flex items-center gap-2.5 wide:hidden">
          <Faces participants={e.participants} total={e.participantCount} size={20} />
          <span className="text-ui-caption text-ink-4">
            <span className="num">{e.sourceCount}</span>{t(" 个来源", e.sourceCount === 1 ? " source" : " sources")}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span className="mono text-ui-subheading-sm font-semibold leading-none text-ink">{num(Math.round(e.heat), locale)}</span>
            <Delta trend={e.trend} pct={e.trendPct} />
          </span>
        </div>
      </div>
      <div className="hidden items-center gap-2.5 wide:flex">
        <Faces participants={e.participants} total={e.participantCount} size={20} />
      </div>
      <Sparkline values={e.spark} className="hidden h-7 w-[104px] wide:block" />
      <div className="hidden flex-col items-end gap-1 wide:flex">
        <span className="mono text-ui-heading font-semibold leading-none tracking-[-0.02em] text-ink">{num(Math.round(e.heat), locale)}</span>
        <Delta trend={e.trend} pct={e.trendPct} />
      </div>
    </li>
  );
}

/** Opens "热度是怎么算的" at the foot of the page and brings it into view. */
function showMethod() {
  const method = document.getElementById("hot-method") as HTMLDetailsElement | null;
  if (!method) return;
  method.open = true;
  method.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
}

export default function HotPage() {
  const t = useT();
  const { hot } = useLoaderData<typeof loader>();
  const [lead, ...rest] = hot.entries;
  const runners = rest.slice(0, 2);
  const others = rest.slice(2);
  return (
    <div className="pb-10">
      <PhoneBar
        title={t("热点", "Trending")}
        actions={
          <button type="button" onClick={showMethod} className="flex h-11 items-center gap-1 px-3 text-ui-body-sm text-accent active:opacity-50">
            <IconInfo size={17} />{t(" 怎么算", " How it works")}
          </button>
        }
      />
      <header className="pb-3 pt-0.5 lg:flex lg:flex-wrap lg:items-end lg:justify-between lg:gap-x-6 lg:gap-y-2 lg:pb-5 lg:pt-1">
        <div>
          <div className="hidden items-center gap-2 text-ui-caption font-semibold tracking-[0.08em] text-hot lg:flex">
            <span className="relative flex size-2" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-hot opacity-30" />
              <span className="relative inline-flex size-2 rounded-full bg-hot" />
            </span>
            {t("实时热度", "Live")}
          </div>
          <h1 data-page-title="" className="text-ui-title-5 font-bold leading-[1.25] tracking-[-0.01em] text-ink lg:mt-1.5 lg:text-ui-title-2 lg:leading-[1.3]">{t(withSubject("热点榜"), `Trending in ${SITE.subject}`)}</h1>
          <p className="mt-1 text-ui-caption-lg leading-relaxed text-ink-4 lg:mt-1.5 lg:text-ui-label-lg lg:text-ink-3">
            {t(
              <>过去 {hot.windowHours}{` 小时，${withSubject("圈")}讨论最多的 `}{hot.entries.length || 10} 件事</>,
              <>The {hot.entries.length || 10} most-discussed {SITE.subject} {(hot.entries.length || 10) === 1 ? "story" : "stories"} of the last {hot.windowHours} hours</>,
            )}
            {hot.computedAt && (
              <span className="lg:hidden">
                {" · "}
                {t(<><span className="num">{monthDayTime(hot.computedAt)}</span> 更新</>, <>Updated <span className="num">{monthDayTime(hot.computedAt, "en")}</span> GMT+8</>)}
              </span>
            )}
          </p>
        </div>
        {hot.computedAt && (
          <p className="hidden text-ui-caption text-ink-4 lg:block">
            {t(<><span className="num">{monthDayTime(hot.computedAt)}</span> 更新 · 按讨论热度排序</>, <>Updated <span className="num">{monthDayTime(hot.computedAt, "en")}</span> GMT+8 · Ranked by heat</>)}
          </p>
        )}
      </header>

      {!lead ? (
        <div className="card rounded-sheet">
          <EmptyState title={t("暂时没有热点", "Nothing trending right now")}>{t("还没有足够多来源共同讨论的事件。", "No story is being discussed by enough sources yet.")}</EmptyState>
        </div>
      ) : (
        <>
          <section aria-label={t("热度前三", "Top 3 by heat")} className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:gap-4">
            <div className="grid grid-cols-1 lg:col-span-7 lg:row-span-2 xl:col-span-8">
              <Lead e={lead} />
            </div>
            {runners.map((e) => (
              <div key={e.story.publicId} className="grid grid-cols-1 lg:col-span-5 xl:col-span-4">
                <Runner e={e} />
              </div>
            ))}
          </section>

          {others.length > 0 && (
            <section aria-label={t("其余热点", "More trending stories")} className="mt-6 lg:mt-7">
              <div className="mb-3 flex items-baseline justify-between px-1">
                <h2 className="text-ui-body font-semibold text-ink">
                  {t("继续看 ", "Also trending ")}<span className="num font-normal text-ink-4">No.{pad(others[0]!.rank)}–{pad(others[others.length - 1]!.rank)}</span>
                </h2>
                <span className="hidden text-ui-caption text-ink-4 wide:block">{t("参与者 · 24 小时走势 · 热度指数", "Participants · 24-hour trend · Heat index")}</span>
              </div>
              <ol className="card divide-y divide-line-soft overflow-hidden">
                {others.map((e) => (
                  <Row key={e.story.publicId} e={e} />
                ))}
              </ol>
            </section>
          )}
        </>
      )}

      <details id="hot-method" className="disclosure group/method mt-8 scroll-mt-[calc(var(--bar-h)+16px)] text-ui-caption text-ink-4">
        <summary className="flex items-center gap-1.5 py-1 transition-colors hover:text-ink-2">
          <IconInfo size={15} />
          {t("热度是怎么算的？", "How is heat calculated?")}
          <span className="ml-auto inline-flex items-center gap-0.5">
            <span className="group-open/method:hidden">{t("了解榜单", "Learn more")}</span>
            <span className="hidden group-open/method:inline">{t("收起", "Hide")}</span>
            <IconChevronDown size={13} className="transition-transform duration-200 group-open/method:rotate-180" />
          </span>
        </summary>
        <div className="max-w-[760px] space-y-2 pb-2 pl-[21px] pt-2 leading-[1.75] text-ink-3">
          <p>
            {t(
              "热度看的是有多少账号和机构在讨论同一件事：同一家重复发只算一次，越近的讨论分量越重，每过 24 小时减半。它反映讨论有多热闹，不代表报道质量。",
              "Heat measures how many accounts and organizations are discussing the same story. Repeat posts by the same account or organization count once, and newer posts carry more weight, halving every 24 hours. Heat shows how lively the discussion is, not how good the coverage is.",
            )}
          </p>
          <p>
            {t(
              "榜单只看过去 48 小时。走势只拿同一批一直在看的来源比较，反映的是我们看得到的范围，不代表全网人数；没有可比的历史时，不画走势线。",
              "The list covers the last 48 hours. Trend lines only compare sources we've tracked continuously, so they reflect our coverage rather than everyone online. When there isn't enough comparable history, no trend line is shown.",
            )}
          </p>
          <p>
            {t(
              "来源名单只列能公开阅读的报道；参与讨论的还有一些不在名单里展示的账号和机构。同一家机构在不同平台发帖合并算一家，所以参与者可能比来源还少。点进事件，可以看各方的报道和观点。",
              "The source list includes only public reports; some accounts and organizations in the discussion are not shown in it. An organization posting on several platforms counts as one, so there can be fewer participants than sources. Open a story to see the reports and views from different sides.",
            )}
          </p>
          <dl className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
            {Object.values(BADGES).map((b) => (
              <div key={b.label.zh} className="flex items-center gap-1.5">
                <dt>
                  <Badge tone={b.tone}>{t(b.label)}</Badge>
                </dt>
                <dd>{t(b.hint)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    </div>
  );
}
