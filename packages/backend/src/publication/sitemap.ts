// Sitemap from the same public metadata as pages: /sitemap.xml is an index of one file per section, so
// Search Console reports indexing section by section, plus a news section of the last 48 hours. On a site with
// an English edition, every page that has one is listed again at /en<path>, in sections of their own (en-…): an
// article or event once its title is in English (until then its English page stays out of search). Process
// and HTTP caches share one five-minute deadline; a saved copy may bridge a restart only for the remainder
// of that original lifetime.
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPORT_NAMES, reportDateLabel, STORY_INDEX_MIN_SOURCES, type ReportKind } from "@aihot/contracts/site";
import { ENGLISH, needsEnglish } from "@aihot/contracts/english";
import { hasEnglish } from "@aihot/contracts/reader-pages";
import { inLanguage, localeOf, pagePath } from "@aihot/contracts/i18n";
import { ABOUT, ACCESS, AGENT, POLICY, SITE, withSubject } from "@aihot/site";
import { config, REPO_ROOT } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { loadChangelog } from "../site/meta.ts";
import { latestHotRanking } from "./hot.ts";
import { eventPageCondition, ITEM_FROM, thinPageCondition } from "./items.ts";
import { sql } from "../db.ts";
import { shared } from "../lib/cache.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { evidenceCondition, listedCondition, selectedCondition, storyReportCondition } from "./scope.ts";
import { usableCopy } from "./english.ts";
import { issueLead, unavailableHeadlineIds } from "./reports.ts";
import { storyTexts } from "./story-text.ts";
import { topicPageCounts } from "./topics.ts";
import { serverModules, type SitemapEntry } from "../modules.ts";

const MAX_URLS = 45_000;
/** Google News Sitemap limit per file. */
const MAX_NEWS_URLS = 1000;
const TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "sitemap-last.json");
const INDEX = "sitemap.xml";
/** The news section's window: what appeared or changed this long ago or since. */
const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;
const NEWS = "news.xml";
/** ISO 639 code for <news:language> (Google News specifies lowercase zh-cn / zh-tw for Chinese). */
const NEWS_LANGUAGE = SITE.locale.toLowerCase().startsWith("zh-")
  ? SITE.locale.toLowerCase()
  : SITE.locale.split("-")[0]!.toLowerCase();

/** The index under `sitemap.xml`, each section under `<section>.xml`. */
interface SitemapDocument { files: Record<string, string>; expiresAt: number }

let lastGood: SitemapDocument | null = null;

/**
 * `newsAt`: the page's own date, which puts it in the news section while recent (and dates it there only).
 * `englishTitle`: an article's or event's title in English, which its English address's identity follows.
 */
type Entry = SitemapEntry & { section?: string; newsAt?: Date | null; newsTitle?: string | null; englishTitle?: string | null };

/** A title's English when it is ready (publication/english.ts), for the English addresses of articles and events. */
const englishTitle = (title: ReturnType<typeof sql>) => ENGLISH
  ? sql`(SELECT c.en FROM english_copy c WHERE c.zh_hash = encode(sha256(convert_to(${title}, 'UTF8')), 'hex') AND c.en IS NOT NULL AND ${usableCopy})`
  : sql`NULL::text`;

/** Whether a page with this title reads in English: its title has no Chinese, or has its English. */
const readsInEnglish = (title: string, english: string | null) => !needsEnglish(title) || !!english;

/** The English addresses of the pages that have one: the same page and identity, in sections of their own. */
function inEnglish(entries: Entry[], revisions: boolean): Entry[] {
  if (!ENGLISH) return [];
  return entries.filter((e) => e.english !== false && hasEnglish(e.loc)).map((e) => ({
    loc: inLanguage(e.loc, "en"),
    revision: !revisions || e.revision === undefined ? undefined : sha256(stableJson([e.revision, e.englishTitle ?? null])),
    lastmod: e.lastmod,
    changefreq: e.changefreq,
    priority: e.priority,
    ...(e.section ? { section: `en-${e.section}` } : {}),
  }));
}

/**
 * One inventory for XML discovery and change notifications. A sitemap bounds what it advertises;
 * notifications read the complete inventory, so leaving the sitemap is never a withdrawal.
 * Collection pages have content identities, not invented modification dates: a removed member can
 * change a page without leaving a reliable timestamp on its surviving members.
 */
export async function loadDiscoveryEntries(at = new Date(), limits?: { urls: number }): Promise<Entry[]> {
  const entries: Entry[] = [];
  const revisionColumn = (value: ReturnType<typeof sql>) => limits ? sql`` : sql`, ${value} AS revision`;
  const [activity] = limits ? [] : await sql<{ selected: string | null; listed: string | null }[]>`
    SELECT md5(string_agg(p.article_id || ':' || p.revision::text, ',' ORDER BY p.timeline_at DESC, p.article_id)
             FILTER (WHERE ${selectedCondition(at)})) AS selected,
           md5(string_agg(p.article_id || ':' || p.revision::text, ',' ORDER BY p.timeline_at DESC, p.article_id)
             FILTER (WHERE ${listedCondition(at)})) AS listed
    FROM publications p WHERE ${listedCondition(at)}`;
  const reports = await sql<{ kind: ReportKind; key: string; t: Date | null; changed: Date; revision?: string }[]>`
    SELECT r.kind, r.key,
      CASE WHEN citations.revision IS NULL THEN greatest(r.updated_at, r.generated_at) END AS t,
      greatest(r.updated_at, r.generated_at) AS changed
      ${revisionColumn(sql`md5(concat_ws('|', r.revision::text, r.updated_at::text, citations.revision))`)}
    FROM reports r LEFT JOIN LATERAL (
      SELECT ${limits ? sql`1` : sql`md5(string_agg(p.article_id || ':' || p.revision::text || ':' || (${listedCondition(at)})::text,
          ',' ORDER BY p.article_id))`} AS revision
      FROM publications p WHERE p.article_id IN (
        SELECT value #>> '{}' FROM jsonb_path_query(r.content, '$.**.itemId') AS cited(value))
      ${limits ? sql`LIMIT 1` : sql``}
    ) citations ON true ORDER BY r.kind, r.key DESC`;
  const reportRevision = (kind: string) => limits ? undefined : sha256(stableJson(reports.filter((r) => r.kind === kind)));
  const topics = await topicPageCounts(at, !limits);
  // The terms and the privacy notice are in Chinese only.
  entries.push(
    { loc: "/", revision: activity?.selected ?? "", changefreq: "hourly", priority: 1 },
    { loc: "/all", revision: activity?.listed ?? "", changefreq: "hourly", priority: 0.9 },
    { loc: "/daily", revision: reportRevision("daily"), changefreq: "daily", priority: 0.9 },
    { loc: "/hot", revision: limits ? undefined : sha256(stableJson((await latestHotRanking())?.entries ?? [])), changefreq: "hourly", priority: 0.9 },
    { loc: "/daily/archive", revision: reportRevision("daily"), changefreq: "daily", priority: 0.7 },
    { loc: "/weekly", revision: reportRevision("weekly"), changefreq: "weekly", priority: 0.7 },
    { loc: "/monthly", revision: reportRevision("monthly"), changefreq: "monthly", priority: 0.6 },
    { loc: "/topics", revision: limits ? undefined : sha256(stableJson(topics)), changefreq: "daily", priority: 0.7 },
    { loc: "/agent", revision: limits ? undefined : sha256(stableJson([SITE, ACCESS, AGENT])), changefreq: "weekly", priority: 0.7 },
    { loc: "/about", revision: limits ? undefined : sha256(stableJson(ABOUT)), changefreq: "monthly", priority: 0.5 },
    { loc: "/terms", revision: limits ? undefined : sha256(stableJson([POLICY.terms, await readFile(path.join(REPO_ROOT, "site/pages/terms.md"), "utf8")])), changefreq: "monthly", priority: 0.4 },
    { loc: "/privacy", revision: limits ? undefined : sha256(stableJson([POLICY.privacy, await readFile(path.join(REPO_ROOT, "site/pages/privacy.md"), "utf8")])), changefreq: "monthly", priority: 0.4 },
    { loc: "/changelog", revision: limits ? undefined : sha256(stableJson(loadChangelog())), changefreq: "weekly", priority: 0.5 },
  );
  // Resolve visible headlines only for reports inside the news window so withdrawn leads never leak into news.xml.
  const recentReportHeads = new Map<string, string>();
  const recentKeys = limits ? reports.filter((r) => r.changed.getTime() >= at.getTime() - NEWS_WINDOW_MS) : [];
  if (recentKeys.length) {
    const rows = await sql<{ kind: ReportKind; key: string; content: Record<string, any> }[]>`
      SELECT r.kind, r.key, r.content FROM reports r
      JOIN jsonb_to_recordset(${sql.json(recentKeys.map((r) => ({ kind: r.kind, key: r.key })))}) AS wanted(kind text, key text)
        ON wanted.kind = r.kind AND wanted.key = r.key`;
    const dailies = rows.filter((r) => r.kind === "daily");
    const periodics = rows.filter((r) => r.kind !== "daily");
    const [goneDaily, gonePeriodic] = await Promise.all([
      dailies.length ? unavailableHeadlineIds(dailies, "daily") : Promise.resolve(new Set<string>()),
      periodics.length ? unavailableHeadlineIds(periodics, "periodic") : Promise.resolve(new Set<string>()),
    ]);
    for (const r of rows) {
      const lead = issueLead(r.content, r.kind === "daily" ? "daily" : "periodic", r.kind === "daily" ? goneDaily : gonePeriodic)?.title.trim();
      const label = `${withSubject(REPORT_NAMES[r.kind])}｜${reportDateLabel(r.kind, r.key)}`;
      recentReportHeads.set(`${r.kind}/${r.key}`, lead ? `${label}：${lead}` : label);
    }
  }
  for (const r of reports) {
    entries.push({ loc: `/${r.kind}/${r.key}`, lastmod: r.t, newsAt: r.changed, newsTitle: recentReportHeads.get(`${r.kind}/${r.key}`), revision: r.revision, changefreq: "monthly", priority: 0.6 });
  }
  for (const t of topics) {
    if (!t.indexable) continue;
    // A topic's archive pages (/page/2+) are noindex, follow and reached from the topic page: neither the
    // sitemap nor change notifications list them.
    entries.push({ loc: `/topics/${t.slug}`, revision: t.revision, changefreq: "daily", priority: 0.6 });
  }
  // A story needs listed evidence of its own and at least STORY_INDEX_MIN_SOURCES distinct public sources:
  // single-source clusters are noindex everywhere, so neither the sitemap nor notifications list them. Its
  // identity follows current readable reports as well as the digest, so a correction or regrouping is visible
  // even when latest_at does not advance.
  const stories = await sql<{ id: number; public_id: string; title: string; revision?: string; en_title: string | null }[]>`
    SELECT st.id, st.public_id::text, st.title, ${englishTitle(sql`st.title`)} AS en_title
      ${revisionColumn(sql`md5(concat_ws('|', st.title, st.summary, st.digest, st.digest_updated_at::text, st.version::text, members.revision))`)}
    FROM stories st JOIN LATERAL (
      SELECT count(DISTINCT p.source_id) AS sources
        ${revisionColumn(sql`md5(string_agg(concat_ws(':', p.article_id, p.revision::text, fa.role, f.updated_at::text, p.source_id, regexp_replace(s.name, '（[^（）]*）', '', 'g')),
          ',' ORDER BY p.article_id, f.id))`)}
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE f.story_id = st.id AND ${storyReportCondition(at)}
    ) members ON true
    WHERE st.merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = st.id AND ${evidenceCondition()} AND ${listedCondition(at)})
      AND members.sources >= ${STORY_INDEX_MIN_SOURCES}
    ORDER BY st.latest_at DESC NULLS LAST, st.id DESC`;
  // Dated as the page's dateModified is (storyLd): its latest public report, or a newer digest that still stands.
  // Only for the sitemap: notifications already follow the content's identity.
  const texts = limits ? await storyTexts(stories.map((s) => Number(s.id)), at) : null;
  for (const s of stories) {
    const text = texts?.get(Number(s.id));
    const dates = [text?.latest?.at, text?.digestUpdatedAt].filter((d): d is Date => !!d);
    const lastmod = dates.length ? new Date(Math.max(...dates.map(Number))) : null;
    entries.push({ loc: `/story/${s.public_id}`, lastmod, newsAt: lastmod, newsTitle: limits ? s.title : undefined, revision: s.revision, changefreq: "daily", priority: 0.5,
      english: readsInEnglish(s.title, s.en_title), englishTitle: s.en_title });
  }
  for (const m of serverModules()) if (m.sitemap?.entries) entries.push(...(await m.sitemap.entries(!limits)).map((e) => ({ ...e, section: m.name })));
  // Material/translation timestamps can also record a retry or a state repair. Hash the content;
  // without a dedicated public modification clock, omitting lastmod is more accurate than guessing.
  // A selection's release is the one date of its own, and it dates the page only in the news section.
  // Thin pages, and articles whose event page stands for them, stay out of the sitemap but not out of
  // notifications: other engines index them.
  const items = await sql<{ id: string; title: string; revision?: string; released: Date | null; en_title: string | null }[]>`
    SELECT p.article_id AS id, p.title, ${englishTitle(sql`p.title`)} AS en_title,
      CASE WHEN p.selected THEN p.visible_after END AS released
      ${revisionColumn(sql`md5(concat_ws('|', p.revision::text, a.content_hash, a.cover::text, tr.title, tr.body_html, tr.body_text, tr.complete::text, qt.text_zh,
        p.source_id, regexp_replace(s.name, '（[^（）]*）', '', 'g'), s.icon_url, st.public_id::text, st.title))`)}
    ${ITEM_FROM}
    WHERE ${storyReportCondition(at)} AND p.indexable ${limits ? sql`AND NOT ${thinPageCondition()} AND NOT ${eventPageCondition(at)}` : sql``}
    ORDER BY p.timeline_at DESC, p.article_id DESC ${limits ? sql`LIMIT ${Math.max(0, limits.urls - entries.length)}` : sql``}`;
  for (const it of items) {
    entries.push({ loc: `/items/${it.id}`, newsAt: it.released, newsTitle: limits ? it.title : undefined, revision: it.revision, changefreq: "monthly", priority: 0.5,
      english: readsInEnglish(it.title, it.en_title), englishTitle: it.en_title });
  }
  // The English addresses come on top of the Chinese ones' limit, each language within its own.
  const chinese = limits ? entries.slice(0, limits.urls) : entries;
  return [...chinese, ...inEnglish(chinese, !limits)];
}

function sectionOf(e: Entry): string {
  if (e.section) return e.section;
  const english = localeOf(e.loc) === "en";
  const loc = english ? pagePath(e.loc) : e.loc;
  const section = loc.startsWith("/story/") ? "stories" : loc.startsWith("/items/") ? "items" : /^\/topics(\/|$)/.test(loc) ? "topics"
    : /^\/(daily|weekly|monthly)(\/|$)/.test(loc) ? "reports" : "pages";
  return english ? `en-${section}` : section;
}

function urlset(entries: Entry[]): string {
  const body = entries
    .map((e) => {
      const parts = [`<loc>${escapeXml(siteUrl(e.loc))}</loc>`];
      if (e.lastmod) parts.push(`<lastmod>${e.lastmod.toISOString()}</lastmod>`);
      if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority}</priority>`);
      return `<url>\n${parts.join("\n")}\n</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function newsUrlset(entries: Array<Entry & { lastmod: Date }>): string {
  const pubName = escapeXml(SITE.name);
  const pubLang = escapeXml(NEWS_LANGUAGE);
  const body = entries
    .map((e) => {
      const iso = e.lastmod.toISOString();
      const title = e.newsTitle?.trim();
      const parts = [
        `<loc>${escapeXml(siteUrl(e.loc))}</loc>`,
        `<lastmod>${iso}</lastmod>`,
      ];
      if (title) {
        parts.push(
          `<news:news>`,
          `<news:publication>`,
          `<news:name>${pubName}</news:name>`,
          `<news:language>${pubLang}</news:language>`,
          `</news:publication>`,
          `<news:publication_date>${iso}</news:publication_date>`,
          `<news:title>${escapeXml(title)}</news:title>`,
          `</news:news>`,
        );
      }
      return `<url>\n${parts.join("\n")}\n</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${body}\n</urlset>\n`;
}

async function build(at: Date): Promise<Record<string, string>> {
  const entries = await loadDiscoveryEntries(at, { urls: MAX_URLS });
  // What is new, newest first, from the pages the other sections list: events by their latest report or
  // digest, selections by their release, reports by their publication or correction. A report that cites
  // articles is undated in its own section (a cited article can change it unannounced); here its own date
  // only says that it is new. The file stays in the index when nothing is new.
  const since = at.getTime() - NEWS_WINDOW_MS;
  const news = entries.flatMap((e) => (e.newsAt && e.newsAt.getTime() >= since ? [{ ...e, lastmod: e.newsAt }] : []))
    .sort((a, b) => b.lastmod.getTime() - a.lastmod.getTime())
    .slice(0, MAX_NEWS_URLS);
  const files: Record<string, string> = { [NEWS]: newsUrlset(news) };
  const sectionLastmod = new Map<string, Date>();
  const latestOf = (list: Entry[]) => {
    let max: Date | null = null;
    for (const e of list) if (e.lastmod && (!max || e.lastmod > max)) max = e.lastmod;
    return max;
  };
  const newsLatest = latestOf(news);
  if (newsLatest) sectionLastmod.set(NEWS, newsLatest);
  for (const [section, list] of Map.groupBy(entries, sectionOf)) {
    const file = `${section}.xml`;
    files[file] = urlset(list);
    const max = latestOf(list);
    if (max) sectionLastmod.set(file, max);
  }
  const body = Object.keys(files).map((file) => {
    const parts = [`<loc>${escapeXml(siteUrl(`/sitemaps/${file}`))}</loc>`];
    const last = sectionLastmod.get(file);
    if (last) parts.push(`<lastmod>${last.toISOString()}</lastmod>`);
    return `<sitemap>\n${parts.join("\n")}\n</sitemap>`;
  }).join("\n");
  files[INDEX] = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
  return files;
}

const rebuilding = shared<void, SitemapDocument>(() => "sitemap", refreshSitemap);

export function loadSitemap(): Promise<SitemapDocument> {
  if (lastGood && lastGood.expiresAt > Date.now()) return Promise.resolve(lastGood);
  return rebuilding();
}

async function refreshSitemap(): Promise<SitemapDocument> {
  try {
    const at = Date.now();
    const files = await build(new Date(at));
    lastGood = { files, expiresAt: at + TTL_MS };
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    // The file's timestamp preserves the same deadline when another process loads it after restart.
    await writeFile(CACHE_FILE, JSON.stringify(files)).then(() => utimes(CACHE_FILE, new Date(at), new Date(at))).catch(() => {});
    return lastGood;
  } catch (error) {
    if (lastGood && lastGood.expiresAt > Date.now()) return lastGood;
    const saved = await Promise.all([readFile(CACHE_FILE, "utf8"), stat(CACHE_FILE)]).catch(() => null);
    if (saved && saved[1].mtimeMs + TTL_MS > Date.now()) {
      return (lastGood = { files: JSON.parse(saved[0]) as Record<string, string>, expiresAt: saved[1].mtimeMs + TTL_MS });
    }
    throw error;
  }
}
