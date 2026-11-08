// A thin daily (a weekend's often carries a single entry) still offers three highlights (今日看点): the
// window's best scored reports the issue left out (2026-11-09). Failure cases, specified before the implementation:
// - a thin issue shows no highlights, or fills them with what this issue or the week's issues already carried,
//   two reports of one event, a report scored below what any source needs to be selected, one from outside
//   the window or from a source that is not editorial, or a selected one the next issue carries (released at
//   or after the cutoff);
// - a report filled in becomes the lead, counts among the issue's events or sources, or differs between the
//   page, v1 and the Agent answer; a withdrawn one keeps its link; its own page does not name the daily that
//   lists it;
// - an issue with three highlights of its own, or a quiet day, is given reports it did not carry;
// - what the highlights showed keeps a later selection (one confirmed after the cutoff, an official post on the
//   same news) out of the next issue's body, or comes back in the highlights of the week's next issues, also
//   after its event was merged into another.
import { editionAt, tag } from "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { firstDaily, loadReport, v1Daily } from "@aihot/backend/publication/reports";
import { composeDaily } from "@aihot/backend/reports/compose";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const MEDIA = `highlights-media-${T}`;
const OTHER = `highlights-other-${T}`;
const SIGNAL = `highlights-signal-${T}`;
const app = await buildApp();
let n = 0;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', '2100-01-01'),
    (${OTHER}, 'Other media', 'rss', 'T2', 'editorial', '2100-01-01'),
    (${SIGNAL}, 'Signal', 'rss', 'T2', 'hot_signal', '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

/** `hours` before the edition time of `date`. */
const hoursBefore = (date: string, hours: number) => new Date(editionAt("daily", date).getTime() - hours * 3_600_000);

/** A report that arrived at `at`, scored `score` and selected or not, public from then on (a selection from `releasedAt`). */
async function report(title: string, at: Date, score: number, selected: boolean, source = MEDIA, releasedAt = at): Promise<string> {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${T}/${++n}`, title,
    bodyText: `${title} 正文`, bodyStatus: "ok", publishedAt: at, discoveredAt: at, via: "fetch" });
  await sql`UPDATE articles SET grouping_status = 'complete' WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${title}, ${`${title}的摘要`}, ${score}, ${selected})`;
  const published = await publishArticle(articleId, { now: at, releasedAt });
  if (source !== SIGNAL) assert.deepEqual([published?.selected, published?.visibility], [selected, "public"], title);
  return articleId;
}

/** A fact of an event (a new event unless `story` is given), reported by `members`. */
async function fact(members: string[], story?: number): Promise<number> {
  const id = story ?? (await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, '事件') RETURNING id`)[0]!.id;
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${randomUUID()}, ${id}, '事实') RETURNING id`;
  for (const m of members) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${f!.id}, ${m}, 'primary')`;
  await sql`UPDATE publications SET fact_id = ${f!.id}, story_id = ${id} WHERE article_id = ANY(${members})`;
  return id;
}

type Content = { leadItemId: string | null; highlights: string[]; picks?: Array<{ itemId: string }>; metrics: Record<string, number>;
  sections: Array<{ items: Array<{ itemId: string }> }>; flashes: Array<{ itemId: string }> };
async function content(date: string): Promise<Content> {
  const [r] = await sql<{ content: Content }[]>`SELECT content FROM reports WHERE kind = 'daily' AND key = ${date}`;
  return r!.content;
}
const carried = (c: Content) => [...c.sections.flatMap((s) => s.items), ...c.flashes, ...(c.picks ?? [])].map((i) => i.itemId);

test("a thin issue fills its highlights with the window's best reports it left out, the same on every outlet", async () => {
  const day = "2021-03-09";
  // The issue before carried an event; its new development here is not news to this issue's readers.
  const earlier = await report("前一期的头条", hoursBefore(day, 30), 90, true);
  const covered = await fact([earlier]);
  await composeDaily("2021-03-08");
  const lead = await report("本期唯一的大事", hoursBefore(day, 5), 90, true);
  const leadStory = await fact([lead]);
  const sameAsLead = await report("头条事件的另一篇", hoursBefore(day, 4), 88, false);
  await fact([sameAsLead], leadStory);
  const best = await report("最值得看的", hoursBefore(day, 3), 74, false);
  const runnerUp = await report("同一事件的另一篇", hoursBefore(day, 2), 73, false);
  await fact([best, runnerUp]);
  const second = await report("第二值得看的", hoursBefore(day, 6), 71, false);
  await fact([second]);
  const third = await report("刚过门槛的", hoursBefore(day, 7), 61, false);
  const below = await report("差一分的", hoursBefore(day, 2), 59, false);
  const followUp = await report("前一期事件的新进展", hoursBefore(day, 3), 80, false);
  await fact([followUp], covered);
  const outside = await report("窗口之前的", hoursBefore(day, 25), 90, false);
  const signal = await report("热度信源的", hoursBefore(day, 3), 90, false, SIGNAL);
  const nextIssues = await report("到截稿时刻才发布的精选", hoursBefore(day, 1), 95, true, OTHER, hoursBefore(day, 0));
  await fact([nextIssues]);

  await composeDaily(day);
  const c = await content(day);
  assert.equal(c.leadItemId, lead);
  assert.deepEqual(carried(c).filter((id) => id !== lead).filter((id) => !c.picks?.some((p) => p.itemId === id)), [], "the issue itself still carries one entry");
  assert.deepEqual(c.picks?.map((p) => p.itemId), [best, second, third], "best first, one per event, at least 60");
  assert.deepEqual(c.highlights, [best, second, third]);
  for (const id of [runnerUp, sameAsLead, below, followUp, outside, signal, nextIssues]) assert.ok(!c.highlights.includes(id), id);
  assert.equal(c.metrics.totalEvents, 1, "a highlight filled in is not one of the issue's events");
  assert.equal(c.metrics.sourcesCount, 1);
  assert.deepEqual(await firstDaily(best), { key: day, lead: false }, "its page names the daily that lists it, never as its lead");

  // Withdrawn after the issue: struck through on the page, gone from v1 and the Agent answer.
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${second}`;
  const site = (await loadReport("daily", day))!;
  assert.equal(site.leadItemId, lead, "a highlight filled in never leads, not even after a withdrawal");
  assert.deepEqual(site.highlights.map((h) => [h.itemId, h.available]), [[best, true], [second, false], [third, true]]);
  assert.equal(site.metrics.sourcesCount, 1);
  assert.equal(site.sections.flatMap((s) => s.items).length, 1);
  const v1 = (await v1Daily(day))!.report as { highlights?: Array<{ title: string; links: { aihot: string | null } }>; sections: unknown[] };
  assert.deepEqual(v1.highlights?.map((h) => h.title), ["最值得看的", "刚过门槛的"]);
  assert.ok(v1.highlights?.[0]?.links.aihot?.endsWith(`/items/${best}`));
  const agent = (await app.inject(`/api/v1/agent/daily/${day}`)).body;
  assert.match(agent, /【今日看点】/);
  assert.ok(agent.includes("最值得看的") && agent.includes("刚过门槛的"));
  assert.ok(!agent.includes("第二值得看的"), "a withdrawn report is not handed to Agents");
});

test("an issue's own entries come first; one with three highlights of its own, or a quiet day, gets none filled in", async () => {
  const day = "2021-04-06";
  const lead = await report("头条", hoursBefore(day, 9), 92, true);
  const next = await report("第二件大事", hoursBefore(day, 8), 90, true);
  const pick = await report("正文以外最好的", hoursBefore(day, 3), 75, false);
  const nextPick = await report("正文以外第二", hoursBefore(day, 4), 70, false);
  for (const id of [lead, next, pick, nextPick]) await fact([id]);
  await composeDaily(day);
  const c = await content(day);
  assert.equal(c.leadItemId, lead);
  assert.deepEqual(c.highlights, [next, pick, nextPick]);

  const full = "2021-04-13";
  const own: string[] = [];
  for (const [i, source] of [MEDIA, MEDIA, OTHER, OTHER].entries()) own.push(await report(`大事 ${i}`, hoursBefore(full, 9 - i), 90 - i, true, source));
  const left = await report("没收进来的", hoursBefore(full, 3), 75, false);
  for (const id of [...own, left]) await fact([id]);
  await composeDaily(full);
  const f = await content(full);
  assert.deepEqual(f.highlights, own.slice(1));
  assert.equal(f.picks, undefined);

  const quiet = "2021-04-20";
  const scored = await report("没有入选的", hoursBefore(quiet, 3), 75, false);
  await fact([scored]);
  await composeDaily(quiet);
  const q = await content(quiet);
  assert.equal(q.leadItemId, null, "a quiet day");
  assert.deepEqual(q.highlights, []);
  assert.equal(q.picks, undefined, "a quiet day says nothing new happened: nothing is filled in");
});

test("the highlights never keep a selection out of the next issue, and never show an event twice in a week", async () => {
  const day = "2021-05-04";
  const lead = await report("周日的头条", hoursBefore(day, 5), 90, true);
  await fact([lead]);
  const shown = await report("周日看点第一", hoursBefore(day, 3), 75, false);
  const shownStory = await fact([shown]);
  const alsoShown = await report("周日看点第二", hoursBefore(day, 4), 74, false);
  const alsoShownStory = await fact([alsoShown]);
  const merged = await report("周日看点第三", hoursBefore(day, 5), 73, false);
  const mergedStory = await fact([merged]);
  await composeDaily(day);
  assert.deepEqual((await content(day)).highlights, [shown, alsoShown, merged]);

  const next = "2021-05-05";
  const monday = await report("周一的头条", hoursBefore(next, 5), 90, true);
  await fact([monday]);
  // The same news, now from its official source and selected: the body carries it in full.
  const official = await report("同一件事的官方消息", hoursBefore(next, 4), 95, true, OTHER);
  const [f] = await sql<{ fact_id: number }[]>`SELECT fact_id FROM publications WHERE article_id = ${shown}`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${f!.fact_id}, ${official}, 'primary')`;
  await sql`UPDATE publications SET fact_id = ${f!.fact_id}, story_id = ${shownStory} WHERE article_id = ${official}`;
  const echo = await report("周日看点第二的新进展", hoursBefore(next, 3), 80, false);
  await fact([echo], alsoShownStory);
  const fresh = await report("周一新的值得看的", hoursBefore(next, 6), 70, false);
  await fact([fresh]);
  // The third highlight's event has since been merged into an event with a new report.
  const joined = await report("合并进来的事件的新报道", hoursBefore(next, 2), 79, false);
  await mergeStoryInto(mergedStory, await fact([joined]), "test", "test");
  await composeDaily(next);
  const c = await content(next);
  assert.ok(c.sections.flatMap((s) => s.items).some((i) => i.itemId === official), "shown only as a highlight the day before");
  assert.deepEqual(c.picks?.map((p) => p.itemId), [fresh], "an event the week's highlights showed is not shown again");
});
