import { useLoaderData } from "react-router";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import type { Route } from "./+types/topics";
import type { TopicSummary, TopicsResponse } from "@aihot/contracts/site";
import { apiGet, edgeTtl, pageExpiresAt } from "../lib/api.server";
import { cachedLoader } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, siteUrl } from "../lib/seo";
import { relativeTime } from "../lib/format";
import { IconChevronRight } from "../components/icons";
import { IntentLink } from "../components/ui/IntentLink";
import { BrandMark } from "../components/BrandMark";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { home: "me", name: "主题" };
export { shouldRevalidate } from "../lib/page-reuse";
export const clientLoader = cachedLoader<typeof loader>();

export async function loader({ request }: { request: Request }) {
  return { ...await apiGet<TopicsResponse>("/api/site/topics", { signal: request.signal }), expiresAt: pageExpiresAt(300) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return pageMeta({ title: SITE.topicsTitle, path: "/topics", image: "/og/pages/topics.png" });
  const { groups, topics } = loaderData;
  const by = groups.map((g) => g.name).join("、");
  const indexed = topics.filter((t) => t.indexable);
  const named = indexed.slice(0, 6).map((t) => t.name.split(" / ")[0]).join("、");
  const base = siteUrl();
  return pageMeta({
    title: SITE.topicsTitle,
    description: `按${by}${subjectAfter("追踪", "最新动态")}：${named ? `${named}等 ` : ""}${topics.length} 个主题，浏览最新精选与重要进展，持续更新。`,
    path: "/topics",
    image: "/og/pages/topics.png",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": `${base}/topics#collection`,
        url: `${base}/topics`,
        name: withSubject("主题"),
        inLanguage: SITE.locale,
        isPartOf: { "@id": `${base}/#website` },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: indexed.length,
          itemListElement: indexed.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, url: `${base}/topics/${t.slug}` })),
        },
      },
      breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "主题", path: "/topics" }]),
    ],
  });
}

export function headers() {
  return edgeTtl(300);
}

/** Phones: a row per topic in a grouped list; wider screens: a card per topic. */
function TopicCard({ t }: { t: TopicSummary }) {
  return (
    <IntentLink
      viewTransition
      to={`/topics/${t.slug}`}
      className="group flex items-center gap-3 py-3 pl-4 pr-3 transition-colors active:bg-bg-sunk lg:card lg:card-hover lg:h-full lg:flex-col lg:items-stretch lg:gap-0 lg:px-5 lg:py-4 lg:active:bg-surface"
    >
      {t.brand && (
        <span className="flex shrink-0 lg:hidden">
          <BrandMark brand={t.brand} size={30} />
        </span>
      )}
      <span className="min-w-0 flex-1 lg:flex lg:flex-col">
        <span className="flex items-center gap-2.5 text-[15.5px] font-semibold text-ink transition-colors group-hover:text-accent lg:text-[15px] lg:font-bold">
          {t.brand && (
            <span className="hidden lg:flex">
              <BrandMark brand={t.brand} size={22} />
            </span>
          )}
          {t.name}
        </span>
        <span className="mt-0.5 line-clamp-1 text-[12.5px] leading-[1.6] text-ink-4 lg:mt-1.5 lg:line-clamp-2 lg:flex-1 lg:text-[13px] lg:leading-[1.65] lg:text-ink-2">
          {t.latest?.title ?? t.definition}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-4 lg:mt-3 lg:justify-between">
          {t.latest && <time dateTime={t.latest.at} suppressHydrationWarning>{relativeTime(t.latest.at)}</time>}
          <span>
            {t.recent > 0 ? (
              <>
                近 30 天 <span className="num font-semibold text-ink-3">{t.recent}</span> 条
              </>
            ) : (
              "近 30 天暂无新精选"
            )}
          </span>
        </span>
      </span>
      <IconChevronRight size={16} className="shrink-0 text-ink-4 lg:hidden" />
    </IntentLink>
  );
}

export default function TopicsPage() {
  const { groups, topics } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="主题" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{subjectAfter("按主题看")}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          {`按${groups.map((g) => g.name).join("、")}浏览 `}
          <span className="num">{topics.length}</span> 个主题，追踪最新精选与重要进展。
        </p>
      </header>
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface lg:mt-3.5 lg:grid lg:grid-cols-3 lg:gap-3 lg:divide-y-0 lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <TopicCard t={t} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
