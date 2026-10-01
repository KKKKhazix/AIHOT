import { evidenceCondition, listedCondition, releasedCondition, selectedCondition } from "./scope.ts";
// Sitemap from the same public metadata as pages: reports, topics and their pages,
// the latest 500 stories, leaderboard pages and indexable items. Cached ~5 minutes and rebuilt in the
// background after that (crawlers get the previous copy meanwhile); if the database fails, the last
// successful sitemap is served (never an empty one). Bounded.
import { FEATURES } from "@aihot/industry/features";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { leaderboardUrls } from "../leaderboard/read.ts";
import { topicCountSnapshot } from "./topics.ts";

async function leaderboardDetailUrls(): Promise<string[]> {
  const fixed = new Set(["/leaderboard", "/leaderboard/sources", "/leaderboard/rules"]);
  return (await leaderboardUrls()).filter((u) => !fixed.has(u) && !u.startsWith("/leaderboard/category/"));
}

const MAX_URLS = 45_000;
const TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "sitemap-last.xml");

interface SitemapSnapshot { xml: string; refreshAt: string | null }
let lastGood: SitemapSnapshot | null = null;

interface Entry {
  loc: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}

async function build(): Promise<SitemapSnapshot> {
  const now = new Date();
  const entries: Entry[] = [];
  const [latestItem] = await sql<{ t: Date | null }[]>`SELECT max(p.timeline_at) AS t FROM publications p WHERE ${selectedCondition(now)}`;
  const [latestDaily] = await sql<{ key: string | null; t: Date | null }[]>`SELECT max(key) AS key, max(generated_at) AS t FROM reports WHERE kind = 'daily'`;
  const latest = latestItem?.t ?? now;
  entries.push(
    { loc: "/", lastmod: latest, changefreq: "hourly", priority: 1 },
    { loc: "/all", lastmod: latest, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily", lastmod: latestDaily?.t, changefreq: "daily", priority: 0.9 },
    { loc: "/hot", lastmod: latest, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily/archive", lastmod: latestDaily?.t, changefreq: "daily", priority: 0.7 },
    { loc: "/weekly", changefreq: "weekly", priority: 0.7 },
    { loc: "/monthly", changefreq: "monthly", priority: 0.6 },
    { loc: "/topics", changefreq: "daily", priority: 0.7 },
    { loc: "/agent", lastmod: latest, changefreq: "weekly", priority: 0.7 },
    { loc: "/about", changefreq: "monthly", priority: 0.5 },
    { loc: "/terms", changefreq: "monthly", priority: 0.4 },
    { loc: "/privacy", changefreq: "monthly", priority: 0.4 },
    { loc: "/changelog", lastmod: latest, changefreq: "weekly", priority: 0.5 },
  );
  if (FEATURES.leaderboard) {
    entries.push(
      { loc: "/leaderboard", changefreq: "daily", priority: 0.8 },
      { loc: "/leaderboard/sources", changefreq: "weekly", priority: 0.5 },
      { loc: "/leaderboard/rules", changefreq: "monthly", priority: 0.4 },
    );
    for (const board of ["coding", "reasoning", "knowledge", "professional"]) entries.push({ loc: `/leaderboard/category/${board}`, changefreq: "daily", priority: 0.6 });
  }
  if (FEATURES.codexResetMonitor) entries.push({ loc: "/codex-reset", changefreq: "hourly", priority: 0.6 });
  const reports = await sql<{ kind: string; key: string; generated_at: Date }[]>`SELECT kind, key, generated_at FROM reports ORDER BY kind, key DESC`;
  for (const r of reports) entries.push({ loc: `/${r.kind}/${r.key}`, lastmod: r.generated_at, changefreq: r.kind === "daily" ? "never" : "monthly", priority: r.kind === "daily" ? 0.6 : 0.6 });
  const topics = await topicCountSnapshot(now);
  for (const t of topics.counts) {
    if (!t.indexable) continue;
    entries.push({ loc: `/topics/${t.slug}`, lastmod: t.latest, changefreq: "daily", priority: 0.6 });
    for (let p = 2; p <= t.pages; p++) entries.push({ loc: `/topics/${t.slug}/page/${p}`, lastmod: t.latest, changefreq: "weekly", priority: 0.3 });
  }
  // Stories with reports of their own; pages that only gather reports grouped elsewhere (imported story
  // levels, regrouped history) are reachable but not listed.
  const stories = await sql<{ public_id: string; latest_at: Date | null }[]>`
    SELECT public_id::text, latest_at FROM stories WHERE merged_into IS NULL AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = stories.id AND ${evidenceCondition()} AND ${listedCondition(now)})
    ORDER BY latest_at DESC NULLS LAST LIMIT 500`;
  for (const s of stories) entries.push({ loc: `/story/${s.public_id}`, lastmod: s.latest_at, changefreq: "daily", priority: 0.5 });
  // Model pages exist only for models on a public top-30 board; source pages for every registered source.
  if (FEATURES.leaderboard) for (const loc of await leaderboardDetailUrls()) entries.push({ loc, changefreq: "weekly", priority: 0.4 });
  const items = await sql<{ id: string; t: Date }[]>`
    SELECT article_id AS id, updated_at AS t FROM publications p WHERE p.visibility = 'public' AND p.indexable AND ${releasedCondition(now)} ORDER BY timeline_at DESC LIMIT ${MAX_URLS - entries.length}`;
  for (const it of items) entries.push({ loc: `/items/${it.id}`, lastmod: it.t, changefreq: "monthly", priority: 0.5 });

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
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`, refreshAt: topics.refreshAt };
}

const sitemap = cached(refreshSitemap, {
  freshMs: TTL_MS, maxStaleMs: 60 * 60_000,
  expiresAt: (value) => value.refreshAt ? Date.parse(value.refreshAt) : null,
});

export async function sitemapXml(): Promise<string> {
  return (await sitemapSnapshot()).xml;
}

export function sitemapSnapshot(): Promise<SitemapSnapshot> {
  return sitemap.get();
}

async function refreshSitemap(): Promise<SitemapSnapshot> {
  try {
    const snapshot = await build();
    lastGood = snapshot;
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, snapshot.xml).catch(() => {});
    return snapshot;
  } catch (error) {
    // 回退只能明确标为过期；磁盘旧文档也不能借本次读取获得新的缓存寿命。
    if (lastGood) return { xml: lastGood.xml, refreshAt: new Date(0).toISOString() };
    const last = await readFile(CACHE_FILE, "utf8").catch(() => null);
    if (last) return { xml: last, refreshAt: new Date(0).toISOString() };
    throw error;
  }
}
