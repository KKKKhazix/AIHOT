// Topic milestones: which selected reports are a topic's milestones and of what kind, which of them
// are one event, how many a month keeps and what each is called. The steps are the same for every
// industry; the kinds, how a report is classified, and merging and naming beyond plain equality are
// the industry pack's (industry/chronicle.ts). Deterministic rules on fields the reports already have,
// no model calls; offline replay imports the same functions.
import type { CategoryKey } from "@aihot/contracts/taxonomy";
import type { TopicEvent, TopicGroupKey, TopicKind, TopicMilestoneKind, TopicMonth } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { CHRONICLE } from "@aihot/industry/chronicle";
import { ENTITIES, entityIdentity, isRelease } from "../editorial/vocabulary.ts";

export interface ChronicleTopic {
  slug: string;
  group: TopicGroupKey;
  entityId: string | null;
  /** Directions: words a milestone's title must use to be about the direction (industry/topics.json). */
  terms: RegExp | null;
  /** Companies: the names its own announcements open with, understood on its page. */
  orgNames: string[];
}

export interface ChronicleReport {
  id: string;
  title: string;
  originalTitle: string | null;
  category: CategoryKey | null;
  tags: string[];
  score: number | null;
  topicSlugs: string[];
  timelineAt: Date;
  publishedAt: Date | null;
  /** Earliest currently public selected evidence of the same fact, including replaced representatives. */
  factPublishedAt: Date | null;
  firstParty: boolean;
  owner: string | null;
  factId: number | null;
  factSubject: string | null;
  factAction: string | null;
  factOccurredAt: Date | null;
  storyPublicId: string | null;
  sourceCount: number;
  scope: string | null;
}

/** How pages show each kind: its name, its track on a company's band, its mark. */
export const CHRONICLE_KINDS: Record<TopicMilestoneKind, TopicKind> = Object.fromEntries(
  Object.entries(CHRONICLE.kinds).map(([key, k]) => [key, { label: k.label, above: !!k.above, launch: !!k.launch }]),
);
/** A company's highlights list its kinds in the pack's order. */
const KIND_ORDER = Object.keys(CHRONICLE.kinds);

/** A direction's or a form's month keeps this many of its most important events; a form may keep more. */
const MONTH_LIMIT = 5;
/** Reports of one event within a week are one milestone. */
const SAME_EVENT_DAYS = 7;
const DAY = 86_400_000;

const CJK = /\p{Script=Han}/u;
/** A title the chronicle can show: Chinese, or a short name such as "Grok 4.3", not an untranslated post. */
const readable = (title: string) => CJK.test(title) || title.trim().split(/\s+/).length <= 4;
const plain = (title: string) => title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const companyNames = new Map(Object.entries(ENTITIES).map(([id, e]) => {
  const names = [id, e.name, ...e.aliases, ...(e.otherNames ?? [])].map(escape).join("|");
  return [id, { anywhere: new RegExp(`(?<![A-Za-z])(?:${names})(?![A-Za-z])`, "i"), first: new RegExp(`^(?:${names})(?![A-Za-z])`, "i") }];
}));
/** The company a text names first. */
function firstCompany(text: string): string | null {
  let best: { id: string; at: number } | null = null;
  for (const [id, names] of companyNames) {
    const at = text.search(names.anywhere);
    if (at >= 0 && (!best || at < best.at)) best = { id, at };
  }
  return best?.id ?? null;
}
const subjectsOf = (r: ChronicleReport) => r.factSubject?.split(/[,，、;；+＋&＆/]/u).map(entityIdentity) ?? [];
const companyTags = (r: ChronicleReport) => r.tags.filter((tag) => tag.startsWith("entity:"));

/**
 * The company's own launch: a subject of the fact; with a subject outside the vocabulary, a title that
 * starts with the company; with none, the company the title names first, before what is launched
 * (or an original title that starts with the company, when the title names none).
 */
function ownLaunch(entity: string, r: ChronicleReport): boolean {
  const names = companyNames.get(entity);
  const subjects = subjectsOf(r);
  if (subjects.some(Boolean)) return subjects.includes(entity);
  if (r.factSubject?.trim()) return names?.first.test(r.title) ?? false;
  const verb = r.title.search(CHRONICLE.launchVerb);
  const actor = firstCompany(verb > 0 ? r.title.slice(0, verb) : r.title);
  return actor ? actor === entity : (names?.first.test(r.originalTitle ?? "") ?? false);
}
/** The company's own news: a subject of the fact, or the only company the report is about. */
function ownNews(entity: string, r: ChronicleReport): boolean {
  const subjects = subjectsOf(r);
  if (subjects.some(Boolean)) return subjects.includes(entity);
  const tags = companyTags(r);
  return tags.length === 1 && tags[0] === `entity:${entity}`;
}

/** What the topic's pages ask of a kind: a company's, or the rest of the topics'; none when they do not take it. */
const kindRules = (t: ChronicleTopic, kind: TopicMilestoneKind) =>
  t.group === "company" ? CHRONICLE.kinds[kind]?.company : CHRONICLE.kinds[kind]?.other;

/**
 * What the report is to the topic, or null when it is no milestone of it whatever its score: a kind the
 * topic's pages take; on a company's page its own launch or its own news; on a direction's page a title
 * naming the direction; on a form's page a kind the form takes.
 */
function milestoneKind(t: ChronicleTopic, r: ChronicleReport): TopicMilestoneKind | null {
  if (!r.topicSlugs.includes(t.slug) || r.category === null || r.scope === "composite" || !readable(r.title)) return null;
  const kind = CHRONICLE.kindOf({ ...r, release: isRelease(r.category, r.tags) }, t.group);
  if (!kind || !kindRules(t, kind)) return null;
  if (t.group === "company") return t.entityId && (CHRONICLE.kinds[kind].launch ? ownLaunch(t.entityId, r) : ownNews(t.entityId, r)) ? kind : null;
  if (t.group === "field") return t.terms?.test(`${r.title} ${r.originalTitle ?? ""}`) ? kind : null;
  return CHRONICLE.forms[t.slug]?.kinds.includes(kind) ? kind : null;
}

/** Its score reaches the kind's minimum; a missing score never acquires a default. */
const qualifies = (t: ChronicleTopic, r: ChronicleReport, kind: TopicMilestoneKind) =>
  r.score !== null && r.score >= (kindRules(t, kind)?.min ?? Infinity);

const eventKey = (r: ChronicleReport) => r.storyPublicId ? `s:${r.storyPublicId}` : r.factId !== null ? `f:${r.factId}` : `a:${r.id}`;
const reportDate = (r: ChronicleReport) => r.factOccurredAt ?? r.factPublishedAt ?? r.publishedAt ?? r.timelineAt;
const monthOf = (at: Date) => beijingDate(at).slice(0, 7);
function firstMonth(now: Date): string {
  const [year, month] = beijingDate(now).split("-").map(Number) as [number, number];
  return monthOf(new Date(Date.UTC(year, month - 12, 1)));
}
export interface ChronicleWindow { now: Date; through?: string }
const afterHistory = (r: ChronicleReport, through?: string) => !through || monthOf(reportDate(r)) > through;

/** Bounded current-content reads include earlier reports of the same event, so a stronger follow-up cannot move its date. */
export function chronicleReadReports<T extends ChronicleReport>(reports: T[], { now, through }: ChronicleWindow): T[] {
  const start = firstMonth(now);
  const automatic = reports.filter((r) => afterHistory(r, through));
  const keys = new Set(automatic.filter((r) => monthOf(reportDate(r)) >= start && reportDate(r) <= now).map(eventKey));
  return automatic.filter((r) => keys.has(eventKey(r)));
}

interface Candidate {
  kind: TopicMilestoneKind;
  /** The report that names the event. */
  head: ChronicleReport;
  at: Date;
  score: number;
  sources: number;
  /** Its name in the chronicle. */
  label: string;
  /** Its qualifying reports. */
  reports: ChronicleReport[];
}

/** The headline: a Chinese title first, then the higher score, the wider coverage, the first party, the earlier report. */
const headline = (a: ChronicleReport, b: ChronicleReport) => Number(CJK.test(b.title)) - Number(CJK.test(a.title))
  || (b.score ?? 0) - (a.score ?? 0) || b.sourceCount - a.sourceCount || Number(b.firstParty) - Number(a.firstParty)
  || reportDate(a).getTime() - reportDate(b).getTime() || a.id.localeCompare(b.id);
const importance = (a: Candidate, b: Candidate) => b.score - a.score || b.sources - a.sources
  || Number(b.head.firstParty) - Number(a.head.firstParty) || a.at.getTime() - b.at.getTime() || a.head.id.localeCompare(b.head.id);

/** Where a headline's first sentence ends: an event's name when the industry pack gives none. */
const SENTENCE = /[，；。！？]|(?<!\d),|,(?!\d)|[;!?](?=\s|$|\p{Script=Han})/u;
const labelOf = (t: ChronicleTopic, title: string, kind: TopicMilestoneKind) =>
  CHRONICLE.eventName?.(title, kind, t) ?? title.split(SENTENCE)[0]!.trim();

function candidate(t: ChronicleTopic, kind: TopicMilestoneKind, reports: ChronicleReport[], at: Date): Candidate {
  const head = [...reports].sort(headline)[0]!;
  return { kind, head, at, score: Math.max(...reports.map((r) => r.score!)), sources: Math.max(...reports.map((r) => r.sourceCount)),
    label: labelOf(t, head.title, kind), reports };
}

/** Within a week: the same headline, or of one kind the same name or (the industry pack's) the same event. */
const oneEvent = (e: Candidate, m: Candidate) => e.at.getTime() - m.at.getTime() <= SAME_EVENT_DAYS * DAY && (plain(e.head.title) === plain(m.head.title)
  || (e.kind === m.kind && (plain(e.label) === plain(m.label) || !!CHRONICLE.sameEvent?.(e, m))));

function candidates(t: ChronicleTopic, reports: ChronicleReport[], window: ChronicleWindow): Candidate[] {
  // One event per story or fact, dated by its earliest report: an explicit occurrence, else the first publication.
  const groups = new Map<string, Array<{ r: ChronicleReport; kind: TopicMilestoneKind }>>();
  for (const r of reports) {
    const kind = afterHistory(r, window.through) ? milestoneKind(t, r) : null;
    if (kind) groups.set(eventKey(r), [...(groups.get(eventKey(r)) ?? []), { r, kind }]);
  }
  const events: Candidate[] = [];
  for (const list of groups.values()) {
    const qualified = list.filter(({ r, kind }) => qualifies(t, r, kind));
    if (qualified.length === 0) continue;
    const explicit = list.flatMap(({ r }) => r.factOccurredAt ? [r.factOccurredAt] : []);
    const dates = explicit.length ? explicit : list.map(({ r }) => r.factPublishedAt ?? r.publishedAt ?? r.timelineAt);
    const head = [...qualified].sort((a, b) => headline(a.r, b.r))[0]!;
    events.push(candidate(t, head.kind, qualified.map(({ r }) => r), new Date(Math.min(...dates.map(Number)))));
  }
  // Grouping can leave one event in several: merge them into the earliest.
  events.sort((a, b) => a.at.getTime() - b.at.getTime() || a.head.id.localeCompare(b.head.id));
  const merged: Candidate[] = [];
  for (const e of events) {
    const i = merged.findIndex((m) => oneEvent(e, m));
    if (i < 0) merged.push(e);
    else merged[i] = candidate(t, merged[i]!.kind, [...merged[i]!.reports, ...e.reports], merged[i]!.at);
  }
  const start = firstMonth(window.now);
  return merged.filter((c) => monthOf(c.at) >= start && c.at <= window.now);
}

/** A company keeps up to its kinds' allowance by importance; another topic its most important events. */
function pick(t: ChronicleTopic, list: Candidate[]): Candidate[] {
  const ranked = [...list].sort(importance);
  if (t.group !== "company") return ranked.slice(0, CHRONICLE.forms[t.slug]?.perMonth ?? MONTH_LIMIT);
  const taken = new Map<TopicMilestoneKind, number>();
  return ranked.filter((c) => {
    taken.set(c.kind, (taken.get(c.kind) ?? 0) + 1);
    return taken.get(c.kind)! <= (CHRONICLE.kinds[c.kind]?.company?.perMonth ?? 0);
  });
}

function toEvent(c: Candidate): TopicEvent {
  const r = c.head;
  return { id: r.id, title: r.title, label: c.label, at: c.at.toISOString(), kind: c.kind,
    href: r.storyPublicId ? `/story/${r.storyPublicId}` : `/items/${r.id}` };
}

export function selectTopicChronicle(t: ChronicleTopic, reports: ChronicleReport[], window: ChronicleWindow): TopicMonth[] {
  const months = new Map<string, Candidate[]>();
  for (const c of candidates(t, reports, window)) months.set(monthOf(c.at), [...(months.get(monthOf(c.at)) ?? []), c]);
  return [...months].sort(([a], [b]) => b.localeCompare(a)).map(([month, list]) => ({
    month,
    events: pick(t, list).sort((a, b) => b.at.getTime() - a.at.getTime() || a.head.id.localeCompare(b.head.id)).map(toEvent),
  }));
}

/** The search snippet's events: the last 30 days' most important, a company's in the order of its kinds. */
export function selectTopicHighlights(t: ChronicleTopic, reports: ChronicleReport[], window: ChronicleWindow): TopicEvent[] {
  const recent = candidates(t, reports, window).filter((c) => c.at.getTime() > window.now.getTime() - 30 * DAY);
  const order = (a: Candidate, b: Candidate) => (t.group === "company" ? KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) : 0) || importance(a, b);
  return recent.sort(order).slice(0, 3).map(toEvent);
}
