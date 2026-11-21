// Failure cases: the card shows no publication date, so a weeks-old launch pushed today reads as
// today's news; the date is taken in UTC and lands a day early around Beijing midnight; the title is no
// larger than the summary, or the source and date read as body text; markdown characters in a model's
// words break the card; the reason reads as body text.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { selectedContent } from "@aihot/backend/notify/selected-content";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { ITEM_COPY, SITE } from "@aihot/site";

config.siteUrl = "https://example.org";

const T = tag();
const SOURCE = `card-${T}`;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'X：ChatGPT (@ChatGPT)','x_search','T1_5','editorial','2100-01-01')`;
});
after(async () => { await stopBoss(); await closeDb(); });

const SPACE = { title: "OpenAI 演示 ChatGPT Space 团队协作用法", summary: "官方演示了团队协作用法。" };

async function selected(category: string, reason: string | null, copy = SPACE) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${category}`,
    title: `${T} ${category}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 60_000) });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${articleId},1,'rule','pass',${category},${copy.title},${copy.summary},${reason},90,true)`;
  await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),selection_adds_value=true WHERE id=${articleId}`;
  await publishArticle(articleId);
  // 00:30 in Beijing on the 15th is still the 14th in UTC.
  await sql`UPDATE publications SET published_at='2026-10-14T16:30:00Z' WHERE article_id=${articleId}`;
  const content = await selectedContent(articleId);
  assert.equal(content.status, "ready");
  return (content as Extract<typeof content, { status: "ready" }>).card as any;
}
const category = (key: string) => CATEGORIES.find((c) => c.key === key)!;

test("the title is larger than the summary, followed by the source and Beijing date in grey", async () => {
  const card = await selected("ai-products", "官方演示了 Space 的协作用法。");
  assert.equal(card.schema, "2.0");
  assert.equal(card.header, undefined, "a header title cannot be made larger");
  const [title, meta, summary, reason, buttons] = card.body.elements;
  const products = category("ai-products");
  assert.equal(title.content, `**OpenAI 演示 ChatGPT Space 团队协作用法** <text_tag color='${products.tagColor}'>${products.label}</text_tag>`);
  const size = card.config.style.text_size[title.text_size];
  for (const end of ["default", "pc", "mobile"]) assert.match(size[end], /^heading-[34]$/, "18px on computers, 16px on phones");
  assert.equal(summary.text_size ?? "normal", "normal");
  assert.equal(summary.content, "官方演示了团队协作用法。");
  assert.deepEqual([meta.text_size, meta.content], ["notation", "<font color='grey'>ChatGPT · 10月15日发布</font>"]);
  assert.deepEqual([reason.text_size, reason.content], ["notation", `<font color='grey'>**${ITEM_COPY.reasonLabel}**　官方演示了 Space 的协作用法。</font>`]);
  const links = buttons.columns.map((c: any) => c.elements[0]);
  assert.deepEqual(links.map((b: any) => b.text.content), [`在 ${SITE.name} 阅读`, "原文"]);
  assert.ok(links.every((b: any) => b.behaviors[0].type === "open_url" && b.behaviors[0].default_url.startsWith("https://")));
  assert.doesNotMatch(JSON.stringify(card), /来源：/);
});

test("without a reason the card goes from the summary straight to the buttons", async () => {
  const card = await selected("ai-models", null);
  assert.deepEqual(card.body.elements.map((e: any) => e.tag), ["markdown", "markdown", "markdown", "column_set"]);
  assert.match(card.body.elements[0].content, new RegExp(`color='${category("ai-models").tagColor}'`));
});

test("markdown characters in the model's words show as written", async () => {
  const card = await selected("paper", null, { title: "延迟 <1 秒的 *Flash* 模型", summary: "支持 [beta] 接口与 `code` 示例。" });
  assert.ok(card.body.elements[0].content.startsWith("**延迟 &#60;1 秒的 &#42;Flash&#42; 模型**"));
  assert.equal(card.body.elements[2].content, "支持 &#91;beta&#93; 接口与 &#96;code&#96; 示例。");
});
