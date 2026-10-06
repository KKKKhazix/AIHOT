// Cache eviction must not change the candidates scored by the current recall. Fill the real
// cache from stored small vectors; only query texts go to the local provider.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";

const T = `recall-cache-${tag()}`;
const provider = await stub((_hit, req) => ({ data: (JSON.parse(req.body).input as string[])
  .map((_text, index) => ({ index, embedding: [1, 0] })) }));
const env = { ...process.env, EMBEDDING_MODEL: T, EMBEDDING_DIMS: "0",
  EMBEDDING_API_KEY: "test-key", EMBEDDING_BASE_URL: `${provider.url}/v1` };
after(async () => { await provider.close(); await closeDb(); });

test("fact and reading recall agree across cold, full and overflowing vector caches", async (t) => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode)
    VALUES (${T}, 'Recall cache fixture', 'rss', 'T1', 'editorial')`;
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, ${T}, now(), now()) RETURNING id`;
  const facts: number[] = [];
  const items = ["first", "second", "background"].map(name => ({ id: `${T}-${name}`, text: `${T}-${name}。` }));
  for (const [index, item] of items.entries()) {
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, discovered_at, timeline_at, published_at)
      VALUES (${item.id}, ${T}, ${item.id}, ${`https://example.org/${item.id}`}, ${item.id}, 'saved background', now(), now(), now())`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, selected, visible_after, revision)
      VALUES (${item.id}, ${item.id}, ${T}, 'news', ${`https://example.org/${item.id}`}, now(), now(), now(), ${index === 2}, now(), 1)`;
    if (index < 2) {
      const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
        VALUES (${item.id}, ${story!.id}, ${item.text}) RETURNING id`;
      facts.push(fact!.id);
      await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${item.id}, 'primary')`;
    }
    await sql`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector)
      VALUES ('article', ${item.id}, ${T}, ${sha256(item.text)}, ${index === 1 ? [0.8, 0.6] : [1, 0]})`;
  }
  await sql`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector)
    SELECT 'article', ${T} || '-filler-' || i, ${T}, ${sha256("filler")}, ARRAY[0,1]::real[] FROM generate_series(0, 29996) i`;
  const run = async (size: number, stale = false) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      const { vectorsFor, recallFacts, recallSelectedBackground } = await import('@aihot/backend/events/recall');
      const { closeDb, sql } = await import('@aihot/backend/db');
      const { sha256 } = await import('@aihot/backend/lib/ids');
      try {
        const items = ${JSON.stringify(items)};
        const fillers = Array.from({ length: Math.max(0, ${size} - items.length) }, (_, i) => ({ id: ${JSON.stringify(T)} + '-filler-' + i, text: 'filler' }));
        if (${size}) await vectorsFor([...items.map(it => ({ ...it, revision: 1 })), ...fillers]);
        if (${stale}) {
          const text = 'changed report';
          await sql\`UPDATE publications SET title = \${text}, revision = 2 WHERE article_id = \${items[0].id}\`;
          await sql\`UPDATE embeddings SET text_hash = \${sha256(text + '。')}, vector = ARRAY[0,1]::real[] WHERE ref_id = \${items[0].id}\`;
        }
        const facts = await recallFacts(${JSON.stringify(`${T}-query`)}, 'query', 0.5, 10);
        const background = await recallSelectedBackground(${JSON.stringify(`${T}-reading-query`)}, 'query', 0.5);
        if (fillers.length) {
          const filler = fillers[0];
          await sql\`UPDATE embeddings SET vector = ARRAY[1,0]::real[] WHERE ref_id = \${filler.id}\`;
          const afterEviction = await vectorsFor([filler]);
          if (afterEviction.get(filler.id)[0] !== 1) throw new Error('overflow retained the old cache');
          await sql\`UPDATE embeddings SET vector = ARRAY[0,1]::real[] WHERE ref_id = \${filler.id}\`;
        }
        console.log(JSON.stringify({ facts, background }));
      } finally { await closeDb(); }
    `], { env, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout) as { facts: Array<{ factId: number; score: number }>; background: Array<{ sourceText: string | null }> };
  };
  const cold = await run(0);
  assert.deepEqual(cold.facts.map(r => r.factId), facts);
  assert.equal(cold.facts[0]!.score, 1);
  assert.ok(Math.abs(cold.facts[1]!.score - 0.8) < 1e-6);
  assert.equal(cold.background.length, 1);
  assert.equal(cold.background[0]!.sourceText, "saved background");
  for (const size of [29_999, 30_000]) await t.test(`initial cache size ${size}`, async () => {
    assert.deepEqual(await run(size), cold);
  });
  await t.test("a changed revision cannot reuse the old matching vector", async () => {
    const stale = await run(30_000, true);
    assert.deepEqual(stale.facts.map(r => r.factId), [facts[1]]);
    assert.deepEqual(stale.background, cold.background);
  });
  assert.equal(provider.hits(), 1, "stored vectors and the shared query receipt avoid further provider requests");
});
