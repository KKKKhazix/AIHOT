// Material storage: every distinct change gets its own revision and history row, also under
// concurrency; imported history gets a baseline instead of a revision; simultaneous first reports
// of one URL create one article; other sources' listings, returns to an earlier version and characters
// lost in transit are no revision (articles used to flip between two versions on every fetch, and a
// feed garbled a few characters differently on every load).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { identityKeyForUrl } from "@aihot/backend/lib/url";

const SOURCE = `test-materials-${tag()}`;
const OTHER = `test-materials-other-${tag()}`;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test materials', 'rss', '2100-01-01'),
            (${OTHER}, 'Test aggregator', 'rss', '2100-01-01')`;
});
after(() => closeDb());

const state = async (id: string) =>
  (await sql<{ revision: number; title: string; content_hash: string | null; processing_state: string }[]>`
    SELECT revision, title, content_hash, processing_state FROM articles WHERE id = ${id}`)[0]!;

// Invalid timestamps from a provider must be absent at the common storage boundary, on both the
// first insert and an update. Otherwise postgres date serialization aborts the complete source run.
test("invalid source timestamps remain unknown on inserts and revisions", async () => {
  const material = { sourceId: SOURCE, url: `https://example.com/date-${tag()}`, title: "Undated", via: "fetch" as const,
    publishedAt: new Date(NaN), sourceUpdatedAt: new Date(NaN) };
  const { articleId } = await upsertMaterial(material);
  assert.equal((await upsertMaterial({ ...material, title: "Undated, revised" })).revised, true);
  const [row] = await sql`SELECT published_at,published_at_claim,source_updated_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { published_at: null, published_at_claim: null, source_updated_at: null });
});

/** An article as a history import writes it: imported content, no hash, no history row, analysed. */
async function imported(url: string) {
  const id = `imp${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
            VALUES (${id}, ${SOURCE}, ${identityKeyForUrl(url)}, ${url}, 'Imported title', now(), now(), 1, NULL, 'imported body', 'ok', 'analyzed')`;
  return id;
}

test("concurrent changes to one article each get a revision", async () => {
  const url = `https://example.com/race-${tag()}`;
  const first = await upsertMaterial({ sourceId: SOURCE, url, title: "T0", excerpt: "e0", via: "fetch" });
  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((i) => upsertMaterial({ sourceId: SOURCE, url, title: `T${i}`, excerpt: `distinct excerpt ${i}`, via: "fetch" })),
  );
  assert.ok(results.every((r) => r.articleId === first.articleId && r.revised));
  const [article] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${first.articleId}`;
  const history = await sql<{ revision: number }[]>`SELECT revision FROM article_revisions WHERE article_id = ${first.articleId} ORDER BY revision`;
  assert.equal(article!.revision, 7);
  assert.deepEqual(history.map((h) => h.revision), [1, 2, 3, 4, 5, 6, 7]);
});

test("an unchanged report does not add a revision", async () => {
  const url = `https://example.com/same-${tag()}`;
  const first = await upsertMaterial({ sourceId: SOURCE, url, title: "Same", excerpt: "same", via: "fetch" });
  const again = await upsertMaterial({ sourceId: SOURCE, url, title: "Same", excerpt: "same", via: "fetch" });
  assert.equal(again.revised, false);
  const [article] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${first.articleId}`;
  assert.equal(article!.revision, 1);
});

// Failure modes: a corrected revision inherits exhausted retries, a future retry time, or the
// old job's queue marker and never gets its own fair attempt. Identical reports must retain those
// limits, while body enrichment during a manual evaluation must retain its paid request identity.
test("a material revision resets old processing failures without resetting unchanged material", async () => {
  const material = { sourceId: SOURCE, url: `https://example.com/retry-${tag()}`, title: "Needs a body", via: "fetch" as const };
  const { articleId } = await upsertMaterial(material);
  const [failed] = await sql`UPDATE articles SET processing_state='failed', processing_attempts=9,
    processing_retry_at=now()+interval '6 hours', processing_error='previous revision failed',
    processing_queued_at=now(), processing_attempt_tag='admin:current-evaluation',
    grouping_status='complete', grouped_at=now(), selection_adds_value=false, selection_value_reason='old revision' WHERE id=${articleId}
    RETURNING processing_state, processing_attempts, processing_retry_at, processing_error, processing_queued_at, processing_attempt_tag,
      grouping_status, grouped_at, selection_adds_value, selection_value_reason`;
  await upsertMaterial(material);
  const [unchanged] = await sql`SELECT processing_state, processing_attempts, processing_retry_at, processing_error, processing_queued_at, processing_attempt_tag,
    grouping_status, grouped_at, selection_adds_value, selection_value_reason
    FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...unchanged }, { ...failed });
  assert.equal((await upsertMaterial({ ...material, bodyText: "The corrected full material", bodyStatus: "ok" })).revised, true);
  const [revised] = await sql`SELECT revision, processing_state, processing_attempts, processing_retry_at, processing_error, processing_queued_at, processing_attempt_tag,
    grouping_status, grouped_at, selection_adds_value, selection_value_reason
    FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...revised }, { revision: 2, processing_state: "new", processing_attempts: 0, processing_retry_at: null,
    processing_error: null, processing_queued_at: null, processing_attempt_tag: "admin:current-evaluation",
    grouping_status: "pending", grouped_at: null, selection_adds_value: null, selection_value_reason: null });
});

test("an imported article's first report records a baseline, not a revision", async () => {
  const url = `https://example.com/imported-${tag()}`;
  const id = `imp${tag()}`;
  // What a history import writes: imported content, no hash, already analysed.
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
            VALUES (${id}, ${SOURCE}, ${identityKeyForUrl(url)}, ${url}, 'Imported  title', now(), now(), 1, NULL, 'imported body', 'ok', 'analyzed')`;
  const listed = { sourceId: SOURCE, url, title: "Imported title", excerpt: "feed summary", via: "fetch" as const };
  const first = await upsertMaterial(listed);
  assert.deepEqual([first.articleId, first.revised, first.created], [id, false, false]);
  assert.equal((await upsertMaterial(listed)).revised, false, "the baseline holds");
  const changed = await upsertMaterial({ ...listed, title: "Imported title, corrected" });
  assert.equal(changed.revised, true, "a real change after the baseline is a revision");
  const [article] = await sql<{ revision: number; processing_state: string }[]>`SELECT revision, processing_state FROM articles WHERE id = ${id}`;
  assert.deepEqual([article!.revision, article!.processing_state], [2, "new"]);
});

test("simultaneous first reports of one URL create one article", async () => {
  const url = `https://example.com/new-${tag()}`;
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => upsertMaterial({ sourceId: SOURCE, url, title: "New", excerpt: "new", via: "fetch" })));
  assert.equal(new Set(results.map((r) => r.articleId)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
});

test("another source listing the same article records a discovery, not a revision", async () => {
  // Hacker News：AI 热帖 lists the English title, the buzzing.cc mirror a Chinese translation.
  const url = `https://example.com/listed-twice-${tag()}`;
  const own = await upsertMaterial({ sourceId: SOURCE, url, title: "One month without AI", excerpt: "own summary", via: "fetch" });
  for (let i = 0; i < 3; i++) {
    const mirror = await upsertMaterial({ sourceId: OTHER, url, title: "没有AI的一个月", excerpt: "译文摘要", via: "fetch" });
    assert.deepEqual([mirror.articleId, mirror.revised], [own.articleId, false]);
    assert.equal((await upsertMaterial({ sourceId: SOURCE, url, title: "One month without AI", excerpt: "own summary", via: "fetch" })).revised, false);
  }
  const a = await state(own.articleId);
  assert.deepEqual([a.revision, a.title], [1, "One month without AI"]);
  const found = await sql<{ source_id: string }[]>`SELECT source_id FROM article_discoveries WHERE article_id = ${own.articleId}`;
  assert.ok(found.some((d) => d.source_id === OTHER), "the other source still counts as a discovery");
});

test("an article linking to a tweet is stored separately from the tweet", async () => {
  const tweetId = `${Date.now()}123456`;
  const url = `https://x.com/openai/status/${tweetId}`;
  const tweet = await upsertMaterial({ sourceId: SOURCE, url, title: "Original tweet", via: "fetch" });
  const article = await upsertMaterial({
    sourceId: OTHER, url: `https://example.com/report-${tag()}?related=${url}`, title: "Independent report", via: "fetch",
  });
  assert.equal(article.created, true);
  assert.notEqual(article.articleId, tweet.articleId);
  assert.equal((await state(tweet.articleId)).title, "Original tweet");
  assert.equal((await state(article.articleId)).title, "Independent report");
  const alias = await upsertMaterial({
    sourceId: OTHER, url: `https://twitter.com/openai/status/${tweetId}`, title: "Tweet alias", via: "fetch",
  });
  assert.equal(alias.created, false);
  assert.equal(alias.articleId, tweet.articleId);
});

test("another source reporting an imported article first does not set its baseline", async () => {
  const url = `https://example.com/imported-mirror-${tag()}`;
  const id = await imported(url);
  const mirror = await upsertMaterial({ sourceId: OTHER, url, title: "镜像站的标题", excerpt: "镜像摘要", via: "fetch" });
  assert.deepEqual([mirror.articleId, mirror.revised], [id, false]);
  assert.equal((await state(id)).content_hash, null, "the mirror's version is not the baseline");
  const own = await upsertMaterial({ sourceId: SOURCE, url, title: "Imported title", excerpt: "feed summary", via: "fetch" });
  assert.equal(own.revised, false, "the article's own listing records the baseline");
  assert.deepEqual([(await state(id)).revision, (await state(id)).processing_state], [1, "analyzed"]);
});

test("a return to an earlier version is not a revision", async () => {
  // One listing with two cards for one post ("Company Mistral and Mozilla…" / "Mistral and Mozilla…").
  const url = `https://example.com/two-cards-${tag()}`;
  const a = { sourceId: SOURCE, url, title: "Company Mistral and Mozilla", excerpt: "card", via: "fetch" as const };
  const b = { ...a, title: "Mistral and Mozilla" };
  const first = await upsertMaterial(a);
  assert.equal((await upsertMaterial(b)).revised, true, "a version not seen before is a revision");
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${first.articleId}`;
  for (let i = 0; i < 3; i++) {
    assert.equal((await upsertMaterial(a)).revised, false, "back to the first version");
    assert.equal((await upsertMaterial(b)).revised, false, "and to the current one again");
  }
  const s = await state(first.articleId);
  assert.deepEqual([s.revision, s.title, s.processing_state], [2, "Mistral and Mozilla", "analyzed"], "nothing to analyse or publish again");
  assert.equal((await upsertMaterial({ ...a, title: "Mistral and Mozilla, updated" })).revised, true, "a new version still is");
  assert.equal((await state(first.articleId)).revision, 3);
});

test("an imported article that returns to its baseline is not revised again", async () => {
  // A page that rotates promotions: the baseline, another rendering, then the baseline again.
  const url = `https://example.com/rotating-${tag()}`;
  const id = await imported(url);
  const base = { sourceId: SOURCE, url, title: "Imported title", bodyText: "Post text. PODCAST SERIES Ideas", via: "fetch" as const };
  assert.equal((await upsertMaterial(base)).revised, false, "baseline");
  assert.equal((await upsertMaterial({ ...base, bodyText: "Post text. Foundry Labs" })).revised, true);
  assert.equal((await upsertMaterial(base)).revised, false, "the baseline version was seen before");
  assert.equal((await state(id)).revision, 2);
});

test("characters lost in transit are no revision, lost or restored", async () => {
  // A feed that garbles a few characters at random on every load: the 盖 of 覆盖 arrives as two U+FFFD, a ， as three.
  const url = `https://example.com/garbled-${tag()}`;
  const excerpt = "新旗舰店覆盖的产品范围更广，包括内衣、家居服、运动服饰、香水及身体护理。";
  const clean = { sourceId: SOURCE, url, title: "维密重回上海淮海路，中国市场进入扩店阶段", excerpt, via: "fetch" as const };
  const lost = (s: string, from: string, n: number) => s.replace(from, "\uFFFD".repeat(n));
  const garbled = [
    { ...clean, excerpt: lost(excerpt, "盖", 2) },
    { ...clean, excerpt: lost(excerpt, "，", 3) },
    { ...clean, title: lost(clean.title, "淮", 2), excerpt: lost(excerpt, "衣", 1) },
  ];
  const first = await upsertMaterial(garbled[0]!);
  for (const report of [clean, ...garbled, clean]) assert.equal((await upsertMaterial(report)).revised, false);
  assert.equal((await state(first.articleId)).revision, 1);
  const edited = (r: typeof clean) => ({ ...r, excerpt: r.excerpt.replace("香水", "美妆") });
  assert.equal((await upsertMaterial(edited(garbled[1]!))).revised, true, "a real change is one, lost characters or not");
  for (const report of [edited(clean), edited(garbled[2]!)]) assert.equal((await upsertMaterial(report)).revised, false);
  assert.equal((await state(first.articleId)).revision, 2);
});
