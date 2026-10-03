/// <reference lib="dom" />
// A topic page tells search engines it is a collection at its own address. It must not claim a list
// the page does not show, and a list it shows keeps its order and links to event pages only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { siteUrl, topicLd } from "../apps/web/app/lib/seo.ts";

const topic = {
  path: "/topics/tutorials",
  name: "教程实践 最新动态",
  description: "值得阅读的教程与实践。",
  dateModified: "2026-10-02T08:00:00.000Z",
  lists: [] as Array<{ name: string; entries: Array<{ title: string; href: string | null }> }>,
};

test("a topic page is a collection at its own address", () => {
  const json = topicLd(topic);
  assert.equal(json["@type"], "CollectionPage");
  assert.equal(json.url, `${siteUrl()}/topics/tutorials`);
  assert.equal(json.dateModified, topic.dateModified);
  // Without a list it makes no empty claim.
  assert.equal("mainEntity" in json, false);
  assert.equal("mainEntity" in topicLd({ ...topic, lists: [{ name: "大事记", entries: [] }] }), false);
});

test("a list the page shows keeps its ordered entry names and public story links", () => {
  const json = topicLd({ ...topic, lists: [{ name: "大事记", entries: [
    { title: "正式发布", href: "/story/model-release" },
    { title: "历史节点", href: null },
  ] }] });
  const list = json.mainEntity as { numberOfItems: number; itemListElement: unknown[] };
  assert.equal(list.numberOfItems, 2);
  assert.deepEqual(list.itemListElement, [
    { "@type": "ListItem", position: 1, name: "正式发布", url: `${siteUrl()}/story/model-release` },
    { "@type": "ListItem", position: 2, name: "历史节点" },
  ]);
});
