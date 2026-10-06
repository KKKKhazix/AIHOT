// The same issue through the website, JSON, Agent answer and RSS. Failure cases: withdrawal
// changes a headline but drops its paragraph in projected indexes/feeds; written historical leads
// keep withdrawn news; citations leak a scheduled selection; missing frozen summaries or corrected
// publication dates differ between readers; discovery claims to list topics it actually omits.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { feedIssues, loadReport, v1Dailies, v1Daily, v1Period, v1Periods } from '@aihot/backend/publication/reports';
import { reportFeed } from '@aihot/backend/publication/feeds';
import { llmsTxt } from '@aihot/backend/publication/llms';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { buildApp } from '../apps/api/src/app.ts';
import type { ReportKind } from '@aihot/contracts/site';

const T = tag();
const source = `report-outlets-${T}`;
const app = await buildApp();
const generatedAt = new Date('2026-09-30T00:00:00Z');
let sequence = 0;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, 'Issue source', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function citation(title: string) {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${T}/${++sequence}`, title,
    bodyText: 'Licensed report fixture', bodyHtml: '<p>Licensed report fixture</p>', bodyStatus: 'ok', via: 'fetch', publishedAt: generatedAt });
  await sql`UPDATE articles SET grouping_status = 'complete' WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${title}, ${`${title} current summary`}, 90, true)`;
  await publishArticle(articleId, { releasedAt: generatedAt });
  return { itemId: articleId, title, summary: `${title} frozen summary`, sourceUrl: `https://example.com/${T}/${sequence}`, sourceName: 'Issue source' };
}

async function issue(kind: ReportKind, key: string, content: Record<string, unknown>) {
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES (${kind}, ${key}, ${generatedAt}, ${generatedAt}, ${sql.json(content as never)}, ${generatedAt}, 'manual')`;
}

async function dailyOutlets(key: string) {
  return {
    site: await loadReport('daily', key),
    v1: (await v1Daily(key))!.report,
    index: (await v1Dailies(50)).items.find((r) => r.date === key)!,
    feed: (await feedIssues('daily', 30)).find((r) => r.key === key)!,
    agent: (await app.inject({ method: 'GET', url: `/api/v1/agent/daily/${key}` })).body,
  };
}

test('withdrawing a named lead preserves the replacement headline and its own frozen paragraph everywhere', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 600_001 });
  const removed = await citation('Withdrawn lead');
  const replacement = await citation('Replacement lead');
  const key = '2096-01-01';
  await issue('daily', key, { leadItemId: removed.itemId, lead: { title: removed.title, leadParagraph: removed.summary },
    highlights: [replacement.itemId], sections: [{ label: 'News', items: [removed, replacement] }] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${removed.itemId}`;
  const outlets = await dailyOutlets(key);
  for (const [name, lead] of Object.entries({ site: outlets.site!.lead, v1: outlets.v1.lead, index: { title: outlets.index.leadTitle, leadParagraph: outlets.index.leadParagraph }, feed: { title: outlets.feed.headline, leadParagraph: outlets.feed.leadParagraph } })) {
    assert.deepEqual(lead, { title: replacement.title, leadParagraph: replacement.summary }, name);
  }
  assert.ok(outlets.agent.includes(replacement.summary));
  assert.ok((await reportFeed('daily')).includes(replacement.summary));
});

test('a historical written daily lead follows withdrawal of the citation it describes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1_200_002 });
  const removed = await citation('历史模型发布与能力升级');
  const replacement = await citation('新的安全工具发布');
  const key = '2096-01-02';
  await issue('daily', key, { lead: { title: removed.title, leadParagraph: removed.summary }, highlights: [replacement.itemId], sections: [{ label: 'News', items: [removed, replacement] }] });
  const before = await v1Daily(key);
  assert.equal(before!.report.lead?.title, removed.title, 'the written lead remains while its citation is public');
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${removed.itemId}`;
  const outlets = await dailyOutlets(key);
  for (const [name, lead] of Object.entries({ site: outlets.site!.lead, v1: outlets.v1.lead, index: { title: outlets.index.leadTitle, leadParagraph: outlets.index.leadParagraph }, feed: { title: outlets.feed.headline, leadParagraph: outlets.feed.leadParagraph } })) {
    assert.deepEqual(lead, { title: replacement.title, leadParagraph: replacement.summary }, name);
  }
  assert.ok(!outlets.agent.includes(removed.title));
});

test('daily, weekly and monthly citations share the public list release boundary', async (t) => {
  for (const [kind, key] of [['daily', '2096-01-03'], ['weekly', '2096-W02'], ['monthly', '2096-01']] as const) {
    await t.test(kind, async () => {
      const pending = await citation(`Not released ${kind}`);
      const visible = await citation(`Released ${kind}`);
      await sql`UPDATE publications SET visible_after = '2100-01-01' WHERE article_id = ${pending.itemId}`;
      await issue(kind, key, { leadItemId: pending.itemId, highlights: [visible.itemId], ...(kind === 'daily'
        ? { lead: { title: pending.title, leadParagraph: pending.summary }, sections: [{ label: 'News', items: [pending, visible] }] }
        : { themes: [{ heading: 'News', storyRefs: [pending, visible] }] }) });
      const site = (await loadReport(kind, key))!;
      assert.equal(site.sections[0]!.items[0]!.available, false, 'website marks the unavailable citation');
      const detail = kind === 'daily' ? (await v1Daily(key))!.report : (await v1Period(kind, key))!.report;
      assert.ok(!JSON.stringify(detail).includes(pending.title), 'v1 omits unreleased citations and replaces the headline');
      const feed = (await feedIssues(kind, 30)).find((r) => r.key === key)!;
      assert.ok(!JSON.stringify(feed).includes(pending.title), 'RSS omits unreleased citations and replaces the headline');
      const agent = await app.inject({ method: 'GET', url: `/api/v1/agent/${kind}/${key}` });
      assert.equal(agent.statusCode, 200);
      assert.ok(!agent.body.includes(pending.title), 'Agent follows the same scope');
    });
  }
});

test('a daily citation without a frozen summary, and a flash with an earlier frozen date, read the same in JSON and website', async () => {
  const entry = await citation('Older report citation');
  const flash = await citation('Flash date');
  const key = '2096-01-04';
  const { summary: _, ...old } = entry;
  await issue('daily', key, { sections: [{ label: 'News', items: [old] }], flashes: [{ ...flash, publishedAt: '2020-01-01T00:00:00Z' }] });
  const site = (await loadReport('daily', key))!;
  const v1 = (await v1Daily(key))!.report;
  assert.equal(site.sections[0]!.items[0]!.summary, `${entry.title} current summary`, 'the current public summary fills the gap');
  assert.equal(v1.sections[0]!.items[0]!.summary, site.sections[0]!.items[0]!.summary);
  assert.equal(new Date(site.flashes[0]!.publishedAt!).toISOString(), generatedAt.toISOString(), 'the corrected publication date');
  assert.equal(v1.flashes[0]!.publishedAt, site.flashes[0]!.publishedAt);
});

test('discovery counts exactly the publicly indexed topics it lists', () => {
  const text = llmsTxt({ hasDailies: false, hasWeekly: false, hasMonthly: false, topics: [{ slug: 'sample', name: 'Example', definition: 'Example topic' }], tools: [],
    modules: { api: [], pace: [], pages: [], topics: [], access: [], usage: [], guideClients: [], ways: [] } });
  assert.match(text, /（1 个主题，下一节逐个列出）/);
});

// A saved overview/section introduction can still repeat the withdrawn citation after the list and
// headline drop it. All three reductions use the same availability decision; intact prose is kept.
// Weekly and monthly prose come from one period path: the full reduction matrix runs on weeklies.
for (const kind of ['weekly', 'monthly'] as const) {
  for (const reduction of kind === 'weekly' ? ['withdrawn', 'summary-only', 'ineligible'] as const : ['withdrawn'] as const) {
    test(`${kind} prose drops unavailable evidence after ${reduction}`, async () => {
      const removed = await citation(`Removed ${kind} ${reduction}`);
      const visible = await citation(`Remaining ${kind} ${reduction}`);
      const n = ['withdrawn', 'summary-only', 'ineligible'].indexOf(reduction) + 10;
      const key = kind === 'weekly' ? `2096-W${n}` : `2095-${String(n - 8).padStart(2, '0')}`;
      const overview = `Overview about ${removed.title}`;
      const introduction = `Introduction about ${removed.title}`;
      await issue(kind, key, { leadItemId: removed.itemId, highlights: [visible.itemId], overview,
        themes: [{ heading: 'Changed section', summary: introduction, storyRefs: [removed, visible] },
          { heading: 'Intact section', summary: 'Intact introduction', storyRefs: [visible] }] });
      assert.equal((await loadReport(kind, key))!.overview, overview, 'unchanged issues retain their own prose');
      if (reduction === 'ineligible') await sql`UPDATE publications SET eligible = false WHERE article_id = ${removed.itemId}`;
      else await sql`UPDATE publications SET visibility = ${reduction} WHERE article_id = ${removed.itemId}`;
      const site = (await loadReport(kind, key))!;
      const v1 = (await v1Period(kind, key))!.report;
      const rss = (await feedIssues(kind, 30)).find((r) => r.key === key)!;
      assert.equal(site.overview, v1.overview);
      assert.equal(rss.leadParagraph, v1.overview);
      assert.ok(!v1.overview?.includes(removed.title), 'withdrawn evidence no longer appears in the overview');
      assert.ok(v1.overview?.includes(visible.title), 'the existing template names the still-public evidence');
      assert.equal(site.sections[0]!.summary, null);
      assert.equal(v1.sections[0]!.summary, null);
      assert.equal(site.sections[1]!.summary, 'Intact introduction');
      assert.equal(v1.sections[1]!.summary, 'Intact introduction');
      const agent = await app.inject({ method: 'GET', url: `/api/v1/agent/${kind}/${key}` });
      assert.ok(!agent.body.includes(removed.title), 'Agent never repeats unavailable evidence through its prose');
    });
  }
}

for (const [kind, key] of [['daily', '2096-01-06'], ['weekly', '2096-W30'], ['monthly', '2096-10']] as const) {
  test(`${kind} imported citations retain the same original link, source and date as the website`, async () => {
    const original = `https://example.com/historical/${kind}/${T}`;
    const old = { itemId: `absent-${kind}-${T}`, title: 'Historical citation', source: { name: 'Historical source' }, links: { original }, publishedAt: '2020-01-01T00:00:00Z' };
    await issue(kind, key, kind === 'daily' ? { sections: [{ label: 'News', items: [old] }] } : { themes: [{ heading: 'News', storyRefs: [old] }] });
    const site = (await loadReport(kind, key))!.sections[0]!.items[0]!;
    const v1 = (kind === 'daily' ? (await v1Daily(key))!.report : (await v1Period(kind, key))!.report).sections[0]!.items[0]!;
    assert.equal(site.sourceUrl, original);
    assert.equal(site.sourceName, 'Historical source');
    assert.equal(v1.links.original, site.sourceUrl);
    assert.equal(v1.source.name, site.sourceName);
    if ('publishedAt' in v1) assert.equal(v1.publishedAt, site.publishedAt);
  });
}


for (const [kind, key] of [['weekly', '2096-W40'], ['monthly', '2096-11']] as const) {
  test(`a historical written ${kind} headline follows withdrawal of its matched citation`, async () => {
    const removed = await citation(`旧版${kind}模型正式发布`);
    const replacement = await citation(`替补${kind}安全系统更新`);
    await issue(kind, key, { ...(kind === 'monthly' ? { title: removed.title } : { headline: removed.title }), overview: `总述：${removed.title}`, highlights: [replacement.itemId],
      themes: [{ heading: 'News', storyRefs: [removed, replacement] }] });
    assert.equal((await v1Period(kind, key))!.report.headline, removed.title);
    await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${removed.itemId}`;
    const site = (await loadReport(kind, key))!;
    const v1 = (await v1Period(kind, key))!.report;
    const feed = (await feedIssues(kind, 30)).find((r) => r.key === key)!;
    const index = (await v1Periods(kind, 50)).items.find((r) => ('week' in r ? r.week : r.month) === key)!;
    for (const title of [site.lead?.title, v1.headline, feed.headline, index.headline]) assert.equal(title, replacement.title);
    assert.equal(site.lead?.leadParagraph, v1.overview);
    if (kind === 'monthly') assert.equal(site.title, replacement.title, 'the page metadata cannot retain the withdrawn headline');
    assert.ok(!JSON.stringify(v1).includes(removed.title));
  });
}


for (const [kind, key] of [['weekly', '2096-W41'], ['monthly', '2096-12']] as const) {
  test(`an unmatched written ${kind} headline cannot restore an unavailable overview`, async () => {
    const removed = await citation('应当撤回的单条证据');
    const title = '本期技术行业综述';
    await issue(kind, key, { headline: title, overview: `不该复述：${removed.title}`,
      themes: [{ heading: 'News', storyRefs: [removed] }] });
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${removed.itemId}`;
    const site = (await loadReport(kind,key))!;
    const v1 = (await v1Period(kind,key))!.report;
    assert.equal(site.overview,v1.overview);
    assert.ok(!site.overview?.includes(removed.title), 'the written overview repeating withdrawn evidence is not shown');
    assert.ok(!site.lead?.leadParagraph.includes(removed.title));
  });
}


test('an expired report index waits for the current withdrawal result',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()+86_400_000});
  const removed=await citation('索引旧头条');
  const replacement=await citation('索引新头条');
  const key='2099-01-01';
  await issue('daily',key,{leadItemId:removed.itemId,lead:{title:removed.title,leadParagraph:removed.summary},highlights:[replacement.itemId],sections:[{label:'News',items:[removed,replacement]}]});
  assert.equal((await v1Dailies(50)).items.find(r=>r.date===key)!.leadTitle,removed.title);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${removed.itemId}`;
  t.mock.timers.tick(60_001);
  assert.equal((await v1Dailies(50)).items.find(r=>r.date===key)!.leadTitle,replacement.title);
});
