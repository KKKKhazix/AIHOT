// The English edition names every category, tag a reader sees, topic and topic group of the industry pack.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORIES, CATEGORY_TAGS, TAG_DISPLAY, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { CATEGORY_EN, TAG_EN, TOPIC_EN, TOPIC_GROUP_EN } from "@aihot/industry/english";

const pack = JSON.parse(readFileSync(new URL("../industry/topics.json", import.meta.url), "utf8")) as {
  groups: Array<{ key: string }>;
  topics: Array<{ slug: string }>;
};

test("every word of the industry pack a reader sees has its English", () => {
  const shown = [...CATEGORY_TAGS, ...TOPIC_TAGS].flatMap((t) => {
    const display = (TAG_DISPLAY as Record<string, string | null>)[t];
    return display === null ? [] : [t, ...(display ? [display] : [])];
  });
  const missing = [
    ...CATEGORIES.filter((c) => !CATEGORY_EN[c.key]).map((c) => `category ${c.key}`),
    ...shown.filter((t) => !(t in TAG_EN) && !/^[\x00-\x7F]+$/.test(t)).map((t) => `tag ${t}`),
    ...pack.topics.filter((t) => !TOPIC_EN[t.slug]).map((t) => `topic ${t.slug}`),
    ...pack.groups.filter((g) => !TOPIC_GROUP_EN[g.key]).map((g) => `topic group ${g.key}`),
  ];
  assert.deepEqual(missing, [], "industry/english.ts 缺这些词的英文");
});
