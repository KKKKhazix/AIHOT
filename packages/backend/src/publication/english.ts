import { localizePath } from "@aihot/contracts/reader-pages";
// The English edition's answers (/api/site/en/…, only where the site has an English edition): the same answers
// as the Chinese ones, with each Chinese text the site wrote (titles, summaries, reasons, event digests, report
// paragraphs, source names) replaced by its English. The worker (editorial/english.ts) translates the Chinese
// readers see and stores it under that whole text (english_copy), so a page read never calls a model, and
// English never outlives the Chinese it says: an edited text is a new key. Until the worker has a text, the
// object it belongs to shows its Chinese — all of its texts, never a card half in each language.
// Each answer's overlay runs twice: once to gather the texts it shows, once to put their English in. The worker
// gathers through the same overlays, so what it translates is what the pages show.
import type {
  FeedItemSummary, GroupReportsResponse, HotEntryView, HotParticipant, HotResponse, HotStripEntry, ItemAvailability,
  PoolResponse, ReportCitation, ReportDetail, ReportIndexResponse, ReportLatestPage, ReportNavigationResponse,
  SearchSuggestions, SiteItemDetail, SiteStats, SourceRef, StoryDetail, StoryFollowupsResponse, StoryReportView, TimelineResponse,
  TopicGroup, TopicLink, TopicPage, TopicSummary, TopicsResponse,
} from "@aihot/contracts/site";
import { REPORT_NAMES_EN } from "@aihot/contracts/site";
import { ENGLISH, HAN, needsEnglish } from "@aihot/contracts/english";

export { HAN, needsEnglish };
import { sectionLabelIn, topicDefinition, topicName } from "@aihot/contracts/taxonomy";
import { TOPIC_GROUP_EN } from "@aihot/industry/english";
import { SITE, withSubject } from "@aihot/site";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { mentionsIn } from "./mentions.ts";
import type { V1ItemPayload } from "./items.ts";
import { siteUrl } from "./links.ts";
import { COMPOSED_OVERVIEW, type ComposedOverview, type DailyNote, type FeedIssue, type ReportKind, type v1Dailies, type v1Daily, type v1Period, type v1Periods } from "./reports.ts";
import { publicSourceName } from "./rules.ts";
import { cardText, type v1HotTopics, type v1Story } from "./stories.ts";
import { monogramOf } from "./topics.ts";

/** How a text is translated: a headline, running text, or a name (its established English name, else as written). */
export type CopyKind = "headline" | "text" | "name";
/** A text of an object, how it is translated and, when it is not the object's own, the article it belongs to. */
type Part = readonly [CopyKind, string | null | undefined, (string | null | undefined)?];

/** What the worker needs about a text the pages show: how to translate it, and the article it belongs to (for its original title). */
export interface Wanted {
  kind: CopyKind;
  item: string | null;
}

export interface Copy {
  /** Link names only in the finished copy shown to readers. Gathering translation inputs needs no links. */
  mentions: typeof mentionsIn;
  /** One object's texts: all in English, or all as they are while any of them has no English yet. `item`: their article. */
  all<const T extends readonly Part[]>(parts: T, item?: string | null): { -readonly [K in keyof T]: T[K][1] };
  /** A text on its own, such as a linked title; a name without English stays as written. */
  one<S extends string | null | undefined>(kind: CopyKind, text: S, item?: string | null): S;
}


export const copyKey = (zh: string) => sha256(zh);

class Gather implements Copy {
  async mentions() { return []; }
  readonly wanted = new Map<string, Wanted>();
  private add(kind: CopyKind, text: string | null | undefined, item?: string | null) {
    if (!needsEnglish(text)) return;
    const known = this.wanted.get(text);
    if (!known) this.wanted.set(text, { kind, item: item ?? null });
    // The same words met again with their article: its original title lends them names (editorial/english.ts).
    else if (!known.item && item) known.item = item;
  }
  all<const T extends readonly Part[]>(parts: T, item?: string | null) {
    for (const [kind, text, own] of parts) this.add(kind, text, own ?? item);
    return parts.map((p) => p[1]) as { -readonly [K in keyof T]: T[K][1] };
  }
  one<S extends string | null | undefined>(kind: CopyKind, text: S, item?: string | null): S {
    this.add(kind, text, item);
    return text;
  }
}

class Apply implements Copy {
  mentions = mentionsIn;
  private readonly en: ReadonlyMap<string, string>;
  constructor(en: ReadonlyMap<string, string>) {
    this.en = en;
  }
  all<const T extends readonly Part[]>(parts: T) {
    const ready = parts.every(([, text]) => !needsEnglish(text) || this.en.has(text));
    return parts.map(([, text]) => (ready && needsEnglish(text) ? this.en.get(text) : text)) as { -readonly [K in keyof T]: T[K][1] };
  }
  one<S extends string | null | undefined>(kind: CopyKind, text: S): S {
    if (needsEnglish(text)) return (this.en.get(text) ?? text) as S;
    return (kind === "name" && text ? englishMarks(text) : text) as S;
  }
}

/** A name with nothing to translate, in English punctuation: "Example：News（RSS）" reads "Example: News (RSS)". */
const englishMarks = (name: string) =>
  name.replace(/\s*：\s*/g, ": ").replace(/\s*[，、]\s*/g, ", ").replace(/\s*（\s*/g, " (").replace(/\s*）/g, ")").trim();

export type Overlay<T> = (value: T, copy: Copy) => T | Promise<T>;

/** The Chinese texts an answer shows, with what the worker needs to translate them. */
export async function wantedIn<T>(value: T, overlay: Overlay<T>): Promise<Map<string, Wanted>> {
  const gather = new Gather();
  await overlay(value, gather);
  return gather.wanted;
}

/** A text an answer shows in Chinese, as the worker takes it. */
export interface WantedText extends Wanted {
  zh: string;
}

/** The same, as a list: what a module gives the worker (modules.ts `english`). */
export async function textsIn<T>(value: T, overlay: Overlay<T>): Promise<WantedText[]> {
  return [...(await wantedIn(value, overlay))].map(([zh, w]) => ({ zh, ...w }));
}

/**
 * The overlay of a module's answer that has none of its own: each object's strings with Han characters go together; a
 * string under a `names` key is a name; nothing under a `keep` key changes (data matched as written, like search aliases).
 * A short line without sentence punctuation reads as a headline (labels, titles), anything longer as running text.
 */
export function everyText<T>(opts: { keep?: readonly string[]; names?: readonly string[] } = {}): Overlay<T> {
  const keep = new Set(opts.keep ?? []);
  const names = new Set(opts.names ?? []);
  const kindOf = (key: string, text: string): CopyKind => (names.has(key) ? "name" : text.length <= 40 && !/[。！？；]/.test(text) ? "headline" : "text");
  const walk = (value: unknown, c: Copy, key: string): unknown => {
    if (typeof value === "string") return c.one(kindOf(key, value), value);
    if (Array.isArray(value)) return value.map((v) => walk(v, c, key));
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value);
    const own = entries.filter((e): e is [string, string] => !keep.has(e[0]) && needsEnglish(typeof e[1] === "string" ? e[1] : null));
    const shown = c.all(own.map(([k, v]) => [kindOf(k, v), v] as const));
    const english = new Map(own.map(([k], i) => [k, shown[i]]));
    return Object.fromEntries(entries.map(([k, v]) => [k, keep.has(k) ? v : english.has(k) ? english.get(k) : walk(v, c, k)]));
  };
  return (value, c) => walk(value, c, "") as T;
}

/** Whether the publication `alias` may still show its original: not withdrawn, its original not withheld. */
export const originalShown = (alias: string) => sql`(${sql(alias)}.visibility <> 'withdrawn' AND NOT ${sql(alias)}.suppress_original)`;

/**
 * A row the worker wrote with an article's original title stands only while that original may be shown; the worker
 * sends an original title by the same rule (editorial/english.ts). Keep the lookup on its primary key:
 * a broad search otherwise hashes the whole publications table to check these few originals.
 */
export const usableCopy = sql`(c.original_of IS NULL OR EXISTS (SELECT 1 FROM publications w WHERE w.article_id = c.original_of AND ${originalShown("w")} OFFSET 0))`;

/** The English of these texts, where the worker has it. */
export async function englishOf(texts: Iterable<string>): Promise<Map<string, string>> {
  const keys = [...new Set(texts)].map(copyKey);
  if (!keys.length) return new Map();
  const rows = await sql<{ zh: string; en: string }[]>`
    SELECT c.zh, c.en FROM english_copy c WHERE c.zh_hash = ANY(${keys}::text[]) AND c.en IS NOT NULL AND ${usableCopy}`;
  return new Map(rows.map((r) => [r.zh, r.en]));
}

/** The answer in English. Only for sites with an English edition: the routes exist only there. */
export async function inEnglish<T>(value: T, overlay: Overlay<T>): Promise<T> {
  const wanted = await wantedIn(value, overlay);
  return overlay(value, new Apply(await englishOf(wanted.keys())));
}

// Overlays, one per answer. Tags and topic slugs stay Chinese (they are the filters' values); the web shows them
// in English. A post, an original title and an author are shown as written.

const source = <S extends SourceRef>(s: S, c: Copy): S => ({ ...s, name: c.one("name", s.name) });
const participant = (p: HotParticipant, c: Copy): HotParticipant => ({ ...p, name: c.one("name", p.name) });
const topicLink = <L extends TopicLink>(t: L): L => ({ ...t, name: topicName(t.slug, t.name, "en") });
const topicGroup = (g: TopicGroup): TopicGroup => ({ ...g, ...(TOPIC_GROUP_EN[g.key] ?? {}) });

export function feedItem(it: FeedItemSummary, c: Copy): FeedItemSummary {
  const [title, summary, reason] = c.all([["headline", it.title], ["text", it.summary], ["text", it.reason]], it.id);
  return {
    ...it, title, summary, reason,
    source: source(it.source, c),
    // A quoted post is shown as written; its Chinese translation is for Chinese readers.
    x: it.x && { ...it.x, quoted: it.x.quoted && { ...it.x.quoted, translation: null } },
    ...(it.sameEvent ? { sameEvent: { ...it.sameEvent, title: c.one("headline", it.sameEvent.title, it.sameEvent.id) } } : {}),
  };
}

const hotStrip = (h: HotStripEntry, c: Copy): HotStripEntry => ({
  ...h, title: c.one("headline", h.title), participants: h.participants.map((p) => participant(p, c)),
});

export const timeline: Overlay<TimelineResponse> = (r, c) => ({
  ...r, cards: r.cards.map((card) => ({ ...card, item: feedItem(card.item, c) })), hot: r.hot && r.hot.map((h) => hotStrip(h, c)),
});

export const pool: Overlay<PoolResponse> = (r, c) => ({ ...r, items: r.items.map((it) => feedItem(it, c)) });

/**
 * An article page in English. Its body is the original (the route asks for it); the Chinese translation is not
 * offered, and a body written in Chinese is not sent: the page reads as its summary does. The Markdown export is
 * the Chinese page's.
 */
export const itemDetail: Overlay<SiteItemDetail> = async (d, c) => {
  const [title, summary, reason] = c.all([["headline", d.title], ["text", d.summary], ["text", d.reason]], d.id);
  const chinese = d.bodyLanguage === "zh";
  return {
    ...d, title, summary, reason,
    source: source(d.source, c),
    story: d.story && { ...d.story, title: c.one("headline", d.story.title) },
    relatedStories: d.relatedStories.map((s) => ({ ...s, title: c.one("headline", s.title) })),
    ...(d.sameEvent ? { sameEvent: { ...d.sameEvent, title: c.one("headline", d.sameEvent.title, d.sameEvent.id) } } : {}),
    topics: d.topics.map(topicLink),
    x: d.x && { ...d.x, quoted: d.x.quoted && { ...d.x.quoted, translationHtml: null } },
    body: chinese ? null : d.body && { ...d.body, zh: null, zhKind: null },
    outline: chinese ? [] : d.outline,
    hasTranslation: false,
    bodyLanguage: "original",
    markdownAvailable: false,
    mentions: await c.mentions([summary]),
  };
};

export const groupReports: Overlay<GroupReportsResponse> = (r, c) => ({
  ...r, reports: r.reports.map((x) => ({ ...x, title: c.one("headline", x.title, x.id), source: source(x.source, c) })),
});

export const followups: Overlay<StoryFollowupsResponse> = (r, c) => ({
  ...r,
  items: r.items.map((f) => ({
    ...f, representative: { ...f.representative, title: c.one("headline", f.representative.title, f.representative.id), source: source(f.representative.source, c) },
  })),
});

/** A hot card: the event's title and digest and its latest turn go together; English is clipped longer, as it runs longer. */
const hotEntry = (e: HotEntryView, c: Copy): HotEntryView => {
  const [title, summary, latest] = c.all([["headline", e.story.title], ["text", e.summary], ["headline", e.latest]]);
  return {
    ...e, story: { ...e.story, title }, summary: cardText(summary, needsEnglish(summary) ? 480 : 1200), latest,
    sourceNames: e.sourceNames.map((n) => c.one("name", n)),
    participants: e.participants.map((p) => participant(p, c)),
  };
};

/** Over the hot ranking with its texts whole (loadHot without clipping): the clip comes after, in the shown language. */
export const hot: Overlay<HotResponse> = (r, c) => ({ ...r, entries: r.entries.map((e) => hotEntry(e, c)) });

const storyReport = (r: StoryReportView, c: Copy): StoryReportView => {
  const [title, summary] = c.all([["headline", r.title], ["text", r.summary]], r.id);
  return { ...r, title, summary, source: source(r.source, c) };
};

/** The story headline and its opening copy switch language together on the page and its share image. */
export function storyHeading<S extends Pick<StoryDetail, "title" | "digest" | "summary" | "excerpt" | "latest" | "latestReport">>(s: S, c: Copy): S {
  const [title, digest, summary, excerptText] = c.all([["headline", s.title], ["text", s.digest], ["text", s.summary], ["text", s.excerpt?.text]], s.excerpt?.itemId);
  const excerpt = s.excerpt && { ...s.excerpt, text: excerptText!, sourceName: c.one("name", s.excerpt.sourceName) };
  return {
    ...s, title, digest, summary, excerpt,
    latest: c.one("headline", s.latest, s.latestReport?.id),
  };
}

export const story: Overlay<StoryDetail> = async (s, c) => {
  const head = storyHeading(s, c);
  const { digest, summary, excerpt } = head;
  return {
    ...head,
    developments: s.developments.map((f) => {
      const [factTitle, reportTitle, reportSummary] = c.all([["headline", f.title], ["headline", f.representative.title], ["text", f.representative.summary]], f.representative.id);
      return { ...f, title: factTitle, representative: { ...f.representative, title: reportTitle, summary: reportSummary, source: source(f.representative.source, c) } };
    }),
    officialReports: s.officialReports.map((r) => storyReport(r, c)),
    timeline: s.timeline.map((r) => storyReport(r, c)),
    related: s.related.map((r) => ({ ...r, title: c.one("headline", r.title) })),
    topics: s.topics.map(topicLink),
    mentions: await c.mentions([digest ?? summary ?? excerpt?.text]),
  };
};

const citation = (x: ReportCitation, c: Copy): ReportCitation => {
  const [title, summary] = c.all([["headline", x.title], ["text", x.summary]], x.itemId);
  return {
    ...x, title, summary, sourceName: c.one("name", x.sourceName),
    ...(x.related ? { related: x.related.map((r) => citation(r, c)) } : {}),
  };
};

/** The issue's own name: a daily's, or the composer's for a weekly or monthly without a headline of its own. */
function issueTitle(r: ReportDetail, c: Copy): string {
  if (r.kind === "daily") return `${withSubject(REPORT_NAMES_EN.daily)} · ${r.key}`;
  const composed = `${SITE.name} ${r.kind === "weekly" ? "周报" : "月报"} · ${r.key}`;
  return r.title === composed ? `${SITE.name} ${REPORT_NAMES_EN[r.kind]} · ${r.key}` : c.one("headline", r.title);
}

/**
 * An issue's front: its lead and overview, in one language. A weekly's or monthly's lead paragraph is its overview,
 * which, once a report it named is withdrawn, is composed by rule (reports.ts COMPOSED_OVERVIEW) and said here in
 * English from the titles it names.
 */
function front(r: ReportDetail, c: Copy): Pick<ReportDetail, "lead" | "overview"> {
  if (r.kind === "daily") {
    const [title, leadParagraph] = c.all([["headline", r.lead?.title], ["text", r.lead?.leadParagraph]], r.leadItemId);
    return { lead: r.lead && { title: title!, leadParagraph: leadParagraph! }, overview: c.one("text", r.overview) };
  }
  const composed = (r as ReportDetail & { [COMPOSED_OVERVIEW]?: ComposedOverview })[COMPOSED_OVERVIEW];
  if (!composed) {
    const [title, overview] = c.all([["headline", r.lead?.title], ["text", r.overview]], r.leadItemId);
    return { lead: r.lead && { title: title!, leadParagraph: overview ?? "" }, overview };
  }
  const [title, ...titles] = c.all([["headline", r.lead?.title, r.leadItemId], ...composed.named.map((n) => ["headline", n.title, n.itemId] as const)]);
  if (titles.some(needsEnglish)) return { lead: r.lead, overview: r.overview };
  const overview = composedOverview(r.kind, composed.count, titles as string[]);
  return { lead: r.lead && { title: title!, leadParagraph: overview }, overview };
}

/** Only the issue title and lead appear on its share image. */
export const reportHeading: Overlay<ReportDetail> = (r, c) => ({ ...r, ...front(r, c), title: issueTitle(r, c) });

/** A composed overview in English, from the titles it names (already in English). */
function composedOverview(kind: ReportKind, count: number, titles: string[]): string {
  const units = ENGLISH?.reports.entry ?? { one: "story", many: "stories" };
  return `${kind === "weekly" ? "This week" : "This month"}: ${count} ${count === 1 ? units.one : units.many}. The most watched: ${titles.join("; ")}.`;
}

/**
 * A report feed's issues (feeds.ts), said as the issue pages say them: each headline goes with its lead paragraph (a
 * composed overview in English from the titles it names), then the sections' labels and the entries' titles.
 */
export const feedIssues = (kind: ReportKind): Overlay<FeedIssue[]> => (issues, c) => issues.map((r) => {
  const composed = (r as FeedIssue & { [COMPOSED_OVERVIEW]?: ComposedOverview })[COMPOSED_OVERVIEW];
  let headline = r.headline;
  let leadParagraph = r.leadParagraph;
  if (composed) {
    const [title, ...titles] = c.all([["headline", r.headline, r.leadItemId], ...composed.named.map((n) => ["headline", n.title, n.itemId] as const)]);
    if (!titles.some(needsEnglish)) [headline, leadParagraph] = [title ?? null, composedOverview(kind, composed.count, titles as string[])];
  } else {
    [headline, leadParagraph] = c.all([["headline", r.headline], ["text", r.leadParagraph]], r.leadItemId);
  }
  return {
    ...r,
    headline: headline ?? null,
    leadParagraph: leadParagraph ?? null,
    sections: r.sections.map((s) => ({
      label: kind === "daily" ? sectionLabelIn(s.label, "en") : c.one("headline", s.label),
      items: s.items.map((i) => ({ ...i, title: c.one("headline", i.title, i.id) })),
    })),
  };
});

export const report: Overlay<ReportDetail> = async (r, c) => {
  const { lead, overview } = front(r, c);
  const sections = r.sections.map((s) => ({
    ...s,
    label: r.kind === "daily" ? sectionLabelIn(s.label, "en", s.key) : c.one("headline", s.label),
    summary: c.one("text", s.summary),
    items: s.items.map((x) => citation(x, c)),
  }));
  return {
    ...r,
    title: issueTitle(r, c),
    lead,
    overview,
    highlights: r.highlights.map((x) => citation(x, c)),
    sections,
    flashes: r.flashes.map((x) => citation(x, c)),
    cover: r.cover && { ...r.cover, caption: c.one("headline", r.cover.caption) },
    mentions: await c.mentions([lead?.leadParagraph, overview, ...sections.flatMap((s) => [s.summary, ...s.items.map((i) => i.summary)])]),
  };
};

export const reportIndex: Overlay<ReportIndexResponse> = (r, c) => ({ ...r, items: r.items.map((e) => ({ ...e, title: c.one("headline", e.title) })) });

export const reportNavigation: Overlay<ReportNavigationResponse> = (r, c) => ({ ...r, items: r.items.map((e) => ({ ...e, title: c.one("headline", e.title) })) });

export const reportLatest: Overlay<ReportLatestPage> = async (r, c) => ({
  index: r.index.map((e) => ({ ...e, title: c.one("headline", e.title) })),
  report: r.report && await report(r.report, c),
});

const topicSummary = <S extends TopicSummary>(t: S, c: Copy): S => ({
  ...topicLink(t),
  definition: topicDefinition(t.slug, t.definition, "en"),
  brand: t.brand && !t.brand.src ? { ...t.brand, monogram: monogramOf(topicName(t.slug, t.name, "en")) } : t.brand,
  latest: t.latest && { ...t.latest, title: c.one("headline", t.latest.title, t.latest.id) },
});

export const topics: Overlay<TopicsResponse> = (r, c) => ({ groups: r.groups.map(topicGroup), topics: r.topics.map((t) => topicSummary(t, c)) });

export const topicPage: Overlay<TopicPage> = (r, c) => ({
  ...r,
  topic: { ...topicSummary(r.topic, c), groupName: TOPIC_GROUP_EN[r.topic.group]?.name ?? r.topic.groupName },
  items: r.items.map((it) => feedItem(it, c)),
});

export const suggestions: Overlay<SearchSuggestions> = (r, c) => ({
  topics: r.topics.map(topicLink),
  hot: r.hot.map((h) => ({ ...h, title: c.one("headline", h.title) })),
});

/** The about page's figures: its river of source names and the latest picks. */
export const stats: Overlay<SiteStats> = (r, c) => ({
  ...r,
  sampleSources: r.sampleSources.map((s) => ({ ...s, name: c.one("name", s.name) })),
  latest: r.latest.map((l) => ({ ...l, title: c.one("headline", l.title, l.id), source: c.one("name", l.source) })),
});

/** Starred items: each one's title and summary today, and its source's name. */
export const availability: Overlay<Record<string, ItemAvailability>> = (r, c) => Object.fromEntries(Object.entries(r).map(([id, a]) => {
  const [title, summary] = c.all([["headline", a.title], ["text", a.summary]], id);
  return [id, {
    ...a,
    ...(a.title !== undefined ? { title, summary } : {}),
    ...(a.sourceName !== undefined ? { sourceName: c.one("name", a.sourceName) } : {}),
  }];
}));

// v1 answers in English: lang=en on /api/v1 and /api/v1/agent, and the MCP tools' lang "en". Each text as the pages
// say it, field by field (v1 shows a few texts in places the pages do not, and a missing one must not hold back the
// rest). Programs read the JSON ("json"): a source keeps the name it is stored under, which they filter and fingerprint
// by. Agents read text ("text"): a source reads by its public name in English, as on the pages.

/** Who reads a v1 answer: a program (JSON) or an agent (the Markdown and the MCP tools' text). */
export type V1Reader = "json" | "text";

const v1Source = <S extends { name: string }>(s: S, c: Copy, by: V1Reader): S => (by === "text" ? { ...s, name: c.one("name", publicSourceName(s.name)) } : s);
const v1Name = (name: string, c: Copy, by: V1Reader) => (by === "text" ? c.one("name", publicSourceName(name)) : name);
const v1Entry = <E extends { title: string; summary?: string | null; source: { name: string } }>(e: E, c: Copy, by: V1Reader): E => ({
  ...e, title: c.one("headline", e.title), ...(e.summary !== undefined ? { summary: c.one("text", e.summary) } : {}), source: v1Source(e.source, c, by),
});

/** v1 items and search results. */
export const v1Items = (by: V1Reader) => <R extends { items: V1ItemPayload[] }>(r: R, c: Copy): R => ({
  ...r, items: r.items.map((i) => ({ ...v1Entry(i, c, by), reason: c.one("text", i.reason) })),
});

type V1Hot = Awaited<ReturnType<typeof v1HotTopics>>;
export const v1Hot = (by: V1Reader): Overlay<V1Hot> => (r, c) => ({
  ...r, items: r.items.map((t) => ({ ...t, title: c.one("headline", t.title), source: v1Source(t.source, c, by), sourceNames: t.sourceNames.map((n) => v1Name(n, c, by)) })),
});

type V1Story = NonNullable<Awaited<ReturnType<typeof v1Story>>>;
export const v1StoryAnswer = (by: V1Reader): Overlay<V1Story> => (r, c) => {
  const s = r.story;
  const neighbour = <N extends { title: string }>(n: N): N => ({ ...n, title: c.one("headline", n.title) });
  return {
    ...r,
    story: {
      ...s, title: c.one("headline", s.title), latest: c.one("headline", s.latest), digest: c.one("text", s.digest),
      reports: s.reports.map((x) => v1Entry(x, c, by)), storyline: s.storyline.map(neighbour), related: s.related.map(neighbour),
    },
  };
};

type V1Daily = NonNullable<Awaited<ReturnType<typeof v1Daily>>>;
export const v1DailyAnswer = (by: V1Reader): Overlay<V1Daily> => (r, c) => {
  const d = r.report;
  return {
    ...r,
    report: {
      ...d,
      lead: d.lead && { title: c.one("headline", d.lead.title), leadParagraph: c.one("text", d.lead.leadParagraph) },
      sections: d.sections.map((s: (typeof d.sections)[number]) => ({ ...s, label: sectionLabelIn(s.label, "en"), items: s.items.map((i: (typeof s.items)[number]) => v1Entry(i, c, by)) })),
      flashes: d.flashes.map((i: (typeof d.flashes)[number]) => v1Entry(i, c, by)),
      highlights: d.highlights.map((i: (typeof d.highlights)[number]) => v1Entry(i, c, by)),
    },
  };
};

/** What the Agent answer adds to a daily's entries: the event's other developments, by their titles. */
export const v1DailyNotes: Overlay<Map<string, DailyNote>> = (notes, c) =>
  new Map([...notes].map(([key, n]) => [key, { ...n, related: n.related.map((x) => ({ ...x, title: c.one("headline", x.title) })) }]));

type V1Period = NonNullable<Awaited<ReturnType<typeof v1Period>>>;
/** A weekly or monthly; an overview composed by rule is said in English from the titles it names, as on its page. */
export const v1PeriodAnswer = (kind: "weekly" | "monthly", by: V1Reader): Overlay<V1Period> => (r, c) => {
  const p = r.report;
  const composed = (p as typeof p & { [COMPOSED_OVERVIEW]?: ComposedOverview })[COMPOSED_OVERVIEW];
  let overview = c.one("text", p.overview);
  if (composed) {
    const titles = composed.named.map((n) => c.one("headline", n.title));
    if (!titles.some(needsEnglish)) overview = composedOverview(kind, composed.count, titles);
  }
  return {
    ...r,
    report: {
      ...p, headline: c.one("headline", p.headline), overview,
      sections: p.sections.map((s: (typeof p.sections)[number]) => ({ ...s, label: c.one("headline", s.label), summary: c.one("text", s.summary), items: s.items.map((i: (typeof s.items)[number]) => v1Entry(i, c, by)) })),
    },
  };
};

export const v1DailyIndex: Overlay<Awaited<ReturnType<typeof v1Dailies>>> = (r, c) => ({
  ...r, items: r.items.map((e) => ({ ...e, leadTitle: c.one("headline", e.leadTitle), leadParagraph: c.one("text", e.leadParagraph) })),
});

export const v1PeriodIndex: Overlay<Awaited<ReturnType<typeof v1Periods>>> = (r, c) => ({
  ...r, items: r.items.map((e) => ({ ...e, headline: c.one("headline", e.headline) })),
});

const LINK_KEYS = new Set(["aihot", "story", "api", "url", "link"]);

/**
 * An English answer's links: the pages it links to at their English addresses, and its v1 addresses asked in English
 * too, so every next step an answer offers stays in English.
 */
export function englishLinks<T>(value: T): T {
  const api = siteUrl("/api/v1/");
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (!LINK_KEYS.has(key)) return v;
      if (v.startsWith(api)) return `${v}${v.includes("?") ? "&" : "?"}lang=en`;
      const base = siteUrl("");
      return v.startsWith(base + "/") ? base + localizePath(v.slice(base.length), "en") : v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, walk(x, key)]));
    if (v && typeof v === "object") return Object.assign(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)])), symbolsOf(v));
    return v;
  };
  return walk(value, "") as T;
}

/** An object's symbol-keyed marks (COMPOSED_OVERVIEW), kept across englishLinks. */
const symbolsOf = (v: object) => Object.fromEntries(Object.getOwnPropertySymbols(v).map((k) => [k, (v as Record<symbol, unknown>)[k]]));

/** A v1 answer in English: its texts, then its links. */
export async function v1InEnglish<T>(value: T, overlay: Overlay<T>): Promise<T> {
  return englishLinks(await inEnglish(value, overlay));
}
