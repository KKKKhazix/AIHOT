// A cached sitemap must keep its original deadline in 200 and 304 responses. Otherwise an edge
// refill starts another five minutes; a failed rebuild must not renew an expired memory/disk copy.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("sitemap responses and rebuild failures preserve the original freshness deadline", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const id = `discovery-${tag()}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${id},'Discovery','rss','T1','editorial')`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,timeline_at,discovered_at)
    VALUES (${id},${id},${id},${`https://example.org/${id}`},'Discovery',${new Date(now)},${new Date(now)})`;
  await sql`INSERT INTO publications (article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,indexable,eligible,channel)
    VALUES (${id},${id},'Discovery','Summary',${`https://example.org/${id}`},${new Date(now)},${new Date(now)},${new Date(now)},true,true,'news')`;
  const first = await app.inject("/sitemap.xml");
  assert.equal(first.statusCode, 200);
  assert.ok(first.body.includes(`/items/${id}</loc>`));
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  t.mock.timers.tick(240_000);
  const cached = await app.inject({ url: "/sitemap.xml", headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(cached.statusCode, 304);
  const ttl = Number(String(cached.headers["cache-control"]).match(/s-maxage=(\d+)/)?.[1] ?? Infinity);
  assert.ok(ttl <= 60, `an aged response must not restart its TTL: ${cached.headers["cache-control"]}`);
  t.mock.timers.tick(61_000);
  const refreshed = await app.inject("/sitemap.xml");
  assert.equal(refreshed.statusCode, 200);
  assert.ok(!refreshed.body.includes(`/items/${id}</loc>`), "expired content must be rebuilt before it is sent");
  t.mock.timers.tick(301_000);
  await sql`ALTER TABLE publications RENAME TO unavailable_publications`;
  try {
    const failed = await app.inject("/sitemap.xml");
    assert.equal(failed.statusCode, 503, "a database outage cannot renew an expired sitemap");
    assert.match(String(failed.headers["cache-control"]), /no-store/);
  } finally {
    await sql`ALTER TABLE unavailable_publications RENAME TO publications`;
  }
});
