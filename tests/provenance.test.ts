// Verified original publishers are independent of discovery channels and collection schedules.
// Attribution preserves material and existing judgements, and routes new work through one pipeline.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publisherOwnsUrl } from "@aihot/backend/content/provenance";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { ingestItems } from "@aihot/backend/ingest/items";
import { queueProcessing, settleNonEditorial } from "@aihot/backend/jobs/content";
import { collectSource } from "@aihot/backend/sources/collect";
import { createSource, updateSource } from "@aihot/backend/admin/sources";
import { groupArticle } from "@aihot/backend/events/group";

after(async () => { await stopBoss(); await closeDb(); });

async function source(tier: string, config = {}, firstParty = tier === "T1", opts: { kind?: string; mode?: string; enabled?: boolean } = {}) {
  const id = `provenance-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, first_party, config, participation_mode, site_fulltext, next_fetch_at, enabled)
    VALUES (${id}, ${id}, ${opts.kind ?? 'rss'}, ${tier}, ${firstParty}, ${sql.json(config)}, ${opts.mode ?? 'editorial'}, true, '2100-01-01', ${opts.enabled ?? true})`;
  return id;
}

const jobs = (articleId: string) => sql<{ name: string; data: { signalOnly?: boolean } }[]>`
  SELECT name, data FROM pgboss.job WHERE data->>'articleId' = ${articleId} AND name IN (${QUEUES.extractBody}, ${QUEUES.analyze}, ${QUEUES.group})`;

test("the first external discovery uses a paused verified publisher, keeps the real discovery and queues extraction once", async () => {
  const scope = `https://www.${tag()}.example/news`;
  const official = await source("T1", { publisherUrlPrefixes: [scope], fetchPublicContent: true }, true, { enabled: false });
  const media = await source("T2");
  const url = `${scope}/release`;
  const input = { sourceId: media, items: [{ url, title: "Release", author: "HN submitter", publishedAt: new Date().toISOString() }] };
  assert.equal((await ingestItems(input)).created, 1);
  const [a] = await sql`SELECT * FROM articles WHERE url = ${url}`;
  assert.deepEqual([a!.source_id, a!.author, a!.revision, a!.body_status], [official, null, 1, "pending"]);
  assert.deepEqual((await sql`SELECT source_id FROM article_discoveries WHERE article_id = ${a!.id}`).map((d) => d.source_id), [media]);
  await ingestItems(input);
  assert.deepEqual((await jobs(a!.id)).map((j) => j.name), [QUEUES.extractBody]);
  assert.equal((await collectSource(official)).error, "paused", "publisher identity does not start its collector");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${a!.id}`).length, 0, "queueing never calls a model");
});

test("a repeated signal discovery adopts a newly registered publisher and resumes editorial processing without revising material", async () => {
  const scope = `https://${tag()}.example/news`;
  const signal = await source("T2", {}, false, { mode: "hot_signal" });
  const url = `${scope}/release`;
  const first = await upsertMaterial({ sourceId: signal, url, title: "Original", bodyText: "Preserved body", via: "fetch" });
  await queueProcessing(first.articleId);
  assert.deepEqual((await jobs(first.articleId)).map((j) => [j.name, j.data.signalOnly]), [[QUEUES.group, true]]);
  assert.equal((await settleNonEditorial(first.articleId)).group, true);
  const [before] = await sql`SELECT * FROM articles WHERE id = ${first.articleId}`;
  const official = await source("T1", { publisherUrlPrefixes: [scope] }, true, { enabled: false });
  const input = { sourceId: signal, items: [{ url, title: "Changed signal headline" }] };
  await ingestItems(input);
  await ingestItems(input);
  const [a] = await sql`SELECT * FROM articles WHERE id = ${first.articleId}`;
  for (const key of ["revision", "content_hash", "title", "body_text", "published_at", "discovered_at", "timeline_at"]) assert.deepEqual(a![key], before![key], key);
  assert.equal(a!.source_id, official);
  assert.equal(a!.processing_state, "new", "a previously settled signal still needs editorial judgement");
  assert.deepEqual((await jobs(first.articleId)).map((j) => j.name).sort(), [QUEUES.analyze, QUEUES.group].sort());
  assert.equal((await settleNonEditorial(first.articleId)).group, false, "the old signal job will stop after attribution changes");
  assert.deepEqual((await sql`SELECT source_id, via FROM article_discoveries WHERE article_id = ${first.articleId} ORDER BY via`).map((d) => [d.source_id, d.via]), [[signal, "fetch"], [signal, "ingest"]]);
  const revised = await upsertMaterial({ sourceId: official, url, title: "Publisher edit", bodyText: "Actual publisher update", via: "fetch" });
  assert.equal(revised.revised, true, "subsequent material changes from the verified publisher still work");
});

// Failure modes: a completed heat-only decision is mistaken for news confirmation when a publisher
// is adopted or a whole source becomes editorial; clearing it must not discard an existing editorial
// judgement. A newly scored candidate must remain unselected until its news identity is confirmed.
for (const entrance of ["publisher", "source-mode"] as const) test(`${entrance} promotion cannot reuse a signal-only grouping as news confirmation`, async () => {
  const scope = `https://${tag()}.example/news`;
  const signal = await source("T1", {}, true, { mode: "hot_signal" });
  const make = async (name: string) => (await upsertMaterial({ sourceId: signal, url: `${scope}/${name}`,
    title: `Release ${name}`, bodyText: "Preserved original material", via: "fetch", publishedAt: new Date() })).articleId;
  const fresh = await make("new");
  await settleNonEditorial(fresh);
  assert.equal((await groupArticle(fresh, { signalOnly: true })).verdict, "signal-unmatched");
  const judged = await make("already-judged");
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected)
    VALUES (${judged},1,'rule','pass','已判断的报道','既有精选已经覆盖全部要点',true)`;
  await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),selection_adds_value=false,
    selection_value_reason='既有精选已覆盖' WHERE id=${judged}`;
  if (entrance === "publisher") {
    await source("T1", { publisherUrlPrefixes: [scope] });
    for (const [id, name] of [[fresh, "new"], [judged, "already-judged"]]) {
      assert.equal((await upsertMaterial({ sourceId: signal, url: `${scope}/${name}`, title: "Discovery", via: "fetch" })).articleId, id);
    }
  } else {
    const [s] = await sql`SELECT updated_at FROM sources WHERE id=${signal}`;
    await updateSource(signal, { patch: { participation_mode: "editorial" }, version: s!.updated_at.toISOString() }, "test");
  }
  const [preserved] = await sql`SELECT grouping_status,selection_adds_value FROM articles WHERE id=${judged}`;
  assert.deepEqual({ ...preserved }, { grouping_status: "complete", selection_adds_value: false }, "current editorial judgement stays reusable");
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected)
    VALUES (${fresh},1,'rule','pass','首次编辑判断','新的新闻候选摘要',true)`;
  await publishArticle(fresh);
  const [pending] = await sql`SELECT p.selection_candidate,p.selected,a.grouping_status FROM publications p JOIN articles a ON a.id=p.article_id WHERE a.id=${fresh}`;
  assert.deepEqual({ ...pending }, { selection_candidate: true, selected: false, grouping_status: "pending" });
  assert.equal((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${fresh}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='notify.selected' AND data->>'articleId'=${fresh}`).length, 0);
});

test("a T1 channel linking another publisher is still a discovery, not that URL's publisher", async () => {
  const scope = `https://${tag()}.example/news`;
  const official = await source("T1", { publisherUrlPrefixes: [scope] });
  const linker = await source("T1", { publisherUrlPrefixes: [`https://${tag()}.example/blog`] });
  const { articleId } = await upsertMaterial({ sourceId: linker, url: `${scope}/release`, title: "Linked release", author: "Link submitter", via: "fetch" });
  const [a] = await sql`SELECT source_id, author FROM articles WHERE id = ${articleId}`;
  assert.deepEqual([a!.source_id, a!.author], [official, null]);
  assert.deepEqual((await sql`SELECT source_id FROM article_discoveries WHERE article_id = ${articleId}`).map((d) => d.source_id), [linker]);
});

test("attribution reuses an existing current-revision editorial judgement even after the source became a signal", async () => {
  const scope = `https://${tag()}.example/news`;
  const media = await source("T2");
  const url = `${scope}/release`;
  const { articleId } = await upsertMaterial({ sourceId: media, url, title: "Release", bodyText: "Body", via: "fetch" });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'replay', 'pass', '发布', '摘要', 85, true)`;
  await sql`UPDATE sources SET participation_mode = 'hot_signal' WHERE id = ${media}`;
  await settleNonEditorial(articleId);
  await source("T1", { publisherUrlPrefixes: [scope] });
  const result = await upsertMaterial({ sourceId: media, url, title: "Changed discovery", via: "fetch" });
  assert.equal(result.processingNeeded, undefined);
  assert.equal((await jobs(articleId)).length, 0);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${articleId}`).length, 1);
});

test("only an observed web-list path supplies implicit ownership; non-T1 and RSS domains never do", async () => {
  const scope = `https://${tag()}.example/news`;
  const media = await source("T2");
  const web = await source("T1", { url: scope }, true, { kind: "web_list" });
  await source("T1", { feedUrl: `${scope}/rss` });
  await source("T1_5", { publisherUrlPrefixes: [scope] }, true);
  const url = `${scope}/release`;
  const { articleId } = await upsertMaterial({ sourceId: media, url, title: "Release", via: "fetch" });
  assert.equal((await sql`SELECT source_id FROM articles WHERE id = ${articleId}`)[0]!.source_id, media);
  await upsertMaterial({ sourceId: web, url, title: "Publisher listing", via: "fetch" });
  assert.equal((await sql`SELECT source_id FROM articles WHERE id = ${articleId}`)[0]!.source_id, web);
  const own = (prefix: string, target: string) => publisherOwnsUrl({ id: web, kind: "rss", config: { publisherUrlPrefixes: [prefix] } }, target);
  assert.equal(own(scope, `${scope}/child`), true);
  for (const target of [`${scope}room/child`, scope.replace("https:", "http:"), scope.replace("https://", "https://www."), scope.replace(".example", ".example.evil"), `${scope}%2Fchild`]) assert.equal(own(scope, target), false, target);
  for (const invalid of [`${scope}?utm_source=trusted`, `${scope}#release`, scope.replace("https://", "https://user@")]) assert.equal(own(invalid, url), false, invalid);
});

test("a later verified publisher repairs source and author, preserving judgement, content and time", async () => {
  const media = await source("T2");
  const scope = `https://${tag()}.example/news`;
  const url = `${scope}/release`;
  const at = new Date("2026-09-20T00:00:00Z");
  const { articleId } = await upsertMaterial({ sourceId: media, url, title: "Original release", author: "HN submitter", bodyText: "Release body", via: "fetch", discoveredAt: at, publishedAt: at });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'replay', 'pass', '原始发布', '真实摘要', 85, true)`;
  await publishArticle(articleId, { releasedAt: at });
  const [before] = await sql`SELECT * FROM publications WHERE article_id = ${articleId}`;
  const official = await source("T1", { publisherUrlPrefixes: [scope] });
  const correction = await upsertMaterial({ sourceId: official, url, title: "Publisher listing title", author: "Publisher team", via: "fetch" });
  const [a] = await sql`SELECT * FROM articles WHERE id = ${articleId}`;
  const [p] = await sql`SELECT * FROM publications WHERE article_id = ${articleId}`;
  assert.deepEqual([correction.articleId, correction.created, correction.revised], [articleId, false, false]);
  assert.deepEqual([a!.source_id, a!.author, a!.revision, a!.body_text], [official, "Publisher team", 1, "Release body"]);
  assert.deepEqual([p!.source_id, p!.first_party, p!.selected, Number(p!.score), p!.analysis_id, p!.body_mode, p!.syndicate],
    [official, true, true, 85, before!.analysis_id, before!.body_mode, before!.syndicate]);
  assert.equal(p!.sort_at.toISOString(), before!.sort_at.toISOString());
  assert.equal(p!.visible_after.toISOString(), before!.visible_after.toISOString());
  assert.equal(p!.revision, before!.revision + 1);
  assert.equal((await sql`SELECT 1 FROM article_discoveries WHERE article_id = ${articleId}`).length, 2);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action = 'article.attribution' AND subject = ${`article:${articleId}`}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${articleId}`).length, 1);
  await upsertMaterial({ sourceId: media, url, title: "Aggregator changed title", author: "Another submitter", via: "fetch" });
  assert.equal((await sql`SELECT source_id FROM articles WHERE id = ${articleId}`)[0]!.source_id, official);
});

test("publisher-first discovery remains the publisher, and an unrelated T1 URL cannot take ownership", async () => {
  const scope = `https://${tag()}.example/news`;
  const official = await source("T1", { publisherUrlPrefixes: [scope] });
  const media = await source("T2");
  const url = `${scope}/release`;
  const first = await upsertMaterial({ sourceId: official, url, title: "Official", author: "Team", via: "fetch" });
  await upsertMaterial({ sourceId: media, url, title: "Aggregator", via: "fetch" });
  assert.equal((await sql`SELECT source_id FROM articles WHERE id = ${first.articleId}`)[0]!.source_id, official);
  const otherUrl = `${scope}room/release`;
  const other = await upsertMaterial({ sourceId: media, url: otherUrl, title: "Different publication", via: "fetch" });
  await upsertMaterial({ sourceId: official, url: otherUrl, title: "Link from official feed", via: "fetch" });
  assert.equal((await sql`SELECT source_id FROM articles WHERE id = ${other.articleId}`)[0]!.source_id, media);
  assert.equal(publisherOwnsUrl({ id: official, kind: "rss", config: { feedUrl: "https://shared.example/feed" } }, "https://shared.example/other-author/post"), false);
  assert.equal(publisherOwnsUrl({ id: official, kind: "web_list", config: { url: "https://shared.example/one-author" } }, "https://shared.example/other-author/post"), false);
});

test("ambiguous registered publishers do not silently choose a source", async () => {
  const media = await source("T2");
  const scope = `https://${tag()}.example/news`;
  const config = { publisherUrlPrefixes: [scope] };
  const one = await source("T1", config);
  const two = await source("T1", config);
  const url = `${scope}/release`;
  const { articleId } = await upsertMaterial({ sourceId: media, url, title: "Release", via: "fetch" });
  await sql`INSERT INTO article_discoveries (article_id, source_id, via) VALUES (${articleId}, ${one}, 'fetch')`;
  await upsertMaterial({ sourceId: two, url, title: "Release", via: "fetch" });
  assert.equal((await sql`SELECT source_id FROM articles WHERE id = ${articleId}`)[0]!.source_id, media);
});

test("a non-T1 flag cannot enter the first-party channel, and source edits derive the flag from tier", async () => {
  const id = await source("T1_5", {}, true);
  const { articleId } = await upsertMaterial({ sourceId: id, url: `https://example.com/${tag()}`, title: "Official social announcement", via: "fetch" });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', ${id}, '公告摘要', false)`;
  await publishArticle(articleId);
  assert.equal((await sql`SELECT first_party FROM publications WHERE article_id = ${articleId}`)[0]!.first_party, false);
  const pool = await loadPool({ channel: "firstParty", q: id, category: null, tag: null });
  assert.equal(pool.items.length, 0);
  const [s] = await sql`SELECT updated_at FROM sources WHERE id = ${id}`;
  const updated = await updateSource(id, { version: s!.updated_at.toISOString(), patch: { tier: "T1", first_party: false } }, "test");
  assert.equal(updated!.first_party, true);
  const created = await createSource({ id: `provenance-create-${tag()}`, name: "Official person", kind: "external", config: {}, tier: "T1_5", first_party: true }, "test");
  assert.equal(created.created && created.source!.first_party, false);
});
