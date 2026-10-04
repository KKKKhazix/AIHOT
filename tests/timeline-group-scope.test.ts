// Failure cases: a composite or mention folding into a fact; stale fact membership still folding;
// a future/withdrawn/unselected report affecting the anchor; filters choosing an anchor outside their
// own set; a later report moving a fact; equal-time standalone cards changing cursor order.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadTimeline } from "@aihot/backend/publication/timeline";

after(closeDb);

test("timeline grouping preserves evidence scope and filter-local anchors", async () => {
  const prefix = `timeline-scope-${tag()}`;
  const at = new Date("2026-01-01T00:00:00Z");
  const now = new Date(+at + 100_000);
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${prefix}, ${prefix}, 'rss', 'T1')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${prefix}, ${prefix}) RETURNING id`;
  const add = async (suffix: string, seconds: number, options: { role?: string; scope?: string; channel?: string; visibility?: string; selected?: boolean; future?: boolean; missing?: boolean; standalone?: boolean } = {}) => {
    const id = `${prefix}-${suffix}`;
    const time = new Date(+at + seconds * 1000);
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${prefix}, ${id}, ${`https://example.org/${id}`}, ${id}, ${time}, ${time})`;
    const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, output)
      VALUES (${id}, 1, 'rule', ${sql.json(options.scope ? { scope: options.scope } : {})}) RETURNING id`;
    await sql`INSERT INTO publications (article_id, source_id, analysis_id, title, url, discovered_at, timeline_at, sort_at, visible_after,
      selected, eligible, visibility, channel, tags, fact_id)
      VALUES (${id}, ${prefix}, ${analysis!.id}, ${id}, ${`https://example.org/${id}`}, ${time}, ${time}, ${time}, ${options.future ? new Date(+now + 1) : time},
        ${options.selected ?? true}, true, ${options.visibility ?? "public"}, ${options.channel ?? "news"}, ${[prefix]}, ${options.standalone ? null : fact!.id})`;
    if (!options.missing && !options.standalone) await sql`INSERT INTO fact_articles (fact_id, article_id, role)
      VALUES (${fact!.id}, ${id}, ${options.role ?? "report"})`;
    return id;
  };
  await add("old-report", 0);
  await add("x-report", 10, { channel: "x" });
  const standalone = [
    await add("composite", 20, { scope: "composite" }),
    await add("mention", 30, { role: "mention" }),
    await add("removed", 40, { missing: true }),
    await add("standalone-a", 50, { standalone: true }),
    await add("standalone-z", 50, { standalone: true }),
  ];
  await add("future", -50, { future: true });
  await add("withdrawn", -40, { visibility: "withdrawn" });
  await add("unselected", -30, { selected: false });
  const filters = { channel: "all" as const, category: null, tag: prefix, now };
  const full = await loadTimeline(filters);
  assert.deepEqual(full.cards.map(card => card.key), [...standalone.reverse().map(id => `a${id}`), `f${fact!.id}`]);
  assert.equal(full.cards.at(-1)!.anchorAt, at.toISOString());
  const filtered = await loadTimeline({ ...filters, channel: "x" });
  assert.deepEqual(filtered.cards.map(card => [card.key, card.anchorAt]), [[`f${fact!.id}`, new Date(+at + 10_000).toISOString()]]);
  const paged = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ ...filters, cursor, limit: 2 });
    paged.push(...page.cards);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(JSON.stringify(paged), JSON.stringify(full.cards));
});
