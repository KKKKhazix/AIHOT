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
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { serverModules } from "@aihot/backend/modules";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { translateEnglish } from "@aihot/backend/editorial/english";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { copyKey, englishOf, report as englishReport, wantedIn } from "@aihot/backend/publication/english";
import { cardText } from "@aihot/backend/media/og";
import { posterText } from "@aihot/backend/media/poster";
import { loadItemOgCard, loadItemPoster } from "@aihot/backend/publication/og";
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
/** v1 in English also keeps a source's stored name, which programs filter and fingerprint by. */
const AS_STORED = new Set([...AS_WRITTEN, "source", "sourceNames"]);
function chinese(value: unknown, path = "$", keep = AS_WRITTEN): string[] {
  if (typeof value === "string") return HAN.test(value) ? [`${path}: ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => chinese(v, `${path}[${i}]`, keep));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => (keep.has(k) ? [] : chinese(v, `${path}.${k}`, keep)));
  return [];
}
const hanIn = (text: string) => text.match(new RegExp(`${HAN.source}+`, "g")) ?? [];
const text = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res.body;
};

/** An MCP tool's answer (stateless, one request), by its full name. */
async function tool(name: string, args: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/api/mcp", headers: {
    host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name,
  }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name, arguments: args,
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
  } } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.headers["content-type"]?.startsWith("text/event-stream") ? JSON.parse(res.body.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) : res.json();
  assert.ok(body.result, JSON.stringify(body).slice(0, 600));
  return body.result as { content: Array<{ text: string }>; structuredContent: Record<string, any>; isError?: boolean };
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

const v1English = () => [
  "/api/v1/items?lang=en", "/api/v1/items?mode=all&window=24h&lang=en", "/api/v1/hot-topics?lang=en", `/api/v1/stories/${site.story}?lang=en`,
  "/api/v1/dailies?lang=en", "/api/v1/dailies/2099-01-02?lang=en", "/api/v1/weeklies?lang=en", "/api/v1/weeklies/2099-W01?lang=en",
  "/api/v1/monthlies?lang=en", "/api/v1/monthlies/2099-01?lang=en",
];
const agentEnglish = () => [
  "/api/v1/agent?lang=en", "/api/v1/agent/latest?window=7d&lang=en", `/api/v1/agent/search?q=${T}&lang=en`, "/api/v1/agent/hot?lang=en",
  `/api/v1/agent/stories/${site.story}?lang=en`, "/api/v1/agent/daily/2099-01-02?lang=en", "/api/v1/agent/weekly/2099-W01?lang=en", "/api/v1/agent/monthly/2099-01?lang=en",
];

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
  for (const url of ["/api/site/en/timeline", "/en/feed.xml", "/en/feed/daily.xml", "/og/en/site.png"]) assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url);
  for (const url of ["/api/v1/items?lang=en", "/api/v1/agent/hot?lang=en"]) assert.equal((await app.inject({ method: "GET", url })).statusCode, 400, `${url}: no lang to take`);
  assert.deepEqual(await translateEnglish(), { stored: 0, failed: 0, calls: 0 });
});

test("once the worker has run, English answers carry no Chinese the site wrote, and Chinese answers are unchanged", { skip: ENGLISH === null }, async () => {
  const chineseBefore = await get("/api/site/timeline");
  const reportBefore = await get("/api/site/reports/weekly/2099-W01");
  const totals = await translateEnglish(RUN);
  assert.ok(totals.stored > 0 && totals.failed === 0, JSON.stringify(totals));
  for (const url of englishAnswers()) assert.deepEqual(chinese(await get(url)), [], url);
  // v1 and the Agent answers in English read what the pages read, so the worker has translated all of it.
  for (const url of v1English()) assert.deepEqual(chinese(await get(url), "$", AS_STORED), [], url);
  for (const url of agentEnglish()) assert.deepEqual(hanIn(await text(url)), [], url);

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

  const releases = (await get("/api/site/changelog")).releases;
  const translated = (await get("/api/site/en/changelog")).releases;
  assert.deepEqual(translated.map((r: { id: string }) => r.id), releases.map((r: { id: string }) => r.id));
  for (const [i, r] of releases.entries()) {
    assert.equal(translated[i].kind, r.kind);
    assert.equal(translated[i].title, HAN.test(r.title) ? english(r.title) : r.title);
    assert.equal(translated[i].body.length, r.body.length);
    assert.deepEqual(hanIn(JSON.stringify([translated[i].body, translated[i].feature])), []);
  }

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

test("an English feed lists only what reads in English, links to the English pages and carries the original text, never Chinese", { skip: ENGLISH === null }, async () => {
  // Two sources that allow republishing: one writes in English, the other in Chinese.
  const wire = await source(`English Wire ${T}`, { fulltext: true });
  const zhWire = await source(`中文转载媒体${T}`, { fulltext: true });
  await sql`UPDATE sources SET syndicate_fulltext = true WHERE id IN (${wire}, ${zhWire})`;
  const original = await report(wire, { title: `己公司发布年度报告${T}`, summary: "己公司发布了年度报告。", reason: "年度报告值得一读。", original: `Ji Corp publishes its annual report ${T}`, body: `The annual report is out, ${T}.` });
  const zhOriginal = await report(zhWire, { title: `庚公司发布新芯片${T}`, summary: "庚公司发布了新芯片。", reason: "新芯片值得关注。", body: `庚公司的芯片正文${T}。` });
  const left = await report(await source(`Example Feed ${T}`), { title: `戊公司的消息${T}`, summary: `戊公司的摘要总被漏掉${T}。`, reason: "戊公司的理由。" });
  // Declared English, written in Chinese: its body is not carried in English either.
  const mislabelled = await report(zhWire, { title: `壬公司发布新服务${T}`, summary: "壬公司发布了新服务。", reason: "新服务值得关注。", original: `Ren Corp ships a service ${T}`, body: `这篇正文登记成英文，其实是中文写的${T}。` });
  await translateEnglish(RUN);
  // An issue whose lead is in English while one entry is not yet: it enters without that entry.
  const lead = { title: `次日头条：己公司发布年度报告${T}`, leadParagraph: "己公司的年度报告是这一天最受关注的发布。" };
  const later = (itemId: string, title: string) => ({ itemId, title, summary: "", sourceId: wire, sourceName: `English Wire ${T}`, sourceUrl: "https://example.com/x", firstParty: false, role: "媒体" });
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at) VALUES ('daily', '2099-01-03', now(), now(), ${sql.json({
    lead, highlights: [], flashes: [], metrics: { totalEvents: 2 },
    sections: [{ key: "ai-models", label: "模型发布/更新", items: [later(original, `己公司发布年度报告${T}`), later(zhOriginal, `目录里总被漏掉的条目${T}`)] }],
  } as never)}, now())`;
  for (const [zh, kind] of [[lead.title, "headline"], [lead.leadParagraph, "text"]]) {
    await sql`INSERT INTO english_copy (zh_hash, zh, kind, en) VALUES (${copyKey(zh!)}, ${zh!}, ${kind!}, ${english(zh!)})`;
  }
  const read = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    assert.match(String(res.headers["content-type"]), /application\/rss\+xml/);
    return res.body;
  };
  const feeds = Object.fromEntries(await Promise.all(["/feed.xml", "/feed/full.xml", "/feed/all.xml", "/feed/daily.xml", "/feed/weekly.xml", "/feed/monthly.xml", "/feed/category/ai-models.xml"]
    .map(async (path) => [path, await read(`/en${path}`)] as const)));
  for (const [path, xml] of Object.entries(feeds)) {
    assert.match(xml, /<language>en<\/language>/, path);
    assert.deepEqual(xml.match(new RegExp(`${HAN.source}+`, "g")) ?? [], [], `${path} carries no Chinese`);
  }
  const full = feeds["/feed/full.xml"]!;
  assert.ok(full.includes(`/en/items/${original}`) && full.includes(english(`己公司发布年度报告${T}`)), "an article in English, linking to its English page");
  assert.ok(full.includes(`The annual report is out, ${T}.`), "the full feed carries the original text");
  assert.ok(full.includes(`/en/items/${zhOriginal}`) && (await app.inject({ method: "GET", url: "/feed/full.xml" })).body.includes(`庚公司的芯片正文${T}。`), "a body written in Chinese is carried in the Chinese feed only");
  assert.ok(!feeds["/feed/all.xml"]!.includes(`/items/${left}`) && (await app.inject({ method: "GET", url: "/feed/all.xml" })).body.includes(`/items/${left}`), "an article still in Chinese is left out");
  const item = (xml: string, id: string) => xml.split("<item>").find((x) => x.includes(`/items/${id}<`)) ?? "";
  assert.ok(item(full, mislabelled) && !item(full, mislabelled).includes("content:encoded"), "a body declared English but written in Chinese is not carried");
  const daily = feeds["/feed/daily.xml"]!;
  assert.ok(daily.includes("/en/daily/2099-01-02") && daily.includes(`/en/items/${site.a}`), "an issue links to its English page and its entries' English pages");
  assert.ok(daily.includes(english("今日头条：甲公司发布新模型")), "its headline in English");
  const issue = daily.split("<item>").find((x) => x.includes("/en/daily/2099-01-03<")) ?? "";
  assert.ok(issue.includes(`/en/items/${original}"`) && !issue.includes(`/items/${zhOriginal}"`), "an entry still in Chinese waits; the issue does not");
  assert.ok((await app.inject({ method: "GET", url: "/feed/daily.xml" })).body.includes(`目录里总被漏掉的条目${T}`));
});

test("v1, the Agent addresses and the MCP tools in English: English pages, the next step asked in English, the stored source names; the sync and the modules take no lang", { skip: ENGLISH === null }, async () => {
  const items = (await get("/api/v1/items?lang=en")).items as Array<Record<string, any>>;
  const zhItems = (await get("/api/v1/items")).items as Array<Record<string, any>>;
  assert.ok(items.length > 0 && items.every((i) => i.links.aihot.includes("/en/items/")), "items link to their English pages");
  assert.deepEqual(items.map((i) => [i.id, i.links.original, i.source.name]), zhItems.map((i) => [i.id, i.links.original, i.source.name]), "the same items, originals and stored source names");
  assert.ok(zhItems.every((i) => !i.links.aihot.includes("/en/")), "the Chinese answer is as it was");
  const story = (await get(`/api/v1/stories/${site.story}?lang=en`)).story;
  assert.ok(story.links.aihot.endsWith(`/en/story/${site.story}`));
  assert.ok([...story.storyline, ...story.related].every((n: any) => n.links.api.endsWith("?lang=en")), "a related story's address asks in English");
  const hot = await text("/api/v1/agent/hot?lang=en");
  assert.match(hot, new RegExp(`/api/v1/agent/stories/${site.story}\\?lang=en`), "the next step asks in English");
  assert.ok(!hot.includes(`${new URL(zhItems[0]!.links.aihot).origin}/items/`), "pages linked in English");
  for (const url of ["/api/v1/hot-topics?lang=fr", "/api/v1/dailies?lang=fr", "/api/v1/weeklies?lang=fr", "/api/v1/agent/hot?lang=fr"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 400, url);
  }
  const guide = await text("/api/v1/agent");
  assert.ok(guide.includes("lang=en"), "the Chinese guide tells installed agents about English");
  const origin = new URL(zhItems[0]!.links.aihot).origin;
  const guideEn = await text("/api/v1/agent?lang=en");
  assert.ok(guideEn.includes(`(${origin}/en)`) && guideEn.includes(`give ${origin}/en.`), "the English guide sends readers to the English home");
  const ability = serverModules().flatMap((m) => m.agent?.abilities ?? [])[0];
  for (const url of ["/api/v1/items?lang=fr", "/api/v1/selected/snapshot?lang=en", ...(ability ? [`/api/v1/agent${ability.path}?lang=en`] : [])]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 400, url);
  }
  const mcp = await tool(MCP_TOOL_NAMES.hot, { lang: "en" });
  assert.deepEqual(hanIn(mcp.content[0]!.text), [], "the tool's text in English");
  assert.match(mcp.content[0]!.text, new RegExp(`public_id=${site.story}, lang="en"`), "the next tool call asks in English too");
  assert.match((await tool(MCP_TOOL_NAMES.daily, { date: "2099-01-02", lang: "en" })).content[0]!.text, /pass date=YYYY-MM-DD, lang="en"/);
  const top = mcp.structuredContent.items[0];
  assert.ok(top.links.aihot.includes("/en/"), "its JSON links the English pages");
  assert.deepEqual(top.sourceNames, (await get("/api/v1/hot-topics")).items[0].sourceNames, "and keeps the stored source names");
  assert.ok(HAN.test((await tool(MCP_TOOL_NAMES.hot, {})).content[0]!.text), "without lang it answers in Chinese");
});

test("the English pages' share images: articles, posters, issues, events, topics and pages in English, the Chinese ones as they were", { skip: ENGLISH === null }, async () => {
  const get = (url: string) => app.inject({ method: "GET", url });
  const card = await loadItemOgCard(site.a, "en");
  assert.deepEqual(hanIn(JSON.stringify([card, cardText(card!)])), [], "an article's English card says nothing in Chinese, as drawn too");
  assert.equal(card!.badge?.label, "AI score");
  const poster = await loadItemPoster(site.a, "en");
  assert.ok(poster!.url.endsWith(`/en/items/${site.a}`), "its poster's code opens the English page");
  assert.deepEqual(hanIn(JSON.stringify(posterText(poster!))), [], "and every word drawn on the poster is English");
  assert.equal(posterText((await loadItemPoster(site.a))!).scan, "长按识别二维码", "the Chinese poster is as it was");
  const zhCard = await loadItemOgCard(site.a);
  assert.ok(HAN.test(zhCard!.title) && !("lang" in zhCard!), "its Chinese card is as it was");
  const pages = ["/site.png", "/pages/topics.png", ...Object.keys(ENGLISH!.cards).map((name) => `/pages/${name}.png`)];
  for (const path of [`/items/${site.a}.png`, `/posters/${site.a}.png`, "/reports/daily/2099-01-02.png", "/reports/weekly/2099-W01.png", "/reports/monthly/2099-01.png", `/stories/${site.story}.png`, "/topics/model-releases.png", ...pages]) {
    const [en, zh] = [await get(`/og/en${path}`), await get(`/og${path}`)];
    assert.equal(en.statusCode, 200, path);
    assert.equal(en.headers["content-type"], "image/png", path);
    assert.notEqual(en.headers.etag, zh.headers.etag, `${path}: a card of its own`);
    assert.equal(en.headers["cache-control"], zh.headers["cache-control"], `${path}: its words are in English, so it keeps as long as the Chinese one`);
  }
  assert.equal((await get("/og/en/pages/free-tokens.png")).statusCode, 404, "a page with no English edition has no English card");
  // An article whose words are not in English yet is kept a minute, so its card turns English soon after they are.
  const waiting = await report(await source(`等待翻译的媒体${T}`), { title: `还没翻译的报道${T}`, summary: "还没有英文的摘要。", reason: "还没有英文的理由。" });
  for (const path of [`/og/en/items/${waiting}.png`, `/og/en/posters/${waiting}.png`]) {
    const res = await get(path);
    assert.equal(res.statusCode, 200, path);
    assert.match(String(res.headers["cache-control"]), /max-age=60,/, path);
  }
  const [merged] = await sql<{ public_id: string }[]>`
    INSERT INTO stories (public_id, title, merged_into) SELECT gen_random_uuid(), ${`并入的事件${T}`}, id FROM stories WHERE public_id = ${site.story}::uuid RETURNING public_id::text`;
  const moved = await get(`/og/en/stories/${merged!.public_id}.png`);
  assert.equal(moved.statusCode, 308);
  assert.equal(moved.headers.location, `/og/en/stories/${site.story}.png`, "a merged event's English card leads to the English one");
});

test("both searches and public clients match the translated wording, including words split across fields", { skip: ENGLISH === null }, async () => {
  const title = "编辑介绍了协作办法";
  const summary = "多款模型可以一起工作。";
  const id = await report(await source("Example Wire"), { title, summary, reason: "这有新意。" });
  for (const [zh, en, kind] of [[title, "Editor shares a method", "headline"], [summary, "For coordinating several models", "text"]] as const) {
    await sql`INSERT INTO english_copy (zh_hash, zh, kind, en, original_of) VALUES (${copyKey(zh)}, ${zh}, ${kind}, ${en}, ${id})`;
  }
  const query = new URLSearchParams({ q: "editor shares a method for coordinating" });
  for (const base of ["/api/site/pool", "/api/site/en/pool"]) {
    for (const tab of ["time", "relevance"]) {
      const result = await get(`${base}?${query}&tab=${tab}`);
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, id);
    }
  }
  for (const lang of ["zh", "en"]) assert.equal((await get(`/api/v1/items?mode=all&${query}&lang=${lang}`)).items[0].id, id);
  assert.equal((await get("/api/site/en/pool?q=coordinating&tab=relevance")).items[0].id, id);
  for (const [prefix, expected] of [["", [title, summary]], ["/en", ["Editor shares a method", "For coordinating several models"]]] as const) {
    const current = (await get(`/api/site${prefix}/items/availability?ids=${id}`))[id];
    assert.deepEqual([current.title, current.summary], expected);
  }
  await sql`UPDATE publications SET suppress_original = true WHERE article_id = ${id}`;
  assert.equal((await get("/api/site/en/pool?q=coordinating+models")).total, 0);
  assert.deepEqual((await get("/api/v1/items?mode=all&q=coordinating+models&lang=en")).items, []);
});
