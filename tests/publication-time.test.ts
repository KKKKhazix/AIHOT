// An item whose original carries no reliable date keeps its public page, and no exit presents when it was
// collected as when it was published. Failure cases: the Markdown export labels the collection time
// "发布时间"; RSS gives the collection time as pubDate; a dated item loses its publication time.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `pubtime-${T}`;
const discovered = new Date(Date.now() - 3600_000);
const published = new Date(Date.now() - 5 * 3600_000);
const ids = { dated: `${T}-dated`, undated: `${T}-undated` };
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Publication time fixture', 'rss', 'T1')`;
  for (const [kind, id] of Object.entries(ids)) {
    const at = kind === "dated" ? published : null;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at)
      VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${`${T} ${kind}`}, ${discovered}, ${discovered}, ${at})`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
        eligible, selected, visible_after, visibility, tags, summary)
      VALUES (${id}, ${`${T} ${kind}`}, ${SOURCE}, 'news', ${`https://example.org/${id}`}, ${discovered}, ${discovered}, ${at}, ${discovered},
        true, false, ${discovered}, 'public', ${[T]}, 'fixture summary')`;
  }
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, url);
  return res.body;
};

test("the Markdown export names the collection time as such when the publication time is unknown", async () => {
  const undated = await get(`/items/${ids.undated}/markdown`);
  assert.ok(undated.includes(`- 收录时间：${discovered.toISOString()}`));
  assert.ok(!undated.includes("发布时间"));
  assert.ok((await get(`/items/${ids.dated}/markdown`)).includes(`- 发布时间：${published.toISOString()}`));
});

test("RSS gives no pubDate for an item without a known publication time", async () => {
  const feed = await get("/feed/all.xml");
  const entry = (id: string) => feed.split("<item>").find((block) => block.includes(`>${id}</guid>`));
  assert.ok(entry(ids.undated) && !entry(ids.undated)!.includes("<pubDate>"));
  assert.ok(entry(ids.dated)!.includes(`<pubDate>${published.toUTCString()}</pubDate>`));
});
