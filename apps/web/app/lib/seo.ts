// Page metadata from one place: title template, canonical address, OG images, robots; and list addresses,
// with the feed filters they carry. The site's name and wording come from site/site.ts;
//; its address from SITE_URL.
import type { MetaDescriptor } from "react-router";
import {
  REPORT_NAMES, REPORT_NAMES_EN, reportDateLabel, reportDateLabelEn, STORY_INDEX_MIN_SOURCES, type ReportDetail, type StoryDetail, type TimelineFilters,
} from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey, sectionLabelIn, topicName } from "@aihot/contracts/taxonomy";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import { ENGLISH, WAITING_ENGLISH_SECONDS, needsEnglish } from "@aihot/contracts/english";
import { feedPath, hasEnglish, localizePath, ogPath, translator, type Locale, type Text } from "./i18n.ts";

/**
 * The site's address: SITE_URL while rendering on the server (what crawlers and share previews read),
 * the page's own origin in the browser.
 */
export function siteUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return (process.env.SITE_URL || SITE.defaultUrl).replace(/\/+$/, "");
}

const HOME_TITLE = SITE.homeTitle;
const SITE_DESCRIPTION = SITE.description;

/** A site path's full address on a page in this language: an English page's links to English editions carry /en. */
const address = (path: string, locale: Locale) => `${siteUrl()}${localizePath(path, locale)}`;

/** The page's language as structured data writes it. */
const inLanguage = (locale: Locale) => (locale === "en" ? "en" : SITE.locale);

/** The site's home in this language, as the WebSite node pages say they are part of. */
const websiteRef = (locale: Locale) => ({ "@id": `${address("/", locale)}#website` });

export interface PageMetaInput {
  /** The page's language: an English page's address carries /en and its defaults are the site's English. */
  locale: Locale;
  title?: string | null;
  /** Use `title` verbatim as the document title (no " · <site>" suffix). */
  rawTitle?: boolean;
  description?: string | null;
  path: string;
  /** Optional in-site Markdown representation for machine readers. */
  markdown?: string;
  image?: string | null;
  noindex?: boolean;
  /** Only Google is asked not to index the page; other engines index it unless `noindex`. */
  googleNoindex?: boolean;
  nofollow?: boolean;
  type?: "website" | "article";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
}

/**
 * A list's address from the parameters it applied (unset ones left out): a page's own address (canonical,
 * og:url), and the api list it reads. Tracking and unknown parameters (`?from=timeline`, `utm_*`) never
 * become part of it. The page caches keep one copy across such parameters, so the address in that copy
 * must not depend on them either.
 */
export function listPath(path: string, params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The feed filters an address asks for; an unknown channel or category means none. */
export function readFilters(params: URLSearchParams): TimelineFilters {
  const channel = params.get("channel") ?? "all";
  const category = params.get("category");
  return {
    channel: isChannelKey(channel) ? channel : "all",
    category: category && isCategoryKey(category) ? category : null,
    tag: params.get("tag")?.trim() || null,
  };
}

/** Feed filters as list address parameters: the default channel and unset filters are left out. */
export function filterParams(f: TimelineFilters) {
  return { channel: f.channel === "all" ? null : f.channel, category: f.category, tag: f.tag };
}

/** Links in shared feed HTML carry only the destination's filters. Pagination starts over unless requested. */
export function feedListPath(base: string, params: URLSearchParams, changes: Partial<Record<"q" | "tab" | "page" | "tag" | "category" | "channel", string | number | null>>) {
  const q = base === "/all" ? params.get("q")?.trim().slice(0, 200) : null;
  return listPath(base, {
    ...filterParams(readFilters(params)), q, tab: q && params.get("tab") === "relevance" ? "relevance" : null,
    ...changes,
  });
}

/** Filter combinations are browsing views; the unfiltered feed and its archive pages remain indexable. */
export function hasFeedFilters(filters: TimelineFilters | undefined): boolean {
  return !!filters && (filters.channel !== "all" || !!filters.category || !!filters.tag);
}

/** "Title · Site". */
export function titled(title: string): string {
  return `${title} · ${SITE.name}`;
}

/** The temporary noindex ends when the English title arrives. */
function waitingForTitle(locale: Locale, title?: string | null) {
  return locale === "en" && needsEnglish(title);
}

export function titleCacheSeconds(seconds: number, locale: Locale, indexableTitle: string | null) {
  return waitingForTitle(locale, indexableTitle) ? Math.min(seconds, WAITING_ENGLISH_SECONDS) : seconds;
}

export function pageMeta(input: PageMetaInput): MetaDescriptor[] {
  const base = siteUrl();
  const english = input.locale === "en" ? ENGLISH : null;
  const home = english?.homeTitle ?? HOME_TITLE;
  const title = input.title ? (input.rawTitle ? input.title : titled(input.title)) : home;
  const description = input.description ?? english?.description ?? SITE_DESCRIPTION;
  const url = address(input.path, input.locale);
  const image = input.image?.startsWith("http") ? input.image : `${base}${ogPath(input.image || "/og/site.png", input.locale)}`;
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:site_name", content: SITE.name },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: input.title ?? home },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:locale", content: input.locale === "en" ? "en_US" : SITE.locale.replace("-", "_") },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: input.title ?? home },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  // The Markdown versions are the Chinese pages'.
  if (input.markdown && input.locale === "zh") tags.push({ tagName: "link", rel: "alternate", type: "text/markdown", href: `${base}${input.markdown}` });
  // An English page whose own title is still Chinese (its words not translated yet) stays out of search until they are.
  const noindex = input.noindex || waitingForTitle(input.locale, input.title);
  if (noindex) tags.push({ name: "robots", content: input.nofollow ? "noindex, nofollow" : "noindex, follow" });
  else {
    // A page in both languages names both, the Chinese as the default, so search engines show readers their own.
    if (ENGLISH && hasEnglish(input.path.split(/[?#]/)[0]!)) {
      const zh = address(input.path, "zh");
      tags.push(
        { tagName: "link", rel: "alternate", hrefLang: SITE.locale, href: zh },
        { tagName: "link", rel: "alternate", hrefLang: "en", href: address(input.path, "en") },
        { tagName: "link", rel: "alternate", hrefLang: "x-default", href: zh },
      );
    }
    // Search results and Discover may show an indexable page's picture large, as they do for news sites.
    tags.push({ name: "robots", content: "max-image-preview:large" });
    if (input.googleNoindex) tags.push({ name: "googlebot", content: "noindex" });
  }
  if (input.jsonLd) tags.push({ "script:ld+json": input.jsonLd });
  return tags;
}

export function organizationLd() {
  const base = siteUrl();
  const founder = SITE.organization.founder;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${base}/#organization`,
    name: SITE.organization.name,
    url: base,
    logo: `${base}/icon.png`,
    ...(founder ? {
      founder: {
        "@type": "Person",
        name: founder.name,
        ...(founder.alternateName ? { alternateName: founder.alternateName } : {}),
        ...(founder.jobTitle ? { jobTitle: founder.jobTitle } : {}),
        ...(founder.description ? { description: founder.description } : {}),
        ...(founder.sameAs?.length ? { sameAs: founder.sameAs } : {}),
      },
    } : {}),
  };
}

export function breadcrumbLd(items: Array<{ name: Text; path: string }>, locale: Locale) {
  const t = translator(locale);
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: t(it.name), item: address(it.path, locale) })),
  };
}

const orgRef = () => ({ "@id": `${siteUrl()}/#organization` });

/**
 * The site as an article's author and publisher, spelled out: the id alone resolves only where the full
 * Organization node is on the same page (the home and about pages), so an article page would name no one.
 */
function siteOrganization() {
  const base = siteUrl();
  return { "@type": "Organization", "@id": `${base}/#organization`, name: SITE.organization.name, url: base, logo: { "@type": "ImageObject", url: `${base}/icon.png` } };
}

/**
 * The home page's machine description: the site, and the site as a dataset with its feeds and API.
 * Model-written content never names a person as its author.
 */
export function siteLd(locale: Locale) {
  const base = siteUrl();
  const t = translator(locale);
  const english = locale === "en" ? ENGLISH : null;
  // The site's address as the Chinese home has always given it (no trailing slash); the English home is /en.
  const home = locale === "en" ? address("/", locale) : base;
  const alternateNames = (SITE as { alternateNames?: readonly string[] }).alternateNames;
  return [
    organizationLd(),
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      ...websiteRef(locale),
      name: SITE.name,
      ...(alternateNames?.length ? { alternateName: alternateNames } : {}),
      url: home,
      description: english?.description ?? SITE_DESCRIPTION,
      inLanguage: inLanguage(locale),
      publisher: orgRef(),
    },
    {
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": `${address("/", locale)}#dataset`,
      name: t(`${SITE.name} — ${withSubject("行业动态数据集")}`, `${SITE.name} — ${SITE.subject} news dataset`),
      description: t(
        `${subjectAfter("持续更新的中文", "行业动态")}：每条附中文摘要、评分与原文出处，${subjectAfter("另有每日精选与", "日报")}，可通过 RSS 与公开 API 获取。`,
        `${SITE.subject} news, updated around the clock: every item has a summary, an AI score and a link to the original, plus daily top picks and the ${SITE.subject} Daily, all available via RSS and a public API.`,
      ),
      url: home,
      inLanguage: inLanguage(locale),
      isAccessibleForFree: true,
      ...(SITE.since ? { temporalCoverage: `${SITE.since}/..` } : {}),
      keywords: english?.keywords ?? SITE.keywords,
      creator: orgRef(),
      publisher: orgRef(),
      distribution: [
        { "@type": "DataDownload", name: t("精选 RSS", "Top Picks RSS"), encodingFormat: "application/rss+xml", contentUrl: `${base}${feedPath("/feed.xml", locale)}` },
        { "@type": "DataDownload", name: t("全部动态 RSS", `All ${SITE.subject} News RSS`), encodingFormat: "application/rss+xml", contentUrl: `${base}${feedPath("/feed/all.xml", locale)}` },
        { "@type": "DataDownload", name: t(`${withSubject("日报")} RSS`, `${SITE.subject} Daily RSS`), encodingFormat: "application/rss+xml", contentUrl: `${base}${feedPath("/feed/daily.xml", locale)}` },
        { "@type": "DataDownload", name: t(`${withSubject("周报")} RSS`, `${SITE.subject} Weekly RSS`), encodingFormat: "application/rss+xml", contentUrl: `${base}${feedPath("/feed/weekly.xml", locale)}` },
        { "@type": "DataDownload", name: t(`${withSubject("月报")} RSS`, `${SITE.subject} Monthly RSS`), encodingFormat: "application/rss+xml", contentUrl: `${base}${feedPath("/feed/monthly.xml", locale)}` },
        { "@type": "DataDownload", name: t("公开 API v1", "Public API v1"), encodingFormat: "application/json", contentUrl: `${base}/api/v1/items` },
        { "@type": "DataDownload", name: "OpenAPI", encodingFormat: "application/json", contentUrl: `${base}/openapi-v1.json` },
      ],
    },
  ];
}

/**
 * A list's entries by their visible titles. No entry URLs: item pages are mostly noindex, and a
 * list item must point at an indexable page; the list itself is the signal.
 */
export function itemListLd(path: string, name: string, titles: string[], locale: Locale) {
  const names = titles.slice(0, 30);
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${SITE.name} · ${name}`,
    url: address(path, locale),
    numberOfItems: names.length,
    itemListElement: names.map((n, i) => ({ "@type": "ListItem", position: i + 1, name: n })),
  };
}

/** An item page: the site's reading of a third-party report, based on (not claiming) the original. */
export function articleLd(input: { locale: Locale; path: string; headline: string; description?: string | null; publishedAt?: string | null; modifiedAt?: string | null; image?: string | null; basedOn?: string | null; section?: string[] }) {
  const base = siteUrl();
  const url = address(input.path, input.locale);
  const description = input.description?.trim();
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "@id": `${url}#article`,
    isPartOf: websiteRef(input.locale),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline: input.headline.slice(0, 110),
    ...(description ? { description: description.slice(0, 300) } : {}),
    inLanguage: inLanguage(input.locale),
    ...(input.publishedAt ? { datePublished: input.publishedAt } : {}),
    ...(input.modifiedAt ? { dateModified: input.modifiedAt } : {}),
    ...(input.image ? { image: new URL(ogPath(input.image, input.locale), base).href } : {}),
    ...(input.section?.length ? { articleSection: input.section } : {}),
    isAccessibleForFree: true,
    author: siteOrganization(),
    publisher: siteOrganization(),
    ...(input.basedOn ? { isBasedOn: input.basedOn } : {}),
  };
}

/** An archive whose entries are indexable pages of their own (report issues). */
export function archiveLd(path: string, name: string, entries: Array<{ path: string; name: string }>, locale: Locale) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url: address(path, locale),
    numberOfItems: entries.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: entries.map((e, i) => ({ "@type": "ListItem", position: i + 1, name: e.name, url: address(e.path, locale) })),
  };
}

/** An issue's date and actual editorial lead, falling back only to a still-public visible highlight. */
export function reportTitle(report: ReportDetail, locale: Locale): string {
  // Without a lead, the first highlight the issue carries as an entry heads it; the reports a thin daily's
  // highlights were filled with are not its news.
  let lead = report.lead?.title.trim();
  if (!lead) {
    const entries = new Set(report.sections.flatMap((s) => s.items.map((i) => i.itemId)));
    lead = report.highlights.find((item) => item.available && entries.has(item.itemId))?.title.trim();
  }
  const t = translator(locale);
  const name = t(
    `${withSubject(REPORT_NAMES[report.kind])}｜${reportDateLabel(report.kind, report.key)}`,
    `${SITE.subject} ${REPORT_NAMES_EN[report.kind]} | ${reportDateLabelEn(report.kind, report.key)}`,
  );
  return lead ? t(`${name}：${lead}`, `${name}: ${lead}`) : name;
}

/**
 * What an issue says, for search results. A daily by its own headlines: its lead's paragraph is that article's
 * own description, and two pages that read alike compete for one result. A weekly or monthly by its lead or
 * overview. Null when the issue has neither.
 */
export function reportDescription(r: ReportDetail, locale: Locale): string | null {
  const t = translator(locale);
  const date = t(reportDateLabel(r.kind, r.key), reportDateLabelEn(r.kind, r.key));
  if (r.kind === "daily") {
    const titles = [...new Set([r.lead?.title, ...r.highlights.filter((h) => h.available).map((h) => h.title)]
      .map((title) => title?.trim()).filter((title): title is string => !!title))];
    if (titles.length) {
      // As many as a result shows in full (about 150 characters; English words take more of them).
      let text = titles[0]!;
      for (const title of titles.slice(1)) {
        if (text.length + title.length > t(120, 140)) break;
        text += t(`；${title}`, `; ${title}`);
      }
      return t(
        `${date} ${withSubject("新闻")}：${text}${/[。！？!?]$/.test(text) ? "" : "。"}`,
        `${SITE.subject} news, ${date}: ${text}${/[.!?]$/.test(text) ? "" : "."}`,
      );
    }
  }
  const lead = r.lead?.leadParagraph ?? r.overview?.slice(0, t(150, 220));
  return lead ? t(`${date} ${withSubject("资讯")}：${lead}`, `${SITE.subject} news, ${date}: ${lead}`) : null;
}

/** One report issue: an editorial round-up by the site (no personal byline), sections as its sections. */
export function reportLd(r: ReportDetail, path: string, description: string, locale: Locale) {
  return articleLd({
    locale,
    path,
    headline: reportTitle(r, locale),
    description,
    publishedAt: r.generatedAt,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    section: [...new Set(r.sections.map((s) => sectionLabelIn(s.label, locale, s.key)))],
  });
}

/** The event page collects public reports; their publication times do not date the page itself. */
export function storyLd(story: StoryDetail, locale: Locale) {
  const base = siteUrl();
  const t = translator(locale);
  const url = address(`/story/${story.publicId}`, locale);
  const description = story.digest ?? story.summary ?? story.excerpt?.text;
  const updated = [story.latestAt, story.digest ? story.digestUpdatedAt : null]
    .filter((at): at is string => !!at).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const reports = [...story.timeline].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    url,
    name: story.title,
    ...(description ? { description } : {}),
    image: `${base}${ogPath(`/og/stories/${story.publicId}.png`, locale)}`,
    inLanguage: inLanguage(locale),
    isPartOf: websiteRef(locale),
    publisher: siteOrganization(),
    ...(updated ? { dateModified: updated } : {}),
    ...(reports.length ? {
      mainEntity: {
        "@type": "ItemList",
        name: t("报道时间线", "Coverage timeline"),
        itemListOrder: "https://schema.org/ItemListOrderDescending",
        numberOfItems: reports.length,
        itemListElement: reports.map((report, index) => ({ "@type": "ListItem", position: index + 1, name: report.title })),
      },
    } : {}),
  };
}

/**
 * An indexable event page with a site-authored digest also carries a NewsArticle node, dated by the
 * digest's own time (never a third-party report's publication time).
 */
export function storyArticleLd(story: StoryDetail, locale: Locale) {
  if (story.sourceCount < STORY_INDEX_MIN_SOURCES || !story.digest || !story.digestUpdatedAt) return null;
  const updated = [story.latestAt, story.digestUpdatedAt]
    .filter((at): at is string => !!at).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return articleLd({
    locale,
    path: `/story/${story.publicId}`,
    headline: story.title,
    description: story.digest,
    publishedAt: story.digestUpdatedAt,
    modifiedAt: updated && updated !== story.digestUpdatedAt ? updated : undefined,
    image: `/og/stories/${story.publicId}.png`,
    section: story.topics.map((t) => topicName(t.slug, t.name, locale)),
  });
}

/** A topic page: the collection, when a report last reached it, and the lists its parts show. */
export function topicLd(input: {
  locale: Locale;
  path: string;
  name: string;
  description: string;
  dateModified: string | null;
  lists: Array<{ name: string; entries: Array<{ title: string; href: string | null }> }>;
}) {
  const url = address(input.path, input.locale);
  // Entries name their event page when they have one (event pages are indexable, most article pages are not).
  const lists = input.lists.filter((l) => l.entries.length > 0).map((l) => ({
    "@type": "ItemList",
    name: `${input.name} · ${l.name}`,
    numberOfItems: l.entries.length,
    itemListElement: l.entries.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: e.title,
      ...(e.href?.startsWith("/story/") ? { url: address(e.href, input.locale) } : {}),
    })),
  }));
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    url,
    name: input.name,
    description: input.description,
    inLanguage: inLanguage(input.locale),
    isPartOf: websiteRef(input.locale),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    ...(lists.length > 0 ? { mainEntity: lists.length === 1 ? lists[0] : lists } : {}),
  };
}
