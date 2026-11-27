// English for the English edition (publication/english.ts): every few minutes, what the site shows in Chinese and
// has no English for yet, translated from that Chinese (as editors and the compliance review left it), never from
// the originals, whose titles only lend names their spelling. Newest first: the last days' reports and events, the
// hot ranking and its leading events, the latest issues, topics and source names; then, as time allows, the rest
// readers reach (every selected report, 30 days of 全部动态, the reports of every event, older events and issues).
// Every source reads what readers see now, as they see it, so nothing hidden or withdrawn is sent.
// A text is its own key, so an edited one is translated again and an unchanged one never. A text the model leaves
// out or answers unusably goes alone the next time a source still shows it; one whose request may have been billed
// (its outcome unknown) waits until that request is released (operations/recover.ts), then goes alone once more and
// no more: a lost answer is paid for again at most once, as everywhere else. After three attempts it stays Chinese.
import { z } from "zod";
import { ENGLISH } from "@aihot/contracts/english";
import { sql, type Db } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt, failedReceiptId, failureKind, stopsBatchRun } from "../providers/receipts.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import * as english from "../publication/english.ts";
import { copyKey, HAN, needsEnglish, originalShown, usableCopy, wantedIn, type Wanted, type WantedText } from "../publication/english.ts";
import { loadChangelog } from "../site/meta.ts";
import { serverModules } from "../modules.ts";
import { latestHotRanking } from "../publication/hot.ts";
import { listReports, loadReport, type ReportKind } from "../publication/reports.ts";
import { publicSourceName } from "../publication/rules.ts";
import { storyReportCondition } from "../publication/scope.ts";
import { loadHot, loadStoryDetail } from "../publication/stories.ts";
import { storyTexts } from "../publication/story-text.ts";
import { listTopicSummaries } from "../publication/topics.ts";
import { modelFor } from "./models.ts";
import { promptText, promptVersion } from "./prompts.ts";

export const ENGLISH_PROMPT_VERSION = promptVersion("translate-copy-en");
const GLOSSARY = Object.entries(ENGLISH?.glossary ?? {});
const SYSTEM = promptText("translate-copy-en", {
  glossary: GLOSSARY.length ? `- 这些名字照此写：${GLOSSARY.map(([zh, en]) => `${zh} → ${en}`).join("；")}。` : "",
});

const BATCH_CHARS = 3000;
const BATCH_TEXTS = 24;
const MAX_FAILURES = 3;
/** A request's longest wait: a run starts none it could not finish within its budget. */
const REQUEST_MS = 90_000;
/** Reports found in the last days are translated first, whatever list they are in. */
const RECENT_DAYS = 3;
/** 全部动态 as far back as readers page through it. */
const POOL_DAYS = 30;
/** The leading events of the hot ranking, whose pages readers open most. */
const HOT_STORIES = 10;

const Output = z.object({ t: z.array(z.object({ id: z.number().int(), en: z.string() })) });

/** A text to translate, with the article it belongs to (its original title and source lend names their spelling). */
interface Text extends WantedText {
  attempts?: number;
}

/**
 * A text's row (`c`) asks for no request now: its English is usable, it was tried three times, or the request it went
 * in may have been billed and is not released yet.
 */
const NOT_DUE: ReturnType<typeof sql> = sql`((c.en IS NOT NULL AND ${usableCopy}) OR c.failures >= ${MAX_FAILURES}
  OR EXISTS (SELECT 1 FROM receipts r WHERE r.id = c.held_by AND r.status = 'unknown'))`;

/** A text shown in Chinese that is due: never tried, or failed and due again. */
const missing = (text: ReturnType<typeof sql>) => sql`(${text} ~ ${HAN} AND NOT EXISTS (
  SELECT 1 FROM english_copy c WHERE c.zh_hash = encode(sha256(convert_to(${text}, 'UTF8')), 'hex') AND ${NOT_DUE}))`;

const fromWanted = (wanted: Map<string, Wanted>): Text[] => [...wanted].map(([zh, w]) => ({ zh, kind: w.kind, item: w.item }));

/**
 * The reason where readers see it, as the read layer shows it (publication/items.ts toItemSummary, detail.ts): a
 * selected report's. A summary-only page and an unselected report show none, so theirs is never sent.
 */
const SHOWN_REASON: ReturnType<typeof sql> = sql`CASE WHEN p.visibility = 'public' AND p.selected THEN p.reason END`;

const itemTexts = (r: { id: string; title: string; summary: string | null; reason: string | null }): Text[] => [
  { zh: r.title, kind: "headline", item: r.id },
  ...(r.summary ? [{ zh: r.summary, kind: "text" as const, item: r.id }] : []),
  ...(r.reason ? [{ zh: r.reason, kind: "text" as const, item: r.id }] : []),
];

/** A development (`f`) an event page lists: one with a public report as its evidence. */
const shownFact = () => sql`EXISTS (
  SELECT 1 FROM fact_articles fa JOIN publications p ON p.article_id = fa.article_id JOIN sources s ON s.id = p.source_id
  WHERE fa.fact_id = f.id AND fa.role <> 'mention' AND ${storyReportCondition(new Date())})`;

async function items(window: "recent" | "reachable", limit: number): Promise<Text[]> {
  const scope = window === "recent"
    ? sql`p.discovered_at > now() - make_interval(days => ${RECENT_DAYS})`
    : sql`(p.selected OR (p.eligible AND p.discovered_at > now() - make_interval(days => ${POOL_DAYS}))
        OR EXISTS (SELECT 1 FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
                   WHERE fa.article_id = p.article_id AND fa.role <> 'mention'))`;
  const rows = await sql<{ id: string; title: string; summary: string | null; reason: string | null }[]>`
    SELECT p.article_id AS id, p.title, p.summary, ${SHOWN_REASON} AS reason
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.visibility IN ('public', 'summary-only') AND s.participation_mode = 'editorial' AND ${scope}
      AND (${missing(sql`p.title`)} OR ${missing(sql`p.summary`)} OR ${missing(SHOWN_REASON)})
    ORDER BY p.selected DESC, p.discovered_at DESC LIMIT ${limit}`;
  return rows.flatMap(itemTexts);
}

/** The hot ranking, the hot strip and search suggestions, and the leading events' pages. */
async function hot(): Promise<Text[]> {
  const ranking = await latestHotRanking();
  if (!ranking) return [];
  const out = fromWanted(await wantedIn(await loadHot((text) => text, ranking), english.hot));
  const now = new Date();
  for (const entry of ranking.entries.slice(0, HOT_STORIES)) {
    const story = await loadStoryDetail(entry.storyId, now, entry.rank);
    if (story) out.push(...fromWanted(await wantedIn(story, english.story)));
  }
  return out;
}

const KINDS: ReportKind[] = ["daily", "weekly", "monthly"];

/** Each kind's archive (every issue's headline) and its latest issue. */
async function latestIssues(): Promise<Text[]> {
  const out: Text[] = [];
  for (const kind of KINDS) {
    const index = await listReports(kind);
    out.push(...fromWanted(await wantedIn({ kind, items: index }, english.reportIndex)));
    const latest = index[0] ? await loadReport(kind, index[0].key) : null;
    if (latest) out.push(...fromWanted(await wantedIn(latest, english.report)));
  }
  return out;
}

async function topics(): Promise<Text[]> {
  return fromWanted(await wantedIn(await listTopicSummaries(), english.topics));
}

/** What the site's modules show in Chinese on their English pages (modules.ts `english`). */
async function moduleTexts(): Promise<Text[]> {
  return (await Promise.all(serverModules().map((m) => m.english?.() ?? []))).flat();
}

/** Every source a page may name (the about page's river names the ones collected now), as readers see its name. */
async function sourceNames(): Promise<Text[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT DISTINCT s.name FROM sources s
    WHERE s.enabled OR EXISTS (SELECT 1 FROM publications p WHERE p.source_id = s.id AND p.visibility <> 'withdrawn')`;
  return [...new Set(rows.map((r) => publicSourceName(r.name)))].filter(needsEnglish).map((zh) => ({ zh, kind: "name" as const, item: null }));
}

/**
 * What these event pages show of their own: the title, the digest and summary as the page shows them (a digest whose
 * reports changed since, or a summary no current report says, is not), and the developments they list.
 */
async function storyPages(ids: number[]): Promise<Text[]> {
  if (!ids.length) return [];
  const own = await sql<{ id: number; title: string }[]>`SELECT id, title FROM stories WHERE id = ANY(${ids}::bigint[]) AND merged_into IS NULL`;
  const shown = await storyTexts(own.map((s) => Number(s.id)));
  const facts = await sql<{ title: string }[]>`
    SELECT f.title FROM facts f WHERE f.story_id = ANY(${ids}::bigint[]) AND ${shownFact()} ORDER BY f.id DESC`;
  return [
    ...own.flatMap((s) => {
      const page = shown.get(Number(s.id));
      return [
        { zh: s.title, kind: "headline" as const, item: null },
        ...(page?.digest ? [{ zh: page.digest, kind: "text" as const, item: null }] : []),
        ...(page?.summary ? [{ zh: page.summary, kind: "text" as const, item: null }] : []),
      ];
    }),
    ...facts.map((f) => ({ zh: f.title, kind: "headline" as const, item: null })),
  ];
}

/** An event (`st`) readers reach: not merged, with a development listed. */
const storyPage = () => sql`st.merged_into IS NULL AND EXISTS (SELECT 1 FROM facts f WHERE f.story_id = st.id AND ${shownFact()})`;

/** The event pages changed in the last days (a new report or development, a rewritten digest), whatever was done before. */
async function recentStories(): Promise<Text[]> {
  const since = sql`now() - make_interval(days => ${RECENT_DAYS})`;
  const rows = await sql<{ id: number }[]>`
    SELECT st.id FROM stories st
    WHERE ${storyPage()} AND (greatest(st.updated_at, st.latest_at) > ${since}
      OR EXISTS (SELECT 1 FROM facts f WHERE f.story_id = st.id AND f.updated_at > ${since}))
    ORDER BY st.id DESC LIMIT 500`;
  return storyPages(rows.map((r) => Number(r.id)));
}

/** One step of a walk through older pages: what it shows, and the cursor's move past it. */
interface Older {
  texts: Text[];
  done: () => Promise<void>;
}

async function saveCursor(key: string, value: Record<string, unknown>) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json(value as never)}, 'english')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

const STORIES_CURSOR = "english.stories";
const STORY_STEP = 50;

/** Every event page, newest first, a few at a time, each once; a page changed since is a recent one again. */
async function olderStories(): Promise<Older | null> {
  const [cursor] = await sql<{ value: { id: number } }[]>`SELECT value FROM settings WHERE key = ${STORIES_CURSOR}`;
  const rows = await sql<{ id: number }[]>`
    SELECT st.id FROM stories st WHERE ${storyPage()} ${cursor ? sql`AND st.id < ${cursor.value.id}` : sql``}
    ORDER BY st.id DESC LIMIT ${STORY_STEP}`;
  if (!rows.length) return null;
  const last = Number(rows.at(-1)!.id);
  return { texts: await storyPages(rows.map((r) => Number(r.id))), done: () => saveCursor(STORIES_CURSOR, { id: last }) };
}

const REPORTS_CURSOR = "english.reports";

/**
 * Older issues, newest first, each once (an issue does not change once written): the cursor is the last one done.
 * New issues are the latest of their kind, which every run covers.
 */
async function olderIssues(): Promise<Older | null> {
  const [cursor] = await sql<{ value: { at: string; kind: string; key: string } }[]>`SELECT value FROM settings WHERE key = ${REPORTS_CURSOR}`;
  const after = cursor?.value;
  const [next] = await sql<{ kind: ReportKind; key: string; at: Date }[]>`
    SELECT kind, key, generated_at AS at FROM reports
    ${after ? sql`WHERE (generated_at, kind, key) < (${after.at}::timestamptz, ${after.kind}, ${after.key})` : sql``}
    ORDER BY generated_at DESC, kind DESC, key DESC LIMIT 1`;
  if (!next) return null;
  const issue = await loadReport(next.kind, next.key);
  return {
    texts: issue ? fromWanted(await wantedIn(issue, english.report)) : [],
    done: () => saveCursor(REPORTS_CURSOR, { at: next.at.toISOString(), kind: next.kind, key: next.key }),
  };
}

/**
 * Of these texts (what a source shows now), those due: never tried, sent together; or failed and due again, each alone
 * (`attempts`). One that waits for its request's release, has usable English or was given up is left.
 */
async function due(texts: Text[]): Promise<Text[]> {
  const unique = [...new Map(texts.filter((t) => needsEnglish(t.zh)).map((t) => [t.zh, t])).values()];
  if (!unique.length) return [];
  const rows = await sql<{ zh_hash: string; failures: number; not_due: boolean }[]>`
    SELECT c.zh_hash, c.failures, ${NOT_DUE} AS not_due FROM english_copy c WHERE c.zh_hash = ANY(${unique.map((t) => copyKey(t.zh))}::text[])`;
  const known = new Map(rows.map((r) => [r.zh_hash, r]));
  return unique.flatMap((t) => {
    const row = known.get(copyKey(t.zh));
    if (!row) return [t];
    if (row.not_due) return [];
    return [row.failures > 0 ? { ...t, attempts: row.failures } : t];
  });
}

/** Whether any of these texts may still be translated: no usable English yet, and fewer than three attempts. */
async function unfinished(texts: Text[]): Promise<boolean> {
  const keys = [...new Set(texts.filter((t) => needsEnglish(t.zh)).map((t) => copyKey(t.zh)))];
  if (!keys.length) return false;
  const [row] = await sql<{ finished: number }[]>`
    SELECT count(*)::int AS finished FROM english_copy c
    WHERE c.zh_hash = ANY(${keys}::text[]) AND ((c.en IS NOT NULL AND ${usableCopy}) OR c.failures >= ${MAX_FAILURES})`;
  return row!.finished < keys.length;
}

/** An answer kept: a name may stay as written; anything else must read as English. */
function accepted(text: Text, answer: string | undefined): string | null {
  const en = answer?.trim();
  if (!en || en.length > text.zh.length * 8 + 200) return null;
  if (text.kind === "name") return en;
  const han = (en.match(new RegExp(HAN, "g")) ?? []).length;
  const letters = (en.match(/\p{L}/gu) ?? []).length;
  return han === 0 || han / Math.max(letters, 1) < 0.1 ? en : null;
}

interface Totals {
  stored: number;
  failed: number;
  calls: number;
}

/**
 * The source names these texts mention that have English: a Chinese name the model would otherwise leave as written
 * goes with the texts, so it reads the same as on the source's own label.
 */
async function namesIn(texts: Text[]): Promise<Array<[string, string]>> {
  const passages = texts.filter((t) => t.kind !== "name").map((t) => t.zh);
  if (!passages.length) return [];
  const rows = await sql<{ zh: string; en: string }[]>`
    SELECT c.zh, c.en FROM english_copy c
    WHERE c.kind = 'name' AND c.en IS NOT NULL AND c.en !~ ${HAN}
      AND EXISTS (SELECT 1 FROM unnest(${passages}::text[]) AS t(zh) WHERE strpos(t.zh, c.zh) > 0)`;
  return rows.map((r) => [r.zh, r.en]);
}

/** One request: the texts that came back usable are stored, the others counted as failed; the receipt is closed with them. */
async function translateBatch(texts: Text[], totals: Totals): Promise<void> {
  const ids = [...new Set(texts.map((t) => t.item).filter((id): id is string => !!id))];
  const context = new Map((ids.length ? await sql<{ id: string; original_title: string | null; source_name: string }[]>`
    SELECT p.article_id AS id, CASE WHEN ${originalShown("p")} THEN p.original_title END AS original_title, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ANY(${ids}::text[])` : []).map((r) => [r.id, r]));
  const input = texts.map((t, id) => {
    const c = t.item ? context.get(t.item) : undefined;
    const original = c?.original_title && !needsEnglish(c.original_title) ? c.original_title : undefined;
    return { id, kind: t.kind, zh: t.zh, ...(original ? { original } : {}), ...(c ? { source: publicSourceName(c.source_name) } : {}) };
  });
  const names = await namesIn(texts);
  const chars = texts.reduce((n, t) => n + t.zh.length, 0);
  const retry = texts.find((t) => t.attempts)?.attempts;
  totals.calls += 1;
  let res;
  try {
    res = await chatJson({
      model: await modelFor("translate"),
      purpose: "translate_copy_en",
      subject: `english:${copyKey(texts[0]!.zh).slice(0, 16)}${texts.length > 1 ? `+${texts.length - 1}` : ""}`,
      promptVersion: ENGLISH_PROMPT_VERSION,
      system: SYSTEM,
      user: JSON.stringify({ texts: input, ...(names.length ? { names: Object.fromEntries(names) } : {}) }),
      schema: Output,
      temperature: 0.2,
      maxTokens: Math.min(8000, chars * 3 + 400),
      timeoutMs: REQUEST_MS,
      ...(retry ? { attemptTag: `retry${retry}` } : {}),
    });
  } catch (error) {
    if (shutdownSignal.signal.aborted || stopsBatchRun(error)) throw error;
    // An attempt, also one that may have been billed: its texts wait for that request's release (NOT_DUE).
    const held = failureKind(error) === "unknown" ? failedReceiptId(error) : null;
    await sql.begin(async (tx) => {
      for (const t of texts) await failed(tx, t, held);
    });
    totals.failed += texts.length;
    return;
  }
  const answers = new Map(res.data.t.map((a) => [a.id, a.en]));
  await sql.begin(async (tx) => {
    for (const [i, t] of texts.entries()) {
      const en = accepted(t, answers.get(i));
      if (!en) {
        await failed(tx, t, null);
        totals.failed += 1;
        continue;
      }
      const originalOf = input[i]!.original ? t.item : null;
      await tx`
        INSERT INTO english_copy (zh_hash, zh, kind, en, original_of, failures, held_by, updated_at)
        VALUES (${copyKey(t.zh)}, ${t.zh}, ${t.kind}, ${en}, ${originalOf}, 0, NULL, now())
        ON CONFLICT (zh_hash) DO UPDATE SET kind = EXCLUDED.kind, en = EXCLUDED.en, original_of = EXCLUDED.original_of, failures = 0, held_by = NULL, updated_at = now()`;
      totals.stored += 1;
    }
    await completeReceipt(tx, res.receiptId);
  });
}

/**
 * An attempt that failed. One whose request may have been billed (`held`) leaves the text a single try, after that
 * request's release: its retry is a request of its own, which ops.recover would release once more.
 */
function failed(tx: Db, t: Text, held: number | null) {
  const last = MAX_FAILURES - 1;
  return tx`
    INSERT INTO english_copy (zh_hash, zh, kind, failures, held_by, updated_at)
    VALUES (${copyKey(t.zh)}, ${t.zh}, ${t.kind}, ${held === null ? 1 : last}, ${held}, now())
    ON CONFLICT (zh_hash) DO UPDATE SET
      failures = ${held === null ? sql`english_copy.failures + 1` : sql`GREATEST(english_copy.failures + 1, ${last})`},
      held_by = EXCLUDED.held_by, updated_at = now()`;
}

/** Texts in requests of a few thousand characters; a failed text goes alone. */
function batches(texts: Text[]): Text[][] {
  const out: Text[][] = [];
  let current: Text[] = [];
  let chars = 0;
  for (const t of texts) {
    if (t.attempts) {
      out.push([t]);
      continue;
    }
    if (current.length && (chars + t.zh.length > BATCH_CHARS || current.length >= BATCH_TEXTS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(t);
    chars += t.zh.length;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * One run (content.english, every five minutes on a site with an English edition): the sources of texts in order,
 * each translated before the next is read, until the time budget is spent (no request starts that could outlast it).
 * Model calls switched off, a full budget or an outage end the run; the next one carries on.
 */
export async function translateEnglish(opts: { budgetMs?: number } = {}): Promise<Totals> {
  const totals: Totals = { stored: 0, failed: 0, calls: 0 };
  if (!ENGLISH) return totals;
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 4 * 60_000;
  const left = () => budgetMs - (Date.now() - started) > REQUEST_MS && !shutdownSignal.signal.aborted;
  // A text goes once a run, whichever sources show it: one that failed is tried again next run.
  const sent = new Set<string>();
  const send = async (texts: Text[]) => {
    for (const batch of batches((await due(texts)).filter((t) => !sent.has(t.zh)))) {
      if (!left()) return false;
      for (const t of batch) sent.add(t.zh);
      await translateBatch(batch, totals);
    }
    return true;
  };
  // Source names first: a new source's English is there for the texts that mention it (namesIn).
  const sources: Array<() => Promise<Text[]>> = [
    sourceNames,
    () => items("recent", 200),
    recentStories,
    hot,
    latestIssues,
    topics,
    () => english.textsIn(loadChangelog(), english.changelog),
    moduleTexts,
    () => items("reachable", 100),
  ];
  try {
    for (const read of sources) {
      if (!left() || !(await send(await read()))) return totals;
    }
    for (const older of [olderStories, olderIssues]) {
      while (left()) {
        const step = await older();
        if (!step) break;
        if (!(await send(step.texts))) return totals;
        // A step with a text still to try stays the next one: a failed text is asked again only while a page shows it.
        if (await unfinished(step.texts)) break;
        await step.done();
      }
    }
  } catch (error) {
    if (shutdownSignal.signal.aborted || stopsBatchRun(error)) return totals;
    throw error;
  }
  return totals;
}
