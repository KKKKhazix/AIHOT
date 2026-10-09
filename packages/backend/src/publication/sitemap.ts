// Sitemap from the same public metadata as pages. Process and HTTP caches share one five-minute
// deadline; a saved copy may bridge a restart only for the remainder of that original lifetime.
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { ABOUT, ACCESS, AGENT, POLICY, SITE } from "@aihot/site";
import { config, REPO_ROOT } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { loadChangelog } from "../site/meta.ts";
import { latestHotRanking } from "./hot.ts";
import { ITEM_FROM } from "./items.ts";
import { sql } from "../db.ts";
import { cached, SHARED_ONLY } from "../lib/cache.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { evidenceCondition, listedCondition, selectedCondition, storyReportCondition } from "./scope.ts";
import { topicPageCounts } from "./topics.ts";
import { serverModules, type SitemapEntry } from "../modules.ts";

const MAX_URLS = 45_000;
const TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "sitemap-last.xml");

interface SitemapDocument { xml: string; expiresAt: number }

let lastGood: SitemapDocument | null = null;

type Entry = SitemapEntry;

/**
 * One inventory for XML discovery and change notifications. A sitemap bounds its advertised history;
 * notifications read the complete inventory, so crossing that display limit is never a withdrawal.
 * Collection pages have content identities, not invented modification dates: a removed member can
 * change a page without leaving a reliable timestamp on its surviving members.
 */
export async function loadDiscoveryEntries(at = new Date(), limits?: { stories: number; urls: number }): Promise<Entry[]> {
  const entries: Entry[] = [];
  const [activity] = limits ? [] : await sql<{ selected: string | null; listed: string | null }[]>`
    SELECT md5(string_agg(p.article_id || ':' || p.revision::text, ',' ORDER BY p.timeline_at DESC, p.article_id)
             FILTER (WHERE ${selectedCondition(at)})) AS selected,
           md5(string_agg(p.article_id || ':' || p.revision::text, ',' ORDER BY p.timeline_at DESC, p.article_id)
             FILTER (WHERE ${listedCondition(at)})) AS listed
    FROM publications p WHERE ${listedCondition(at)}`;
  const reports = await sql<{ kind: string; key: string; t: Date | null; revision: string }[]>`
    SELECT r.kind, r.key,
      CASE WHEN citations.revision IS NULL THEN greatest(r.updated_at, r.generated_at) END AS t,
      md5(concat_ws('|', r.revision::text, r.updated_at::text, citations.revision)) AS revision
    FROM reports r LEFT JOIN LATERAL (
      SELECT md5(string_agg(p.article_id || ':' || p.revision::text || ':' || (${listedCondition(at)})::text,
          ',' ORDER BY p.article_id)) AS revision
      FROM publications p WHERE p.article_id IN (
        SELECT value #>> '{}' FROM jsonb_path_query(r.content, '$.**.itemId') AS cited(value))
    ) citations ON true ORDER BY r.kind, r.key DESC`;
  const reportRevision = (kind: string) => sha256(stableJson(reports.filter((r) => r.kind === kind)));
  const topics = await topicPageCounts(at, !limits);
  entries.push(
    { loc: "/", revision: activity?.selected ?? "", changefreq: "hourly", priority: 1 },
    { loc: "/all", revision: activity?.listed ?? "", changefreq: "hourly", priority: 0.9 },
    { loc: "/daily", revision: reportRevision("daily"), changefreq: "daily", priority: 0.9 },
    { loc: "/hot", revision: limits ? undefined : sha256(stableJson((await latestHotRanking())?.entries ?? [])), changefreq: "hourly", priority: 0.9 },
    { loc: "/daily/archive", revision: reportRevision("daily"), changefreq: "daily", priority: 0.7 },
    { loc: "/weekly", revision: reportRevision("weekly"), changefreq: "weekly", priority: 0.7 },
    { loc: "/monthly", revision: reportRevision("monthly"), changefreq: "monthly", priority: 0.6 },
    { loc: "/topics", revision: sha256(stableJson(topics)), changefreq: "daily", priority: 0.7 },
    ...serverModules().flatMap((m) => m.sitemap?.pages ?? []),
    { loc: "/agent", revision: sha256(stableJson([SITE, ACCESS, AGENT])), changefreq: "weekly", priority: 0.7 },
    { loc: "/about", revision: sha256(stableJson(ABOUT)), changefreq: "monthly", priority: 0.5 },
    { loc: "/terms", revision: sha256(stableJson([POLICY.terms, await readFile(path.join(REPO_ROOT, "site/pages/terms.md"), "utf8")])), changefreq: "monthly", priority: 0.4 },
    { loc: "/privacy", revision: sha256(stableJson([POLICY.privacy, await readFile(path.join(REPO_ROOT, "site/pages/privacy.md"), "utf8")])), changefreq: "monthly", priority: 0.4 },
    { loc: "/changelog", revision: sha256(stableJson(loadChangelog())), changefreq: "weekly", priority: 0.5 },
  );
  for (const r of reports) entries.push({ loc: `/${r.kind}/${r.key}`, lastmod: r.t, revision: r.revision, changefreq: "monthly", priority: 0.6 });
  for (const t of topics) {
    if (!t.indexable) continue;
    entries.push({ loc: `/topics/${t.slug}`, revision: t.revision, changefreq: "daily", priority: 0.6 });
    for (let p = 2; p <= t.pages; p++) entries.push({ loc: `/topics/${t.slug}/page/${p}`, revision: t.revision, changefreq: "weekly", priority: 0.3 });
  }
  // A story needs listed evidence of its own. Its identity follows current readable reports as well
  // as the digest, so a correction or regrouping is visible even when latest_at does not advance.
  const stories = await sql<{ public_id: string; revision: string }[]>`
    SELECT st.public_id::text, md5(concat_ws('|', st.title, st.summary, st.digest, st.digest_updated_at::text,
      st.version::text, members.revision)) AS revision
    FROM stories st JOIN LATERAL (
      SELECT md5(string_agg(concat_ws(':', p.article_id, p.revision::text, fa.role, f.updated_at::text, s.name),
        ',' ORDER BY p.article_id, f.id)) AS revision
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE f.story_id = st.id AND ${storyReportCondition(at)}
    ) members ON true
    WHERE st.merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = st.id AND ${evidenceCondition()} AND ${listedCondition(at)})
    ORDER BY st.latest_at DESC NULLS LAST, st.id DESC ${limits ? sql`LIMIT ${limits.stories}` : sql``}`;
  for (const s of stories) entries.push({ loc: `/story/${s.public_id}`, revision: s.revision, changefreq: "daily", priority: 0.5 });
  for (const m of serverModules()) if (m.sitemap?.entries) entries.push(...(await m.sitemap.entries()));
  // Material/translation timestamps can also record a retry or a state repair. Hash the content;
  // without a dedicated public modification clock, omitting lastmod is more accurate than guessing.
  const items = await sql<{ id: string; revision: string }[]>`
    SELECT p.article_id AS id,
      md5(concat_ws('|', p.revision::text, a.content_hash, tr.title, tr.body_html, tr.body_text, tr.complete::text, qt.text_zh,
        s.name, s.icon_url, st.public_id::text, st.title)) AS revision
    ${ITEM_FROM}
    WHERE ${storyReportCondition(at)} AND p.indexable
    ORDER BY p.timeline_at DESC, p.article_id DESC ${limits ? sql`LIMIT ${Math.max(0, limits.urls - entries.length)}` : sql``}`;
  for (const it of items) entries.push({ loc: `/items/${it.id}`, revision: it.revision, changefreq: "monthly", priority: 0.5 });
  return limits ? entries.slice(0, limits.urls) : entries;
}

async function build(at: Date): Promise<string> {
  const entries = await loadDiscoveryEntries(at, { stories: 500, urls: MAX_URLS });
  const body = entries
    .slice(0, MAX_URLS)
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

const rebuilding = cached(refreshSitemap, SHARED_ONLY);

export function loadSitemap(): Promise<SitemapDocument> {
  if (lastGood && lastGood.expiresAt > Date.now()) return Promise.resolve(lastGood);
  return rebuilding.get();
}

async function refreshSitemap(): Promise<SitemapDocument> {
  try {
    const at = Date.now();
    const xml = await build(new Date(at));
    lastGood = { xml, expiresAt: at + TTL_MS };
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    // The file's timestamp preserves the same deadline when another process loads it after restart.
    await writeFile(CACHE_FILE, xml).then(() => utimes(CACHE_FILE, new Date(at), new Date(at))).catch(() => {});
    return lastGood;
  } catch (error) {
    if (lastGood && lastGood.expiresAt > Date.now()) return lastGood;
    const saved = await Promise.all([readFile(CACHE_FILE, "utf8"), stat(CACHE_FILE)]).catch(() => null);
    if (saved && saved[1].mtimeMs + TTL_MS > Date.now()) {
      return (lastGood = { xml: saved[0], expiresAt: saved[1].mtimeMs + TTL_MS });
    }
    throw error;
  }
}
