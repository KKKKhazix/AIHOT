// A paused external source must not accept new reports or look healthy after a rejected push.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { IngestError, ingestItems } from "@aihot/backend/ingest/items";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { Reply, stub, tag } from "./setup.ts";

const MANUAL_WECHAT = "wechat-manual";
const WECHAT_TAG = tag();
const detailCalls: string[] = [];
const dajiala = await stub((_hit, req) => {
  const requested = new URL(req.url, "http://dajiala.test").searchParams.get("url") ?? "";
  detailCalls.push(requested);
  if (requested.includes("provider-failure")) return new Reply(503, { error: "busy" });
  const old = requested.includes("old-post");
  const invalid = requested.includes("invalid-time");
  const missing = requested.includes("missing-time");
  return {
    code: 0,
    title: "Provider title is not used",
    content: `<p>公众号正文 ${WECHAT_TAG}</p><script>unsafe()</script>`,
    author: "公众号作者",
    desc: "公众号摘要",
    ...(missing ? {} : { pubtime: invalid ? "not a publication date" : new Date(Date.now() - (old ? 72 : 1) * 3_600_000).toISOString() }),
  };
});
process.env.DAJIALA_BASE_URL = dajiala.url;
process.env.DAJIALA_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'dajiala'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled)
            VALUES ('wechat-manual', 'Manual WeChat', 'external', '{}'::jsonb, 'T2', 'editorial', true)
            ON CONFLICT (id) DO UPDATE SET kind='external', config='{}'::jsonb, participation_mode='editorial', enabled=true`;
});

after(async () => {
  await dajiala.close();
  await stopBoss();
  await closeDb();
});

test("a paused external source rejects pushed items without recording a successful fetch", async () => {
  const sourceId = `test-paused-ingest-${tag()}`;
  const lastOkAt = new Date("2026-09-01T00:00:00Z");
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, health, last_ok_at)
    VALUES (${sourceId}, 'Paused external source', 'external', '{}'::jsonb, 'T2', 'editorial', false, 'paused', ${lastOkAt})`;

  await assert.rejects(
    ingestItems({ sourceId, items: [{ title: "New report", url: `https://example.org/${sourceId}` }] }),
    (error: unknown) => error instanceof IngestError && error.status === 409,
  );

  const [source] = await sql<{ last_ok_at: Date }[]>`SELECT last_ok_at FROM sources WHERE id = ${sourceId}`;
  const [articles] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM articles WHERE source_id = ${sourceId}`;
  assert.equal(source!.last_ok_at.toISOString(), lastOkAt.toISOString());
  assert.equal(articles!.count, 0);

  await sql`UPDATE sources SET enabled = true WHERE id = ${sourceId}`;
  assert.deepEqual(await ingestItems({ sourceId, items: [{ title: "New report", url: `https://example.org/${sourceId}` }] }), { ok: true, created: 1 });
});

test("an externally reported calendar day stays date-only through storage", async () => {
  const sourceId = `test-date-ingest-${tag()}`;
  await ingestItems({ sourceId, items: [{ title: "Calendar day", url: `https://example.org/${sourceId}`, publishedAt: "2026-10-13" }] });
  const [row] = await sql`SELECT publication_time, published_at_claim FROM articles WHERE source_id=${sourceId}`;
  assert.equal(row!.publication_time, "2026-10-13");
  assert.equal(row!.published_at_claim.toISOString(), "2026-10-13T00:00:00.000Z");
});

test("manual WeChat ingest enriches only new article links and uses the provider publication time", async () => {
  const shortUrl = `https://mp.weixin.qq.com/s/${WECHAT_TAG}-recent`;
  const longUrl = `https://mp.weixin.qq.com/s/?__biz=${WECHAT_TAG}&mid=123&idx=1&sn=long-post`;
  const oldUrl = `https://mp.weixin.qq.com/s/${WECHAT_TAG}-old-post`;
  const invalidUrl = `https://mp.weixin.qq.com/s/${WECHAT_TAG}-invalid-time`;
  const missingUrl = `https://mp.weixin.qq.com/s/${WECHAT_TAG}-missing-time`;
  const shareTime = new Date().toISOString();

  await ingestItems({ sourceId: MANUAL_WECHAT, items: [
    { title: "推送标题", url: shortUrl, publishedAt: shareTime },
    { title: "长链接文章", url: longUrl },
    { title: "旧文章", url: oldUrl },
    { title: "时间无效文章", url: invalidUrl, publishedAt: shareTime },
    { title: "时间缺失文章", url: missingUrl, publishedAt: shareTime },
  ] });

  assert.equal(detailCalls.length, 5, "short and long links each use article_detail once");
  const rows = await sql<{ url: string; published_at: Date | null; discovered_at: Date; backfill: boolean; body_text: string | null; body_html: string | null; author: string | null; excerpt: string | null }[]>`
    SELECT url,published_at,discovered_at,backfill,body_text,body_html,author,excerpt FROM articles
    WHERE source_id='wechat-manual' AND url IN (${shortUrl},${longUrl},${oldUrl},${invalidUrl},${missingUrl})`;
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  const recent = byUrl.get(shortUrl)!;
  assert.ok(recent.published_at);
  assert.ok(Math.abs(recent.published_at.getTime() - (Date.now() - 3_600_000)) < 10_000, "the provider time replaces the share time and is parsed as a real instant");
  assert.equal(recent.backfill, false);
  assert.equal(recent.author, "公众号作者");
  assert.equal(recent.excerpt, "公众号摘要");
  assert.match(recent.body_text ?? "", /公众号正文/);
  assert.doesNotMatch(recent.body_html ?? "", /<script/i, "provider markup passes through the shared sanitizer");
  assert.equal(byUrl.get(longUrl)!.body_text?.includes("公众号正文"), true);
  assert.equal(byUrl.get(oldUrl)!.backfill, true, "an article older than 48 hours is archived by its original time");
  assert.equal(byUrl.get(invalidUrl)!.published_at, null, "invalid provider time stays unknown instead of using share time");
  assert.equal(byUrl.get(invalidUrl)!.backfill, true);
  assert.equal(byUrl.get(missingUrl)!.published_at, null, "missing provider time stays unknown instead of using share time");
  assert.equal(byUrl.get(missingUrl)!.backfill, true);

  await ingestItems({ sourceId: MANUAL_WECHAT, items: [{ title: "推送标题", url: shortUrl, publishedAt: shareTime }] });
  assert.equal(detailCalls.length, 5, "a duplicate task does not buy another lookup");
  const [afterRetry] = await sql<{ revision: number; published_at: Date | null }[]>`SELECT revision,published_at FROM articles WHERE url=${shortUrl}`;
  assert.equal(afterRetry!.revision, 1);
  assert.equal(afterRetry!.published_at!.toISOString(), recent.published_at!.toISOString());
});

test("manual WeChat ingest ignores lookalike and non-article URLs, and propagates provider failures", async () => {
  const before = detailCalls.length;
  const shareTime = "2026-11-01T10:00:00Z";
  await ingestItems({ sourceId: MANUAL_WECHAT, items: [
    { title: "相似域名", url: `https://mp.weixin.qq.com.evil.example/s/${WECHAT_TAG}`, publishedAt: shareTime },
    { title: "非公众号链接", url: `https://example.org/${WECHAT_TAG}`, publishedAt: shareTime },
    { title: "公众号其他路径", url: `https://mp.weixin.qq.com/profile/${WECHAT_TAG}`, publishedAt: shareTime },
  ] });
  assert.equal(detailCalls.length, before, "lookalike hosts, other hosts, and non-/s paths never call Dajiala");

  const failureUrl = `https://mp.weixin.qq.com/s/${WECHAT_TAG}-provider-failure`;
  await assert.rejects(ingestItems({ sourceId: MANUAL_WECHAT, items: [{ title: "接口失败", url: failureUrl }] }), /dajiala HTTP 503/);
  assert.equal(detailCalls.length, before + 1);
  const [notSaved] = await sql`SELECT id FROM articles WHERE url=${failureUrl}`;
  assert.equal(notSaved, undefined, "a failed detail lookup does not save a share timestamp or partially ingest the article");
});
