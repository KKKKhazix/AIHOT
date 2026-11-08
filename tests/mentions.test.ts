// The site's own texts link the names of pages it has (contracts/mentions.ts): an article page, an event
// page and a report are sent the pages their texts name. Company topics are the engine's own; other pages,
// such as a model's, come from the installed modules, so a site without them still links its companies.
// Failure cases: a page a module offers is not sent; a site without modules sends a module's pages or none.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { loadStoryDetail } from "@aihot/backend/publication/stories";
import { loadReport } from "@aihot/backend/publication/reports";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const source = `mentions-${T}`;
const at = new Date("2026-09-30T00:00:00Z");
const models = [{ name: "models", mentions: async () => [{ href: "/models/dots-2", names: ["Dots 2"] }] }];
let sequence = 0;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, 'Mention source', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

async function article(title: string, summary: string) {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${T}/${++sequence}`, title,
    bodyText: "Fixture body", bodyHtml: "<p>Fixture body</p>", bodyStatus: "ok", via: "fetch", publishedAt: at });
  await sql`UPDATE articles SET grouping_status = 'complete' WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${title}, ${summary}, 90, true)`;
  await publishArticle(articleId, { releasedAt: at });
  return articleId;
}

const hrefs = (mentions: Array<{ href: string | null }>) => mentions.map((m) => m.href);

test("an article page is sent the pages its summary names: the module's and the engine's company topics", async () => {
  const id = await article("Dots 2 发布", "OpenAI 发布 Dots 2，接入了已有的应用。");
  installModules([]);
  const bare = await loadItemDetail(id);
  assert.equal(bare.kind, "found");
  if (bare.kind !== "found") return;
  assert.deepEqual(hrefs(bare.item.mentions), ["/topics/openai"], "a site without modules links its companies only");

  installModules(models);
  const full = await loadItemDetail(id);
  if (full.kind !== "found") return assert.fail("article missing");
  assert.deepEqual(full.item.mentions, [
    { href: "/topics/openai", names: ["OpenAI"] },
    { href: "/models/dots-2", names: ["Dots 2"] },
  ]);
});

test("an event page is sent the pages its overview names", async () => {
  installModules(models);
  const id = await article("谷歌发布 Dots 2 对手", "谷歌发布 Dots 2 的对手。");
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, '谷歌发布新模型', ${at}, ${at}) RETURNING id`;
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title, subject, action, object) VALUES (${`f-${randomUUID()}`}, ${s!.id}, '谷歌发布新模型', '谷歌', '发布', '新模型') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role, evidence) VALUES (${f!.id}, ${id}, 'report', 'fixture')`;
  await sql`UPDATE publications SET story_id = ${s!.id}, fact_id = ${f!.id} WHERE article_id = ${id}`;
  const story = (await loadStoryDetail(Number(s!.id), new Date(+at + 3600_000)))!;
  assert.equal(story.excerpt?.text, "谷歌发布 Dots 2 的对手。");
  assert.deepEqual(hrefs(story.mentions), ["/topics/google", "/models/dots-2"]);
});

test("a report is sent the pages its lead and summaries name", async () => {
  installModules(models);
  const id = await article("Dots 2 发布", "Dots 2 上线。");
  const key = "2096-02-01";
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${key}, ${at}, ${at}, ${sql.json({
      lead: { title: "英伟达发布新卡", leadParagraph: "英伟达发布新卡。" },
      sections: [{ label: "模型", items: [{ itemId: id, title: "Dots 2 发布", summary: "Dots 2 上线。", sourceUrl: "https://example.com", sourceName: "Mention source" }] }],
    } as never)}, ${at}, 'manual')`;
  const report = (await loadReport("daily", key))!;
  assert.deepEqual(hrefs(report.mentions), ["/topics/nvidia", "/models/dots-2"]);
});
