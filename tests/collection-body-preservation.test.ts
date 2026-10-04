// Metadata recovery must not replace an already confirmed article body with another rendering of
// the page; the same free detail response can still supply a body when none was confirmed before.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { collectSource } from "@aihot/backend/sources/collect";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const original = "The publisher already supplied this confirmed body, which must remain unchanged. ".repeat(6).trim();
const alternate = "A later page rendering supplies different readable text while exposing its publication metadata. ".repeat(6).trim();
const publishedAt = new Date(Date.now() - 3600000);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/listing") return res.end(`<ul><li><a href="/complete">Complete article</a></li><li><a href="/pending">Pending article</a></li></ul>`);
  const title = req.url === "/complete" ? "Complete article" : "Pending article";
  res.end(`<html><head><title>${title}</title><meta property="article:published_time" content="${publishedAt.toISOString()}"></head><body><article><h1>${title}</h1><p>${alternate}</p></article></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

test("publication metadata recovery keeps a confirmed body and only fills an unconfirmed body", async () => {
  const sourceId = `body-preservation-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES (${sourceId},'Body preservation','web_list',${sql.json({ url: base + "/listing", itemSelector: "li", titleSelector: "a", detail: { maxFetches: 10 } })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
  const complete = await upsertMaterial({ sourceId, url: base + "/complete", title: "Complete article", bodyText: original, bodyHtml: `<p>${original}</p>`, bodyStatus: "ok", via: "fetch" });
  const pending = await upsertMaterial({ sourceId, url: base + "/pending", title: "Pending article", bodyStatus: "pending", via: "fetch" });
  assert.equal((await collectSource(sourceId)).status, "ok");
  const [confirmed] = await sql`SELECT body_text,body_html,body_status,published_at FROM articles WHERE id=${complete.articleId}`;
  assert.equal(confirmed!.body_text, original);
  assert.equal(confirmed!.body_html, `<p>${original}</p>`);
  assert.equal(confirmed!.body_status, "ok");
  assert.equal(confirmed!.published_at.toISOString(), publishedAt.toISOString());
  const [filled] = await sql`SELECT body_text,body_status,published_at FROM articles WHERE id=${pending.articleId}`;
  assert.ok(filled!.body_text.includes(alternate));
  assert.equal(filled!.body_status, "ok");
  assert.equal(filled!.published_at.toISOString(), publishedAt.toISOString());
});
