// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { REPORTS, SITE, withSubject } from "@aihot/site";
import { sql } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { isoWeekRange, monthRange } from "@aihot/contracts/time";
import { dailyUrl, itemUrl, periodUrl, siteUrl } from "./links.ts";
import { publicSourceName } from "./rules.ts";
import { listedCondition } from "./scope.ts";

export type { ReportKind };

interface ReportRow {
  kind: ReportKind;
  key: string;
  window_start: Date;
  window_end: Date;
  content: Record<string, any>;
  generated_at: Date;
}

interface Availability {
  available: boolean;
  /** The article's public summary, for issues saved before summaries were frozen into them. */
  summary: string | null;
  firstParty: boolean;
  sourceId: string | null;
  sourceName: string | null;
  sourceIcon: string | null;
  publishedAt: Date | null;
}

async function availability(ids: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; eligible: boolean; summary: string | null; first_party: boolean; source_id: string; source_name: string | null; icon_url: string | null; at: Date | null }[]>`
    SELECT p.article_id AS id, p.visibility, p.eligible, p.summary, (s.tier = 'T1') AS first_party, p.source_id, s.name AS source_name, s.icon_url,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN sources s ON s.id = p.source_id
    WHERE p.article_id IN ${sql(ids)}`;
  for (const r of rows) {
    out.set(r.id, {
      available: r.visibility === "public" && r.eligible,
      summary: r.summary,
      firstParty: r.first_party,
      sourceId: r.source_id,
      sourceName: r.source_name,
      sourceIcon: r.icon_url,
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
    SELECT article_id AS id FROM publications
    WHERE article_id = ANY(${unique}::text[]) AND (visibility <> 'public' OR NOT eligible)`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Directory/feed metadata only: citation summaries and full report prose stay in the detail read. Issue
 * numbers count the whole series of the kind before the limit applies, so the 401st issue is numbered
 * 401 although the index keeps 400; a back-filled or deleted issue renumbers the ones after it.
 */
export async function reportIndexRows(kind: ReportKind, limit: number) {
  return sql<{ key: string; issue_number: number; content: Record<string, any>; generated_at: Date }[]>`
    SELECT key, generated_at, (row_number() OVER (ORDER BY key))::int AS issue_number, jsonb_build_object(
      'lead', content->'lead', 'headline', content->'headline', 'title', content->'title',
      'leadItemId', content->'leadItemId', 'highlights', content->'highlights',
      CASE WHEN kind = 'daily' THEN 'sections' ELSE 'themes' END,
      jsonb_build_array(jsonb_build_object(CASE WHEN kind = 'daily' THEN 'items' ELSE 'storyRefs' END,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item->'itemId', 'title', item->'title') ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(jsonb_path_query_array(content,
           CASE WHEN kind = 'daily' THEN '$.sections[*].items[*]'::jsonpath ELSE '$.themes[*].storyRefs[*]'::jsonpath END
         )) WITH ORDINALITY AS cited(item, ord))))) AS content
    FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT ${limit}`;
}

/** The entries an issue cites in reading order: a daily's sections, a weekly's or monthly's themes. */
function entriesOf(content: Record<string, any>, kind: "daily" | "periodic"): Array<Record<string, any>> {
  return kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
}

/**
 * The entries an issue may lead with, in order. An issue that names its lead item (composed by rule)
 * leads with that entry, then its highlights, then the rest; an issue without a written lead with its
 * entries as cited. An issue with a written lead (a model wrote it in earlier versions) has none.
 */
function leadCandidates(content: Record<string, any>, kind: "daily" | "periodic"): Array<Record<string, any>> {
  const entries = entriesOf(content, kind);
  if (!content.leadItemId) return (kind === "daily" ? content.lead?.title : periodicHeadline(content)) ? [] : entries;
  const byId = new Map(entries.filter((e) => e.itemId).map((e) => [String(e.itemId), e]));
  const order = new Set([content.leadItemId, ...(content.highlights ?? []), ...entries.map((e) => e.itemId)].filter(Boolean).map(String));
  return [...order].map((id) => byId.get(id)).filter((e): e is Record<string, any> => !!e);
}

export interface IssueLead { itemId: string | null; title: string; leadParagraph: string | null }

/**
 * The lead an issue shows, everywhere it is shown (page, indexes, feeds, v1, MCP). An issue that
 * names its lead item leads with that entry's own title and summary; once the item is withdrawn, the
 * next candidate still public leads in its own words, so a withdrawn report is never set above the
 * others. An earlier issue keeps its written lead, else its first cited item still public. A weekly's
 * or monthly's lead has no paragraph of its own (see periodOverview). `gone` must cover the candidates
 * before the first public one (see {@link unavailableHeadlineIds}); entries read without summaries lead
 * without a paragraph.
 */
export function issueLead(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>): IssueLead | null {
  const candidates = leadCandidates(content, kind);
  if (!candidates.length) {
    const title = kind === "daily" ? content.lead?.title : periodicHeadline(content);
    return title ? { itemId: null, title: String(title), leadParagraph: kind === "daily" ? content.lead?.leadParagraph ?? null : null } : null;
  }
  const first = candidates.find((e) => !e.itemId || !gone.has(String(e.itemId)));
  if (!first) return null;
  const lead = { itemId: first.itemId ? String(first.itemId) : null, title: String(first.title ?? "") };
  if (kind === "periodic") return { ...lead, leadParagraph: null };
  const own = first.itemId === content.leadItemId && typeof content.lead?.leadParagraph === "string";
  return { ...lead, leadParagraph: own ? content.lead.leadParagraph : content.leadItemId && typeof first.summary === "string" ? first.summary : null };
}

/**
 * A weekly's or monthly's overview: the one written for it, else what it carries, naming the first three
 * of its lead, highlights and entries still public. `gone` must cover every entry.
 */
function periodOverview(content: Record<string, any>, kind: "weekly" | "monthly", gone: Set<string>): string | null {
  if (typeof content.overview === "string" && content.overview) return content.overview;
  const shown = leadCandidates(content, "periodic").filter((e) => !e.itemId || !gone.has(String(e.itemId)));
  if (!shown.length) return null;
  return `${kind === "weekly" ? "本周" : "本月"} ${shown.length} ${REPORTS.entry.measure}${REPORTS.entry.noun}，最受关注的是：${shown.slice(0, 3).map((e) => e.title).join("；")}。`;
}

/** A weekly or monthly's own headline; the composer's "<site name> 周报 · 2026-W38" names the issue, not its news. */
function periodicHeadline(content: Record<string, any>): string | null {
  const text = String(content.headline ?? content.title ?? "");
  const issueName = text.startsWith(`${SITE.name} `) && /^[周月]报 · /.test(text.slice(SITE.name.length + 1));
  return text && !issueName ? text : null;
}

/** Check only the first possible lead of each report; advance reports whose candidate was withdrawn. */
export async function unavailableHeadlineIds(rows: Array<{ content: Record<string, any> }>, kind: "daily" | "periodic"): Promise<Set<string>> {
  const reports = rows.map((r) => leadCandidates(r.content, kind)).filter((items) => items.length > 0);
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

/** Ids among the cited items that are no longer public, from an availability read. */
const goneIn = (avail: Map<string, Availability>) => new Set([...avail].filter(([, a]) => !a.available).map(([id]) => id));

/** Items absent from this database (older than the imported window) stay cited as they were published. */
const stillPublic = (raw: Record<string, any>, avail: Map<string, Availability>) => !raw.itemId || (avail.get(raw.itemId)?.available ?? true);

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  if (!stillPublic(raw, avail)) {
    // Withdrawn since: the reader sees a marked title; the summary and links are not sent at all.
    return {
      itemId: id, title: String(raw.title ?? ""), summary: null, sourceName: "", sourceUrl: "", sourceIconUrl: null,
      firstParty: false, publishedAt: null, available: false,
    };
  }
  const iconSrcSet = a?.sourceIcon ? proxiedImageSet(a.sourceIcon, "avatar") : null;
  return {
    itemId: id,
    title: String(raw.title ?? ""),
    // The issue's own words first; older weeklies and monthlies froze no summary, the article's stands in.
    summary: raw.summary ?? a?.summary ?? null,
    sourceName: publicSourceName(String(a?.sourceName ?? raw.sourceName ?? raw.source?.name ?? "")),
    sourceUrl: String(raw.sourceUrl ?? raw.links?.original ?? ""),
    sourceIconUrl: a?.sourceIcon ? proxiedImage(a.sourceIcon, "avatar") : null,
    ...(iconSrcSet ? { sourceIconSrcSet: iconSrcSet } : {}),
    firstParty: a?.firstParty ?? false,
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    available: true,
  };
}

/**
 * How many sources an issue cites: those of its entries still public and of what is listed under them, as
 * the database has them, else as the issue recorded them.
 */
function citedSources(content: Record<string, any>, kind: "daily" | "periodic", avail: Map<string, Availability>): number {
  const cited = entriesOf(content, kind).filter((e) => stillPublic(e, avail)).flatMap((e) => [e, ...(e.related ?? [])]);
  return new Set(cited.filter((e) => stillPublic(e, avail)).map((e) => (e.itemId ? avail.get(e.itemId)?.sourceId : undefined) ?? e.sourceId).filter(Boolean)).size;
}

/**
 * A cited entry with what a daily entry composed by rule adds: how many other sources reported the
 * event, the event's other developments listed under it (titles only), and the earlier daily it follows.
 */
function entryCitation(raw: Record<string, any>, avail: Map<string, Availability>): ReportCitation {
  const citation = citationFrom(raw, avail);
  if (!citation.available) return citation;
  const related: ReportCitation[] = (raw.related ?? []).map((r: Record<string, any>) => ({ ...citationFrom(r, avail), summary: null }));
  return {
    ...citation,
    ...(Number(raw.sources) > 1 ? { otherSources: Number(raw.sources) - 1 } : {}),
    ...(related.length ? { related } : {}),
    ...(typeof raw.followUp === "string" ? { followUp: raw.followUp } : {}),
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
  if (!leadTitle) return highlights.find((c) => c.available) ?? all.find((c) => c.available);
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
  const srcSet = proxiedImageSet(row.m.url, "hero");
  return { url, ...(srcSet ? { srcSet } : {}), width: typeof row.m.width === "number" ? row.m.width : null, height: typeof row.m.height === "number" ? row.m.height : null };
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
  // Its number counts every issue of the kind up to it, as the index numbers them (reportIndexRows).
  const [r] = await sql<(Pick<ReportRow, "content" | "generated_at"> & { issue_number: number })[]>`
    SELECT r.content, r.generated_at, (SELECT count(*)::int FROM reports earlier WHERE earlier.kind = r.kind AND earlier.key <= r.key) AS issue_number
    FROM reports r WHERE r.kind = ${kind} AND r.key = ${key}`;
  if (!r) return null;
  const c = r.content;
  const entries: Array<Record<string, any>> = [
    ...(c.sections ?? []).flatMap((s: any) => s.items ?? []),
    ...(c.flashes ?? []),
    ...(c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
  ];
  const rawItems = [...entries, ...entries.flatMap((e) => e.related ?? [])];
  const avail = await availability([...new Set(rawItems.map((i) => i.itemId).filter(Boolean))]);
  const cite = (raw: Record<string, any>) => entryCitation(raw, avail);

  const sections: ReportDetail["sections"] = kind === "daily"
    ? (c.sections ?? []).map((s: any) => ({ label: String(s.label), summary: null, items: (s.items ?? []).map(cite) }))
    : (c.themes ?? []).map((t: any) => ({ label: String(t.heading), summary: t.summary ?? null, items: (t.storyRefs ?? []).map(cite) }));
  const all = sections.flatMap((s) => s.items);
  const highlightIds: string[] = c.highlights ?? [];
  const highlights = highlightIds.length
    ? highlightIds.map((id) => all.find((x: ReportCitation) => x.itemId === id)).filter((x): x is ReportCitation => !!x)
    : all.slice(0, 3);
  const text = [c.lead?.leadParagraph ?? "", c.overview ?? "", ...all.flatMap((i: ReportCitation) => [`${i.title}${i.summary ?? ""}`, ...(i.related ?? []).map((r) => r.title)])].join("");
  // An issue leads with the item it names (an issue composed by rule records it), or the one standing in
  // for it once withdrawn (issueLead); an earlier daily's lead is matched by title. An earlier weekly or
  // monthly's picture comes from its first highlight, captioned with it.
  const gone = goneIn(avail);
  const named = c.leadItemId ? issueLead(c, kind === "daily" ? "daily" : "periodic", gone) : null;
  const overview = kind === "daily" ? c.overview ?? null : periodOverview(c, kind, gone);
  const leadItem = c.leadItemId
    ? all.find((x) => x.itemId === named?.itemId)
    : kind === "daily" ? leadItemOf(c.lead?.title, highlights, all) : (highlights.find((x) => x.available) ?? all.find((x) => x.available));
  const [{ prev, next }, picture] = await Promise.all([neighbors(kind, key), leadItem?.itemId && leadItem.available ? leadCover(leadItem.itemId) : null]);
  const cover = picture && leadItem ? { ...picture, caption: kind === "daily" || c.leadItemId ? null : leadItem.title } : null;
  const headline = kind === "daily" ? null : periodicHeadline(c);
  const title = kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    issueNumber: r.issue_number,
    title,
    generatedAt: r.generated_at.toISOString(),
    lead: c.leadItemId
      ? (named ? { title: named.title, leadParagraph: (kind === "daily" ? named.leadParagraph : overview) ?? "" } : null)
      : c.lead ?? (headline ? { title: headline, leadParagraph: String(c.overview ?? "") } : null),
    leadItemId: (kind === "daily" || c.leadItemId) && leadItem?.available ? leadItem.itemId : null,
    overview,
    highlights,
    sections,
    flashes: (c.flashes ?? []).map(cite),
    cover,
    metrics: {
      ...c.metrics,
      ...(c.metrics?.firstPartyEvents !== undefined ? { firstPartyEvents: all.filter((i) => i.firstParty).length } : {}),
      ...(c.metrics?.sourcesCount !== undefined ? { sourcesCount: citedSources(c, kind === "daily" ? "daily" : "periodic", avail) } : {}),
    },
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
  return rows.map((r) => ({
    key: r.key,
    issueNumber: r.issue_number,
    title: issueLead(r.content, shape, gone)?.title ?? null,
    count: entriesOf(r.content, shape).length,
  }));
}

// v1

const attribution = (url: string) => ({ name: SITE.name, url });

export async function v1Dailies(limit: number) {
  const index = await reportIndex("daily");
  const rows = index.rows.slice(0, limit);
  const gone = index.gone;
  const items = rows.map((r) => {
    const url = dailyUrl(r.key);
    const lead = issueLead(r.content, "daily", gone);
    return {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      leadTitle: lead?.title ?? null,
      leadParagraph: lead?.leadParagraph ?? null,
      links: { aihot: url },
      attribution: attribution(url),
    };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

/**
 * What a daily entry adds for readers of the Agent answer, keyed by the entry's link: other sources,
 * the event's other developments (title and link on this site), and the earlier daily it follows.
 */
export interface DailyNote {
  otherSources: number;
  related: Array<{ title: string; link: string }>;
  followUp: string | null;
}

/** The v1 daily (its fields never change) and the notes the Agent answer adds to it. */
export async function dailyWithNotes(date: string | "latest") {
  const [r] = date === "latest"
    ? await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at FROM reports WHERE kind = 'daily' ORDER BY key DESC LIMIT 1`
    : await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at FROM reports WHERE kind = 'daily' AND key = ${date}`;
  if (!r) return null;
  const c = r.content;
  const raw = [...(c.sections ?? []).flatMap((s: any) => s.items ?? []), ...(c.flashes ?? [])];
  const avail = await availability([...new Set([...raw, ...raw.flatMap((i: any) => i.related ?? [])].map((i: any) => i.itemId).filter(Boolean))] as string[]);
  const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  const links = (i: any) => ({ aihot: i.itemId ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") });
  const url = dailyUrl(r.key);
  const lead = c.lead || c.leadItemId ? issueLead(c, "daily", goneIn(avail)) : null;
  const notes = new Map<string, DailyNote>();
  for (const i of raw.filter(ok)) {
    const related = (i.related ?? []).filter((x: any) => x.itemId && ok(x)).map((x: any) => ({ title: String(x.title), link: itemUrl(x.itemId) }));
    const otherSources = Number(i.sources) > 1 ? Number(i.sources) - 1 : 0;
    if (otherSources || related.length || i.followUp) notes.set(links(i).aihot ?? links(i).original, { otherSources, related, followUp: i.followUp ?? null });
  }
  const body = {
    schemaVersion: 1 as const,
    report: {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      windowStart: r.window_start.toISOString(),
      windowEnd: r.window_end.toISOString(),
      links: { aihot: url },
      attribution: attribution(url),
      lead: lead ? { title: lead.title, leadParagraph: lead.leadParagraph ?? "" } : null,
      sections: (c.sections ?? []).map((s: any) => ({
        label: String(s.label),
        items: (s.items ?? []).filter(ok).map((i: any) => ({
          title: String(i.title),
          summary: String(i.summary ?? ""),
          source: { name: String(avail.get(i.itemId)?.sourceName ?? i.sourceName ?? "") },
          links: links(i),
          attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
        })),
      })),
      flashes: (c.flashes ?? []).filter(ok).map((i: any) => ({
        title: String(i.title),
        source: { name: String(avail.get(i.itemId)?.sourceName ?? i.sourceName ?? "") },
        links: links(i),
        publishedAt: new Date(i.publishedAt ?? r.generated_at).toISOString(),
        attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
      })),
    },
  };
  return { body, notes };
}

export async function v1Daily(date: string | "latest") {
  return (await dailyWithNotes(date))?.body ?? null;
}

export interface FeedIssue {
  key: string;
  generatedAt: Date;
  headline: string | null;
  /** A daily's lead paragraph; a weekly's or monthly's overview. */
  leadParagraph: string | null;
  sections: Array<{ label: string; items: Array<{ title: string; link: string }> }>;
}

/**
 * The newest issues of a kind for its RSS feed: headline, lead paragraph (a weekly's or monthly's
 * overview) and each section's entry titles with their links on this site, withdrawn ones left out.
 */
export async function feedIssues(kind: ReportKind, limit: number): Promise<FeedIssue[]> {
  const rows = kind === "daily"
    ? await sql<{ key: string; generated_at: Date; content: Record<string, any> }[]>`
      SELECT key, generated_at, jsonb_build_object(
        'lead', content->'lead', 'leadItemId', content->'leadItemId', 'highlights', content->'highlights',
        'sections', (SELECT coalesce(jsonb_agg(jsonb_build_object('label', s->'label', 'items',
          (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', i->'itemId', 'title', i->'title') ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(coalesce(s->'items', '[]'::jsonb)) WITH ORDINALITY AS e(i, ord))) ORDER BY sord), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(content->'sections', '[]'::jsonb)) WITH ORDINALITY AS x(s, sord))) AS content
      FROM reports WHERE kind = 'daily' ORDER BY key DESC LIMIT ${limit}`
    : await sql<{ key: string; generated_at: Date; content: Record<string, any> }[]>`
      SELECT key, generated_at, jsonb_build_object(
        'headline', content->'headline', 'title', content->'title', 'overview', content->'overview',
        'leadItemId', content->'leadItemId', 'highlights', content->'highlights',
        'themes', (SELECT coalesce(jsonb_agg(jsonb_build_object('heading', t->'heading', 'storyRefs',
          (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', i->'itemId', 'title', i->'title') ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(coalesce(t->'storyRefs', '[]'::jsonb)) WITH ORDINALITY AS e(i, ord))) ORDER BY tord), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(content->'themes', '[]'::jsonb)) WITH ORDINALITY AS x(t, tord))) AS content
      FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT ${limit}`;
  const shape = kind === "daily" ? "daily" : "periodic";
  const gone = await unavailableIds(rows.flatMap((r) => entriesOf(r.content, shape).map((i) => i.itemId)));
  return rows.map((r) => {
    const lead = issueLead(r.content, shape, gone);
    const groups: Array<{ label: unknown; items?: Array<Record<string, any>> }> = kind === "daily"
      ? (r.content.sections ?? []).map((s: any) => ({ label: s.label, items: s.items }))
      : (r.content.themes ?? []).map((t: any) => ({ label: t.heading, items: t.storyRefs }));
    return {
      key: r.key,
      generatedAt: r.generated_at,
      headline: lead?.title ?? null,
      leadParagraph: kind === "daily" ? lead?.leadParagraph ?? null : periodOverview(r.content, kind, gone),
      sections: groups.map((g) => ({
        label: String(g.label),
        items: (g.items ?? []).filter((i) => i.itemId && !gone.has(i.itemId)).map((i) => ({ title: String(i.title), link: itemUrl(i.itemId) })),
      })).filter((s) => s.items.length > 0),
    };
  });
}

// v1 weeklies and monthlies

export type PeriodKind = "weekly" | "monthly";

/** A weekly's or monthly's own key and calendar days: { week, periodStart, periodEnd } or { month, … }. */
function periodOf(kind: PeriodKind, key: string) {
  const range = kind === "weekly" ? isoWeekRange(key) : monthRange(key);
  return { ...(kind === "weekly" ? { week: key } : { month: key }), periodStart: range?.start ?? null, periodEnd: range?.end ?? null };
}

/** Whether a weekly or monthly key is a real ISO week (2026-W39) or calendar month (2026-09). */
export function isPeriodKey(kind: PeriodKind, key: string): boolean {
  return (kind === "weekly" ? isoWeekRange(key) : monthRange(key)) !== null;
}

/** The v1 index of weeklies or monthlies, newest first: key, days, headline and link. */
export async function v1Periods(kind: PeriodKind, limit: number) {
  const index = await reportIndex(kind);
  const items = index.rows.slice(0, limit).map((r) => {
    const url = periodUrl(kind, r.key);
    return {
      ...periodOf(kind, r.key),
      generatedAt: r.generated_at.toISOString(),
      headline: issueLead(r.content, "periodic", index.gone)?.title ?? null,
      links: { aihot: url },
      attribution: attribution(url),
    };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

/**
 * A weekly or monthly in v1: its headline, overview and sections, each with its introduction and the
 * items it carries in order. Withdrawn items are left out; source names are as stored, like the daily's.
 */
export async function v1Period(kind: PeriodKind, key: string | "latest") {
  const [r] = key === "latest"
    ? await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT 1`
    : await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at FROM reports WHERE kind = ${kind} AND key = ${key}`;
  if (!r) return null;
  const c = r.content;
  const raw: Array<Record<string, any>> = (c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const avail = await availability([...new Set(raw.map((i) => i.itemId).filter(Boolean))] as string[]);
  const ok = (i: Record<string, any>) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  const gone = goneIn(avail);
  const url = periodUrl(kind, r.key);
  return {
    schemaVersion: 1 as const,
    report: {
      ...periodOf(kind, r.key),
      generatedAt: r.generated_at.toISOString(),
      windowStart: r.window_start.toISOString(),
      windowEnd: r.window_end.toISOString(),
      links: { aihot: url },
      attribution: attribution(url),
      headline: issueLead(c, "periodic", gone)?.title ?? null,
      overview: periodOverview(c, kind, gone),
      sections: (c.themes ?? []).map((t: any) => ({
        label: String(t.heading),
        summary: typeof t.summary === "string" && t.summary ? t.summary : null,
        items: (t.storyRefs ?? []).filter(ok).map((i: any) => {
          const a = i.itemId ? avail.get(i.itemId) : undefined;
          return {
            title: String(i.title),
            summary: String(i.summary ?? a?.summary ?? ""),
            source: { name: String(a?.sourceName ?? i.sourceName ?? "") },
            links: { aihot: i.itemId ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") },
            publishedAt: a?.publishedAt?.toISOString() ?? (i.publishedAt ? new Date(i.publishedAt).toISOString() : null),
            attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
          };
        }),
      })).filter((s: { items: unknown[] }) => s.items.length > 0),
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
  return (await listReports(kind)).filter((e) => e.key.startsWith(month)).map(({ key, issueNumber, title }) => ({ key, issueNumber, title }));
}
