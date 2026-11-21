import assert from "node:assert/strict";
import { test } from "node:test";
import githubTrending from "../module.ts";

const pattern = githubTrending.apiPaths![0]!;

test("api path claims the module's routes and their subpaths", () => {
  assert.equal(pattern.test("/api/github-trending"), true);
  assert.equal(pattern.test("/api/github-trending?period=weekly"), true);
  assert.equal(pattern.test("/api/github-trending/history"), true);
});

test("api path does not claim siblings with the same prefix", () => {
  assert.equal(pattern.test("/api/github-trending-evil"), false);
  assert.equal(pattern.test("/api/github-trendings"), false);
});
