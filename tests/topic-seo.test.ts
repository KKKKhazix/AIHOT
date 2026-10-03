/// <reference lib="dom" />
// A topic page tells search engines it is a collection at its own address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { siteUrl, topicLd } from "../apps/web/app/lib/seo.ts";

const topic = {
  path: "/topics/tutorials",
  name: "教程实践 最新动态",
  description: "值得阅读的教程与实践。",
  dateModified: "2026-10-02T08:00:00.000Z",
};

test("a topic page is a collection at its own address", () => {
  const json = topicLd(topic);
  assert.equal(json["@type"], "CollectionPage");
  assert.equal(json.url, `${siteUrl()}/topics/tutorials`);
  assert.equal(json.dateModified, topic.dateModified);
});
