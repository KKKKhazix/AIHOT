// Failure modes before changing related-event reads: withdrawn bridges still advertise a neighbor;
// one surviving bridge is treated as enough; corrections or a manual detach leave stale ties;
// ordinary revisions and the recall window erase history; restored evidence stays hidden;
// unrelated link types or older links without a saved judgement are accidentally removed; bridges
// judged before a story merge are lost, so withdrawing them changes nothing or hides valid evidence.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { buildApp } from "../apps/api/src/app.ts";

const source = `related-evidence-${tag()}`;
const app = await buildApp();
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, 'Related evidence fixture', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function report() {
  const token = randomUUID();
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${token}`,
    title: token, bodyText: 'A concrete report about this event.', bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected, output)
    VALUES (${articleId}, 1, 'rule', 'pass', ${token}, 'Public fixture summary', false, ${sql.json({scope:'single'})})`;
  await publishArticle(articleId);
  return articleId;
}

async function story() {
  const publicId = randomUUID();
  const [row] = await sql<{id:number}[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${publicId}, ${publicId}, now(), now()) RETURNING id`;
  const [fact] = await sql<{id:number}[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`fact-${publicId}`}, ${row!.id}, ${publicId}) RETURNING id`;
  const id = await report();
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
  return {id:row!.id, factId:fact!.id, publicId};
}

async function pair(relation = 'related', witnesses = true) {
  const a = await story(), b = await story();
  const bridges: string[] = [];
  for (let i=0; i<2 && witnesses; i++) {
    const id = await report();
    bridges.push(id);
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${a.factId}, ${id}, 'report')`;
    await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates)
      VALUES (${id}, ${a.factId}, ${a.id}, 'new-fact-in-story',
        ${sql.json([{id:b.factId, relation:'SAME_STORY', confidence:0.95}])})`;
  }
  await sql`INSERT INTO story_links (story_id, other_id, relation)
    VALUES (${a.id}, ${b.id}, ${relation}), (${b.id}, ${a.id}, ${relation})`;
  return {a,b,bridges};
}

async function bridge(own: Awaited<ReturnType<typeof story>>, other: Awaited<ReturnType<typeof story>>) {
  const id = await report();
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${own.factId}, ${id}, 'report')`;
  await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates)
    VALUES (${id}, ${own.factId}, ${own.id}, 'new-fact-in-story',
      ${sql.json([{id:other.factId, relation:'SAME_STORY', confidence:0.95}])})`;
  return id;
}

async function advertised(a: Awaited<ReturnType<typeof story>>, b: Awaited<ReturnType<typeof story>>, expected: boolean) {
  for (const prefix of ['/api/site/stories/', '/api/v1/stories/', '/api/v1/agent/stories/']) {
    const response = await app.inject({method:'GET',url:prefix+a.publicId});
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes(b.publicId), expected, `${prefix} advertises the same neighbors`);
  }
}

test('two bridges, one bridge, no bridges, and restoration agree on every public story read', async () => {
  const {a,b,bridges} = await pair();
  await advertised(a,b,true);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${bridges[0]!}`;
  await advertised(a,b,false);
  await advertised(b,a,false);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${bridges[1]!}`;
  await advertised(a,b,false);
  await sql`UPDATE publications SET visibility='public' WHERE article_id=ANY(${bridges})`;
  await advertised(a,b,true);
  assert.equal((await sql`SELECT 1 FROM story_links WHERE story_id=${a.id} AND other_id=${b.id}`).length,1,'history is retained');
});

test('natural ageing and a membership-preserving revision retain the association', async () => {
  const {a,b,bridges} = await pair();
  await sql`UPDATE grouping_decisions SET created_at=now()-interval '30 days' WHERE article_id=ANY(${bridges})`;
  await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates)
    VALUES (${bridges[0]!}, ${a.factId}, ${a.id}, 'kept', '[]'::jsonb)`;
  await advertised(a,b,true);
});

test('a later explicit judgement invalidates the old bridge until the evidence is restored', async () => {
  const {a,b,bridges} = await pair();
  await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates)
    VALUES (${bridges[0]!}, ${a.factId}, ${a.id}, 'new-fact-in-story',
      ${sql.json([{id:b.factId, relation:'UNRELATED', confidence:0.95}])})`;
  await advertised(a,b,false);
  await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates)
    VALUES (${bridges[0]!}, ${a.factId}, ${a.id}, 'new-fact-in-story',
      ${sql.json([{id:b.factId, relation:'SAME_STORY', confidence:0.95}])})`;
  await advertised(a,b,true);
});

test('an explicitly removed membership no longer supports a related event', async () => {
  const {a,b,bridges} = await pair();
  await sql`DELETE FROM fact_articles WHERE article_id=${bridges[0]!}`;
  await advertised(a,b,false);
});

test('correcting a bridge to a composite invalidates it even before republishing', async () => {
  const {a,b,bridges} = await pair();
  await sql`UPDATE analyses SET output=${sql.json({scope:'composite'})} WHERE article_id=${bridges[0]!}`;
  await advertised(a,b,false);
});

test('a repeated judgement for one article does not count as two reports', async () => {
  const {a,b,bridges} = await pair();
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${bridges[0]!}`;
  await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict, candidates)
    VALUES (${bridges[1]!}, ${a.factId}, ${a.id}, 'new-fact-in-story',
      ${sql.json([{id:b.factId, relation:'SAME_STORY', confidence:0.95}])})`;
  await advertised(a,b,false);
});

test('storyline links and historical links without saved bridge judgements are retained', async () => {
  const line = await pair('storyline');
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=ANY(${line.bridges})`;
  await advertised(line.a,line.b,true);
  const historical = await pair('related',false);
  await advertised(historical.a,historical.b,true);
});

test('bridges judged before a story merge follow their fact into the surviving story', async () => {
  const a = await story(), b = await story(), merged = await story();
  const early = [await bridge(merged, b), await bridge(merged, b)];
  const later = await bridge(a, b);
  await sql`INSERT INTO story_links (story_id, other_id, relation)
    VALUES (${a.id}, ${b.id}, 'related'), (${b.id}, ${a.id}, 'related')`;
  assert.ok(await mergeStoryInto(merged.id, a.id, 'fixture', 'editor'));
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${later}`;
  await advertised(a,b,true);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=ANY(${early})`;
  await advertised(a,b,false);
  await advertised(b,a,false);
});
