// Failure cases: warming depends on a removed HTTP listener; the worker and API create different
// card bytes; a correction reuses an old card; withdrawal bypasses visibility through a cached image;
// a render/cache failure interrupts the best-effort preparation step.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

const directory = await mkdtemp(path.join(os.tmpdir(), "share-image-warm-"));
process.env.AIHOT_DATA_DIR = directory;
const { sql, closeDb } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { publishArticle } = await import("@aihot/backend/publication/publish");
const { warmShareImage } = await import("@aihot/backend/media/prepare");
const { buildApp } = await import("../apps/api/src/app.ts");
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); await rm(directory, { recursive: true, force: true }); });

test("the worker warms the API's current public PNG without an HTTP server", async () => {
  const source = `share-warm-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext)
    VALUES (${source}, 'Share fixture', 'rss', 'T1', 'editorial', true, true)`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: "Share fixture",
    bodyText: "A public article with a prepared share card.", bodyHtml: "<p>A public article.</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', ${CATEGORY_KEYS[0]!}, '分享图预热验证', 'API 与 worker 复用同一份图片', 'fixture', 90, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  // There is no serving process here: an implementation that asks one for the card returns false.
  assert.equal(await warmShareImage(articleId), true, "a prepared public card must not depend on a serving process");

  const cache = path.join(directory, "ogcache");
  const files = await readdir(cache);
  assert.equal(files.length, 1);
  const file = path.join(cache, files[0]!);
  const png = await readFile(file);
  const metadata = await sharp(png).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 1200, 630]);
  const response = await app.inject(`/og/items/${articleId}.png`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, png);

  await sql`UPDATE publications SET title = '修正后的分享图标题' WHERE article_id = ${articleId}`;
  assert.equal(await warmShareImage(articleId), true);
  const corrected = await app.inject(`/og/items/${articleId}.png`);
  assert.equal(corrected.statusCode, 200);
  assert.notEqual(corrected.headers.etag, response.headers.etag);
  assert.notDeepEqual(corrected.rawPayload, png);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${articleId}`;
  assert.equal(await warmShareImage(articleId), false);
  assert.equal((await app.inject(`/og/items/${articleId}.png`)).statusCode, 404);
  assert.equal(await warmShareImage("missing-share-fixture"), false);

  await sql`UPDATE publications SET visibility = 'public' WHERE article_id = ${articleId}`;
  await rm(cache, { recursive: true, force: true });
  await writeFile(cache, "not a directory");
  assert.equal(await warmShareImage(articleId), false, "a disk failure remains best effort");
});
