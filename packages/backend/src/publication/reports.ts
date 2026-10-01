// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { listedCondition } from "./scope.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";
import { SITE, withSubject } from "@aihot/industry/site";

export type { ReportKind };

interface ReportRow {
  kind: ReportKind;
  key: string;
  window_start: Date;
  window_end: Date;
  content: Record<string, any>;
  generated_at: Date;
  revision: number;
}

interface Availability {
  available: boolean;
  firstParty: boolean;
  sourceId: string | null;
  sourceIcon: string | null;
  storyPublicId: string | null;
  publishedAt: Date | null;
}

async function availability(ids: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; available: boolean; first_party: boolean; source_id: string; icon_url: string | null; story_public_id: string | null; at: Date | null }[]>`
    SELECT p.article_id AS id, (${listedCondition(new Date())}) AS available, p.first_party, p.source_id, s.icon_url, st.public_id::text AS story_public_id,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(ids)}`;
  for (const r of rows) {
    out.set(r.id, {
      available: r.available,
      firstParty: r.first_party,
      sourceId: r.source_id,
      sourceIcon: r.icon_url,
      storyPublicId: r.story_public_id,
      publishedAt: r.at,
    });
  }
  return out;
}

/** Ids among `ids` that are no longer public. Ids absent from this database stay cited as published. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT p.article_id AS id FROM publications p
    WHERE p.article_id = ANY(${unique}::text[]) AND NOT (${listedCondition(new Date())})`;
  return new Set(rows.map((r) => r.id));
}

/** Directory/feed metadata only: citation summaries and full report prose stay in the detail read. */
export async function reportIndexRows(kind: ReportKind, limit: number) {
  // 先按完整的同类现存刊物编号，再裁剪导航；历史补刊和删除会改变后续期号。
  return sql<{ key: string; issue_number: number; content: Record<string, any>; generated_at: Date }[]>`
    SELECT key, generated_at, (row_number() OVER (ORDER BY key ASC))::int AS issue_number, jsonb_build_object(
      'lead', content->'lead', 'headline', content->'headline', 'title', content->'title',
      CASE WHEN kind = 'daily' THEN 'sections' ELSE 'themes' END,
      jsonb_build_array(jsonb_build_object(CASE WHEN kind = 'daily' THEN 'items' ELSE 'storyRefs' END,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item->'itemId', 'title', item->'title') ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(jsonb_path_query_array(content,
           CASE WHEN kind = 'daily' THEN '$.sections[*].items[*]'::jsonpath ELSE '$.themes[*].storyRefs[*]'::jsonpath END
         )) WITH ORDINALITY AS cited(item, ord))))) AS content
    FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT ${limit}`;
}

/**
 * A report's headline for indexes and feeds: its lead, else the first cited item that is still public.
 * `gone` must cover withdrawn candidates before the first public title (see {@link unavailableHeadlineIds}).
 */
export function reportHeadline(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>): string | null {
  if (kind === "daily" && content.lead?.title) return String(content.lead.title);
  if (kind === "periodic" && periodicHeadline(content)) return periodicHeadline(content);
  const items: Array<Record<string, any>> = kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const first = items.find((i) => !i.itemId || !gone.has(i.itemId));
  return first?.title ?? null;
}

/** A weekly or monthly's own headline; the composer's "<site> 周报 · 2026-W38" names the issue, not its news. */
function periodicHeadline(content: Record<string, any>): string | null {
  const text = String(content.headline ?? content.title ?? "");
  return text && !/^.+ [周月]报 · \d{4}-/.test(text) ? text : null;
}

/** Check only the first possible headline of each report; advance reports whose candidate was withdrawn. */
export async function unavailableHeadlineIds(rows: Array<{ content: Record<string, any> }>, kind: "daily" | "periodic"): Promise<Set<string>> {
  const reports = rows
    .filter((r) => (kind === "daily" ? !r.content.lead?.title : !periodicHeadline(r.content)))
    .map((r): Array<{ itemId?: string | null }> => kind === "daily"
      ? (r.content.sections ?? []).flatMap((s: any) => s.items ?? [])
      : (r.content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []));
  const gone = new Set<string>();
  const checked = new Set<string>();
  while (true) {
    const candidates = reports.map((items) => items.find((i) => !i.itemId || !gone.has(i.itemId))?.itemId)
      .filter((id): id is string => !!id && !checked.has(id));
    if (!candidates.length) return gone;
    for (const id of await unavailableIds(candidates)) gone.add(id);
    for (const id of candidates) checked.add(id);
  }
}

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  // Items absent from this database (older than the imported window) stay cited as they were published.
  const available = id ? (a ? a.available : true) : true;
  if (!available) {
    // Withdrawn since: the reader sees a marked title; the summary and links are not sent at all.
    return {
      itemId: id, title: String(raw.title ?? ""), summary: null, sourceName: "", sourceUrl: "", sourceId: null, sourceIconUrl: null,
      firstParty: false, role: raw.role ?? null, storyPublicId: null, publishedAt: null, available: false,
    };
  }
  return {
    itemId: id,
    title: String(raw.title ?? ""),
    summary: raw.summary ?? null,
    sourceName: String(raw.sourceName ?? raw.source?.name ?? ""),
    sourceUrl: String(raw.sourceUrl ?? raw.links?.original ?? ""),
    sourceId: raw.sourceId ?? a?.sourceId ?? null,
    sourceIconUrl: a?.sourceIcon ? proxiedImage(a.sourceIcon, "avatar") : null,
    ...(a?.sourceIcon && proxiedImageSet(a.sourceIcon, "avatar") ? { sourceIconSrcSet: proxiedImageSet(a.sourceIcon, "avatar")! } : {}),
    firstParty: raw.firstParty ?? a?.firstParty ?? false,
    role: raw.role ?? null,
    storyPublicId: raw.storyPublicId ?? a?.storyPublicId ?? null,
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    available,
  };
}

const bigrams = (text: string) => {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}]/gu, "")];
  return new Set(chars.slice(1).map((ch, i) => chars[i] + ch));
};

/**
 * The item a daily's front page leads with. Without an editors' lead it is the first highlight (else
 * the first story), as the page sets it. The editors' lead is written about one of the items, so it is
 * the item whose title shares most of the lead's character pairs, if most of them are shared; a lead
 * that matches no item clearly has none.
 */
export function leadItemOf(leadTitle: string | undefined, highlights: ReportCitation[], all: ReportCitation[]): ReportCitation | undefined {
  if (!leadTitle) return highlights[0] ?? all[0];
  const want = bigrams(leadTitle);
  if (want.size === 0) return undefined;
  let best: { c: ReportCitation; share: number } | undefined;
  for (const c of all) {
    const have = bigrams(c.title);
    const share = [...want].filter((b) => have.has(b)).length / want.size;
    if (!best || share > best.share) best = { c, share };
  }
  return best && best.share >= 0.5 ? best.c : undefined;
}

/**
 * A picture for the front page's lead item: its own first sizeable image, else one from another public
 * report of the same event (first-hand first). Items shown as summaries only lend no pictures.
 */
async function leadCover(itemId: string): Promise<{ url: string; srcSet?: string; width: number | null; height: number | null } | null> {
  const [row] = await sql<{ m: { url: string; width?: number; height?: number } }[]>`
    SELECT img.m
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (
      SELECT m FROM jsonb_array_elements(coalesce(a.media, '[]'::jsonb)) m
      WHERE m->>'kind' = 'image' AND coalesce((m->>'width')::numeric, 800) >= 480 LIMIT 1
    ) img
    WHERE (p.article_id = ${itemId} OR p.story_id = (SELECT story_id FROM publications WHERE article_id = ${itemId}))
      AND ${listedCondition(new Date())} AND p.body_mode <> 'summary'
    ORDER BY (p.article_id = ${itemId}) DESC, p.first_party DESC, coalesce(p.score, 0) DESC, p.article_id
    LIMIT 1`;
  if (!row) return null;
  const url = proxiedImage(row.m.url, "full");
  if (!url) return null;
  return { url, ...(proxiedImageSet(row.m.url, "hero") ? { srcSet: proxiedImageSet(row.m.url, "hero")! } : {}), width: typeof row.m.width === "number" ? row.m.width : null, height: typeof row.m.height === "number" ? row.m.height : null };
}

function readingMinutes(text: string): number {
  return Math.max(1, Math.round([...text].length / 450));
}

async function neighbors(kind: ReportKind, key: string): Promise<{ prev: string | null; next: string | null }> {
  const [row] = await sql<{ prev: string | null; next: string | null }[]>`
    SELECT (SELECT key FROM reports WHERE kind = ${kind} AND key < ${key} ORDER BY key DESC LIMIT 1) AS prev,
      (SELECT key FROM reports WHERE kind = ${kind} AND key > ${key} ORDER BY key ASC LIMIT 1) AS next`;
  return { prev: row?.prev ?? null, next: row?.next ?? null };
}

export async function loadReport(kind: ReportKind, key: string): Promise<ReportDetail | null> {
  const [r] = await sql<(ReportRow & { issue_number: number })[]>`
    SELECT r.kind, r.key, r.window_start, r.window_end, r.content, r.generated_at, r.revision,
      (SELECT count(*)::int FROM reports earlier WHERE earlier.kind = r.kind AND earlier.key <= r.key) AS issue_number
    FROM reports r WHERE r.kind = ${kind} AND r.key = ${key}`;
  if (!r) return null;
  const c = r.content;
  const rawItems: Array<Record<string, any>> = [
    ...(c.sections ?? []).flatMap((s: any) => s.items ?? []),
    ...(c.flashes ?? []),
    ...(c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
  ];
  const avail = await availability([...new Set(rawItems.map((i) => i.itemId).filter(Boolean))]);
  const cite = (raw: Record<string, any>) => citationFrom(raw, avail);

  const sections = kind === "daily"
    ? (c.sections ?? []).map((s: any) => ({ label: String(s.label), summary: null, items: (s.items ?? []).map(cite) }))
    : (c.themes ?? []).map((t: any) => ({ label: String(t.heading), summary: t.summary ?? null, items: (t.storyRefs ?? []).map(cite) }));
  const labelled: Array<ReportCitation & { label: string }> = sections.flatMap((s: { label: string; items: ReportCitation[] }) => s.items.map((i) => ({ ...i, label: s.label })));
  // Weekly and monthly reports carry the editor's reading order across themes.
  const order: string[] = Array.isArray(c.storyOrder) ? c.storyOrder : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const stories = order.length
    ? [...labelled].sort((a, b) => (rank.get(a.itemId ?? "") ?? order.length) - (rank.get(b.itemId ?? "") ?? order.length))
    : labelled;
  const all: ReportCitation[] = labelled;
  const highlightIds: string[] = c.highlights ?? [];
  const highlights = highlightIds.length
    ? highlightIds.map((id) => all.find((x: ReportCitation) => x.itemId === id)).filter((x): x is ReportCitation => !!x)
    : all.slice(0, 3);
  const text = [c.lead?.leadParagraph ?? "", c.overview ?? "", ...all.map((i: ReportCitation) => `${i.title}${i.summary ?? ""}`)].join("");
  // A weekly or monthly's picture comes from its first highlight and is captioned with that story.
  const leadItem = kind === "daily" ? leadItemOf(c.lead?.title, highlights, all) : (highlights[0] ?? all[0]);
  const [{ prev, next }, picture] = await Promise.all([neighbors(kind, key), leadItem?.itemId && leadItem.available ? leadCover(leadItem.itemId) : null]);
  const cover = picture && leadItem ? { ...picture, caption: kind === "daily" ? null : leadItem.title } : null;
  const headline = kind === "daily" ? null : periodicHeadline(c);
  const title = kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    issueNumber: r.issue_number,
    title,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    lead: c.lead ?? (headline ? { title: headline, leadParagraph: String(c.overview ?? "") } : null),
    overview: c.overview ?? null,
    highlights,
    sections,
    stories,
    flashes: (c.flashes ?? []).map(cite),
    cover,
    metrics: c.metrics ?? {},
    readingMinutes: readingMinutes(text),
    prev,
    next,
  };
}

/**
 * The newest 400 issues of a kind with their withdrawn headline candidates. Every archive, navigation
 * and feed of that kind reads this; it is rebuilt at most once a minute per process (a new issue or a
 * withdrawal shows within a minute, like the pages' own caches).
 */
const INDEX_LIMIT = 400;
const indexes = new Map<ReportKind, Cached<{ rows: Awaited<ReturnType<typeof reportIndexRows>>; gone: Set<string> }>>();
export function reportIndex(kind: ReportKind) {
  let entry = indexes.get(kind);
  if (!entry) {
    entry = cached(async () => {
      const rows = await reportIndexRows(kind, INDEX_LIMIT);
      return { rows, gone: await unavailableHeadlineIds(rows, kind === "daily" ? "daily" : "periodic") };
    }, { freshMs: 60_000, maxStaleMs: 10 * 60_000 });
    indexes.set(kind, entry);
  }
  return entry.get();
}

export async function listReports(kind: ReportKind, limit = INDEX_LIMIT): Promise<ReportIndexEntry[]> {
  const index = await reportIndex(kind);
  const rows = index.rows.slice(0, limit);
  const shape = kind === "daily" ? "daily" : "periodic";
  const gone = index.gone;
  return rows.map((r) => {
    const items = kind === "daily" ? (r.content.sections ?? []).flatMap((s: any) => s.items ?? []) : (r.content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
    return {
      key: r.key,
      issueNumber: r.issue_number,
      title: reportHeadline(r.content, shape, gone),
      generatedAt: r.generated_at.toISOString(),
      count: items.length,
    };
  });
}

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

const attribution = (url: string) => ({ name: SITE.name, url });

export async function v1Dailies(limit: number) {
  const index = await reportIndex("daily");
  const rows = index.rows.slice(0, limit);
  const gone = index.gone;
  const items = rows.map((r) => {
    const url = dailyUrl(r.key);
    return {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      leadTitle: reportHeadline(r.content, "daily", gone),
      leadParagraph: r.content.lead?.leadParagraph ?? null,
      links: { aihot: url },
      attribution: attribution(url),
    };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Daily(date: string | "latest") {
  const [r] = date === "latest"
    ? await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = 'daily' ORDER BY key DESC LIMIT 1`
    : await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = 'daily' AND key = ${date}`;
  if (!r) return null;
  const c = r.content;
  const raw = [...(c.sections ?? []).flatMap((s: any) => s.items ?? []), ...(c.flashes ?? [])];
  const avail = await availability([...new Set(raw.map((i: any) => i.itemId).filter(Boolean))] as string[]);
  const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  const links = (i: any) => ({ aihot: i.itemId ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") });
  const url = dailyUrl(r.key);
  return {
    schemaVersion: 1 as const,
    report: {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      windowStart: r.window_start.toISOString(),
      windowEnd: r.window_end.toISOString(),
      links: { aihot: url },
      attribution: attribution(url),
      lead: c.lead ? { title: String(c.lead.title), leadParagraph: String(c.lead.leadParagraph) } : null,
      sections: (c.sections ?? []).map((s: any) => ({
        label: String(s.label),
        items: (s.items ?? []).filter(ok).map((i: any) => ({
          title: String(i.title),
          summary: String(i.summary ?? ""),
          source: { name: String(i.sourceName ?? "") },
          links: links(i),
          attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
        })),
      })),
      flashes: (c.flashes ?? []).filter(ok).map((i: any) => ({
        title: String(i.title),
        source: { name: String(i.sourceName ?? "") },
        links: links(i),
        publishedAt: new Date(i.publishedAt ?? r.generated_at).toISOString(),
        attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
      })),
    },
  };
}

export { siteUrl };

export function reportNavigation(kind: ReportKind, index: ReportIndexEntry[], key: string): ReportNavigationEntry[] {
  const at = index.findIndex((e) => e.key === key);
  return index.map((entry, n) => ({ key: entry.key, issueNumber: entry.issueNumber,
    ...(kind !== "daily" || entry.key.slice(0, 7) === key.slice(0, 7) || n < 3 || Math.abs(n - at) <= 1 ? { title: entry.title } : {}),
  }));
}

export async function loadReportNavigation(kind: ReportKind, key: string) {
  return reportNavigation(kind, await listReports(kind), key);
}

export async function loadReportMonth(kind: ReportKind, month: string) {
  return (await listReports(kind)).filter((e) => e.key.startsWith(month)).map(({ key, title, issueNumber }) => ({ key, title, issueNumber }));
}
