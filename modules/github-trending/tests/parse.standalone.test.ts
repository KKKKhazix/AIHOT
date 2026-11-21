import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseTrending } from "../parse.ts";

const html = readFileSync(path.join(import.meta.dirname, "fixtures/trending.html"), "utf8");

test("parses rows in rank order with full fields", () => {
  const rows = parseTrending(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    rank: 1, repo: "acme/rocket", description: "A fast toolkit for building agents.",
    language: "TypeScript", stars: 12345, starsPeriod: 1234, url: "https://github.com/acme/rocket",
  });
});

test("missing description/language become null, numbers strip commas", () => {
  const rows = parseTrending(html);
  assert.equal(rows[1]!.description, null);
  assert.equal(rows[1]!.language, null);
  assert.equal(rows[1]!.stars, 800);
  assert.equal(rows[1]!.starsPeriod, 56);
});

test("empty page yields no rows", () => {
  assert.deepEqual(parseTrending("<html><body></body></html>"), []);
});
