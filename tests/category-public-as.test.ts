// A category filter on the public API (v1, RSS, MCP) takes in the categories published as it (`publicAs`)
// and nothing else. No category key is spelled out in the filter, so an industry with its own categories
// type-checks and reads the same way.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { v1Items } from "@aihot/backend/publication/v1";
import { CATEGORIES } from "@aihot/industry/taxonomy";

const T = `pubas${tag()}`;
const SOURCE = `test-${T}`;
const now = new Date();
// The default industry has tip and opinion as two public categories (none is published as another).
const [first, second] = ["tip", "opinion"].filter((k) => CATEGORIES.some((c) => c.key === k && !("publicAs" in c)));

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'publicAs fixture', 'rss', 'T1', 'editorial', '2100-01-01')`;
  for (const category of [first!, second!]) {
    const id = `${T}-${category}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at, language)
      VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${`${T} ${category}`}, ${now}, ${now}, ${now}, 'en')`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
        eligible, selected, visible_after, visibility, search_text, tags, summary, body_mode, syndicate, category)
      VALUES (${id}, ${`${T} ${category}`}, ${SOURCE}, 'news', ${`https://example.org/${id}`}, ${now}, ${now}, ${now}, ${now},
        true, true, ${new Date(+now - 1000)}, 'public', ${T}, ${[T]}, 'fixture', 'full', false, ${category})`;
  }
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});

const read = (category: string) =>
  v1Items({ mode: "all", window: "24h", by: "timeline", category: category as never, q: null, limit: 20, cursor: null }, now);

test("tip on the public API no longer takes in opinion, a public category of its own", { skip: !(first && second) }, async () => {
  assert.deepEqual((await read(first!)).items.map((i) => i.title), [`${T} ${first}`]);
  assert.deepEqual((await read(second!)).items.map((i) => i.title), [`${T} ${second}`]);
});
