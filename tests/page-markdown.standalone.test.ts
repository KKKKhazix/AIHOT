// Failure modes: a Markdown page downloads, is indexed separately, cannot revalidate or answer HEAD,
// or its web page does not point at it.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { sendPageMarkdown } from "../apps/api/src/http/respond.ts";
import { ENGLISH } from "@aihot/contracts/english";
import { SITE } from "@aihot/site";
import { pageMeta, siteUrl } from "../apps/web/app/lib/seo.ts";

test("Markdown responses carry canonical/noindex, ETag/304 and HEAD without an attachment", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get("/fixture.md", (req, reply) => sendPageMarkdown(req, reply, "# Fixture\n", { path: "/fixture", etagPrefix: "fixture", cacheControl: "public, max-age=60" }));
  const get = await app.inject("/fixture.md");
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(get.headers["content-disposition"], undefined);
  assert.equal(get.headers["x-robots-tag"], "noindex");
  assert.equal(get.headers.link, `<${siteUrl()}/fixture>; rel="canonical"`);
  const cached = await app.inject({ url: "/fixture.md", headers: { "if-none-match": String(get.headers.etag) } });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, "");
  for (const key of ["link", "x-robots-tag", "etag", "cache-control"]) assert.equal(cached.headers[key], get.headers[key]);
  const head = await app.inject({ method: "HEAD", url: "/fixture.md" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  for (const key of ["content-type", "link", "x-robots-tag", "etag", "cache-control"]) assert.equal(head.headers[key], get.headers[key]);
});

test("pageMeta advertises only an explicitly supplied Markdown representation", () => {
  const alternate = { tagName: "link", rel: "alternate", type: "text/markdown", href: `${siteUrl()}/fixture.md` };
  const markdown = (tag: object) => "type" in tag && tag.type === "text/markdown";
  assert.ok(pageMeta({ locale: "zh", path: "/fixture", markdown: "/fixture.md" }).some((tag) => JSON.stringify(tag) === JSON.stringify(alternate)));
  assert.ok(!pageMeta({ locale: "zh", path: "/fixture" }).some(markdown));
  // The Markdown versions are the Chinese pages'; an English page does not offer them.
  assert.ok(!pageMeta({ locale: "en", path: "/hot", markdown: "/hot.md" }).some(markdown));
});

test("a published page names its own address and language", () => {
  const locale = ENGLISH ? "en" : "zh";
  const url = siteUrl() + (ENGLISH ? "/en/hot" : "/hot");
  const tags = pageMeta({ locale, path: "/hot" });
  const find = (key: string, value: string) => tags.find((tag) => (tag as Record<string, unknown>)[key] === value) as Record<string, string> | undefined;
  assert.equal(find("rel", "canonical")?.href, url);
  assert.equal(find("property", "og:url")?.content, url);
  assert.equal(find("property", "og:locale")?.content, ENGLISH ? "en_US" : SITE.locale.replace("-", "_"));
  // A page without an English edition keeps its one address.
  assert.equal((pageMeta({ locale: "en", path: "/changelog" }).find((tag) => (tag as Record<string, unknown>).rel === "canonical") as Record<string, string>).href, `${siteUrl()}/changelog`);
});

test("a page in both languages names both for search engines; an English page still in Chinese stays out of search", () => {
  type Tag = Record<string, string>;
  const alternates = (tags: object[]) => (tags as Tag[]).filter((tag) => tag.rel === "alternate" && tag.hrefLang).map((tag) => `${tag.hrefLang} ${tag.href}`);
  const robots = (tags: object[]) => (tags as Tag[]).find((tag) => tag.name === "robots")?.content;
  if (!ENGLISH) {
    assert.deepEqual(alternates(pageMeta({ locale: "zh", path: "/hot" })), [], "a site without an English edition names no other language");
    return;
  }
  const both = [`${SITE.locale} ${siteUrl()}/hot`, `en ${siteUrl()}/en/hot`, `x-default ${siteUrl()}/hot`];
  for (const locale of ["zh", "en"] as const) assert.deepEqual(alternates(pageMeta({ locale, path: "/hot", title: "Trending" })), both, locale);
  assert.deepEqual(alternates(pageMeta({ locale: "zh", path: "/changelog" })), [], "a page with no English edition names none");
  assert.deepEqual(alternates(pageMeta({ locale: "zh", path: "/hot", noindex: true })), [], "a page out of search names none");
  const untranslated = pageMeta({ locale: "en", path: "/items/abc", title: "还没翻译的标题" });
  assert.match(robots(untranslated) ?? "", /^noindex/, "its words are not translated yet");
  assert.deepEqual(alternates(untranslated), []);
  assert.doesNotMatch(robots(pageMeta({ locale: "en", path: "/items/abc", title: "A translated title" })) ?? "", /noindex/);
  assert.doesNotMatch(robots(pageMeta({ locale: "zh", path: "/items/abc", title: "中文标题" })) ?? "", /noindex/, "the Chinese page is not affected");
});
