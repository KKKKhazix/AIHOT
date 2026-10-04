// Failure cases: representation repair buys analysis or changes manual decisions, grouping or receipts;
// appended X Articles, expanded URLs, literal entity text, summaries and translations are decoded blindly;
// stale inputs, another source kind, an inconsistent body or identity are accepted; retries decode twice;
// a failed audit/publication commits only part of the repair; the current revision hash stays stale.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { contentHash, upsertMaterial, type XPostData } from "@aihot/backend/content/materials";
import { xEncodingRepairPlan } from "@aihot/backend/content/x-encoding";
import { normalizeXEncoding, previewXEncodingRepair } from "@aihot/backend/admin/content";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const source = `encoding-${T}`;
let sequence = 0;
before(async () => {
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES(${source},'Encoding repair','x_search','T1','editorial',true,true)`;
  installModules([{ name: "repair-check", on: { articleChanged: async (change, tx) => {
    assert.equal(change.kind, "content", "post text and titles must refresh every public listing");
    await tx`INSERT INTO settings(key,value) VALUES(${`repair-hook:${change.id}`},${tx.json(change)})`;
  } } }]);
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

async function fixture(options: { long?: boolean; customTitle?: boolean } = {}) {
  const tweetId = `${Date.now()}${++sequence}`;
  const post: XPostData = { tweetId, authorName: 'Example', handle: 'example', text: 'Research &amp; development\nLiteral &amp;lt; and <code>\nhttps://example.test/?value=&amp;keep=1',
    quoted: { authorName: 'Quoted', handle: 'quoted', text: 'value &lt; 3 &amp; value &gt; 0', url: 'https://x.com/quoted/status/123' } };
  const article = options.long ? { title: 'A literal &amp; heading', text: 'The long article deliberately writes &amp; and &lt;.' } : null;
  const base = `${post.text}\n\n【引用 @quoted】${post.quoted!.text}`;
  const body = base + (article ? `\n\n# ${article.title}\n\n${article.text}` : '');
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://x.com/example/status/${tweetId}`, identityKey: `x:${tweetId}`,
    title: options.customTitle ? 'An independently edited &amp; title' : 'Research &amp; development', bodyText: body, bodyStatus: 'ok',
    xPost: post, publishedAt: new Date(), via: 'fetch', excerpt: 'Saved excerpt &amp; literal' });
  await sql`UPDATE articles SET x_article=${article ? sql.json(article) : null},processing_state='analyzed',grouping_status='complete',grouped_at=now(),selection_adds_value=true WHERE id=${id}`;
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${`encoding-${id}`},'example','score_article',${`article:${id}`},'completed','{"saved":true}'::jsonb) RETURNING id`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected,receipt_ids)
    VALUES(${id},1,'rule','pass',NULL,'判断摘要 &amp; literal',true,${[receipt!.id]})`;
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason,version,updated_by)
    VALUES(${id},'{"title":"人工标题 &amp; literal","selected":true}'::jsonb,'Keep decision',4,'test')`;
  await sql`INSERT INTO translations(article_id,lang,revision,title,body_text) VALUES(${id},'zh',1,'原有译名 &amp;','原有译文 &amp;')`;
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'Existing story') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title,manual) VALUES(${`encoding-${id}`},${story!.id},'Existing fact',true) RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,manual) VALUES(${fact!.id},${id},'primary',true)`;
  await publishArticle(id);
  return { id, post, article, body };
}

async function retained(id: string) {
  const [row] = await sql`SELECT revision,processing_state,processing_attempts,processing_retry_at,processing_queued_at,grouping_status,
    grouped_at,grouping_receipt_id,selection_adds_value,selection_value_reason,discovered_at,published_at,backfill FROM articles WHERE id=${id}`;
  return { row, analyses: await sql`SELECT * FROM analyses WHERE article_id=${id}`, overrides: await sql`SELECT * FROM editorial_overrides WHERE article_id=${id}`,
    translations: await sql`SELECT * FROM translations WHERE article_id=${id}`, membership: await sql`SELECT * FROM fact_articles WHERE article_id=${id}`,
    receipts: await sql`SELECT * FROM receipts WHERE subject=${`article:${id}`}`, jobs: await sql`SELECT id,name,data FROM pgboss.job ORDER BY id` };
}

test("encoding repair updates only the confirmed post representation and current revision, preserving paid and editorial work", async () => {
  const { id, article } = await fixture({ long: true });
  const before = await retained(id);
  const plan = (await previewXEncodingRepair(id))!;
  assert.equal(plan.changed, true);
  assert.equal(plan.after.title, 'Research & development');
  assert.match(plan.after.body_text!, /Literal &lt; and <code>/);
  assert.match(plan.after.body_text!, /https:\/\/example.test\/\?value=&amp;keep=1/);
  assert.ok(plan.after.body_text!.endsWith(`# ${article!.title}\n\n${article!.text}`), 'long-form text is preserved byte for byte');
  const result = await normalizeXEncoding(id, { version: plan.version, hash: plan.hash, requestId: `repair-${id}`, reason: 'Confirmed provider escaping' }, 'test');
  assert.equal(result.status, 'repaired');
  assert.deepEqual(await retained(id), before);
  const [saved] = await sql`SELECT title,body_text,content_hash,x_post,x_article,excerpt FROM articles WHERE id=${id}`;
  assert.equal(saved!.body_text, plan.after.body_text);
  assert.equal(saved!.x_post.quoted.text, 'value < 3 & value > 0');
  assert.deepEqual(saved!.x_article, article);
  assert.equal(saved!.excerpt, 'Saved excerpt &amp; literal');
  assert.equal(saved!.content_hash, contentHash({ title: saved!.title, bodyText: saved!.body_text, excerpt: saved!.excerpt }));
  const [revision] = await sql`SELECT title,body_text,content_hash FROM article_revisions WHERE article_id=${id} AND revision=1`;
  assert.deepEqual([revision!.title, revision!.body_text, revision!.content_hash], [saved!.title, saved!.body_text, saved!.content_hash]);
  const [published] = await sql`SELECT selected,title,original_title FROM publications WHERE article_id=${id}`;
  assert.equal(published!.selected, true);
  assert.equal(published!.title, '人工标题 &amp; literal');
  assert.equal(published!.original_title, 'Research & development');
  const [search] = await sql`SELECT body FROM pool_search WHERE article_id=${id}`;
  assert.match(search!.body, /research & development/);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key=${`repair-hook:${id}`}`).length, 1);
});

test("the audited command is idempotent and cannot decode a literal entity a second time", async () => {
  const { id } = await fixture({ customTitle: true });
  const plan = (await previewXEncodingRepair(id))!;
  assert.equal(plan.after.title, 'An independently edited &amp; title');
  const input = { version: plan.version, hash: plan.hash, requestId: `repair-${id}`, reason: 'Confirmed provider escaping' };
  const first = await normalizeXEncoding(id, input, 'test');
  const state = await sql`SELECT title,body_text,content_hash FROM articles WHERE id=${id}`;
  assert.deepEqual(await normalizeXEncoding(id, input, 'test'), first);
  assert.equal((await normalizeXEncoding(id, { ...input, requestId: `other-${id}` }, 'another-operator')).status, 'already-normalized');
  assert.deepEqual(await sql`SELECT title,body_text,content_hash FROM articles WHERE id=${id}`, state);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${id}`} AND action='content.normalize-x-encoding'`).length, 1);
});

test("stale material and unproved text shapes are refused instead of being rewritten", async () => {
  const { id } = await fixture();
  const plan = (await previewXEncodingRepair(id))!;
  await assert.rejects(normalizeXEncoding(id, { version: plan.version + 1, hash: plan.hash, requestId: `stale-${id}`, reason: 'Stale' }, 'test'), /changed|修改|版本/i);
  await sql`UPDATE articles SET x_post=jsonb_set(x_post,'{text}','"Changed text"'::jsonb) WHERE id=${id}`;
  await assert.rejects(normalizeXEncoding(id, { version: plan.version, hash: plan.hash, requestId: `stale-${id}`, reason: 'Stale' }, 'test'), /changed|修改|版本/i);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${id}`} AND action='content.normalize-x-encoding'`).length, 0);
  const [row] = await sql`SELECT a.*,s.kind FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${id}`;
  assert.throws(() => xEncodingRepairPlan({ ...row, kind: 'rss' } as never), /X|provider|来源/);
  assert.throws(() => xEncodingRepairPlan({ ...row, identity_key: 'x:wrong' } as never), /identity|身份/);
  assert.throws(() => xEncodingRepairPlan(row as never), /body|正文/);
});

test("an audit failure rolls back material, current revision, projection and cache work together", async () => {
  const { id } = await fixture();
  const plan = (await previewXEncodingRepair(id))!;
  const before = {
    article: await sql`SELECT * FROM articles WHERE id=${id}`,
    revision: await sql`SELECT * FROM article_revisions WHERE article_id=${id}`,
    published: await sql`SELECT * FROM publications WHERE article_id=${id}`,
    ledger: await sql`SELECT * FROM selected_ledger WHERE article_id=${id}`,
  };
  await sql.unsafe(`CREATE FUNCTION refuse_encoding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor='refuse-encoding' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe('CREATE TRIGGER refuse_encoding_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_encoding_audit()');
  try {
    await assert.rejects(normalizeXEncoding(id, { version: plan.version, hash: plan.hash, requestId: `repair-${id}`, reason: 'Confirmed escaping' }, 'refuse-encoding'), /audit unavailable/);
    assert.deepEqual({ article: await sql`SELECT * FROM articles WHERE id=${id}`, revision: await sql`SELECT * FROM article_revisions WHERE article_id=${id}`,
      published: await sql`SELECT * FROM publications WHERE article_id=${id}`, ledger: await sql`SELECT * FROM selected_ledger WHERE article_id=${id}` }, before);
    assert.equal((await sql`SELECT 1 FROM settings WHERE key=${`repair-hook:${id}`}`).length, 0);
  } finally {
    await sql.unsafe('DROP TRIGGER refuse_encoding_audit ON audit_log');
    await sql.unsafe('DROP FUNCTION refuse_encoding_audit()');
  }
});
