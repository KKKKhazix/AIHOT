// Cross-outlet failures: indexing a page that returns 404, exposing an unreleased item through the
// sitemap, losing a manually indexed archive page, or matching source notes readers cannot see.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { setSeoIndexed } from "@aihot/backend/admin/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const key = tag();
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function fixture(name: string, mode = "editorial", relevance = "pass") {
  const source = `outlet-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, ${name}, 'rss', 'T1', ${mode}, '2100-01-01')`;
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`,
    title: "Source article", bodyText: "Confirmed material", bodyStatus: "ok", publishedAt: new Date(), via: "fetch" });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, category, selected, score)
    VALUES (${id}, 1, 'rule', ${relevance}, '对外标题', '对外摘要', 'ai-models', true, 90)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  return id;
}

test("indexing and sitemap require a readable source, while manual archive indexing remains available", async () => {
  const archive = await fixture("Archived editorial", "editorial", "block");
  const signal = await fixture("Heat signal", "hot_signal");
  const future = await fixture("Not released yet");
  for (const id of [archive, signal]) await setSeoIndexed(id, { indexed: true, reason: "local indexing check" }, "test");
  assert.equal((await app.inject(`/api/site/items/${archive}`)).statusCode, 200);
  assert.equal((await app.inject(`/api/site/items/${signal}`)).statusCode, 404);
  const [stored] = await sql`SELECT indexable FROM publications WHERE article_id = ${signal}`;
  assert.equal(stored!.indexable, false, "unreadable sources must not acquire an indexable publication");
  // Existing rows may carry an old indexability decision: the read layer must enforce live scope too.
  await sql`UPDATE publications SET indexable = true WHERE article_id = ${signal}`;
  await sql`UPDATE publications SET visible_after = now() + interval '1 day' WHERE article_id = ${future}`;
  const sitemap = await app.inject("/sitemap.xml");
  assert.equal(sitemap.statusCode, 200);
  assert.ok(sitemap.body.includes(`/items/${archive}</loc>`), "a readable archive can be explicitly indexed outside the pool");
  assert.ok(!sitemap.body.includes(`/items/${signal}</loc>`), "a stale index bit cannot publish a 404 URL");
  assert.ok(!sitemap.body.includes(`/items/${future}</loc>`), "an unreleased selection cannot reach discovery");
});

test("every search matches the source name readers see and excludes its internal notes", async () => {
  const visible = `Visible${key}`;
  const internal = `Internal${key}`;
  const id = await fixture(`${visible}（${internal}）`);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "outlet-search", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp`)));
  try {
    for (const [query, expected] of [[visible, true], [internal, false]] as const) {
      for (const prefix of ["/api/site/pool?q=", "/api/v1/items?mode=all&q=", "/api/v1/agent/search?q="]) {
        const res = await app.inject(`${prefix}${encodeURIComponent(query)}`);
        assert.equal(res.statusCode, 200, prefix);
        assert.equal(res.body.includes(id), expected, `${prefix}${query}`);
      }
      const result = await client.callTool({ name: MCP_TOOL_NAMES.search, arguments: { q: query } });
      assert.equal(result.isError, undefined);
      assert.equal(JSON.stringify(result.structuredContent).includes(id), expected, `MCP ${query}`);
    }
  } finally { await client.close(); }
});
