import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { pickRepresentative, representativePriority } from "@aihot/backend/publication/representative";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadStoryFollowups } from "@aihot/backend/publication/followups";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { loadStoryDetail, v1Story } from "@aihot/backend/publication/stories";
import { candidates } from "@aihot/backend/reports/edition";
import { composeStoryDigest, DIGEST_PROMPT_VERSION, DIGEST_SYSTEM, DigestSchema } from "@aihot/backend/events/digest";
import { chatJson } from "@aihot/backend/providers/llm";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { detachFromFact, moveToFact } from "@aihot/backend/events/corrections";
import { overrideFields, setVisibility } from "@aihot/backend/admin/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { latestHotRanking } from "@aihot/backend/publication/hot";

const key = `evidence-${tag()}`;
const now = new Date();
const at = (hours: number) => new Date(+now - hours * 3600_000);
let digestPrompt = "";
let digestHold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_hit, req) => {
  digestPrompt = JSON.parse(req.body).messages[1].content;
  if (digestHold) {
    const hold = digestHold;
    digestHold = null;
    hold.entered.open();
    await hold.release.promise;
  }
  return { id: "local", choices: [{ message: { content: JSON.stringify({ title: "OpenAI 发布 Dots", digest: "Dots 的对话可用，但自主执行任务仍然消耗额度。", latest: "模型生成的无关最新进展不得使用" }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

async function source(suffix: string, tier: string, owner: string | null = null, role: string | null = null) {
  const id = `${key}-${suffix}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,owner_entity_id,config,first_party,next_fetch_at)
    VALUES (${id},${suffix},'rss',${tier},'editorial',${owner},${sql.json(role ? { publisherRole: role } : {})},${tier !== 'T1'},'2100-01-01')`;
  return id;
}
async function story(title = "OpenAI 发布 Dots") {
  const [s] = await sql`INSERT INTO stories (public_id,title,first_report_at,latest_at,latest) VALUES (${randomUUID()},${title},${at(100)},${at(0)},'错误的生成进展') RETURNING id, public_id`;
  const [f] = await sql`INSERT INTO facts (public_id,story_id,title,subject,action,object,conditions)
    VALUES (${`f-${randomUUID()}`},${s!.id},${title},'OpenAI','发布','Dots','自主执行任务消耗额度') RETURNING id, public_id`;
  return { storyId: Number(s!.id), storyPublicId: s!.public_id as string, factId: Number(f!.id), factPublicId: f!.public_id as string };
}
async function report(sourceId: string, group: Awaited<ReturnType<typeof story>>, opts: { title: string; hours: number; selected?: boolean; score?: number; role?: string }) {
  const id = `${key}-${randomUUID()}`;
  const date = at(opts.hours);
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,timeline_at,discovered_at,published_at)
    VALUES (${id},${sourceId},${id},${`https://example.org/${id}`},${opts.title},${date},${date},${date})`;
  const [a] = await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,output)
    VALUES (${id},1,'rule','pass',${opts.title},${opts.title},${opts.score ?? 70},${opts.selected ?? true},
      ${sql.json({ fact: { evidence: "Tasks consume usage.", conditions: [{ text: "自主任务消耗额度", quote: "Tasks consume usage." }] } })}) RETURNING id`;
  await sql`INSERT INTO publications (article_id,analysis_id,source_id,title,summary,url,channel,first_party,timeline_at,discovered_at,published_at,sort_at,
    story_id,fact_id,selected,eligible,visible_after,tags,body_mode,score)
    VALUES (${id},${a!.id},${sourceId},${opts.title},${opts.title},${`https://example.org/${id}`},'news',true,${date},${date},${date},${date},
    ${group.storyId},${group.factId},${opts.selected ?? true},true,${date},${[key]},'full',${opts.score ?? 70})`;
  await sql`INSERT INTO fact_articles (fact_id,article_id,role,evidence) VALUES (${group.factId},${id},${opts.role ?? 'report'},'Tasks consume usage.')`;
  return id;
}

test("source tier and event ownership are separate; mentions of an entity do not establish authority", () => {
  const row = { body_mode: "full" as const, score: 70, timeline_at: now, source_tier: "T2", publisher_role: null, owner_entity_id: null, fact_subject: "OpenAI" };
  const org = { ...row, source_tier: "T1_5", publisher_role: "organization", owner_entity_id: "openai", score: 60 };
  const person = { ...org, publisher_role: "person", score: 90 };
  assert.equal(pickRepresentative([person, org]), org);
  const first = { ...row, source_tier: "T1", score: 40, first_party: false };
  assert.equal(pickRepresentative([org, first]), first, "T1 does not depend on the first_party flag");
  for (const subject of [null, "Databricks", "OpenAI合作伙伴", "Sam Altman (@sama)"]) {
    assert.equal(representativePriority({ ...org, fact_subject: subject }), 3, String(subject));
  }
  assert.equal(representativePriority({ ...org, fact_subject: "ChatGPT" }), 1, "exact configured product alias");
  assert.equal(representativePriority({ ...org, fact_subject: "OpenAI / Anthropic" }), 1, "explicit co-subject list");
  assert.equal(representativePriority({ ...org, owner_entity_id: "qwen", fact_subject: "Qwen Team" }), 1, "the company under another of its own names");
  assert.equal(representativePriority({ ...org, owner_entity_id: "world-labs", fact_subject: "AMD + World Labs" }), 1);
  assert.equal(representativePriority({ ...org, fact_subject: "OpenAI + " }), 3, "incomplete subject list is not evidence");
  assert.equal(representativePriority({ ...org, owner_entity_id: null }), 3);
  assert.equal(representativePriority({ ...org, owner_entity_id: "unregistered-org", fact_subject: "unregistered-org" }), 3, "equal unknown strings are not verified identity");
  assert.equal(representativePriority({ ...org, fact_subject: "OpenAI + unregistered-org" }), 3, "an unrecognized co-subject is not silently accepted");
  assert.equal(representativePriority({ ...row, first_party: true } as typeof row), 3, "the first_party flag never elevates a source");
});

test("mentions cannot choose a timeline origin, anchor, representative, or a latest-progress link", async () => {
  const organization = await source("organization", "T1_5", "openai", "organization");
  const media = await source("media", "T2");
  const t1 = await source("t1", "T1");
  const g = await story();
  const official = await report(organization, g, { title: "Dots 正式发布", hours: 3, score: 65 });
  const latest = await report(media, g, { title: "Dots 后续更新", hours: 2, score: 90 });
  const earlyMention = await report(t1, g, { title: "EARLY ROUNDUP", hours: 90, role: "mention" });
  const lateMention = await report(t1, g, { title: "LATEST ROUNDUP", hours: 1, role: "mention" });
  await report(t1, g, { title: "未入选官网稿", hours: 4, selected: false, score: 30 });
  const q = { channel: "all" as const, category: null, tag: key, now };
  const timeline = await loadTimeline(q);
  const card = timeline.cards.find(c => c.key === `f${g.factId}`)!;
  assert.equal(card.item.id, official);
  assert.equal(card.anchorAt, at(3).toISOString());
  assert.ok(timeline.cards.some(c => c.key === `a${earlyMention}`) && timeline.cards.some(c => c.key === `a${lateMention}`), "a stale mention projection stays an independent selected article");
  assert.equal((await loadStoryFollowups(g.storyPublicId, now))!.items[0]!.representative.id, official);
  const group = await loadGroupReports({ factPublicId: g.factPublicId, channel: "all", category: null, tag: key }, now);
  assert.equal(group?.reports.length, 3, "only primary/report members are same-fact reports");
  const detail = (await loadStoryDetail(g.storyId, now))!;
  assert.equal(detail.developments[0]!.representative.id, official, "unselected T1 cannot enter the selected representative pool");
  assert.equal(detail.firstReportAt, at(4).toISOString());
  assert.deepEqual(detail.latestReport, { id: latest });
  assert.equal(detail.latest, "Dots 后续更新");
  assert.equal(detail.officialReports.length, 1, "only tier T1 has the first-party label");
  assert.equal(detail.developments[0]!.representative.source.firstParty, false);
  const edition = await candidates(at(100), now);
  assert.equal(edition.find((c) => c.factId === g.factPublicId)?.itemId, official, "report editions use the same authority within their own time window");
  assert.equal(edition.find((c) => c.itemId === official)?.firstParty, false);
  assert.equal(edition.find((c) => c.itemId === earlyMention)?.factId, null, "a related roundup stays independent in reports");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${latest}`;
  const after = (await loadStoryDetail(g.storyId, now))!;
  assert.equal(after.latestReport!.id, official);
  assert.equal(after.latest, "Dots 正式发布");
  assert.equal((await v1Story(g.storyId))!.story.latest, after.latest);
  const firstParty = await loadTimeline({ ...q, channel: "firstParty" });
  assert.ok(!firstParty.cards.some(c => c.item.id === official), "a stale true projection flag cannot put T1_5 into first-party channel");
});

test("digest input excludes mentions, preserves scoped conditions, and ignores generated latest", async () => {
  const s = await source("digest", "T1");
  const g = await story();
  const main = await report(s, g, { title: "Dots 任务仍计费用量", hours: 5 });
  const mention = await report(s, g, { title: "MENTION MUST NOT ENTER DIGEST", hours: 1, role: "mention" });
  const composite = await report(s, g, { title: "COMPOSITE WAITING FOR GROUP CLEANUP", hours: 1 });
  await sql`UPDATE analyses SET output=output || '{"scope":"composite"}'::jsonb WHERE article_id=${composite}`;
  assert.equal((await candidates(at(100), now)).find((c) => c.itemId === composite)?.factId, null, "known composites cannot occupy a report's fact before projection repair");
  assert.equal((await composeStoryDigest(g.storyId)).updated, true);
  assert.ok(digestPrompt.includes("Tasks consume usage.") && digestPrompt.includes("自主执行任务消耗额度"));
  assert.ok(!digestPrompt.includes(mention) && !digestPrompt.includes("MENTION MUST NOT ENTER DIGEST"));
  assert.ok(!digestPrompt.includes(composite), "known composite input is excluded before its stale hard membership is cleaned");
  const [stored] = await sql`SELECT latest FROM stories WHERE id=${g.storyId}`;
  assert.equal(stored!.latest, "Dots 任务仍计费用量");
  const calls = provider.hits();
  assert.equal((await composeStoryDigest(g.storyId)).updated, false);
  assert.equal(provider.hits(), calls);
  await sql`UPDATE facts SET conditions='仅自主任务消耗额度，对话不消耗' WHERE id=${g.factId}`;
  assert.equal((await composeStoryDigest(g.storyId)).updated, true, "changed conditions invalidate the saved inputs hash");
  assert.ok(digestPrompt.includes("仅自主任务消耗额度，对话不消耗"));
  const [version] = await sql`SELECT article_ids FROM story_digests WHERE story_id=${g.storyId} ORDER BY version DESC LIMIT 1`;
  assert.deepEqual(version!.article_ids, [main]);
  const remaining = await report(s, g, { title: "保留的后续报道", hours: 2 });
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${main}`;
  const publicStory = (await loadStoryDetail(g.storyId, now))!;
  assert.equal(publicStory.digest, null, "a saved digest loses its withdrawn evidence before any model refresh");
  assert.equal(publicStory.latestReport!.id, remaining);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id IN ${sql([remaining, composite])}`;
  assert.equal(await v1Story(g.storyId), null, "mentions alone cannot supply an event or invent required v1 latest/time fields");
  const beforeClear = provider.hits();
  assert.equal((await composeStoryDigest(g.storyId)).updated, true);
  assert.equal(provider.hits(), beforeClear, "clearing an empty story does not call a model");
  const [cleared] = await sql`SELECT digest, latest FROM stories WHERE id=${g.storyId}`;
  assert.deepEqual({ ...cleared }, { digest: null, latest: null });
});

// Recovery failures: restoring identical evidence must restore the saved digest without another
// model request; evidence corrected while withdrawn must be rewritten instead of resurrecting it.
test("a cleared digest recovers from matching saved evidence without another model call", async () => {
  const s = await source("digest-restoration", "T1");
  const g = await story();
  const id = await report(s, g, { title: "可恢复的真实报道", hours: 2, selected: false });
  assert.equal((await composeStoryDigest(g.storyId)).updated, true);
  const original = (await v1Story(g.storyId))!.story.digest;
  const calls = provider.hits();
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  assert.equal((await composeStoryDigest(g.storyId)).updated, true);
  assert.equal(await v1Story(g.storyId), null);
  await sql`UPDATE publications SET visibility = 'public' WHERE article_id = ${id}`;
  assert.equal((await composeStoryDigest(g.storyId)).updated, true, "restoration cannot be skipped merely because the input hash is unchanged");
  assert.equal((await v1Story(g.storyId))!.story.digest, original);
  assert.equal(provider.hits(), calls, "the matching saved digest is reused without paying again");
  assert.equal((await composeStoryDigest(g.storyId)).updated, false, "the restored projection is idempotent");

  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  await composeStoryDigest(g.storyId);
  await sql`UPDATE publications SET visibility = 'public', summary = '已经更正的资料' WHERE article_id = ${id}`;
  assert.equal((await composeStoryDigest(g.storyId)).updated, true);
  assert.equal(provider.hits(), calls + 1, "changed evidence must generate a corrected digest");
  assert.ok(digestPrompt.includes("已经更正的资料"));
});

test("the hot board shows an event under its own title, linked to the fact most sources report", async () => {
  const s = await source("hot", "T2");
  const official = await source("hot-official", "T1");
  const other = await source("hot-other", "T2");
  const g = await story("OpenAI 发布 Dots");
  const fact = async (title: string) => Number((await sql`INSERT INTO facts (public_id,story_id,title,subject) VALUES (${`f-${randomUUID()}`},${g.storyId},${title},'OpenAI') RETURNING id`)[0]!.id);
  // A leak opens the story and a single follow-up scores highest; the launch is what two sources report.
  const leak = await report(s, { ...g, factId: await fact("OpenAI 常驻助手曝光") }, { title: "发布前的爆料", hours: 30, score: 99 });
  const media = await report(s, g, { title: "Dots 媒体报道", hours: 4, score: 90 });
  const blog = await report(official, g, { title: "Dots 官网发布", hours: 3, score: 60 });
  const followUp = await report(other, { ...g, factId: await fact("ChatGPT Space 新进展") }, { title: "Space 高分报道", hours: 2, score: 99 });
  for (const [i, id] of [leak, media, blog, followUp].entries()) await sql`INSERT INTO story_signals (story_id,article_id,source_id,participant_key,kind,observed_at)
    VALUES (${g.storyId},${id},(SELECT source_id FROM articles WHERE id=${id}),${`${key}-participant-${i}`},'editorial',${at(1)})`;
  await computeHotRanking(now);
  const entry = (await latestHotRanking())!.entries.find(e => e.storyId === g.storyId)!;
  assert.ok(entry);
  assert.equal(entry.title, "OpenAI 发布 Dots");
  assert.equal(entry.representativeItemId, blog, "the launch's first-party report, not the earlier leak or a later high score");
  assert.equal(entry.participantCount, 3, "heat still counts each source once");
  await sql`UPDATE stories SET title='OpenAI 发布常驻智能体 Dots' WHERE id=${g.storyId}`;
  assert.equal((await latestHotRanking())!.entries.find(e => e.storyId === g.storyId)!.title, "OpenAI 发布常驻智能体 Dots", "a retitled event shows at once");
  await sql`UPDATE fact_articles SET role='mention' WHERE article_id=${blog}`;
  assert.ok(!(await latestHotRanking())!.entries.some(e => e.storyId === g.storyId), "regrouped or mention-only representatives leave cached rankings immediately");
});

test("an editor moves a report into the fact it repeats: no false development remains and the membership is the editor's", async () => {
  const s = await source("move", "T1");
  const g = await story("OpenAI 发布 GPT-6.1 Sol");
  const launch = await report(s, g, { title: "Sol 官网发布", hours: 6 });
  const [dup] = await sql`INSERT INTO facts (public_id,story_id,title,subject) VALUES (${`f-${randomUUID()}`},${g.storyId},'OpenAI发布GPT-6.1 Sol模型','OpenAI') RETURNING id`;
  const repost = await report(s, { ...g, factId: Number(dup!.id) }, { title: "官方线程里的重复发布", hours: 1 });
  await sql`INSERT INTO story_signals (story_id,article_id,source_id,participant_key,kind,observed_at) VALUES (${g.storyId},${repost},${s},${`source:${s}`},'editorial',${at(1)})`;
  // Moving re-derives the publication from its analysis, which carries no test tag: read the unfiltered timeline.
  const cards = async () => (await loadTimeline({ channel: "all", category: null, tag: null, limit: 40, now: new Date() })).cards.filter(c => [launch, repost].includes(c.item.id));
  assert.equal((await cards()).length, 2);
  assert.deepEqual(await moveToFact(repost, g.factPublicId, "同一次发布的官方重复帖", "test"), { fact: g.factId, story: g.storyId, left: 1 });
  const after = await cards();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.item.id, launch);
  assert.equal(after[0]!.group!.reportCount, 2);
  assert.deepEqual([...await sql`SELECT fact_id, role, manual, evidence FROM fact_articles WHERE article_id=${repost}`].map(r => ({ ...r, fact_id: Number(r.fact_id) })),
    [{ fact_id: g.factId, role: "report", manual: true, evidence: "Tasks consume usage." }]);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${repost} AND story_id=${g.storyId}`).length, 1, "its heat evidence stays with the story");
  await assert.rejects(moveToFact(repost, "f-missing", "x", "test"), /目标事实不存在/);
});

test("an in-flight digest cannot overwrite an editor revision or a merge, and its paid response remains reusable", async () => {
  const s = await source('digest-concurrency', 'T1');
  for (const merge of [false, true]) {
    const g = await story();
    await report(s, g, {title:'Dots 的同一条真实报道',hours:1});
    const target = merge ? await story('人工合并目标') : null;
    const entered = gate(), release = gate();
    digestHold = {entered,release};
    const pending = composeStoryDigest(g.storyId);
    await entered.promise;
    const user = digestPrompt;
    try {
      await sql`UPDATE stories SET version=version+2,origin='manual',title='人工修正后的事件',digest='人工修正后的综述内容',latest='人工确认进展',merged_into=${target?.storyId ?? null} WHERE id=${g.storyId}`;
    } finally { release.open(); }
    assert.deepEqual(await pending,{updated:false});
    const [stored] = await sql`SELECT version,title,digest,latest,merged_into FROM stories WHERE id=${g.storyId}`;
    assert.deepEqual({...stored},{version:3,title:'人工修正后的事件',digest:'人工修正后的综述内容',latest:'人工确认进展',merged_into:target?.storyId ?? null});
    assert.equal((await sql`SELECT 1 FROM story_digests WHERE story_id=${g.storyId}`).length,0,'obsolete input cannot create digest history');
    const calls = provider.hits();
    const reused = await chatJson({model:'deepseek-flash',purpose:'story_digest',subject:`story:${g.storyId}@1`,promptVersion:DIGEST_PROMPT_VERSION,
      system:DIGEST_SYSTEM,user,schema:DigestSchema,temperature:0.3,maxTokens:1200});
    assert.equal(provider.hits(),calls,'the settled response is reused without another provider request');
    const [receipt] = await sql`SELECT status FROM receipts WHERE id=${reused.receiptId}`;
    assert.equal(receipt!.status,'completed');
  }
});

// A story version alone does not describe the input: an article correction, withdrawal, detachment
// or a new report can all happen while its model request is in flight without editing the story.
for (const change of ["correction", "withdrawal", "detach", "addition"] as const) {
  test(`an in-flight digest rejects changed report inputs after ${change}`, async () => {
    const s = await source(`digest-input-${change}`, "T1");
    const g = await story();
    const id = await report(s, g, { title: "生成期间可能更正的报道", hours: 2, selected: false });
    const entered = gate(), release = gate();
    digestHold = { entered, release };
    const pending = composeStoryDigest(g.storyId);
    await entered.promise;
    try {
      if (change === "correction") await overrideFields(id, { fields: { summary: "已经核实的更正摘要" }, reason: "correct input", version: 0 }, "test");
      if (change === "withdrawal") await setVisibility(id, { visibility: "withdrawn", reason: "withdraw input", version: 0 }, "test");
      if (change === "detach") await detachFromFact(id, "wrong fact", "test");
      if (change === "addition") await report(s, g, { title: "模型请求后抵达的新进展", hours: 1, selected: false });
    } finally { release.open(); }
    assert.deepEqual(await pending, { updated: false });
    assert.equal((await sql`SELECT 1 FROM story_digests WHERE story_id = ${g.storyId}`).length, 0);
    if (change === "correction" || change === "addition") {
      assert.equal((await composeStoryDigest(g.storyId)).updated, true, "a subsequent job accepts the current evidence");
      assert.ok(digestPrompt.includes(change === "correction" ? "已经核实的更正摘要" : "模型请求后抵达的新进展"));
    }
  });
}
