/// <reference lib="dom" />
// Search engines must not see a chronicle when the reader's topic has no qualifying events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { siteUrl, topicLd } from "../apps/web/app/lib/seo.ts";

const topic = {
  path: "/topics/tutorials",
  name: "教程实践 最新动态",
  description: "值得阅读的教程与实践。",
  dateModified: "2026-10-02T08:00:00.000Z",
};

test("a topic without milestones stays a collection without an empty chronicle claim", () => {
  const json = topicLd({ ...topic, events: [] });
  assert.equal(json["@type"], "CollectionPage");
  assert.equal(json.url, `${siteUrl()}/topics/tutorials`);
  assert.equal(json.dateModified, topic.dateModified);
  assert.equal("mainEntity" in json, false);
  assert.equal(JSON.stringify(json).includes("大事记"), false);
});

test("a topic with milestones keeps its ordered event names and public story links", () => {
  const json = topicLd({ ...topic, events: [
    { title: "正式发布", href: "/story/model-release" },
    { title: "历史节点", href: null },
  ] });
  assert.equal(json.mainEntity?.numberOfItems, 2);
  assert.deepEqual(json.mainEntity?.itemListElement, [
    { "@type": "ListItem", position: 1, name: "正式发布", url: `${siteUrl()}/story/model-release` },
    { "@type": "ListItem", position: 2, name: "历史节点" },
  ]);
});
