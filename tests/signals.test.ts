// Live news before history, and discussion posts that come before the first report: a discussion post
// skips the analysis queue; history (a backfill that was already old when found) waits behind live
// work and founds no event; a post that found no story is grouped again, while it still counts for
// heat, when a fact close to it gains evidence (a report founds or joins it, a post attaches to it),
// or when the post it quotes arrives and joins a fact.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { mergeStories, moveToFact, requestRegroup } from "@aihot/backend/events/corrections";
import { groupArticle } from "@aihot/backend/events/group";
import { queueProcessing, settleNonEditorial } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const EDITORIAL = `test-sig-ed-${T}`;
const SIGNAL = `test-sig-hs-${T}`;
const TOPIC = `WL${T}`;
/** Text of its own: close to nothing stored. */
const ALONE = `ZZ${T}`;

// Embeddings: a text carrying one of the markers in VECTORS points in that marker's direction; texts
// about the topic point one way, everything else another. The judge calls the first candidate the same
// occurrence, unless the post says NOPE or the candidate says OTHER.
// The topic's axis and the markers' dimensions are this run's own, so stored vectors of earlier runs never match them.
const axis = 2 + (parseInt(T.slice(-4), 36) % 1000);
const VECTORS = new Map<string, Array<[number, number]>>();
/** A direction in this run's dimensions base, base + 1, …, apart from the topic's. */
const direction = (base: number, components: number[]): Array<[number, number]> => components.map((x, i) => [2 + ((axis - 2 + base + i) % 1000), x]);
let postJudgements = 0;
/** The candidates the judge was shown for the last post. */
let shown: string[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { input?: string[]; messages?: Array<{ role: string; content: string }> };
  if (body.input) {
    return { data: body.input.map((text, index) => {
      const embedding = Array<number>(1024).fill(0);
      const marked = [...VECTORS].find(([marker]) => text.includes(marker))?.[1];
      if (marked) for (const [i, x] of marked) embedding[i] = x;
      else embedding[text.includes(TOPIC) ? axis : text.includes(ALONE) ? axis + 1 : 1] = 1;
      return { index, embedding };
    }) };
  }
  const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
  const post = user.startsWith("【帖子】");
  const candidates = user.split("【候选 C").slice(1);
  if (post) [postJudgements, shown] = [postJudgements + 1, candidates];
  const no = post && user.split("\n\n")[0]!.includes("NOPE");
  const decisions = candidates.map((candidate, i) => ({
    id: `C${i + 1}`, relation: i === 0 && !no && !candidate.includes("OTHER") ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 0.95, note: "",
  }));
  const answer = { query: "收购", decisions, selection: { addsValue: true, reason: "fixture news" } };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
for (const name of ["DASHSCOPE_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[name] = `${provider.url}/v1`;
for (const name of ["DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY"]) process.env[name] = "test-key";

async function job(articleId: string) {
  const [j] = await sql<{ name: string; priority: number; data: { signalOnly?: boolean } }[]>`
    SELECT name, priority, data FROM pgboss.job WHERE singleton_key = ${articleId} ORDER BY created_on DESC LIMIT 1`;
  return j ?? null;
}

async function report(suffix: string, opts: { title: string; backfill?: string; publishedAt?: Date }) {
  const { articleId } = await upsertMaterial({
    sourceId: EDITORIAL, url: `https://example.com/sig-${T}-${suffix}`, title: opts.title, bodyText: "Body.", bodyStatus: "ok", via: "fetch",
    publishedAt: opts.publishedAt ?? new Date(), backfill: opts.backfill ?? null,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${opts.title}, '摘要', 80, false, ${sql.json({ fact: { title: opts.title } })})`;
  await publishArticle(articleId);
  return articleId;
}

/** A discussion post found (and published) `hoursAgo`, recorded the way collection records it. */
async function post(suffix: string, title: string, hoursAgo: number) {
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  const { articleId } = await upsertMaterial({ sourceId: SIGNAL, url: `https://example.com/sig-${T}-${suffix}`, title, via: "fetch", publishedAt: at });
  await sql`UPDATE articles SET discovered_at = ${at} WHERE id = ${articleId}`;
  assert.deepEqual(await settleNonEditorial(articleId), { group: true });
  return articleId;
}

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('dashscope', 'deepseek')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
            (${EDITORIAL}, 'Test editorial', 'rss', 'T1', 'editorial', '2100-01-01'),
            (${SIGNAL}, 'Test signal', 'rss', 'T2', 'hot_signal', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("a discussion post that came before any report is grouped again when a report founds its fact", async () => {
  const { articleId: postId } = await upsertMaterial({ sourceId: SIGNAL, url: `https://example.com/sig-${T}-post`, title: `AMD to acquire ${TOPIC}`, via: "fetch", publishedAt: new Date() });
  await queueProcessing(postId);
  const queued = await job(postId);
  assert.deepEqual([queued?.name, queued?.priority, queued?.data.signalOnly], ["events.group", -1, true], "straight to grouping, behind reports");

  assert.deepEqual(await settleNonEditorial(postId), { group: true });
  assert.equal((await groupArticle(postId, { signalOnly: true })).verdict, "signal-unmatched");
  const [decided] = await sql<{ verdict: string }[]>`SELECT verdict FROM grouping_decisions WHERE article_id = ${postId}`;
  assert.equal(decided?.verdict, "signal-unmatched", "a post that found nothing is recorded as such");

  const reportId = await report("first", { title: `AMD 收购 ${TOPIC}` });
  const founded = await groupArticle(reportId);
  assert.equal(founded.verdict, "new-story");
  assert.equal(founded.rematched, 1);
  assert.deepEqual([(await job(postId))?.name, (await job(postId))?.data.signalOnly], ["events.group", true]);

  // The worker takes the job; here the test decides it.
  const again = await groupArticle(postId, { signalOnly: true });
  assert.equal(again.verdict, "signal");
  assert.equal(again.storyId, founded.storyId);
});

test("history waits behind live work and founds no event; a new source's post from today is news", async () => {
  const old = await report("old", { title: `旧闻 ${T}`, backfill: "first-import", publishedAt: new Date(Date.now() - 30 * 86_400_000) });
  await queueProcessing(old, { step: "analyze" });
  assert.deepEqual([(await job(old))?.name, (await job(old))?.priority], ["content.analyze", -2]);
  assert.equal((await groupArticle(old)).verdict, "historical");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${old}`).length, 0);

  const fresh = await report("fresh", { title: `新闻 ${T}`, backfill: "first-import", publishedAt: new Date(Date.now() - 3_600_000) });
  await queueProcessing(fresh, { step: "analyze" });
  assert.equal((await job(fresh))?.priority, 0);
  assert.notEqual((await groupArticle(fresh)).verdict, "historical");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${fresh}`).length, 1);
});

test("a discussion post that quotes a post not yet collected joins its story when the original arrives", async () => {
  // Dan Shipper's "SONNET 5.5 IS OUT!" quoted Anthropic's post a minute before it was collected; the
  // original then joined the fact a report had already founded (same-fact: no new fact, no rematch).
  const tweetId = `9${Date.now()}`;
  const { articleId: postId } = await upsertMaterial({
    sourceId: SIGNAL, url: `https://x.com/danshipper/status/1${Date.now()}`, title: `SONNET IS OUT! ${ALONE}`, via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: `1${Date.now()}`, authorName: "Dan", handle: "danshipper", text: "SONNET IS OUT!", quoted: { authorName: "Anthropic", handle: "AnthropicAI", text: "Introducing", url: `https://x.com/AnthropicAI/status/${tweetId}` } },
  });
  assert.deepEqual(await settleNonEditorial(postId), { group: true });
  assert.equal((await groupArticle(postId, { signalOnly: true })).verdict, "signal-unmatched");

  const first = await groupArticle(await report("quoted-first", { title: `Anthropic 发布 ${TOPIC} Sonnet` }));
  const { articleId: originalId } = await upsertMaterial({
    sourceId: EDITORIAL, url: `https://x.com/AnthropicAI/status/${tweetId}`, title: `Introducing ${TOPIC} Sonnet`, bodyText: "Introducing.", bodyStatus: "ok",
    via: "fetch", publishedAt: new Date(), xPost: { tweetId, authorName: "Anthropic", handle: "AnthropicAI", text: `Introducing ${TOPIC} Sonnet` },
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${originalId}, 1, 'rule', 'pass', 'ai-models', ${`Anthropic 发布 ${TOPIC} Sonnet`}, '摘要', 80, false, ${sql.json({ fact: { title: "Sonnet" } })})`;
  const joined = await groupArticle(originalId);
  assert.equal(joined.verdict, "same-fact");
  assert.equal(joined.storyId, first.storyId);
  assert.equal(joined.reclaimed, 1);
  assert.equal((await job(postId))?.data.signalOnly, true);

  const again = await groupArticle(postId, { signalOnly: true });
  assert.deepEqual([again.verdict, again.storyId], ["signal-native", first.storyId]);
});

test("a post from earlier in the heat window is grouped again when a report founds its fact; one past the window is not", async () => {
  // Techmeme had PHP2Shell nine hours before the first report; the six-hour look-back missed it.
  const m = `HW${T}`;
  VECTORS.set(m, direction(10, [1]));
  const recent = await post("hw-recent", `Unconfirmed report of a flaw ${m}`, 20);
  const old = await post("hw-old", `An older word on the flaw ${m}`, 50);
  for (const id of [recent, old]) assert.equal((await groupArticle(id, { signalOnly: true })).verdict, "signal-unmatched");

  const founded = await groupArticle(await report("hw", { title: `Flaw disclosed ${m}` }));
  assert.deepEqual([founded.verdict, founded.rematched], ["new-story", 1]);
  assert.equal((await job(recent))?.data.signalOnly, true);
  assert.equal(await job(old), null, "it no longer counts for heat");
});

test("a report that joins a fact wakes the earlier posts close to it", async () => {
  const [first, second, reaction] = [`JA${T}`, `JB${T}`, `JP${T}`];
  VECTORS.set(first, direction(20, [1, 0]));
  VECTORS.set(second, direction(20, [0.9, 0.436]));
  VECTORS.set(reaction, direction(20, [0.6, 0.8]));
  const postId = await post("join", `Reaction ${reaction}`, 1);
  assert.equal((await groupArticle(postId, { signalOnly: true })).verdict, "signal-unmatched");

  const founded = await groupArticle(await report("join-1", { title: `Launch ${first}` }));
  assert.deepEqual([founded.verdict, founded.rematched], ["new-story", 0], "not close to the first report");
  const joined = await groupArticle(await report("join-2", { title: `Launch in detail ${second}` }));
  assert.deepEqual([joined.verdict, joined.storyId, joined.rematched], ["same-fact", founded.storyId, 1]);

  const again = await groupArticle(postId, { signalOnly: true });
  assert.deepEqual([again.verdict, again.storyId], ["signal", founded.storyId]);
});

test("a post that joins a fact recalls it for posts close to it, earlier ones too; the judge still decides", async () => {
  // PHP2Shell: posts about the warning, the patches and sites going offline were far from the reports
  // about AI finding the flaws, and close to each other.
  const [found, patch, warning, again] = [`PR${T}`, `PP${T}`, `PW${T}`, `PA${T}`];
  VECTORS.set(found, direction(30, [1, 0]));
  VECTORS.set(patch, direction(30, [0.8, 0.6]));
  VECTORS.set(warning, direction(30, [0.4, 0.9165]));
  VECTORS.set(again, direction(30, [0.4, 0.9165]));
  const warningId = await post("peer-warning", `Admins warned of two critical flaws ${warning}`, 3);
  assert.equal((await groupArticle(warningId, { signalOnly: true })).verdict, "signal-unmatched");
  const founded = await groupArticle(await report("peer", { title: `AI helped find the flaws ${found}` }));
  assert.deepEqual([founded.verdict, founded.rematched], ["new-story", 0]);

  const patchId = await post("peer-patch", `Emergency patches for the flaws ${patch}`, 1);
  const attached = await groupArticle(patchId, { signalOnly: true });
  assert.deepEqual([attached.verdict, attached.storyId, attached.rematched], ["signal", founded.storyId, 1], "the earlier warning is close to this post");
  const woken = await groupArticle(warningId, { signalOnly: true });
  assert.deepEqual([woken.verdict, woken.storyId], ["signal", founded.storyId]);

  const judged = postJudgements;
  const twinId = await post("peer-again", `Admins warned again ${again}`, 0);
  const twin = await groupArticle(twinId, { signalOnly: true });
  assert.deepEqual([twin.verdict, twin.storyId, postJudgements - judged], ["signal", founded.storyId, 1], "a post identical to another post still goes to the judge");
});

test("a post the judge already answered for a fact is not woken by more evidence of that fact", async () => {
  const [first, second, take] = [`OA${T}`, `OB${T}`, `OP${T}`];
  VECTORS.set(first, direction(40, [1, 0]));
  VECTORS.set(second, direction(40, [0.9, 0.436]));
  VECTORS.set(take, direction(40, [0.8, 0.6]));
  const founded = await groupArticle(await report("once-1", { title: `Launch ${first}` }));
  const postId = await post("once", `NOPE, a take on something else ${take}`, 1);
  assert.equal((await groupArticle(postId, { signalOnly: true })).verdict, "signal-unmatched", "the judge saw the fact and said no");

  const joined = await groupArticle(await report("once-2", { title: `Launch in detail ${second}` }));
  assert.deepEqual([joined.verdict, joined.storyId, joined.rematched], ["same-fact", founded.storyId, 0]);
});

test("a fact the judge said a post is not about is not offered again when another fact wakes the post", async () => {
  const [elsewhere, here, take] = [`NA${T}`, `NB${T}`, `NP${T}`];
  VECTORS.set(elsewhere, direction(50, [1, 0]));
  VECTORS.set(take, direction(50, [0.8, 0.6]));
  VECTORS.set(here, direction(50, [0.342, 0.94]));
  await groupArticle(await report("answered-1", { title: `OTHER launch ${elsewhere}` }));
  const takeId = await post("answered", `A take ${take}`, 1);
  assert.equal((await groupArticle(takeId, { signalOnly: true })).verdict, "signal-unmatched", "the judge said no to the first fact");

  const founded = await groupArticle(await report("answered-2", { title: `Launch ${here}` }));
  assert.deepEqual([founded.verdict, founded.rematched], ["new-story", 1]);
  const again = await groupArticle(takeId, { signalOnly: true });
  assert.deepEqual([again.verdict, again.storyId, shown.length], ["signal", founded.storyId, 1], "only the new fact went to the judge");
});

test("a post an editor moved recalls the fact they chose, not the one the model picked", async () => {
  const [picked, chosen, moved, later] = [`MA${T}`, `MB${T}`, `MP${T}`, `ML${T}`];
  VECTORS.set(picked, direction(60, [1, 0, 0]));
  VECTORS.set(chosen, direction(60, [0, 0, 1]));
  VECTORS.set(moved, direction(60, [0.8, 0.6, 0]));
  VECTORS.set(later, direction(60, [0.45, 0.85, 0.27]));
  const launch = await groupArticle(await report("moved-1", { title: `Launch ${picked}` }));
  const pricing = await groupArticle(await report("moved-2", { title: `Pricing ${chosen}` }));
  await mergeStories(pricing.storyId!, launch.storyId!, "test: one story", "test");
  const movedId = await post("moved", `Reaction ${moved}`, 2);
  assert.deepEqual([(await groupArticle(movedId, { signalOnly: true })).verdict], ["signal"], "the model put it with the launch");
  const [fact] = await sql<{ public_id: string }[]>`SELECT public_id FROM facts WHERE id = ${pricing.factId!}`;
  await moveToFact(movedId, fact!.public_id, "test: about the pricing", "test");

  const laterId = await post("moved-later", `Another reaction ${later}`, 1);
  await groupArticle(laterId, { signalOnly: true });
  const [decision] = await sql<{ candidates: Array<{ id: number }> }[]>`SELECT candidates FROM grouping_decisions WHERE article_id = ${laterId} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(decision!.candidates.map((c) => c.id), [pricing.factId], "the moved post stands for the editor's fact only");
});

test("an editor's regroup asks the judge again about a fact it said no to; grouping on its own does not", async () => {
  const [fact, take] = [`RA${T}`, `RP${T}`];
  VECTORS.set(fact, direction(70, [1, 0]));
  VECTORS.set(take, direction(70, [0.8, 0.6]));
  const launch = await groupArticle(await report("regroup-fact", { title: `OTHER launch ${fact}` }));
  const takeId = await post("regroup-take", `A take ${take}`, 1);
  const offered = async () => (await sql<{ candidates: Array<{ id: number }> }[]>`
    SELECT candidates FROM grouping_decisions WHERE article_id = ${takeId} ORDER BY id DESC LIMIT 1`)[0]!.candidates.map((c) => c.id);
  assert.equal((await groupArticle(takeId, { signalOnly: true })).verdict, "signal-unmatched");
  assert.deepEqual(await offered(), [launch.factId], "the judge said no to the launch");
  assert.equal((await groupArticle(takeId, { signalOnly: true })).verdict, "signal-unmatched");
  assert.deepEqual(await offered(), [], "grouped again on its own, it is not asked again");

  await requestRegroup(takeId, `regroup-${T}`);
  const [queued] = await sql<{ data: { regroup?: boolean } }[]>`SELECT data FROM pgboss.job WHERE singleton_key = ${`manual:group:${takeId}:regroup-${T}`}`;
  assert.equal(queued?.data.regroup, true);
  assert.equal((await groupArticle(takeId, { regroup: queued!.data.regroup })).verdict, "signal-unmatched");
  assert.deepEqual(await offered(), [launch.factId], "the editor's regroup offers the launch again");
});
