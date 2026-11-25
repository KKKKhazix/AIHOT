import { redirect, useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { displayTagIn } from "@aihot/contracts/taxonomy";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { filterKeep, filterParams, hasFeedFilters, itemListLd, listPath, pageMeta, readFilters, siteLd } from "../lib/seo";
import { hotInNav } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { ActiveFilters, CategoryTabs, FeedBar, SearchField, TagClear } from "../features/feed/Filters";
import { apiIn, L, localeOf, localizePath, translator, useLocale, useT } from "../lib/i18n";

export const handle: Screen = { tab: "featured", name: L("精选", "Top Picks") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const locale = localeOf(pagePathname(request));
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(localizePath(`/all${url.search}`, locale));
  const filters = readFilters(url.searchParams);
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(listPath(apiIn("/timeline", locale), filterParams(filters)), { responseHeaders: upstream, signal: request.signal });
  // A minute at most, here and on /all: new selections must not wait longer at the edge or in a browser.
  return cachedPage(60, { data, filters }, upstream);
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  const path = listPath("/", loaderData ? filterParams(loaderData.filters) : {});
  const titles = loaderData?.data.cards.map((c) => c.item.title) ?? [];
  const jsonLd = path === "/" ? [...siteLd(locale), itemListLd("/", t("精选", "Top Picks"), titles, locale)] : undefined;
  const tags = pageMeta({ locale, path, noindex: hasFeedFilters(loaderData?.filters), jsonLd });
  // Webmaster platforms look for their verification tag on the (Chinese) home page only.
  if (path !== "/" || locale === "en") return tags;
  return [...tags, ...Object.entries(SITE.siteVerification).map(([name, content]) => ({ name, content }))];
}

export default function Home() {
  const { data, filters } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const shownTag = filters.tag ? displayTagIn(filters.tag, locale) : null;
  return (
    <div className="pb-6">
      {/* Phones: the bar (精选 | 全部, filter, search), the filter in use, today's hot topics, the feed. */}
      <FeedBar base="/" category={filters.category} channel={filters.channel} />
      <ActiveFilters base="/" category={filters.category} channel={filters.channel} tag={filters.tag} />
      <div className="lg:flex lg:items-center lg:gap-1.5">
        <h1 className="sr-only lg:not-sr-only lg:text-ui-heading-lg lg:font-semibold lg:leading-[1.3] lg:text-ink">
          {shownTag ? `#${shownTag}` : t("精选", "Top Picks")}
        </h1>
        {filters.tag && <TagClear base="/" tag={filters.tag} />}
      </div>
      <div className="mb-5 mt-4 hidden items-center justify-between gap-4 lg:flex">
        <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
        <SearchField keep={filterKeep(filters)} />
      </div>

      {data.hot && hotInNav && <HotTopics entries={data.hot} />}

      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}
