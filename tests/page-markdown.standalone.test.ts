// Failure modes: a Markdown page downloads, is indexed separately, cannot revalidate or answer HEAD,
// or its web page does not point at it.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { sendPageMarkdown } from "../apps/api/src/http/respond.ts";
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
  assert.ok(pageMeta({ path: "/fixture", markdown: "/fixture.md" }).some((tag) => JSON.stringify(tag) === JSON.stringify(alternate)));
  assert.ok(!pageMeta({ path: "/fixture" }).some((tag) => "rel" in tag && tag.rel === "alternate"));
});
