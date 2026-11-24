// The English edition (publication/english.ts, editorial/english.ts) over a seeded site. Once the worker has run, no
// /api/site/en answer carries Chinese the site wrote, except what is shown as written (tags, the originals' own words),
// and a body written in Chinese is not sent; the Chinese answers are what they were. An edited text shows its Chinese,
// the whole card with it, until the worker translates it again; English made with an original title is not shown once
// that article is withdrawn or its original withheld, and is made again without it; what readers do not see (a hidden
// reason, an event's stale digest) is never sent; a text the model leaves out goes alone next time while readers still
// see it, and one whose request may have been billed waits for that request's release, then goes alone once more and no
// more; after three attempts it stays Chinese. A source name the site has in English goes with the texts that mention
// it, and a name with nothing to translate reads in English punctuation. Without an English edition (the open source
// site) there are no English routes and the worker does nothing.
import { LOST, pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { ENGLISH } from "@aihot/contracts/english";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { translateEnglish } from "@aihot/backend/editorial/english";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { copyKey, englishOf, report as englishReport, wantedIn } from "@aihot/backend/publication/english";
import { loadReport } from "@aihot/backend/publication/reports";
import { publishArticle } from "@aihot/backend/publication/publish";
import { digestInputsHash, digestReports } from "@aihot/backend/publication/story-evidence";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const english = (zh: string) => `EN ${createHash("sha256").update(zh).digest("hex").slice(0, 12)}`;
// A budget long enough for any request the worker starts.
const RUN = { budgetMs: 10 * 60_000 };

// The model answers every text with its marker, except a text it keeps leaving out, and a request whose answer is
// always lost; each request's texts are kept, and the source names that went with them.
const requests: string[][] = [];
const namesSent: Array<Record<string, string> | undefined> = [];
const provider = await stub(async (_hit, req) => {
  const { texts, names } = JSON.parse(JSON.parse(req.body).messages[1].content) as { texts: Array<{ id: number; zh: string; original?: string }>; names?: Record<string, string> };
  requests.push(texts.map((x) => x.zh));
  namesSent.push(names);
  if (texts.some((x) => x.zh.includes("回答总丢"))) return LOST;
  const t = texts.filter((x) => !x.zh.includes("总被漏掉")).map((x) => ({ id: x.id, en: `${english(x.zh)}${x.original ? " (named after the original)" : ""}` }));
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ t }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
pointModels(provider.url, ["deepseek-flash"]);
const app = await buildApp();

after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return JSON.parse(res.body) as Record<string, any>;
};

/** Where Chinese stays on English pages: filter values, the originals' own words, the site's modules' parts. */
const AS_WRITTEN = new Set(["tags", "tagTopics", "filters", "originalTitle", "author", "x", "modules"]);
function chinese(value: unknown, path = "$"): string[] {
  if (typeof value === "string") return HAN.test(value) ? [`${path}: ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => chinese(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => (AS_WRITTEN.has(k) ? [] : chinese(v, `${path}.${k}`)));
  return [];
}

let n = 0;
async function source(name: string, opts: { tier?: string; fulltext?: boolean } = {}) {
  const id = `en-${T}-${++n}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${id}, ${name}, 'rss', ${opts.tier ?? "T2"}, 'editorial', ${opts.fulltext ?? false}, '2100-01-01')`;
  return id;
}

/** A selected report, in a story's development when one is given, published as the pipeline publishes it. */
async function report(sourceId: string, texts: { title: string; summary: string; reason: string; original?: string; body?: string }, fact?: number) {
  const k = ++n;
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/en-${T}-${k}`, title: texts.original ?? `原文标题${k}`, language: texts.original ? "en" : "zh",
    bodyText: texts.body ?? `正文 ${T} ${k}`, ...(texts.body ? { bodyHtml: `<p>${texts.body}</p>` } : {}), bodyStatus: "ok", via: "fetch",
    publishedAt: new Date(Date.now() - 3_600_000),
  });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,tags,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models',ARRAY['模型发布'],${texts.title},${texts.summary},${texts.reason},88,true)`;
  if (fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact}, ${articleId}, 'primary')`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const site: Record<string, any> = {};

/** Runs the worker once; the source names that went with the request carrying this text. */
async function namesWith(text: string) {
  const from = requests.length;
  await translateEnglish(RUN);
  const at = requests.findIndex((texts, i) => i >= from && texts.includes(text));
  assert.ok(at >= 0, `${text} was sent`);
  return namesSent[at];
}

before(async () => {
  if (!ENGLISH) return;
  const media = await source(`测试媒体${T}`, { tier: "T1" });
  const lab = await source(`Example Labs ${T}`);
  const [story] = await sql<{ id: number; public_id: string }[]>`
    INSERT INTO stories (public_id, title) VALUES (gen_random_uuid(), ${`甲公司新模型事件${T}`}) RETURNING id, public_id::text`;
  const facts: number[] = [];
  for (const i of [1, 2]) {
    const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${i}`}, ${story!.id}, ${`进展${i}：甲公司宣布新模型`}) RETURNING id`;
    facts.push(f!.id);
  }
  const a = await report(media, { title: `甲公司发布新模型${T}`, summary: "甲公司今天发布了新模型，推理速度提升一倍。", reason: "这是今年最重要的发布之一。", original: `Acme releases its new model ${T}` }, facts[0]);
  const b = await report(lab, { title: `乙实验室评测甲公司新模型${T}`, summary: "乙实验室的评测显示新模型在编码上领先。", reason: "独立评测，数据可信。" }, facts[1]);
  const gone = await report(lab, { title: `已撤下的报道${T}`, summary: "这条报道后来撤下了。", reason: "撤下前的理由。" });
  const w = await report(lab, { title: `丁公司发布智能体${T}`, summary: "丁公司发布了新的智能体产品。", reason: "值得关注的产品发布。", original: `Delta ships an agent ${T}` });
  // Written in Chinese, readable in full: the English page does not send that body.
  const zhBody = await report(await source(`中文全文媒体${T}`, { fulltext: true }), { title: `中文原文的报道${T}`, summary: "一篇中文写的报道。", reason: "中文报道的理由。", body: "这是中文写的正文。" });
  // A story stands on its own summary while a current report says it word for word.
  await sql`UPDATE stories SET summary = '甲公司今天发布了新模型，推理速度提升一倍。' WHERE id = ${story!.id}`;
  const now = new Date();
  await sql`INSERT INTO hot_rankings (computed_at, rule_version, entries, published) VALUES (now(), 'test', ${sql.json([{
    rank: 1, storyId: story!.id, storyPublicId: story!.public_id, title: `甲公司新模型事件${T}`, heat: 10, trend: "new", trendPct: null, badges: ["new"],
    participantCount: 2, sourceCount: 2, signalCount: 0, reportCount: 2, sourceNames: [`测试媒体${T}`, `Example Labs ${T}`],
    latestAt: now.toISOString(), firstReportAt: now.toISOString(), representativeItemId: a, representativeUrl: "https://example.com/a", representativeSource: `测试媒体${T}`,
    participants: [{ sourceId: media, name: `测试媒体${T}`, kind: "editorial", tier: "T1" }, { sourceId: lab, name: `Example Labs ${T}`, kind: "editorial", tier: "T2" }],
  }] as never)}, true)`;
  const entry = (itemId: string, title: string, summary: string | null) => ({ itemId, title, summary, sourceId: media, sourceName: `测试媒体${T}`, sourceUrl: "https://example.com/a", firstParty: true, role: "官方" });
  const daily = {
    lead: { title: "今日头条：甲公司发布新模型", leadParagraph: "甲公司的新模型是今天最受关注的发布。" },
    highlights: [a],
    // The second entry was frozen before its report was edited: the issue keeps its own words.
    sections: [{ key: "ai-models", label: "模型发布/更新", items: [entry(a, `甲公司发布新模型${T}`, "甲公司今天发布了新模型，推理速度提升一倍。"), entry(b, "编辑前的旧标题", "编辑前的旧摘要。")] }],
    flashes: [],
    metrics: { totalEvents: 2 },
  };
  // A report it named was withdrawn since: the overview is composed by rule, and English pages say it in English.
  const weekly = {
    headline: "本周头条：甲公司发布新模型", overview: "本周最重要的是甲公司的新模型。",
    themes: [{ key: "ai-models", heading: "新模型密集发布", summary: "这一周有两家公司发布了新模型。", storyRefs: [
      entry(a, `甲公司发布新模型${T}`, "甲公司今天发布了新模型，推理速度提升一倍。"), entry(gone, `已撤下的报道${T}`, "这条报道后来撤下了。"),
      entry(w, `丁公司发布智能体${T}`, "丁公司发布了新的智能体产品。"),
    ] }],
    metrics: { totalStories: 3 },
  };
  const monthly = {
    headline: "本月头条：甲公司发布新模型", overview: "这个月最重要的是甲公司的新模型。",
    themes: [{ key: "ai-models", heading: "本月的模型发布", summary: "这个月的模型发布一览。", storyRefs: [entry(a, `甲公司发布新模型${T}`, "甲公司今天发布了新模型，推理速度提升一倍。")] }],
    metrics: { totalStories: 1 },
  };
  for (const [kind, key, content] of [["daily", "2099-01-02", daily], ["weekly", "2099-W01", weekly], ["monthly", "2099-01", monthly]] as const) {
    await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at) VALUES (${kind}, ${key}, now(), now(), ${sql.json(content as never)}, now())`;
  }
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${gone}`;
  // An event only one source covers (no search page of its own), with a digest that stands: its reports are unchanged.
  const [single] = await sql<{ id: number; public_id: string }[]>`
    INSERT INTO stories (public_id, title) VALUES (gen_random_uuid(), ${`只有一家报道的事件${T}`}) RETURNING id, public_id::text`;
  const [singleFact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-single`}, ${single!.id}, '独家进展') RETURNING id`;
  const only = await report(await source(`独家媒体${T}`), { title: `独家报道${T}`, summary: "独家报道的摘要。", reason: "独家报道的理由。" }, singleFact!.id);
  const digest = "这件事的 AI 综述：只有一家媒体报道。";
  await sql`INSERT INTO story_digests (story_id, version, digest, article_ids, inputs_hash)
            VALUES (${single!.id}, 1, ${digest}, ${[only]}, ${digestInputsHash(await digestReports(sql, [single!.id]))})`;
  await sql`UPDATE stories SET digest = ${digest}, digest_version = 1, digest_updated_at = now() WHERE id = ${single!.id}`;
  Object.assign(site, { a, b, w, zhBody, story: story!.public_id, single: single!.public_id, digest, fact: `f-${T}-1` });
});

const englishAnswers = () => [
  "/api/site/en/timeline", "/api/site/en/pool", "/api/site/en/pool?q=%E7%94%B2%E5%85%AC%E5%8F%B8",
  `/api/site/en/items/${site.a}`, `/api/site/en/items/${site.b}`, `/api/site/en/items/${site.zhBody}`, `/api/site/en/items/availability?ids=${site.a},${site.b}`,
  `/api/site/en/stories/${site.story}`, `/api/site/en/stories/${site.single}`, `/api/site/en/stories/${site.story}/followups`,
  `/api/site/en/groups/${site.fact}/reports`, "/api/site/en/stats",
  "/api/site/en/hot", "/api/site/en/topics", "/api/site/en/topics/model-releases", "/api/site/en/search/suggestions",
  "/api/site/en/reports/daily", "/api/site/en/reports/daily/latest-page", "/api/site/en/reports/daily/2099-01-02",
  "/api/site/en/reports/daily/navigation/2099-01-02", "/api/site/en/reports/daily/months/2099-01",
  "/api/site/en/reports/weekly/latest-page", "/api/site/en/reports/weekly/2099-W01",
  "/api/site/en/reports/monthly", "/api/site/en/reports/monthly/latest-page", "/api/site/en/reports/monthly/2099-01",
];

test("without an English edition there are no English answers and nothing to translate", { skip: ENGLISH !== null }, async () => {
  const res = await app.inject({ method: "GET", url: "/api/site/en/timeline" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(await translateEnglish(), { stored: 0, failed: 0, calls: 0 });
});

test("once the worker has run, English answers carry no Chinese the site wrote, and Chinese answers are unchanged", { skip: ENGLISH === null }, async () => {
  const chineseBefore = await get("/api/site/timeline");
  const reportBefore = await get("/api/site/reports/weekly/2099-W01");
  const totals = await translateEnglish(RUN);
  assert.ok(totals.stored > 0 && totals.failed === 0, JSON.stringify(totals));
  for (const url of englishAnswers()) assert.deepEqual(chinese(await get(url)), [], url);

  const item = await get(`/api/site/en/items/${site.a}`);
  assert.equal(item.title, `${english(`甲公司发布新模型${T}`)} (named after the original)`);
  assert.equal(item.source.name, english(`测试媒体${T}`));
  assert.equal(item.hasTranslation, false);
  const zhBody = await get(`/api/site/en/items/${site.zhBody}`);
  assert.deepEqual([zhBody.body, zhBody.outline], [null, []], "a body written in Chinese is not sent");
  assert.ok((await get(`/api/site/items/${site.zhBody}`)).body?.zh, "the Chinese page reads it");
  const single = await get(`/api/site/en/stories/${site.single}`);
  assert.equal(single.digest, english(site.digest), "an event without a search page of its own reads in English too");
  const weekly = await get("/api/site/en/reports/weekly/2099-W01");
  const named = (zh: string) => `${english(zh)} (named after the original)`;
  assert.equal(weekly.overview, `This week: 2 top stories. The most watched: ${named(`甲公司发布新模型${T}`)}; ${named(`丁公司发布智能体${T}`)}.`, "the composed overview is said in English");
  assert.equal(weekly.lead.leadParagraph, weekly.overview);
  assert.equal(weekly.title, `${(await get("/api/site/reports/weekly/2099-W01")).title.split(" ")[0]} Weekly · 2099-W01`);
  const daily = await get("/api/site/en/reports/daily/2099-01-02");
  assert.equal(daily.sections[0].items[1].title, english("编辑前的旧标题"), "an issue's own frozen words are translated as they stand");
  assert.deepEqual(await get("/api/site/timeline"), chineseBefore, "Chinese answers never read the English");
  assert.deepEqual(await get("/api/site/reports/weekly/2099-W01"), reportBefore);

  const again = await translateEnglish(RUN);
  assert.equal(again.calls, 0, "nothing translated twice");
});

test("an edited text shows its Chinese, its card with it, until it is translated again", { skip: ENGLISH === null }, async () => {
  await sql`UPDATE publications SET title = ${`甲公司发布新模型（更正）${T}`} WHERE article_id = ${site.b}`;
  const card = async () => (await get("/api/site/en/timeline")).cards.map((c: any) => c.item).find((i: any) => i.id === site.b);
  const stale = await card();
  assert.equal(stale.title, `甲公司发布新模型（更正）${T}`);
  assert.equal(stale.summary, "乙实验室的评测显示新模型在编码上领先。", "never half in each language");
  await translateEnglish(RUN);
  const fresh = await card();
  assert.deepEqual([fresh.title, fresh.summary], [english(`甲公司发布新模型（更正）${T}`), english("乙实验室的评测显示新模型在编码上领先。")]);
});

test("English named after an original title is not shown once that original is withheld, and is made again without it", { skip: ENGLISH === null }, async () => {
  const title = `甲公司发布新模型${T}`;
  const [row] = await sql<{ original_of: string | null }[]>`SELECT original_of FROM english_copy WHERE zh = ${title}`;
  assert.equal(row?.original_of, site.a);
  await sql`UPDATE publications SET suppress_original = true, original_title = NULL, body_mode = 'summary', syndicate = false WHERE article_id = ${site.a}`;
  assert.equal((await get(`/api/site/en/items/${site.a}`)).title, title);
  const seen = requests.length;
  await translateEnglish(RUN);
  assert.ok(requests.slice(seen).flat().includes(title), "translated again, without the original");
  assert.equal((await get(`/api/site/en/items/${site.a}`)).title, english(title));
  const [redone] = await sql<{ original_of: string | null }[]>`SELECT original_of FROM english_copy WHERE zh = ${title}`;
  assert.equal(redone?.original_of, null);
});

test("English named after an original title is not shown once that article is withdrawn, and is made again without it", { skip: ENGLISH === null }, async () => {
  const title = `丁公司发布智能体${T}`;
  const [row] = await sql<{ original_of: string | null }[]>`SELECT original_of FROM english_copy WHERE zh = ${title}`;
  assert.equal(row?.original_of, site.w);
  // Withdrawn whole (its original_title kept): the weekly still names it, struck through.
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${site.w}`;
  assert.deepEqual([...(await englishOf([title])).keys()], [], "not used once withdrawn");
  await translateEnglish(RUN);
  const [redone] = await sql<{ original_of: string | null; en: string }[]>`SELECT original_of, en FROM english_copy WHERE zh = ${title}`;
  assert.deepEqual([redone?.original_of, redone?.en], [null, english(title)], "translated again without the original");
  const weekly = await get("/api/site/en/reports/weekly/2099-W01");
  assert.ok(weekly.sections[0].items.some((i: any) => i.title === english(title)));
});

test("a text the model leaves out goes alone next time, and stays Chinese after three attempts", { skip: ENGLISH === null }, async () => {
  const media = await source(`另一家媒体${T}`);
  const id = await report(media, { title: `丙公司的消息${T}`, summary: "这句总被漏掉。", reason: "理由照常翻译。" });
  const sent = () => requests.filter((r) => r.includes("这句总被漏掉。"));
  for (const run of [1, 2, 3]) {
    await translateEnglish(RUN);
    const [row] = await sql<{ failures: number }[]>`SELECT failures FROM english_copy WHERE zh = '这句总被漏掉。'`;
    assert.equal(row?.failures, run);
  }
  assert.equal(sent().length, 3);
  assert.ok(sent()[0]!.length > 1 && sent().slice(1).every((r) => r.length === 1), "first with its card, then alone");
  await translateEnglish(RUN);
  assert.equal(sent().length, 3, "not asked a fourth time");
  assert.equal((await get(`/api/site/en/items/${id}`)).title, `丙公司的消息${T}`, "the page stays Chinese with it");
});

test("a text whose request may have been billed waits for that request's release, then goes alone", { skip: ENGLISH === null }, async () => {
  const media = await source(`又一家媒体${T}`);
  await report(media, { title: `戊公司的消息${T}`, summary: "这句等着放行。", reason: "等放行的理由。" });
  const [receipt] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
    VALUES (${`english-held-${T}`}, 'deepseek', 'deepseek-flash', 'translate_copy_en', 'english:held', 'unknown', '{}', 1) RETURNING id`;
  for (const zh of [`戊公司的消息${T}`, "这句等着放行。", "等放行的理由。"]) {
    await sql`INSERT INTO english_copy (zh_hash, zh, kind, failures, held_by) VALUES (${createHash("sha256").update(zh).digest("hex")}, ${zh}, 'text', 1, ${receipt!.id})`;
  }
  const sent = () => requests.filter((r) => r.includes("这句等着放行。"));
  await translateEnglish(RUN);
  assert.equal(sent().length, 0, "held while the request's outcome is unknown");
  await sql`UPDATE receipts SET status = 'failed' WHERE id = ${receipt!.id}`;
  await translateEnglish(RUN);
  assert.deepEqual(sent(), [["这句等着放行。"]], "released: asked again, alone");
});

test("a text whose answer is lost goes alone once more after its request's release, and is not paid for a third time", { skip: ENGLISH === null }, async () => {
  const media = await source(`丢回答的媒体${T}`);
  const id = await report(media, { title: `己公司的消息${T}`, summary: "这句的回答总丢。", reason: "同一批的理由。" });
  const sent = () => requests.filter((r) => r.includes("这句的回答总丢。"));
  // ops.recover, half an hour on: an unknown request is released once.
  const release = async () => {
    await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE purpose = 'translate_copy_en' AND status = 'unknown'`;
    await autoReleaseUnknownReceipts();
  };
  await translateEnglish(RUN);
  assert.equal(sent().length, 1);
  assert.ok(sent()[0]!.length > 1, "first with its card");
  await translateEnglish(RUN);
  assert.equal(sent().length, 1, "held while its request's outcome is unknown");
  await release();
  await translateEnglish(RUN);
  assert.deepEqual(sent().slice(1), [["这句的回答总丢。"]], "released: asked again, alone");
  await release();
  await translateEnglish(RUN);
  assert.equal(sent().length, 2, "lost again: not asked a third time");
  const card = await get(`/api/site/en/items/${id}`);
  assert.equal(card.title, `己公司的消息${T}`, "the page stays Chinese with it");
  assert.ok(requests.some((r) => r.length === 1 && r[0] === "同一批的理由。"), "the rest of its batch went alone and was translated");
});

test("a reason readers do not see is never sent: a summary-only report's, an unselected one's", { skip: ENGLISH === null }, async () => {
  const media = await source(`只给摘要的媒体${T}`);
  const summaryOnly = await report(media, { title: `仅展示摘要的报道${T}`, summary: "这篇只展示摘要。", reason: "编辑隐藏的理由。" });
  const unselected = await report(media, { title: `落选的报道${T}`, summary: "这篇后来落选了。", reason: "落选后留下的理由。" });
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${summaryOnly}`;
  await sql`UPDATE publications SET selected = false WHERE article_id = ${unselected}`;
  await translateEnglish(RUN);
  const sent = requests.flat();
  assert.ok(!sent.includes("编辑隐藏的理由。") && !sent.includes("落选后留下的理由。"), "hidden reasons stay with us");
  assert.ok(sent.includes("这篇只展示摘要。") && sent.includes("这篇后来落选了。"), "what the pages show is translated");
  const page = await get(`/api/site/en/items/${summaryOnly}`);
  assert.equal(page.title, english(`仅展示摘要的报道${T}`));
  assert.equal(page.reason, null);
});

test("a failed text is asked again only while readers see it", { skip: ENGLISH === null }, async () => {
  const media = await source(`后来撤下的媒体${T}`);
  const gone = await report(media, { title: `后来撤稿的报道${T}`, summary: "撤稿前总被漏掉的摘要。", reason: "撤稿报道的理由。" });
  const hidden = await report(media, { title: `后来只展示摘要的报道${T}`, summary: "后来只展示摘要。", reason: "隐藏前总被漏掉的理由。" });
  const sent = (zh: string) => requests.filter((r) => r.includes(zh)).length;
  await translateEnglish(RUN);
  assert.equal(sent("撤稿前总被漏掉的摘要。"), 1);
  assert.equal(sent("隐藏前总被漏掉的理由。"), 1);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${gone}`;
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${hidden}`;
  await translateEnglish(RUN);
  assert.equal(sent("撤稿前总被漏掉的摘要。"), 1, "withdrawn: not asked again");
  assert.equal(sent("隐藏前总被漏掉的理由。"), 1, "summary-only: its reason is not asked again");
});

test("an event's digest or summary its page does not show is never sent", { skip: ENGLISH === null }, async () => {
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, summary) VALUES (gen_random_uuid(), ${`综述过期的事件${T}`}, '没有报道这样说的事件摘要。') RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-stale`}, ${story!.id}, '综述过期事件的进展') RETURNING id`;
  const only = await report(await source(`综述过期的媒体${T}`), { title: `综述过期事件的报道${T}`, summary: "这件事的报道摘要。", reason: "综述过期事件的理由。" }, fact!.id);
  // Written before its report's words changed: the page leaves it out until it is written again.
  await sql`INSERT INTO story_digests (story_id, version, digest, article_ids, inputs_hash) VALUES (${story!.id}, 1, '报道改写前的综述。', ${[only]}, 'before-the-edit')`;
  await sql`UPDATE stories SET digest = '报道改写前的综述。', digest_version = 1, digest_updated_at = now() WHERE id = ${story!.id}`;
  await translateEnglish(RUN);
  const sent = requests.flat();
  assert.ok(sent.includes(`综述过期的事件${T}`) && sent.includes("综述过期事件的进展"), "what the page shows is translated");
  assert.ok(!sent.includes("报道改写前的综述。") && !sent.includes("没有报道这样说的事件摘要。"), "what it does not show is never sent");
});

test("a text goes to the model with its own article: each title a composed overview names, and words met first without one", { skip: ENGLISH === null }, async () => {
  const wanted = await wantedIn((await loadReport("weekly", "2099-W01"))!, englishReport);
  assert.equal(wanted.get(`甲公司发布新模型${T}`)?.item, site.a, "not the lead's article, nor none");
  assert.equal(wanted.get(`丁公司发布智能体${T}`)?.item, site.w);
  const later = await wantedIn(null, (value, c) => {
    c.one("headline", "先在别处出现的标题", null);
    c.one("headline", "先在别处出现的标题", "item-1");
    return value;
  });
  assert.equal(later.get("先在别处出现的标题")?.item, "item-1", "met again with its article, the article goes along");
});

test("a source name the site has in English goes with the texts that mention it, and only with those", { skip: ENGLISH === null }, async () => {
  const name = `新闻之家${T}`;
  await sql`INSERT INTO english_copy (zh_hash, zh, kind, en) VALUES (${copyKey(name)}, ${name}, 'name', ${`News Home ${T}`})`;
  const mentions = `据${name}报道，丙公司发布了新产品。`;
  await report(await source(`Example Wire ${T}`), { title: `丙公司发布新产品${T}`, summary: mentions, reason: "新产品值得一看。" });
  assert.deepEqual(await namesWith(mentions), { [name]: `News Home ${T}` });
  const other = "丁公司发布了新服务。";
  await report(await source(`Example Post ${T}`), { title: `丁公司发布新服务${T}`, summary: other, reason: "新服务值得一看。" });
  assert.equal(await namesWith(other), undefined, "a request whose texts do not mention it goes without");
});

test("a new source's name is translated before the texts that mention it, so they go with its English", { skip: ENGLISH === null }, async () => {
  const name = `新开的媒体${T}`;
  const mentions = `${name}报道，辛公司发布了新工具。`;
  await report(await source(name), { title: `辛公司发布新工具${T}`, summary: mentions, reason: "新工具值得一看。" });
  assert.deepEqual(await namesWith(mentions), { [name]: english(name) });
});

test("a name with nothing to translate reads in English punctuation on English pages, as written on Chinese ones", { skip: ENGLISH === null }, async () => {
  const id = await report(await source(`Example Wire：AI ${T}`), { title: `丁公司发布新模型${T}`, summary: "丁公司发布了新模型。", reason: "新模型值得一看。" });
  assert.equal((await get(`/api/site/en/items/${id}`)).source.name, `Example Wire: AI ${T}`);
  assert.equal((await get(`/api/site/items/${id}`)).source.name, `Example Wire：AI ${T}`);
});
