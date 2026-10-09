// A source's publication boundary must see its article-page date: undated listings must not be
// discarded before enrichment, and old/future/missing dates must still stay out of storage and preview.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { previewSource } from "@aihot/backend/admin/sources";

const T = tag();
const now = Date.now();
const boundary = new Date(now - 86400000).toISOString();
const dates: Record<string, string | null> = {
  fresh: new Date(now - 3600000).toISOString(),
  old: new Date(now - 2 * 86400000).toISOString(),
  future: new Date(now + 2 * 86400000).toISOString(),
  missing: null,
};
let headlineSuffix = "";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  const path = new URL(req.url!, base).pathname;
  if (path.startsWith("/list/")) {
    const mode = path.split("/")[2];
    res.end(`<ul>${Object.keys(dates).map(key => `<li><a href="/${mode}/${key}">An article ${key}${headlineSuffix}</a>${mode === "authoritative" ? `<time datetime="${dates.fresh}"></time>` : ""}</li>`).join("")}</ul>`);
  } else {
    const date = dates[path.split("/")[2]!];
    res.end(`<html><head>${date ? `<meta name="original-publication" content="${date}">` : ""}<meta property="article:modified_time" content="${dates.fresh}"></head><body><article><h1>Original article</h1><p>${"A complete original article. ".repeat(20)}</p></article></body></html>`);
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

for (const mode of ["undated", "authoritative"]) {
  test(`${mode} listing applies its boundary after original article dates in both preview and storage`, async () => {
    headlineSuffix = "";
    const id = `test-publication-window-${mode}-${T}`;
    const sourceConfig = {
      url: `${base}/list/${mode}`, itemSelector: "li", titleSelector: "a", linkSelector: "a", publishedAtSelector: "time",
      publishedAfter: boundary,
      detail: { maxFetches: 10, publishedAtSelector: 'meta[name="original-publication"]', publishedAtAuthoritative: mode === "authoritative" },
    };
    const preview = await previewSource({ id, kind: "web_list", config: sourceConfig });
    assert.deepEqual(preview.items.map(item => [item.url, item.publishedAt]), [[`${base}/${mode}/fresh`, dates.fresh]]);
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
      VALUES (${id}, ${id}, 'web_list', ${sql.json(sourceConfig)}, 'T1', 'editorial', ${sql.json({ initializedAt: new Date(now).toISOString() })}, '2100-01-01')`;
    for (let i = 0; i < 2; i++) assert.equal((await collectSource(id, { force: true })).status, "ok");
    const rows = await sql<{ url: string; published_at: Date }[]>`SELECT url, published_at FROM articles WHERE source_id = ${id}`;
    assert.deepEqual(rows.map(row => [row.url, row.published_at.toISOString()]), [[`${base}/${mode}/fresh`, dates.fresh]]);
    headlineSuffix = " revised";
    await sql`UPDATE sources SET config = ${sql.json({ ...sourceConfig, detail: { ...sourceConfig.detail, summarySelector: 'meta[name="description"]' } })} WHERE id = ${id}`;
    assert.equal((await collectSource(id, { force: true })).revised, 1, "a rule update must preserve a known date while admitting a genuine title revision");
    headlineSuffix = "";
  });
}
