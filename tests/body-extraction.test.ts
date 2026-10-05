// Optional rules must not replace a usable native body on failure, trigger extra paid reads, or
// diverge between metadata recovery and the extraction worker. Local pages cover those boundaries.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, extractFromUrl, readable } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sanitizeBody, trimTrailingChrome } from "@aihot/backend/content/sanitize";
import { stripTags } from "@aihot/backend/lib/text";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { createSource, previewSource, updateSource } from "@aihot/backend/admin/sources";
import { assertSupportedConfig, UnsupportedConfig, unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchDetail } from "@aihot/backend/sources/web-list";

const T = tag();
const prose = "The article explains the research methods, results and limitations, with original evidence for its conclusions. ".repeat(6).trim();
const noise = "Newsletter module noise repeated between the article's paragraphs. ".repeat(6);
const date = "2026-10-01 09:30:00";
const fragment = `<p>${prose}</p><div class="newsletter"><p>${noise}</p><img src="/newsletter.jpg"></div>` +
  `<ul><li>First finding</li><li>Second finding</li></ul><table><tr><td>Measured result</td></tr></table>` +
  `<figure><a href="/evidence"><img src="/chart.jpg?a=1&amp;b=2" width="640" height="480"></a><figcaption>Original chart</figcaption></figure>` +
  `<div class="newsletter"><p>${noise}</p></div><p>${prose}</p>`;
const page = `<html><head><title>Research article</title><meta property="article:published_time" content="${date}">` +
  `<meta property="article:modified_time" content="2026-10-05T12:00:00Z"></head><body>` +
  `<nav><a href="/">Home</a></nav><article class="article-body">${fragment}</article>` +
  `<aside class="newsletter"><p>Outside the article.</p></aside></body></html>`;
const rules = { selector: ".article-body", excludeSelectors: [".newsletter", ".related-content"] };
let pageReads = 0, jinaReads = 0;
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  if (path.startsWith("/http")) {
    jinaReads += 1;
    res.setHeader("content-type", "text/plain");
    return res.end(`Title: Rendered article\nMarkdown Content:\n${prose}`);
  }
  if (path.endsWith("/listing")) {
    res.setHeader("content-type", "text/html");
    if (path === "/preservation/listing") return res.end('<ul><li><a href="/complete">Complete article</a></li><li><a href="/pending">Pending article</a></li></ul>');
    return res.end(`<ul><li><a href="${path.replace(/listing$/, "post")}">Research article</a></li></ul>`);
  }
  if (path.endsWith("/feed")) {
    res.setHeader("content-type", "application/xml");
    return res.end(`<rss version="2.0"><channel><title>Research</title><item><title>Research article</title><link>${base}${path.replace(/feed$/, "post")}</link></item></channel></rss>`);
  }
  if (path.endsWith("/json")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify([{ title: "Research article", url: `${base}${path.replace(/json$/, "post")}` }]));
  }
  pageReads += 1;
  res.setHeader("content-type", "text/html");
  res.end(path === "/empty" ? "<html><body></body></html>" : page);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
process.env.JINA_API_KEY = "test-key";
process.env.JINA_BASE_URL = base;
before(async () => { await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`; });
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

test("without hints the body, images and date remain the native Readability result", () => {
  const { document } = parseHTML(page);
  const el = document.createElement("base");
  el.setAttribute("href", base + "/post");
  document.head.appendChild(el);
  const native = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 200, keepClasses: false }).parse()!;
  const html = trimTrailingChrome(sanitizeBody(native.content!, base + "/post"));
  const got = readable(page, base + "/post", "+00:00")!;
  assert.equal(got.html, html);
  assert.equal(got.text, stripTags(html));
  assert.equal(got.via, "readability");
  assert.equal(got.publishedAt?.toISOString(), "2026-10-01T09:30:00.000Z");
  assert.deepEqual(got.images.map(img => img.url), [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]!.replace(/&amp;/g, "&")).slice(0, 12));
  assert.deepEqual(readable(page, base + "/post", "+00:00", undefined), got);
});

test("selection excludes every matching descendant, retains structure, and keeps full-page metadata", () => {
  const got = readable(page, base + "/post", "+00:00", rules)!;
  assert.equal(got.via, "selector");
  assert.ok(got.text.includes(prose));
  assert.ok(!got.text.includes("module noise") && !got.text.includes("Outside the article"));
  assert.ok(got.html.includes("<ul>") && got.html.includes("<table>") && got.html.includes("<figcaption>"));
  assert.ok(got.html.includes(`href="${base}/evidence"`));
  assert.deepEqual(got.images, [{ kind: "image", url: `${base}/chart.jpg?a=1&b=2`, width: 640, height: 480 }]);
  assert.equal(got.text, stripTags(got.html));
  assert.equal(got.publishedAt?.toISOString(), "2026-10-01T09:30:00.000Z");
  assert.equal(readable(page, base + "/post", "+09:00", rules)?.publishedAt?.toISOString(), "2026-10-01T00:30:00.000Z");
});

test("absent optional modules are a no-op, including when all exclusions match zero nodes", () => {
  const bare = page.replace(/class="newsletter"/g, 'class="ordinary"');
  for (const excludeSelectors of [undefined, [], [".missing"], [".newsletter", ".related-content"]]) {
    const got = readable(bare, base + "/post", undefined, { selector: ".article-body", excludeSelectors })!;
    assert.equal(got.via, "selector");
    assert.equal(got.html, trimTrailingChrome(sanitizeBody(`<article class="article-body">${fragment.replace(/class="newsletter"/g, 'class="ordinary"')}</article>`, base + "/post")));
  }
});

test("selection preserves lazy and noscript images without keeping their placeholders", () => {
  const image = `${base}/chart.jpg`;
  for (const markup of [
    `<img data-lazy-src="${image}" width="640" height="480">`,
    `<img class="lazy" src="/blank.gif" data-lazy-src="${image}" width="640" height="480">`,
    `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///w==" data-lazy-src="${image}" width="640" height="480">`,
    `<img src="/blank.gif"><noscript><img src="${image}" width="640" height="480"></noscript>`,
    `<img hidden src="/blank.gif"><noscript><img src="${image}" width="640" height="480"></noscript>`,
    `<img style="display:none" src="/blank.gif"><noscript><img src="${image}" width="640" height="480"></noscript>`,
    `<img aria-hidden="true" src="/blank.gif"><noscript><img src="${image}" width="640" height="480"></noscript>`,
    `<a href="/evidence"><img src="/blank.gif"></a><noscript><a href="/evidence"><img src="${image}" width="640" height="480"></a></noscript>`,
    `<a hidden href="/evidence"><img src="/blank.gif"></a><noscript><a href="/evidence"><img src="${image}" width="640" height="480"></a></noscript>`,
    `<figure data-lazy-src="${image}"></figure>`,
  ]) {
    const html = page.replace(fragment, `<p>${prose}</p><figure>${markup}<figcaption>Chart evidence</figcaption></figure><p>${prose}</p>`);
    const baseline = readable(html, base + "/post")!;
    assert.deepEqual(baseline.images.map(img => img.url), [image], markup);
    const got = readable(html, base + "/post", undefined, rules)!;
    assert.equal(got.via, "selector");
    assert.deepEqual(got.images, baseline.images, markup);
    assert.ok(!got.html.includes("blank.gif"));
    assert.ok(got.text.includes("Chart evidence"));
  }
});

test("selection removes explicitly hidden content before measuring the cleaned body", () => {
  const hidden = [
    "hidden", 'aria-hidden="true"', 'style="display: none"', 'style="visibility: hidden"',
    'style="display: none !important"', 'style="display:none!important"', 'style="DISPLAY:NONE"',
    'style="Display: None"', 'style="visibility: hidden !important"', 'style="VISIBILITY:HIDDEN"',
    'style="display:none !IMPORTANT; display:block"', 'style="visibility:hidden!important; visibility:visible"',
  ];
  for (const attribute of hidden) {
    const html = page.replace(fragment, `<p>${prose}</p><div ${attribute}><p>Hidden navigation noise</p><img src="/hidden.jpg"></div><p>${prose}</p>`);
    const got = readable(html, base + "/post", undefined, rules)!;
    assert.equal(got.via, "selector");
    assert.ok(!got.text.includes("Hidden navigation"), attribute);
    assert.ok(!got.html.includes("hidden.jpg"), attribute);
    assert.ok(got.text.includes(prose));
    const short = page.replace(fragment, `<p>Short article.</p><div ${attribute}><p>${prose}</p></div>`);
    assert.deepEqual(readable(short, base + "/post", undefined, rules), readable(short, base + "/post"), attribute);
    for (const html of [
      page.replace('class="article-body"', `class="article-body" ${attribute}`),
      page.replace('<article class="article-body">', `<div ${attribute}><article class="article-body">`).replace("</article>", "</article></div>"),
    ]) assert.deepEqual(readable(html, base + "/post", undefined, rules), readable(html, base + "/post"), attribute);
  }
  for (const style of [
    "display:none; display:block", "DISPLAY:none; display:block", "display:none; DISPLAY:block !important",
    "visibility:hidden; VISIBILITY:visible", "visibility:hidden!important; visibility:visible!important",
  ]) {
    const html = page.replace('class="article-body"', `class="article-body" style="${style}"`);
    assert.equal(readable(html, base + "/post", undefined, rules)!.via, "selector", style);
  }
  const math = page.replace(fragment, `<p>${prose}</p><img class="fallback-image" aria-hidden="true" src="/math.jpg">`);
  assert.deepEqual(readable(math, base + "/post", undefined, rules)!.images, readable(math, base + "/post")!.images);
  const hiddenImage = page.replace(fragment, `<p>${prose}</p><img hidden src="/blank.gif"><noscript><img hidden src="/hidden.jpg"></noscript>`);
  assert.deepEqual(readable(hiddenImage, base + "/post", undefined, rules)!.images, []);
});

test("invalid values, selectors and destructive exclusions return the unchanged baseline", () => {
  const baseline = readable(page, base + "/post", "+00:00");
  for (const hints of [null, false, "selector", [], {}, { selector: 1 }, { selector: " " }, { selector: ".missing" }, { selector: "p" }, { selector: "[" }, { selector: "figcaption" },
    { selector: ".article-body", excludeSelectors: null }, { selector: ".article-body", excludeSelectors: ".newsletter" },
    { selector: ".article-body", excludeSelectors: [1] }, { selector: ".article-body", excludeSelectors: [""] },
    { selector: ".article-body", excludeSelectors: [".newsletter", "["] }, { selector: ".article-body", excludeSelectors: ["*"] }]) {
    assert.deepEqual(readable(page, base + "/post", "+00:00", hints), baseline, JSON.stringify(hints));
  }
  assert.deepEqual(readable(page + '<div class="article-body">Another region</div>', base + "/post", "+00:00", rules), readable(page + '<div class="article-body">Another region</div>', base + "/post", "+00:00"));
});

test("a selector can recover from native extraction failure without guessing a date", t => {
  for (const outcome of [null, "throw"] as const) {
    const mock = t.mock.method(Readability.prototype, "parse", () => { if (outcome === "throw") throw new Error("parse failed"); return null; });
    const got = readable(page, base + "/post", undefined, rules)!;
    assert.equal(got.via, "selector");
    assert.ok(got.text.includes(prose));
    assert.equal(got.publishedAt ?? null, null);
    assert.equal(readable(page, base + "/post", undefined, { selector: ".missing" }), null);
    mock.mock.restore();
  }
});

test("hint values fail locally, while unknown keys and unsupported source kinds retain config validation", () => {
  for (const kind of ["rss", "web_list", "json_list"] as const) {
    for (const hints of [rules, null, false, [], "invalid", {}, { selector: "[", excludeSelectors: [1] }]) {
      assert.deepEqual(unsupportedConfig(kind, { bodyExtraction: hints }), []);
    }
    assert.deepEqual(unsupportedConfig(kind, { bodyExtraction: { selector: ".article-body", typo: true } }), ["bodyExtraction.typo"]);
  }
  for (const kind of ["x_search", "mp_account", "external"] as const) {
    assert.deepEqual(unsupportedConfig(kind, { bodyExtraction: rules }), ["bodyExtraction"]);
  }
});

test("admin validation rejects malformed hints and CSS, but does not require matching page nodes", () => {
  for (const kind of ["rss", "web_list", "json_list"] as const) {
    assert.doesNotThrow(() => assertSupportedConfig(kind, {}));
    for (const hints of [rules, { selector: ".missing" }, { selector: "p", excludeSelectors: [] },
      { selector: ".missing", excludeSelectors: [".also-missing"] }]) {
      assert.doesNotThrow(() => assertSupportedConfig(kind, { bodyExtraction: hints }));
    }
    for (const hints of [null, false, true, 42, "invalid", [], [1], {}, { selector: 1 }, { selector: "" },
      { selector: " " }, { selector: "[" }, { selector: ".article-body", excludeSelectors: null },
      { selector: ".article-body", excludeSelectors: ".newsletter" }, { selector: ".article-body", excludeSelectors: [1] },
      { selector: ".article-body", excludeSelectors: [""] }, { selector: ".article-body", excludeSelectors: [".newsletter", "["] }]) {
      assert.throws(() => assertSupportedConfig(kind, { bodyExtraction: hints }),
        (error: unknown) => error instanceof UnsupportedConfig && error.statusCode === 400 && error.message.includes("bodyExtraction"),
        JSON.stringify(hints));
      assert.deepEqual(unsupportedConfig(kind, { bodyExtraction: hints }), []);
    }
  }
});

test("admin create, edit and preview reject bad hints without saving them", async () => {
  const draft = { id: `body-admin-${T}`, name: "Body admin", kind: "rss" as const, config: { feedUrl: base + "/admin/feed" } };
  assert.equal((await createSource(draft, "test")).created, true);
  const [before] = await sql`SELECT config,updated_at FROM sources WHERE id=${draft.id}`;
  const invalid = { ...draft.config, bodyExtraction: { selector: "[" } };
  await assert.rejects(createSource({ ...draft, id: `body-admin-invalid-${T}`, config: invalid }, "test"), UnsupportedConfig);
  await assert.rejects(updateSource(draft.id, { patch: { config: invalid }, version: before!.updated_at.toISOString() }, "test"), UnsupportedConfig);
  await assert.rejects(previewSource({ ...draft, config: invalid }), UnsupportedConfig);
  const [after] = await sql`SELECT config,updated_at FROM sources WHERE id=${draft.id}`;
  assert.deepEqual(after, before);
  assert.equal((await sql`SELECT id FROM sources WHERE id=${`body-admin-invalid-${T}`}`).length, 0);
});

test("enhancement success or failure uses one page read and no Jina read; both failures still use Jina", async () => {
  for (const hints of [undefined, rules, { selector: ".missing" }, { selector: "[" }]) {
    const counts = [pageReads, jinaReads];
    const got = await extractFromUrl(base + "/request", `test:${T}`, "+00:00", hints);
    assert.deepEqual([pageReads, jinaReads], [counts[0]! + 1, counts[1]]);
    assert.deepEqual(got, readable(page, base + "/request", "+00:00", hints));
  }
  const counts = [pageReads, jinaReads];
  const got = await extractFromUrl(base + "/empty", `test:${T}`, undefined, rules);
  assert.equal(got?.via, "jina");
  assert.equal(got?.text, prose);
  assert.deepEqual([pageReads, jinaReads], [counts[0]! + 1, counts[1]! + 1]);
});

test("detail recovery and the worker apply the same rules, and confirmed bodies are skipped", async () => {
  const sourceId = `body-worker-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES (${sourceId},'Body worker','rss',${sql.json({ feedUrl: base + "/feed", bodyExtraction: rules })})`;
  const detail = await fetchDetail(base + "/worker", { id: sourceId, config: { detail: {}, bodyExtraction: rules } } as never, { date: true, title: false, summary: false, body: true });
  const { articleId } = await upsertMaterial({ sourceId, url: base + "/worker", title: "Research article", via: "fetch" });
  assert.equal(await extractArticleBody(articleId), "ok");
  const [row] = await sql`SELECT body_html,body_text,body_status FROM articles WHERE id=${articleId}`;
  assert.equal(row!.body_html, detail.body!.html);
  assert.equal(row!.body_text, detail.body!.text);
  assert.equal(row!.body_status, "ok");
  const reads = pageReads;
  await sql`UPDATE sources SET config=${sql.json({ bodyExtraction: { selector: ".missing" } })} WHERE id=${sourceId}`;
  assert.equal(await extractArticleBody(articleId), "skipped");
  assert.equal(pageReads, reads);
});

test("all three listing kinds forward hints and invalid hints do not break collection", async () => {
  for (const kind of ["rss", "web_list", "json_list"] as const) {
    for (const valid of [true, false]) {
      const sourceId = `body-collect-${kind}-${valid}-${T}`;
      const prefix = `${base}/${sourceId}`;
      const listing = kind === "rss" ? { feedUrl: prefix + "/feed" } : kind === "web_list" ? { url: prefix + "/listing", itemSelector: "li", titleSelector: "a" } : { url: prefix + "/json", titlePaths: ["title"], urlTemplate: "{raw:url}" };
      const bodyExtraction = valid ? rules : { selector: "[", excludeSelectors: [1] };
      await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,cursor) VALUES (${sourceId},'Body collection',${kind},'T1','editorial',${sql.json({ ...listing, detail: { maxFetches: 5 }, bodyExtraction })},${sql.json({ initializedAt: new Date().toISOString() })})`;
      const reads = [pageReads, jinaReads];
      assert.equal((await collectSource(sourceId, { force: true })).status, "ok");
      const [row] = await sql`SELECT body_html,body_text,body_status FROM articles WHERE source_id=${sourceId}`;
      assert.equal(row!.body_status, "ok");
      assert.equal(row!.body_html, readable(page, prefix + "/post", undefined, bodyExtraction)!.html);
      assert.equal(row!.body_text, stripTags(row!.body_html));
      assert.deepEqual([pageReads, jinaReads], [reads[0]! + 1, reads[1]]);
    }
  }
});

test("metadata recovery with hints preserves a confirmed body while filling a pending body", async () => {
  const sourceId = `body-preserve-hints-${T}`;
  const original = "The publisher supplied a confirmed body that must not be replaced. ".repeat(6).trim();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,cursor) VALUES (${sourceId},'Body preservation hints','web_list','T1','editorial',${sql.json({ url: base + "/preservation/listing", itemSelector: "li", titleSelector: "a", detail: { maxFetches: 5, publishedAtUtcOffset: "+00:00" }, bodyExtraction: rules })},${sql.json({ initializedAt: new Date().toISOString() })})`;
  const complete = await upsertMaterial({ sourceId, url: base + "/complete", title: "Complete article", bodyText: original, bodyHtml: `<p>${original}</p>`, bodyStatus: "ok", via: "fetch" });
  const pending = await upsertMaterial({ sourceId, url: base + "/pending", title: "Pending article", bodyStatus: "pending", via: "fetch" });
  const reads = [pageReads, jinaReads];
  assert.equal((await collectSource(sourceId, { force: true })).status, "ok");
  const [confirmed] = await sql`SELECT body_text,body_html,body_status,published_at FROM articles WHERE id=${complete.articleId}`;
  assert.equal(confirmed!.body_text, original);
  assert.equal(confirmed!.body_html, `<p>${original}</p>`);
  assert.equal(confirmed!.body_status, "ok");
  assert.equal(confirmed!.published_at.toISOString(), "2026-10-01T09:30:00.000Z");
  const [filled] = await sql`SELECT body_html,body_text,body_status,published_at FROM articles WHERE id=${pending.articleId}`;
  assert.equal(filled!.body_html, readable(page, base + "/pending", undefined, rules)!.html);
  assert.ok(!filled!.body_text.includes("module noise"));
  assert.equal(filled!.body_status, "ok");
  assert.equal(filled!.published_at.toISOString(), "2026-10-01T09:30:00.000Z");
  assert.deepEqual([pageReads, jinaReads], [reads[0]! + 2, reads[1]]);
});
