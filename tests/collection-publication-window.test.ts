// Failure cases: a first-import cap only postpones paid history processing until the next run;
// boundary-day, undated or future-dated entries bypass a fixed source publication window.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

type Item = { id: string; date: string | null };
const lists = new Map<string, Item[]>();
const T = tag();
const cutoff = new Date(Date.now() - 86400_000);
cutoff.setMilliseconds(0);
const server = http.createServer((req, res) => {
  const path = req.url!;
  const rows = lists.get(path) ?? [];
  if (path.startsWith("/json")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(rows));
  } else if (path.startsWith("/rss")) {
    res.setHeader("content-type", "application/rss+xml");
    res.end(`<rss version="2.0"><channel><title>Publication window</title>${rows.map(row =>
      `<item><title>${row.id}</title><link>${base}/article${path}/${row.id}</link>${row.date ? `<pubDate>${new Date(row.date).toUTCString()}</pubDate>` : ""}</item>`).join("")}</channel></rss>`);
  } else {
    res.setHeader("content-type", "text/html");
    res.end(rows.map(row => `<article><a href="${base}/article${path}/${row.id}">${row.id}</a>${row.date ? `<time datetime="${row.date}"></time>` : ""}</article>`).join(""));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

for (const kind of ["rss", "web_list", "json_list"]) test(`${kind} applies the fixed publication window on the first and all subsequent runs`, async () => {
  const id = `window-${T}-${kind}`;
  const path = `/${kind}/${id}`;
  const rows: Item[] = [
    { id: "old", date: new Date(cutoff.getTime() - 86400_000).toISOString() },
    { id: "boundary", date: cutoff.toISOString() },
    { id: "undated", date: null },
    { id: "future", date: new Date(Date.now() + 86400_000).toISOString() },
    { id: "current", date: new Date(Date.now() - 60_000).toISOString() },
  ];
  lists.set(path, rows);
  const mapping = kind === "rss" ? { feedUrl: base + path } : kind === "json_list"
    ? { url: base + path, titlePaths: ["id"], urlTemplate: `${base}/article${path}/{id}`, publishedAtPath: "date" }
    : { url: base + path, itemSelector: "article", linkSelector: "a", publishedAtSelector: "time" };
  await sql`INSERT INTO sources(id,name,kind,participation_mode,config,next_fetch_at)
    VALUES(${id},${id},${kind},'editorial',${sql.json({ ...mapping, publishedAfter: cutoff.toISOString() })},'2100-01-01')`;
  assert.equal((await collectSource(id)).created, 1);
  assert.equal((await collectSource(id)).created, 0, "a regular fetch must not start ingesting the old entries");
  rows.push({ id: "latest", date: new Date(Date.now() - 30_000).toISOString() });
  assert.equal((await collectSource(id)).created, 1);
  const saved = await sql`SELECT title FROM articles WHERE source_id=${id} ORDER BY title`;
  assert.deepEqual(saved.map(row => row.title), ["current", "latest"]);
  const [queued] = await sql`SELECT count(*)::int AS n FROM pgboss.job j JOIN articles a ON a.id=j.data->>'articleId' WHERE a.source_id=${id}`;
  assert.equal(queued!.n, 2, "excluded history never queues extraction or paid analysis");
});
