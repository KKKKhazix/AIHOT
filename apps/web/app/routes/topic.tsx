import { REPORTS, SEO_TITLES, SITE } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { TOPIC_GROUP_EN } from "@aihot/industry/english";
import { topicDefinition, topicName } from "@aihot/contracts/taxonomy";
import { data, redirect, useLoaderData, useNavigation } from "react-router";
import type { Route } from "./+types/topic";
import type { TopicPage } from "@aihot/contracts/site";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, titled, topicLd } from "../lib/seo";
import { DayList, Pagination } from "../features/feed/DayList";
import { BrandMark } from "../components/BrandMark";
import { EmptyState } from "../components/ui/Page";
import { beijingDate } from "@aihot/contracts/time";
import { monthDay, monthDayTime } from "../lib/format";
import { BackLink } from "../components/shell/BackLink";
import { PhoneBar } from "../components/shell/PhoneBar";
import { navUp } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";
import type { TopicPagePart } from "../modules";
import { loadParts } from "../site-modules";
import { apiIn, localeOf, localizePath, pagePath, translator, useLocale, useT, type Locale } from "../lib/i18n";

// Topics are reached from the topics page, as long as the site shows it.
const UP = navUp("/topics");
export const handle: Screen = { home: UP.tab };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

/** Selected items of a topic: shared caches keep the page as long as its api answer (one minute). */
export async function loader({ params, request }: Route.LoaderArgs) {
  if (/[\u0000-\u001f\u007f]/.test(params.slug)) throw data({ message: "not_found" }, { status: 404 });
  const page = params.page ? Number(params.page) : 1;
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw data({ message: "not_found" }, { status: 404 });
  // Page 1 lives at the topic's own address (308), in the reader's language.
  if (params.page === "1") throw redirect(localizePath(`/topics/${encodeURIComponent(params.slug)}`, localeOf(pagePathname(request))), 308);
  const pageData = await loadOr404<TopicPage>(apiIn(`/topics/${encodeURIComponent(params.slug)}?page=${page}`, localeOf(pagePathname(request))), { signal: request.signal });
  return cachedPage(60, { data: pageData });
}

const PARTS = await loadParts((m) => m.topicPage);

type Part = TopicPagePart & { key: string; data: unknown };

/** The modules' parts that have something on this page, in the site's order. */
function partsOf(data: TopicPage): Part[] {
  return PARTS.flatMap(({ name, part }) => {
    const value = data.modules[name];
    return value !== undefined && part.shows(value, data.topic) ? [{ ...part, key: name, data: value }] : [];
  });
}

/**
 * The search snippet: what the topic covers, after when it last changed and its biggest recent events. People search
 * "{name} 最新动态"; the page showed for that query but was rarely clicked while the snippet was the bare definition.
 */
function description(data: TopicPage, parts: Part[], locale: Locale): string {
  const { topic } = data;
  const t = translator(locale);
  let text = topicDefinition(topic.slug, topic.definition, locale);
  const news = parts.flatMap((p) => p.news(p.data)).slice(0, 2).map((title) => title.replace(/[。.]$/u, "")).join(t("；", "; "));
  // The headlines are Chinese: English says only when the topic last changed.
  if (news && topic.latest) text = t(`${monthDay(beijingDate(topic.latest.at))}更新：${news}。${topic.definition}`, `Updated ${monthDay(beijingDate(topic.latest.at), Date.now(), "en")}. ${text}`);
  return text.length > 150 ? `${text.slice(0, 149)}…` : text;
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  if (!loaderData) return [{ title: titled(t("主题不存在", "Topic not found")) }, { name: "robots", content: "noindex" }];
  const data = loaderData.data;
  const { topic, page } = data;
  const name = topicName(topic.slug, topic.name, locale);
  const parts = partsOf(data);
  const path = page > 1 ? `/topics/${topic.slug}/page/${page}` : `/topics/${topic.slug}`;
  const text = page > 1 ? t(`${topic.name} 精选归档（第 ${page} 页）。${topic.definition}`, `${name}: top picks archive, page ${page}. ${topicDefinition(topic.slug, topic.definition, locale)}`) : description(data, parts, locale);
  const crumbs = breadcrumbLd([{ name: SITE.name, path: "/" }, ...UP.crumbs, { name, path: `/topics/${topic.slug}` }], locale);
  const updated = topic.latest ? monthDay(beijingDate(topic.latest.at), Date.now(), locale) : null;
  return pageMeta({
    locale,
    title: page > 1
      ? t(`${topic.name} 精选 · 第 ${page} 页`, `${name} Top Picks · Page ${page}`)
      : t(SEO_TITLES.topic(topic.name, topic.group, updated), ENGLISH?.seoTitles.topic(name, topic.group, updated) ?? SEO_TITLES.topic(name, topic.group, updated)),
    description: text,
    path,
    image: `/og/topics/${topic.slug}.png`,
    // The first page stands in search for the topic; archive pages (/page/2+) shift reports along, and
    // their links stay followed so every report is still reached (aligned with /all?page=2+).
    noindex: !topic.indexable || page > 1,
    jsonLd: page > 1
      ? crumbs
      : [
          topicLd({
            locale,
            path,
            name: t(`${topic.name} 最新动态`, `${name}: Latest News`),
            description: text,
            dateModified: topic.latest?.at ?? null,
            lists: parts.map((p) => ({ name: t(p.name), entries: p.entries(p.data) })),
          }),
          crumbs,
        ],
  });
}

export default function TopicRoute() {
  const t = useT();
  const locale = useLocale();
  const { data } = useLoaderData<typeof loader>();
  const { topic, items, page, pageCount, pageSize } = data;
  const name = topicName(topic.slug, topic.name, locale);
  const selectedEn = ENGLISH?.reports.metricUnits.selectedCount;
  const parts = partsOf(data);
  const href = (p: number) => (p <= 1 ? `/topics/${topic.slug}` : `/topics/${topic.slug}/page/${p}`);
  const first = (page - 1) * pageSize + 1;
  const last = first + items.length - 1;
  // Another page of this topic on its way: the list it replaces dims, if the wait is long enough to notice.
  const navigation = useNavigation();
  const paging = navigation.state === "loading" && !!navigation.location && pagePath(navigation.location.pathname).startsWith(`/topics/${topic.slug}`);
  return (
    <div className="pb-6">
      <PhoneBar back={{ to: UP.to, label: UP.back }} title={name} />
      <BackLink to={UP.to} label={t(`返回${t(UP.back)}`, `Back to ${t(UP.name)}`)} showPrevious={false} />
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-5 pt-3 lg:pt-1">
        <div className="min-w-0 max-w-[760px]">
          <p className="text-ui-caption font-semibold tracking-[0.08em] text-accent">{t(topic.groupName, TOPIC_GROUP_EN[topic.group]?.name ?? topic.groupName)}</p>
          <h1 data-page-title="" className="mt-1.5 flex items-center gap-3 text-ui-heading-lg font-bold leading-[1.3] tracking-[-0.01em] text-ink lg:text-ui-title-2">
            {topic.brand && <BrandMark brand={topic.brand} size={34} />}
            <span>
              {t(
                <>
                  {topic.name}{" "}
                  <span className="whitespace-nowrap font-semibold text-ink-4">最新动态</span>
                </>,
                // English titles the page with the topic's name alone ("OpenAI / ChatGPT", "Tutorials").
                <>{name}</>,
              )}
            </span>
          </h1>
          <p className="mt-1.5 text-pretty text-ui-label-lg leading-relaxed text-ink-3">{topicDefinition(topic.slug, topic.definition, locale)}</p>
          <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-ui-caption-lg text-ink-4">
            <span>
              <span className="num font-semibold text-ink-2">{topic.total.toLocaleString(t("zh-CN", "en-US"))}</span>{t(` ${REPORTS.metricUnits.selectedCount}`, ` ${selectedEn ? (topic.total === 1 ? selectedEn.one : selectedEn.many) : REPORTS.metricUnits.selectedCount}`)}
            </span>
            <span>
              {t(
                <>近 30 天 <span className="num font-semibold text-ink-2">{topic.recent.toLocaleString("zh-CN")}</span> 条</>,
                <><span className="num font-semibold text-ink-2">{topic.recent.toLocaleString("en-US")}</span> in the last 30 days</>,
              )}
            </span>
            <span>
              {t(
                <>共收录 <span className="num font-semibold text-ink-2">{topic.poolTotal.toLocaleString("zh-CN")}</span> 条</>,
                <><span className="num font-semibold text-ink-2">{topic.poolTotal.toLocaleString("en-US")}</span> {topic.poolTotal === 1 ? "item" : "items"} total</>,
              )}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-4 text-ui-caption text-ink-4">
          {topic.latest && (
            <span>
              {t(
                <><time dateTime={topic.latest.at} className="num">{monthDayTime(topic.latest.at)}</time> 更新</>,
                <>Updated <time dateTime={topic.latest.at} className="num">{monthDayTime(topic.latest.at, "en")}</time> GMT+8</>,
              )}
            </span>
          )}
        </div>
      </header>

      {parts.map((p) => (
        <div key={`${p.key}:${topic.slug}`} className="mb-8">
          <p.Block data={p.data} topic={topic} />
        </div>
      ))}

      <h2 className="sr-only">{page === 1 ? t(`${topic.name}的精选`, `Top picks on ${name}`) : t(`精选归档 · 第 ${page} 页`, `Top picks archive · Page ${page}`)}</h2>
      <div className={`transition-opacity ${paging ? "opacity-55 delay-150" : ""}`}>
      {items.length === 0 ? (
        <div className="lg:card">
          <EmptyState title={t("这个主题暂时还没有精选内容", "No top picks on this topic yet")} />
        </div>
      ) : (
        <DayList items={items} tagTopics={data.tagTopics} currentTopicSlug={topic.slug} headerAside={<span className="num whitespace-nowrap">{t(
          <>第 {first}–{last} 条<span className="hidden sm:inline"> · 共 {topic.total.toLocaleString("zh-CN")} 条</span></>,
          <>Items {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")}<span className="hidden sm:inline"> of {topic.total.toLocaleString("en-US")}</span></>,
        )}</span>} />
      )}
      </div>
      <Pagination page={page} pageCount={pageCount} href={href} />
    </div>
  );
}
