// 真实发布路径配合可控时钟，保证主题统计、分页和缓存都在同一发布边界切换。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage } from "@aihot/backend/publication/topics";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `topic-release-${T}`;
const START = Math.floor(Date.now() / 1000) * 1000;
const RELEASE = START + 180_000;
const DAY = 86_400_000;
const app = await buildApp();
const slug = (name: string) => `${T}-${name}`;
const ids: string[] = [];
after(async () => {
  await app.close();
  if (ids.length) {
    await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ANY(${ids}::text[])`;
    await sql`DELETE FROM selected_ledger WHERE article_id = ANY(${ids}::text[])`;
    await sql`DELETE FROM articles WHERE id = ANY(${ids}::text[])`;
  }
  await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  await sql`DELETE FROM topics WHERE slug LIKE ${T + '-%'}`;
  await stopBoss();
  await closeDb();
});
async function article(name: string, tags: string[], timeline: number, pending = false) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.test/${T}/${name}`, title: `原文 ${name}`, bodyText: "测试正文", bodyStatus: "ok", via: "fetch", publishedAt: new Date(timeline), discoveredAt: new Date(timeline) });
  ids.push(articleId);
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected,tags)
    VALUES (${articleId},1,'rule','pass','ai-models',${`标题 ${name}`},'测试摘要','理由',90,true,${tags})`;
  await publishArticle(articleId, pending ? {} : { releasedAt: new Date(START - DAY) });
  return articleId;
}
const get = (url: string, etag?: string) => app.inject({ method: "GET", url, headers: etag ? { "if-none-match": etag } : {} });
const topic = (data: any, name: string) => data.topics.find((entry: any) => entry.slug === slug(name));
function bounded(headers: Record<string, unknown>, deadline: number) {
  const cc = String(headers["cache-control"]);
  assert.doesNotMatch(cc, /stale/);
  const expires = String(headers["x-accel-expires"]);
  assert.ok(expires === "0" || (expires.startsWith("@") && Number(expires.slice(1)) * 1000 <= deadline), expires);
  for (const [, seconds] of cc.matchAll(/(?:^|[, ])(?:max-age|s-maxage)=(\d+)/g)) assert.ok(Date.now() + Number(seconds) * 1000 <= deadline);
}

test("主题的真实发布、统计和缓存共享时间门槛", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  assert.equal(config.selectedVisibleAfterSeconds, 180, "保留默认三分钟发布延迟");
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${SOURCE},'主题测试','rss','T1','editorial','2100-01-01')`;
  for (const name of ["page", "index", "recent", "fifty", "excluded", "entity", "empty"]) {
    await sql`INSERT INTO topics(slug,name,grp,entity_id,tags,definition,related,position)
      VALUES(${slug(name)},${name},${name === "entity" ? "company" : "field"},${name === "entity" ? T : null},${[slug(name), slug(name) + "-alias"]},'测试主题',${[]},1000)`;
  }
  for (const [name, size] of [["page", 20], ["index", 19], ["recent", 19], ["fifty", 50]] as const) {
    for (let i = 0; i < size; i++) await article(`${name}-${i}`, [slug(name), slug(name) + "-alias"], START - (name === "recent" || name === "fifty" ? 31 * DAY : DAY) - i * 1000);
  }
  const pending = await article("pending-page", [slug("page")], START, true);
  await article("pending-index", [slug("index")], START, true);
  await article("last-recent", [slug("recent")], RELEASE - 30 * DAY);
  await article("entity-subject", [`entity:${T}`, slug("entity")], START - DAY);
  await article("entity-mention", [slug("entity")], START - DAY);
  for (const kind of ["public", "summary-only", "withdrawn", "unselected", "null-release"]) {
    const id = await article(`exclude-${kind}`, [slug("excluded")], START - DAY);
    if (kind === "unselected") await sql`UPDATE publications SET selected=false WHERE article_id=${id}`;
    else if (kind === "null-release") await sql`UPDATE publications SET visible_after=NULL WHERE article_id=${id}`;
    else await sql`UPDATE publications SET visibility=${kind} WHERE article_id=${id}`;
  }
  const [saved] = await sql`SELECT visible_after FROM publications WHERE article_id=${pending}`;
  assert.equal(saved!.visible_after.getTime(), RELEASE);
  t.mock.timers.setTime(RELEASE - 10_000);
  const beforeDirectory = await get("/api/site/topics");
  const beforeSitemap = await get("/sitemap.xml");
  const beforePage = await get(`/api/site/topics/${slug("page")}`);

  await t.test("发布前不提前计数、索引或产生空分页", async () => {
    assert.equal(beforeDirectory.statusCode, 200);
    const directory = beforeDirectory.json();
    assert.deepEqual([topic(directory, "page").total, topic(directory, "page").recent], [20, 20]);
    assert.deepEqual([topic(directory, "index").total, topic(directory, "index").indexable], [19, false]);
    assert.equal(topic(directory, "page").latestAt, new Date(START - DAY).toISOString());
    const page = beforePage.json();
    assert.deepEqual([page.topic.total, page.pageCount, page.items.length], [20, 1, 20]);
    assert.ok(!page.items.some((i: any) => i.id === pending));
    const missing = await get(`/api/site/topics/${slug("page")}?page=2`);
    assert.equal(missing.statusCode, 404);
    assert.match(String(missing.headers["cache-control"]), /no-store|no-cache/);
    assert.ok(!beforeSitemap.body.includes(`/topics/${slug("page")}/page/2`));
    assert.ok(!beforeSitemap.body.includes(`/topics/${slug("index")}</loc>`));
    const entry = beforeSitemap.body.split("<url>").find(value => value.includes(`/topics/${slug("page")}</loc>`))!;
    assert.ok(entry.includes(`<lastmod>${new Date(START - DAY).toISOString()}</lastmod>`));
  });

  await t.test("分类、重复标签、主体标签和非法页码保留原语义", async () => {
    const directory = beforeDirectory.json();
    assert.equal(topic(directory, "excluded").total, 1);
    assert.equal(topic(directory, "entity").total, 1);
    for (const page of [0, -1, 1.5, NaN]) assert.equal(await loadTopicPage(slug("page"), page, new Date(RELEASE - 1)), null);
    const empty = await loadTopicPage(slug("empty"), 1, new Date(RELEASE - 1));
    assert.deepEqual([empty!.topic.total, empty!.pageCount, empty!.items.length], [0, 1, 0]);
  });

  await t.test("预热响应及304的各层缓存截止不晚于发布时刻", async () => {
    for (const response of [beforeDirectory, beforePage, beforeSitemap]) bounded(response.headers, RELEASE);
    for (const [url, previous] of [["/api/site/topics", beforeDirectory], [`/api/site/topics/${slug("page")}`, beforePage], ["/sitemap.xml", beforeSitemap]] as const) {
      const notModified = await get(url, String(previous.headers.etag));
      assert.equal(notModified.statusCode, 304);
      bounded(notModified.headers, RELEASE);
    }
  });

  await t.test("固定visible_after在前1毫秒、恰好、后1毫秒一致切换", async () => {
    for (const [at, total] of [[RELEASE - 1, 20], [RELEASE, 21], [RELEASE + 1, 21]]) {
      t.mock.timers.setTime(at!);
      const page = (await get(`/api/site/topics/${slug("page")}`)).json();
      assert.equal(page.topic.total, total);
      assert.equal(page.pageCount, total === 20 ? 1 : 2);
      assert.equal(page.items.some((item: any) => item.id === pending), total === 21);
      const second = await get(`/api/site/topics/${slug("page")}?page=2`);
      assert.equal(second.statusCode, total === 20 ? 404 : 200);
      if (total === 21) assert.equal(second.json().items.length, 1);
    }
  });

  await t.test("发布时首次请求同步刷新目录和sitemap，不沿用旧ETag", async () => {
    t.mock.timers.setTime(RELEASE);
    const directory = await get("/api/site/topics", String(beforeDirectory.headers.etag));
    assert.equal(directory.statusCode, 200);
    assert.equal(topic(directory.json(), "page").total, 21);
    assert.equal(topic(directory.json(), "index").indexable, true);
    const sitemap = await get("/sitemap.xml", String(beforeSitemap.headers.etag));
    assert.equal(sitemap.statusCode, 200);
    assert.ok(sitemap.body.includes(`/topics/${slug("page")}/page/2`));
    assert.ok(sitemap.body.includes(`/topics/${slug("index")}</loc>`));
    const [unchanged] = await sql`SELECT visible_after FROM publications WHERE article_id=${pending}`;
    assert.equal(unchanged!.visible_after.getTime(), RELEASE, "只推进时钟，不改发布数据");
  });

  await t.test("最近30天采用严格边界，50篇不依赖近期文章", async () => {
    t.mock.timers.setTime(RELEASE);
    const directory = (await get("/api/site/topics")).json();
    assert.deepEqual([topic(directory, "recent").total, topic(directory, "recent").recent, topic(directory, "recent").indexable], [20, 0, false]);
    assert.deepEqual([topic(directory, "fifty").total, topic(directory, "fifty").recent, topic(directory, "fifty").indexable], [50, 0, true]);
    const oldTime = await loadTopicPage(slug("page"), 1, new Date(RELEASE - 1));
    assert.equal(oldTime!.topic.total, 20, "显式时间不复用另一个时刻的缓存");
  });

  await t.test("数据库失败时旧sitemap不重新取得新鲜寿命", async () => {
    await get("/sitemap.xml");
    t.mock.timers.setTime(RELEASE + 3_600_001);
    // 仅在专用测试库临时改名，finally恢复；不向产品代码添加失败开关。
    const hidden = `publications_${T}`;
    await sql`ALTER TABLE publications RENAME TO ${sql(hidden)}`;
    try {
      const response = await get("/sitemap.xml");
      assert.ok(response.statusCode === 200 || response.statusCode === 503);
      assert.match(String(response.headers["cache-control"]), /no-cache|no-store/);
      if (response.statusCode === 200) assert.ok(response.body.includes("<urlset"), "保留上次成功文档，不能编造空站点地图");
    } finally {
      await sql`ALTER TABLE ${sql(hidden)} RENAME TO publications`;
    }
  });
});
