// Detail counts must stay equivalent to the directory, including its global clock deadlines.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadTopicDirectory, loadTopicPage, listTopics } from "@aihot/backend/publication/topics";

const T = tag();
const SOURCE = `topic-counts-${T}`;
const DAY = 86_400_000;
const NOW = Date.parse("2026-03-07T12:00:00Z");
const slug = (name: string) => `${T}-${name}`;
const ids: string[] = [];
after(async () => {
  await sql`DELETE FROM articles WHERE source_id=${SOURCE}`;
  await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  await sql`DELETE FROM topics WHERE slug LIKE ${T + '-%'}`;
  await closeDb();
});

async function article(name: string, tags: string[], timeline: number, release = NOW - DAY) {
  const id = `${T}-${name}`;
  ids.push(id);
  const at = new Date(timeline);
  const url = `https://example.test/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${id},${SOURCE},${id},${url},${name},${at},${at})`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,timeline_at,sort_at,selected,visible_after,tags)
    VALUES(${id},${name},'test',${SOURCE},'news',${url},${at},${at},${at},true,${new Date(release)},${tags})`;
  return id;
}

async function equivalent(name: string, at = NOW, page = 1) {
  const now = new Date(at);
  const directory = await loadTopicDirectory(now);
  const expected = directory.topics.find(t => t.slug === slug(name));
  const detail = await loadTopicPage(slug(name), page, now);
  assert.ok(expected);
  assert.ok(detail);
  const { related, ...summary } = detail.topic;
  assert.deepEqual(summary, expected);
  assert.equal(detail.refreshAt, directory.refreshAt);
  assert.equal(detail.pageCount, Math.max(1, Math.ceil(expected.total / 20)));
  assert.equal(detail.page, page);
  return detail;
}

test("topic detail preserves count, metadata and global deadline semantics", async t => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${SOURCE},'Topic count tests','rss','T1','editorial','2100-01-01')`;
  for (const [name, group, entity, tags] of [
    ["field", "field", null, [slug("match"), slug("alias"), slug("match")]],
    ["company", "company", T, [slug("match")]],
    ["genre", "genre", "", [slug("match")]],
    ["empty", "field", null, []],
    ["edited", "field", null, [slug("match")]],
    ["deleted", "field", null, [slug("match")]],
  ] as const) {
    await sql`INSERT INTO topics(slug,name,grp,entity_id,tags,definition,related,position)
      VALUES(${slug(name)},${name},${group},${entity},${[...tags]},${`definition ${name}`},
        ${[slug("empty"), slug("missing"), slug("field"), slug("empty")]},1000)`;
  }
  await listTopics(); // Pin the same catalog metadata snapshot used by existing detail reads.
  for (let i = 0; i < 50; i++) await article(`item-${i}`, [slug("match"), slug("alias"), slug("match")], NOW - (i < 20 ? 1 : 31) * DAY);
  const entity = await article("entity", [`entity:${T}`], NOW - DAY);
  const globalExpiry = NOW + 1000;
  const globalRelease = NOW + 2000;
  await article("global-recent", [slug("unrelated")], globalExpiry - 30 * DAY);
  await article("global-pending", [slug("unrelated")], NOW, globalRelease);
  for (const state of ["withdrawn", "summary-only", "unselected", "null-release"]) {
    const id = await article(state, [slug("match")], NOW - DAY);
    if (state === "unselected") await sql`UPDATE publications SET selected=false WHERE article_id=${id}`;
    else if (state === "null-release") await sql`UPDATE publications SET visible_after=null WHERE article_id=${id}`;
    else await sql`UPDATE publications SET visibility=${state} WHERE article_id=${id}`;
  }

  await t.test("overlap counts once, company subject wins, empty tags and related metadata survive", async () => {
    const field = await equivalent("field");
    assert.deepEqual([field.topic.total, field.topic.recent, field.topic.indexable, field.pageCount], [50, 20, true, 3]);
    assert.deepEqual(field.topic.related, ["empty", "field", "empty"].map(name => ({ slug: slug(name), name })));
    assert.deepEqual(field.items.map(i => i.id), ids.slice(0, 20).sort().reverse());
    const company = await equivalent("company");
    assert.equal(company.topic.total, 1);
    assert.deepEqual(company.items.map(i => i.id), [entity]);
    assert.equal((await equivalent("genre")).topic.total, 50, "empty entity id falls back to tags");
    const empty = await equivalent("empty");
    assert.deepEqual([empty.topic.total, empty.topic.recent, empty.topic.latestAt, empty.items, empty.pageCount], [0, 0, null, [], 1]);
    assert.equal((await equivalent("field", NOW, 3)).items.length, 10);
    for (const page of [0, -1, 1.5, NaN, Infinity, 4]) assert.equal(await loadTopicPage(slug("field"), page, new Date(NOW)), null);
    assert.equal(await loadTopicPage(slug("missing"), 1, new Date(NOW)), null);
  });

  await t.test("unrelated release and recent-window deadlines remain global and exact", async () => {
    for (const [at, deadline] of [[NOW, globalExpiry], [globalExpiry - 1, globalExpiry], [globalExpiry, globalRelease], [globalRelease - 1, globalRelease]]) {
      assert.equal((await equivalent("empty", at)).refreshAt, new Date(deadline!).toISOString());
    }
    await equivalent("field", globalRelease);
    await equivalent("field", globalRelease + 1);
    assert.equal((await equivalent("empty", Date.parse("2200-01-01"))).refreshAt, null);
    assert.equal((await equivalent("field", NOW)).topic.recent, 20, "a historical request does not use a later count");
  });

  await t.test("30-day cutoffs truncate database microseconds like Date and ignore daylight-saving changes", async () => {
    const boundary = await article("micro-boundary", [`entity:${T}`], NOW - 30 * DAY);
    await sql`UPDATE publications SET timeline_at=timeline_at + interval '0.000999 seconds' WHERE article_id=${boundary}`;
    const company = await equivalent("company");
    assert.equal(company.topic.recent, 1, "fractional milliseconds at the cutoff are not newly recent");
    await equivalent("company", NOW - 1);
    await equivalent("company", NOW + 1);
    // Change only this test process's pool; production/database settings stay untouched.
    const connections = await Promise.all(Array.from({ length: Number(process.env.DATABASE_POOL_MAX || 10) }, () => sql.reserve()));
    for (const connection of connections) {
      await connection`SET TIME ZONE 'America/New_York'`;
      connection.release();
    }
    try {
      const [shift] = await sql`SELECT ${new Date(NOW - DAY)}::timestamptz + interval '30 days' AS calendar_deadline`;
      assert.notEqual(shift!.calendar_deadline.getTime(), NOW + 29 * DAY, "fixture crosses a DST transition");
      assert.equal((await equivalent("field", globalRelease)).refreshAt, new Date(NOW + 29 * DAY).toISOString());
    } finally {
      const connections = await Promise.all(Array.from({ length: Number(process.env.DATABASE_POOL_MAX || 10) }, () => sql.reserve()));
      for (const connection of connections) {
        await connection`SET TIME ZONE 'UTC'`;
        connection.release();
      }
    }
  });

  await t.test("fresh count tags retain cached metadata/item semantics during edits and deletion", async () => {
    await sql`UPDATE topics SET name='new name',tags=${[`entity:${T}`]} WHERE slug=${slug("edited")}`;
    const edited = await equivalent("edited");
    assert.equal(edited.topic.name, "edited");
    assert.equal(edited.topic.total, 2);
    assert.equal(edited.items.length, 20, "items retain cached matching tags just as before");
    await sql`DELETE FROM topics WHERE slug=${slug("deleted")}`;
    const deleted = await equivalent("deleted");
    assert.equal(deleted.topic.total, 0);
    assert.equal(deleted.items.length, 20);
  });

  await t.test("indexability and page bounds retain 19/20/21 and 49/50 thresholds", async () => {
    const matching = ids.slice(0, 50);
    await sql`UPDATE publications SET timeline_at=${new Date(NOW - 31 * DAY)} WHERE article_id = ANY(${matching}::text[])`;
    for (const total of [19, 20, 21, 49, 50]) {
      await sql`UPDATE publications SET selected=false WHERE article_id = ANY(${matching}::text[])`;
      await sql`UPDATE publications SET selected=true WHERE article_id = ANY(${matching.slice(0, total)}::text[])`;
      const old = await equivalent("field");
      assert.deepEqual([old.topic.total, old.topic.recent, old.topic.indexable], [total, 0, total >= 50]);
      await sql`UPDATE publications SET timeline_at=${new Date(NOW - DAY)} WHERE article_id=${matching[0]!}`;
      const recent = await equivalent("field");
      assert.deepEqual([recent.topic.total, recent.topic.recent, recent.topic.indexable], [total, 1, total >= 20]);
      await sql`UPDATE publications SET timeline_at=${new Date(NOW - 31 * DAY)} WHERE article_id=${matching[0]!}`;
    }
  });
});
