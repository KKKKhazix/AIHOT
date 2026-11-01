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
import { collectFindings } from "@aihot/backend/operations/alerts";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const original = "The publisher already supplied this confirmed body, which must remain unchanged. ".repeat(6).trim();
const alternate = "A later page rendering supplies different readable text while exposing its publication metadata. ".repeat(6).trim();
const publishedAt = new Date(Date.now() - 3600000);
const presentationNames = ["blocked", "later"];
let presentationMarkup = "<p>The <b>model</b> is available.</p>";
const server = http.createServer((req, res) => {
  if (req.url === "/presentation-feed") {
    res.setHeader("content-type", "application/rss+xml");
    return res.end(`<rss version="2.0"><channel><title>Fixture</title>${presentationNames.map(name => `<item><title>${name}</title><link>${base}/${name}</link><pubDate>${publishedAt.toUTCString()}</pubDate><content:encoded><![CDATA[${name === "blocked" ? presentationMarkup : "<p>A second article can still be collected.</p>"} ]]></content:encoded></item>`).join("")}</channel></rss>`);
  }
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


test("an unmatchable translated layout stays intact, is not a follow-up and does not stop its feed", async () => {
  const sourceId = `presentation-blocked-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES (${sourceId},'Presentation blocked','rss',${sql.json({ feedUrl: base + "/presentation-feed", summaryIsBody: true })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
  const input = { sourceId, url: base + "/blocked", title: "blocked", bodyText: "The model is available.", bodyHtml: "<p>The model is available.</p>", bodyStatus: "ok" as const, via: "fetch" as const, publishedAt };
  const { articleId } = await upsertMaterial(input);
  await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin)
    VALUES (${articleId},'zh',1,'<p>模型已开放。</p>','模型已开放。',true,'model')`;
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete' WHERE id=${articleId}`;
  const result = await collectSource(sourceId);
  assert.equal(result.status, "ok");
  assert.equal(result.created, 1, "the article behind the failed refresh is still collected");
  const [row] = await sql`SELECT a.body_html,a.revision,a.processing_state,a.processing_error,t.body_html AS translated FROM articles a JOIN translations t ON t.article_id=a.id WHERE a.id=${articleId}`;
  assert.deepEqual({ ...row }, { body_html: input.bodyHtml, revision: 1, processing_state: 'analyzed', processing_error: null, translated: '<p>模型已开放。</p>' });
  // 10-19..10-29: all eight such follow-ups were the same wording with a link added or tags nested
  // differently, closed as accepted; the consistent version kept is the answer, there is nothing to do.
  assert.equal((await collectFindings()).some(f => f.key.startsWith("sources.") && f.key.endsWith(`.${sourceId}`)), false);
  presentationMarkup = '<p>The model is available.</p><figure><img src="https://example.com/restored.png"></figure>';
  assert.equal((await collectSource(sourceId)).status, "ok");
  assert.match((await sql`SELECT body_html FROM articles WHERE id=${articleId}`)[0]!.body_html, /restored.png/, "a layout the translation can follow is applied");
});

