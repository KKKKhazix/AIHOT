// Event grouping invariants: an editor's decision made while the model is deciding stands; a
// revision keeps its membership without asking the model; an explicit regroup decides again; a
// report waiting for a regroup is not evidence for others until its own turn decides it again; a
// story's root is its earliest fact that still holds reports; two stories a report ties together
// merge only when both models see one story in their roots.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { detachFromFact } from "@aihot/backend/events/corrections";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { linkRelatedStories } from "@aihot/backend/events/consolidate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-events-${T}`;
const FACT_TITLE = `测试事件${T}发布新模型`;

// The model calls the first candidate the same occurrence (and, asked about a pair, agrees), but
// only once the test lets it answer; the same stub serves the judge and the review model.
let hold = gate();
let asked = gate();
type Rel = "SAME_OCCURRENCE" | "SAME_STORY" | "UNRELATED";
let relation: Rel = "SAME_OCCURRENCE";
/** What the pair prompt answers when it differs from the batch answer. */
let pairRelation: Rel | null = null;
/** Answer every candidate of a batch prompt, not only the first. */
let answerAll = false;
const provider = await stub(async (_hit, req) => {
  asked.open();
  await hold.promise;
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  const pair = user.includes("报道 A");
  const ids = answerAll ? [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!) : ["C1"];
  const answer = pair
    ? { a: "发布", b: "发布", relation: pairRelation ?? relation, difference: "", confidence: 0.95 }
    : { query: "发布新模型", decisions: ids.map((id) => ({ id, relation, confidence: 0.95, note: "" })) };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";

let storyId: number;
let factId: number;

const randomText = () => Array.from({ length: 16 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

async function report(suffix: string, title = FACT_TITLE, summary = "摘要", publishedAt = new Date()) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/events-${T}-${suffix}`, title: `Model launch ${T} ${suffix}`, bodyText: "A new model.", bodyStatus: "ok", via: "fetch", publishedAt,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${title}, ${summary}, 80, false, ${sql.json({ fact: { title, subject: "测试", action: "发布", object: "模型" } })})`;
  await publishArticle(articleId);
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test events', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // An existing fact with one report: the candidate every later report meets.
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${FACT_TITLE}, now(), now()) RETURNING id`;
  storyId = story!.id;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${storyId}, ${FACT_TITLE}) RETURNING id`;
  factId = fact!.id;
  const first = await report("first");
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${first}, 'report')`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${storyId}, ${first}, ${`source:${SOURCE}`}, ${SOURCE}, 'editorial', now())`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("a detach made while the model is deciding the report's fact stands", async () => {
  const id = await report("race");
  const grouping = groupArticle(id);
  await Promise.race([asked.promise, grouping.then(() => assert.fail("grouping ended without asking the model"))]);
  await detachFromFact(id, "wrong fact", "test");
  hold.open();
  const result = await grouping;

  assert.equal(result.verdict, "manual");
  const memberships = await sql`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`;
  assert.equal(memberships.length, 0, "the report is not attached again");
  const signals = await sql`SELECT story_id FROM story_signals WHERE article_id = ${id}`;
  assert.equal(signals.length, 0, "no heat evidence is written back to the story");
  const [publication] = await sql<{ fact_id: number | null; story_id: number | null }[]>`SELECT fact_id, story_id FROM publications WHERE article_id = ${id}`;
  assert.deepEqual({ ...publication }, { fact_id: null, story_id: null }, "it is shown on its own");
});

test("a report joins the fact the model names, and a revision keeps that membership without asking again", async () => {
  hold = gate();
  hold.open();
  const id = await report("second");
  const first = await groupArticle(id);
  assert.equal(first.verdict, "same-fact");
  assert.equal(first.factId, factId);
  const hits = provider.hits();

  // A revision sends the report through grouping again: nothing to decide, nothing to pay.
  const again = await groupArticle(id);
  assert.equal(again.verdict, "kept");
  assert.equal(again.factId, factId);
  assert.equal(provider.hits(), hits, "the model is not asked about a report that already has its fact");
  const memberships = await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`;
  assert.deepEqual(memberships.map((m) => Number(m.fact_id)), [factId]);
  const [publication] = await sql<{ fact_id: number | null; story_id: number | null }[]>`SELECT fact_id, story_id FROM publications WHERE article_id = ${id}`;
  assert.deepEqual({ fact_id: Number(publication!.fact_id), story_id: Number(publication!.story_id) }, { fact_id: factId, story_id: storyId });
});

test("an explicit regroup drops the automatic membership and decides again", async () => {
  hold = gate();
  hold.open();
  const id = await report("third");
  assert.equal((await groupArticle(id)).verdict, "same-fact");

  // The same candidates and text reuse the paid verdict (receipts); the decision is still made again.
  const forced = await groupArticle(id, { force: true });
  assert.equal(forced.verdict, "same-fact");
  assert.equal(forced.factId, factId);
  const decisions = await sql<{ verdict: string }[]>`SELECT verdict FROM grouping_decisions WHERE article_id = ${id} ORDER BY id`;
  assert.deepEqual(decisions.map((d) => d.verdict), ["same-fact", "same-fact"], "a forced regroup decides again");
  const memberships = await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`;
  assert.equal(memberships.length, 1, "the report has exactly one membership after the regroup");
  const signals = await sql<{ story_id: number }[]>`SELECT story_id FROM story_signals WHERE article_id = ${id}`;
  assert.deepEqual(signals.map((s) => Number(s.story_id)), [storyId]);
});

test("a report waiting for a regroup is not evidence for others, and its own turn decides it again", async () => {
  hold = gate();
  hold.open();
  // Text no other report shares (the test database may keep rows of earlier runs; recall is lexical here).
  const text = Array.from({ length: 16 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const waiting = await report("waiting", text, text);
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${text}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fw-${T}`}, ${story!.id}, ${text}) RETURNING id`;
  const oldFact = Number(fact!.id);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${oldFact}, ${waiting}, 'report')`;
  await sql`INSERT INTO regroup_pending (article_id) VALUES (${waiting})`;

  // A later report of the same occurrence does not meet the waiting one: nothing to compare with.
  const later = await report("later", text, text);
  const first = await groupArticle(later);
  assert.equal(first.verdict, "new-story");
  assert.notEqual(first.factId, oldFact);

  // Its turn (any grouping of it, not only a forced one): the old membership goes and the decision is
  // made against what counts now.
  const again = await groupArticle(waiting);
  assert.equal(again.verdict, "same-fact");
  assert.equal(again.factId, first.factId);
  const memberships = await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${waiting}`;
  assert.deepEqual(memberships.map((m) => Number(m.fact_id)), [first.factId]);
  const [left] = await sql<{ n: number }[]>`SELECT count(*) AS n FROM regroup_pending WHERE article_id = ${waiting}`;
  assert.equal(Number(left!.n), 0, "the report counts again once it is decided");
});

test("a development attaches to the story's earliest fact that still holds reports", async () => {
  hold = gate();
  hold.open();
  const text = Array.from({ length: 16 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  // A story whose first fact was emptied (a regroup, a detach, or a merge carried it over).
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${text}, now(), now()) RETURNING id`;
  await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${`fe-${T}`}, ${story!.id}, 'emptied')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fr-${T}`}, ${story!.id}, ${text}) RETURNING id`;
  const first = await report("root", text, text);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${first}, 'report')`;

  relation = "SAME_STORY";
  try {
    const development = await report("development", text, text);
    const result = await groupArticle(development);
    assert.equal(result.verdict, "new-fact-in-story");
    assert.equal(result.storyId, Number(story!.id));
  } finally {
    relation = "SAME_OCCURRENCE";
  }
});


/** A story whose only fact holds one report with the given text. */
async function storyWithRoot(text: string, suffix: string) {
  const [story] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${text}, now(), now()) RETURNING id, public_id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fs-${suffix}-${T}`}, ${story!.id}, ${text}) RETURNING id`;
  const article = await report(suffix, text, text);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${article}, 'report')`;
  return { storyId: Number(story!.id), publicId: String(story!.public_id), factId: Number(fact!.id), articleId: article };
}

test("a story's root is the fact reported first, not the one with the lowest number", async () => {
  hold = gate();
  hold.open();
  const early = randomText(), late = randomText();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${early}, now(), now()) RETURNING id`;
  // Created first (lower id), reported later: a fact carried over from a merged or imported story.
  const [later] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`ft-late-${T}`}, ${story!.id}, ${late}) RETURNING id`;
  const [first] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`ft-early-${T}`}, ${story!.id}, ${early}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${later!.id}, ${await report("late-fact", late, late)}, 'report')`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${first!.id}, ${await report("early-fact", early, early, new Date(Date.now() - 2 * 3600_000))}, 'report')`;

  // A development of the fact reported first joins the story through it.
  relation = "SAME_STORY";
  try {
    const result = await groupArticle(await report("follow-up", early, early));
    assert.equal(result.verdict, "new-fact-in-story");
    assert.equal(result.storyId, Number(story!.id));
  } finally {
    relation = "SAME_OCCURRENCE";
  }
});

test("two stories a report ties together merge when both models see one story in their roots", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const older = await storyWithRoot(`${text}甲`, "older");
  const newer = await storyWithRoot(`${text}乙`, "newer");
  relation = "SAME_STORY";
  answerAll = true;
  try {
    const result = await groupArticle(await report("bridge", text, text));
    assert.equal(result.verdict, "new-fact-in-story");
    assert.deepEqual(result.consolidated?.map((c) => [c.from, c.into, c.merge]), [[newer.storyId, older.storyId, true]]);
    assert.equal(result.storyId, older.storyId, "the report ends up in the surviving story");
    const [merged] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${newer.storyId}`;
    assert.equal(Number(merged!.merged_into), older.storyId);
    const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${newer.publicId}`;
    assert.equal(Number(alias!.story_id), older.storyId, "the merged story's public id keeps answering");
  } finally {
    relation = "SAME_OCCURRENCE";
    answerAll = false;
  }
});

test("two stories stay apart when their roots are different events, whatever the report ties them with", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const one = await storyWithRoot(`${text}甲`, "one");
  const two = await storyWithRoot(`${text}乙`, "two");
  relation = "SAME_STORY";
  pairRelation = "UNRELATED";
  answerAll = true;
  try {
    const result = await groupArticle(await report("comparison", text, text));
    assert.deepEqual(result.consolidated?.map((c) => [c.from, c.into, c.merge, c.second]), [[two.storyId, one.storyId, false, null]]);
    const rows = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id IN (${one.storyId}, ${two.storyId})`;
    assert.deepEqual(rows.map((r) => r.merged_into), [null, null]);
  } finally {
    relation = "SAME_OCCURRENCE";
    pairRelation = null;
    answerAll = false;
  }
});

test("a story whose reports all moved away keeps its address: it redirects to where the last one went", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const old = await storyWithRoot(text, "moving");
  // A second report of the old story, about something no other report mentions.
  const other = randomText();
  const staying = await report("staying", other, other);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${old.factId}, ${staying}, 'report')`;
  const target = await storyWithRoot(text, "target");

  // The first report moves to the story it belongs to; the old story still has a report and stays.
  const moved = await groupArticle(old.articleId, { force: true });
  assert.equal(moved.verdict, "same-fact");
  assert.equal(moved.storyId, target.storyId);
  assert.equal(moved.redirected, undefined);

  // The last one leaves too: the old story redirects to where it went.
  const last = await groupArticle(staying, { force: true });
  assert.equal(last.verdict, "new-story");
  assert.deepEqual(last.redirected, [old.storyId]);
  const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${old.publicId}`;
  assert.equal(Number(alias!.story_id), last.storyId, "the old public id answers with the story its last report went to");
});

test("stories that reports keep tying together without merging list each other as related", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const one = await storyWithRoot(`${text}甲`, "related-one");
  const two = await storyWithRoot(`${text}乙`, "related-two");
  const links = async () =>
    (await sql<{ story_id: number; other_id: number; relation: string }[]>`
      SELECT story_id, other_id, relation FROM story_links WHERE story_id IN (${one.storyId}, ${two.storyId}) ORDER BY story_id`)
      .map((l) => [Number(l.story_id), Number(l.other_id), l.relation]);
  // Each report is a development of both stories; their roots are different events, so they stay apart.
  relation = "SAME_STORY";
  pairRelation = "UNRELATED";
  answerAll = true;
  try {
    await groupArticle(await report("tie-one", text, text));
    await linkRelatedStories();
    assert.deepEqual(await links(), [], "one report is not enough");

    await groupArticle(await report("tie-two", text, text));
    await linkRelatedStories();
    assert.deepEqual(await links(), [[one.storyId, two.storyId, "related"], [two.storyId, one.storyId, "related"]]);
  } finally {
    relation = "SAME_OCCURRENCE";
    pairRelation = null;
    answerAll = false;
  }
});
