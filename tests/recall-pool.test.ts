// Recall must keep the same evidence through a query-plan change: discovery defines the window,
// live stories and membership roles define eligibility, and the latest analysis (revision, then id)
// excludes composites even before publication catches up. Shared reports retain every fact.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { recallFacts } from "@aihot/backend/events/recall";

const T = `recall-${tag()}`;
const title = `${T}模型发布全新版本详细说明`;
after(closeDb);

test("recall preserves window, live-story, membership and latest-analysis evidence", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode)
    VALUES (${T}, 'Recall fixture', 'rss', 'T1', 'editorial')`;
  const [live] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, ${title}, now(), now()) RETURNING id`;
  const [merged] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at, merged_into)
    VALUES (${randomUUID()}, ${title}, now(), now(), ${live!.id}) RETURNING id`;
  const expected: number[] = [];
  for (const [index, scenario] of ["single", "missing-analysis", "unknown-scope", "composite", "latest-single", "latest-composite", "higher-revision", "old-discovery", "boundary", "recent-discovery", "mention", "merged", "shared"].entries()) {
    const id = `${T}-${scenario}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at)
      VALUES (${id}, ${T}, ${id}, ${`https://example.org/${id}`}, ${title},
        now() - CASE WHEN ${scenario} = 'old-discovery' THEN interval '15 days'
          WHEN ${scenario} = 'boundary' THEN interval '14 days'
          WHEN ${scenario} = 'recent-discovery' THEN interval '14 days' - interval '1 minute' ELSE interval '1 day' END,
        now(), now() - interval '1 year')`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
      VALUES (${`${T}-fact-${index}`}, ${scenario === "merged" ? merged!.id : live!.id}, ${title}) RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role)
      VALUES (${fact!.id}, ${id}, ${scenario === "mention" ? "mention" : index % 2 ? "primary" : "report"})`;
    if (scenario !== "missing-analysis") {
      await sql`INSERT INTO analyses (article_id, input_revision, origin, title_zh, output)
        VALUES (${id}, ${scenario === "higher-revision" ? 2 : 1}, 'rule', ${title},
          ${sql.json(scenario === "unknown-scope" ? {} : { scope: ["composite", "latest-single"].includes(scenario) ? "composite" : "single" })})`;
      if (["latest-single", "latest-composite", "higher-revision"].includes(scenario)) {
        await sql`INSERT INTO analyses (article_id, input_revision, origin, title_zh, output)
          VALUES (${id}, 1, 'rule', ${title}, ${sql.json({ scope: scenario === "latest-single" ? "single" : "composite" })})`;
        await sql`INSERT INTO publications (article_id, analysis_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at)
          SELECT a.id, (SELECT min(id) FROM analyses WHERE article_id = a.id), a.title, a.source_id, 'news', a.url,
            a.discovered_at, a.timeline_at, a.timeline_at FROM articles a WHERE a.id = ${id}`;
      }
    }
    if (!["composite", "latest-composite", "old-discovery", "boundary", "mention", "merged"].includes(scenario)) expected.push(fact!.id);
    if (scenario === "shared") {
      const [second] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
        VALUES (${`${T}-shared-fact`}, ${live!.id}, ${title}) RETURNING id`;
      await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${second!.id}, ${id}, 'primary')`;
      expected.push(second!.id);
    }
  }
  const recalled = await recallFacts(`${T}-query`, title, 0, 1000);
  assert.deepEqual(recalled.map(r => r.factId).sort((a, b) => a - b), expected.sort((a, b) => a - b));
  assert.ok(recalled.every(r => r.score === 1 && r.storyId === live!.id && r.factTitle === title));
});
