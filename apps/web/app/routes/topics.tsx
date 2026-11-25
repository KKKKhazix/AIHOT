import { namesEn } from "@aihot/contracts/i18n";
import { useLoaderData } from "react-router";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { TOPIC_GROUP_EN } from "@aihot/industry/english";
import { topicDefinition, topicName } from "@aihot/contracts/taxonomy";
import type { Route } from "./+types/topics";
import type { TopicGroup, TopicSummary, TopicsResponse } from "@aihot/contracts/site";
import { apiGet, cachedPage, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, siteUrl } from "../lib/seo";
import { relativeTime } from "../lib/format";
import { IconChevronRight } from "../components/icons";
import { IntentLink } from "../components/ui/IntentLink";
import { BrandMark } from "../components/BrandMark";
import { PhoneBar } from "../components/shell/PhoneBar";
import { navUp } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";
import { apiIn, L, localeOf, localizePath, translator, useLocale, useT, type Locale } from "../lib/i18n";

export const handle: Screen = { home: navUp("/topics").tab, name: L("主题", "Topics") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  return cachedPage(300, await apiGet<TopicsResponse>(apiIn("/topics", localeOf(pagePathname(request))), { signal: request.signal }));
}

/** A topic group's name and line in the page's language (the industry pack's English). */
function groupIn(g: TopicGroup, locale: Locale): TopicGroup {
  const en = locale === "en" ? TOPIC_GROUP_EN[g.key] : undefined;
  return en ? { ...g, name: en.name, blurb: en.blurb } : g;
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  const title = t(SITE.topicsTitle, ENGLISH?.topicsTitle ?? SITE.topicsTitle);
  if (!loaderData) return pageMeta({ locale, title, path: "/topics", image: "/og/pages/topics.png" });
  const { groups, topics } = loaderData;
  const by = t(groups.map((g) => g.name).join("、"), namesEn(groups.map((g) => groupIn(g, locale).name)));
  const indexed = topics.filter((topic) => topic.indexable);
  const named = indexed.slice(0, 6).map((topic) => topicName(topic.slug, topic.name, locale).split(" / ")[0]).join(t("、", ", "));
  const base = siteUrl();
  // The page builds its structured data itself: addresses in its language.
  const url = (path: string) => `${base}${localizePath(path, locale)}`;
  return pageMeta({
    locale,
    title,
    description: t(
      `按${by}整理 ${topics.length} 个${withSubject("主题")}${named ? `（含 ${named} 等）` : ""}，集中看各方向最新精选与进展。`,
      `${topics.length} ${SITE.subject} topics across ${by}${named ? `, including ${named}` : ""}: the latest top picks and developments in each, in one place.`,
    ),
    path: "/topics",
    image: "/og/pages/topics.png",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": `${url("/topics")}#collection`,
        url: url("/topics"),
        name: t(withSubject("主题"), `${SITE.subject} Topics`),
        inLanguage: locale === "en" ? "en" : SITE.locale,
        isPartOf: { "@id": `${url("/")}#website` },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: indexed.length,
          itemListElement: indexed.map((topic, i) => ({ "@type": "ListItem", position: i + 1, name: topicName(topic.slug, topic.name, locale), url: url(`/topics/${topic.slug}`) })),
        },
      },
      breadcrumbLd([{ name: SITE.name, path: "/" }, { name: L("主题", "Topics"), path: "/topics" }], locale),
    ],
  });
}

const BACK = { to: "/more", label: L("我的", "Me") };

/** Phones: a row per topic in a grouped list; wider screens: a card per topic. */
function TopicCard({ topic }: { topic: TopicSummary }) {
  const t = useT();
  const locale = useLocale();
  return (
    <IntentLink
      viewTransition
      to={`/topics/${topic.slug}`}
      className="group flex items-center gap-3 py-3 pl-4 pr-3 transition-colors active:bg-bg-sunk lg:card lg:card-hover lg:h-full lg:flex-col lg:items-stretch lg:gap-0 lg:px-5 lg:py-4 lg:active:bg-surface"
    >
      {topic.brand && (
        <span className="flex shrink-0 lg:hidden">
          <BrandMark brand={topic.brand} size={30} />
        </span>
      )}
      <span className="min-w-0 flex-1 lg:flex lg:flex-col">
        <span className="flex items-center gap-2.5 text-ui-body-plus font-semibold text-ink transition-colors group-hover:text-accent lg:text-ui-body lg:font-bold">
          {topic.brand && (
            <span className="hidden lg:flex">
              <BrandMark brand={topic.brand} size={22} />
            </span>
          )}
          {topicName(topic.slug, topic.name, locale)}
        </span>
        <span className="mt-0.5 line-clamp-1 text-ui-caption-lg leading-[1.6] text-ink-4 lg:mt-1.5 lg:line-clamp-2 lg:flex-1 lg:text-ui-label lg:leading-[1.65] lg:text-ink-2">
          {topic.latest?.title ?? topicDefinition(topic.slug, topic.definition, locale)}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ui-caption-md text-ink-4 lg:mt-3 lg:justify-between">
          {topic.latest && <time dateTime={topic.latest.at} suppressHydrationWarning>{relativeTime(topic.latest.at, Date.now(), locale)}</time>}
          <span>
            {topic.recent > 0 ? (
              t(
                <>
                  近 30 天 <span className="num font-semibold text-ink-3">{topic.recent}</span> 条
                </>,
                <>
                  <span className="num font-semibold text-ink-3">{topic.recent.toLocaleString("en-US")}</span> in the last 30 days
                </>,
              )
            ) : (
              t("近 30 天暂无新精选", "No new top picks in the last 30 days")
            )}
          </span>
        </span>
      </span>
      <IconChevronRight size={16} className="shrink-0 text-ink-4 lg:hidden" />
    </IntentLink>
  );
}

export default function TopicsPage() {
  const t = useT();
  const locale = useLocale();
  const { groups, topics } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <PhoneBar back={BACK} title={t("主题", "Topics")} />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-ui-heading-lg font-semibold leading-[1.3] text-ink">{t(subjectAfter("按主题看"), `Browse ${SITE.subject} by Topic`)}</h1>
        <p className="mt-1.5 text-ui-label leading-relaxed text-ink-3">
          {t(
            <>
              {`按${groups.map((g) => g.name).join("、")}分了 `}
              <span className="num">{topics.length}</span> 个主题，挑关心的方向看最新动态。
            </>,
            <>
              <span className="num">{topics.length}</span> topics across {namesEn(groups.map((g) => groupIn(g, locale).name))}. Pick the ones you care about to see the latest.
            </>,
          )}
        </p>
      </header>
      {groups.map((g) => groupIn(g, locale)).map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-ui-body font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-ui-caption text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface lg:mt-3.5 lg:grid lg:grid-cols-3 lg:gap-3 lg:divide-y-0 lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent xl:grid-cols-4">
            {topics
              .filter((topic) => topic.group === g.key)
              .map((topic) => (
                <li key={topic.slug}>
                  <TopicCard topic={topic} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
