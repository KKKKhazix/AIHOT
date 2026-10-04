// Relevance rewrites must keep every term mandatory across direct/body fields, retain the
// title and whole-company boosts, deduplicate company/text matches, and preserve filters,
// release scope, literal LIKE characters, tie ordering and empty-page totals.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadPool } from "@aihot/backend/publication/pool";

const T = `relevance-${tag()}`;
const now = new Date("2026-01-01T12:00:00Z");
const id = (suffix: string) => `${T}-${suffix}`;
const query = (q: string) => ({ channel: "all" as const, category: null, tag: null, tab: "relevance" as const, q, now });
after(closeDb);
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${T}, ${T}, 'rss', 'T1')`;
});

async function add(suffix: string, direct: string, body: string, options: {
  title?: string; age?: number; channel?: "news" | "x"; category?: "ai-models" | "paper"; tags?: string[];
  visibility?: string; eligible?: boolean; future?: boolean; noSearchRow?: boolean;
} = {}) {
  const at = new Date(+now - (options.age ?? 60) * 1000);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id(suffix)}, ${T}, ${id(suffix)}, ${`https://example.org/${id(suffix)}`}, ${options.title ?? "neutral"}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, category, tags, url, discovered_at, timeline_at, sort_at,
    selected, eligible, visibility, visible_after, search_text)
    VALUES (${id(suffix)}, ${options.title ?? "neutral"}, ${T}, ${options.channel ?? "news"}, ${options.category ?? "ai-models"}, ${options.tags ?? []},
      ${`https://example.org/${id(suffix)}`}, ${at}, ${at}, ${at}, ${options.future ?? false}, ${options.eligible ?? true},
      ${options.visibility ?? "public"}, ${options.future ? new Date(+now + 60_000) : at}, ${direct})`;
  if (!options.noSearchRow) await sql`INSERT INTO pool_search (article_id, direct, body) VALUES (${id(suffix)}, ${direct}, ${body})`;
}

test("short and multi-term relevance keep cross-field AND and deterministic score ties", async () => {
  await add("title", "zx qy", "zx qy", { title: "ZX QY", age: 100 });
  await add("cross-a", "zx", "qy", { age: 50 });
  await add("cross-z", "zx", "qy", { age: 50 });
  await add("body", "", "zx qy", { age: 1 });
  await add("partial", "zx", "zx", { age: 10 });
  await add("withdrawn", "zx qy", "zx qy", { visibility: "withdrawn" });
  await add("future", "zx qy", "zx qy", { future: true });
  await add("ineligible", "zx qy", "zx qy", { eligible: false });
  const multi = await loadPool(query("zx qy"));
  assert.deepEqual(multi.items.map(item => item.id), ["title", "cross-z", "cross-a", "body"].map(id));
  assert.equal(multi.total, 4);
  const single = await loadPool(query("zx"));
  assert.deepEqual(single.items.map(item => item.id), ["title", "partial", "cross-z", "cross-a", "body"].map(id));
  const beyond = await loadPool({ ...query("zx qy"), page: 2 });
  assert.deepEqual([beyond.items, beyond.total, beyond.pageCount], [[], 4, 1]);
});

test("company relevance retains tag-only candidates, boosts and unique totals", async () => {
  await add("company-both", "openai", "openai", { title: "OpenAI", tags: ["entity:openai"], age: 100 });
  await add("company-tag", "", "", { tags: ["entity:openai"], noSearchRow: true, age: 1 });
  await add("company-text", "openai qy", "openai", { title: "OpenAI", age: 60 });
  await add("company-low", "openai", "", { age: 1 });
  await add("company-withdrawn", "openai", "openai", { tags: ["entity:openai"], visibility: "withdrawn" });
  const company = await loadPool(query("OpenAI"));
  assert.deepEqual(company.items.map(item => item.id), ["company-both", "company-tag", "company-text", "company-low"].map(id));
  assert.equal(company.total, 4, "the text-and-tag candidate counts once");
  const multi = await loadPool(query("openai qy"));
  assert.deepEqual(multi.items.map(item => item.id), [id("company-text")], "only the whole company alias expands the candidates");
});

test("relevance retains combined filters and literal LIKE characters", async () => {
  await add("filtered", "uv", "uv", { channel: "x", category: "paper", tags: [T] });
  await add("wrong-channel", "uv", "uv", { category: "paper", tags: [T] });
  await add("wrong-category", "uv", "uv", { channel: "x", tags: [T] });
  await add("wrong-tag", "uv", "uv", { channel: "x", category: "paper" });
  const filtered = await loadPool({ ...query("uv"), channel: "x", category: "paper", tag: T });
  assert.deepEqual(filtered.items.map(item => item.id), [id("filtered")]);
  await add("literal", "qx%_\\z", "");
  await add("wildcard-lookalike", "qx-anything-z", "");
  assert.deepEqual((await loadPool(query("qx%_\\z"))).items.map(item => item.id), [id("literal")]);
});
