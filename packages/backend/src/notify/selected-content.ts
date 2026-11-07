// The current selected card and its eligibility, shared by initial delivery, mirrors and recovery.
import { sql } from "../db.ts";
import { itemUrl } from "../publication/links.ts";
import { publicSourceName } from "../publication/rules.ts";
import { dingtalkMarkdown, type DingtalkContent } from "./dingtalk.ts";
import { type CategoryKey } from "@aihot/contracts/taxonomy";
import { beijingDay } from "@aihot/contracts/time";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { ITEM_COPY, SITE } from "@aihot/site";

const MAX_AGE_MS = 12 * 3600_000;
/** Content groups get first-party (T1) and near-first-party (T1_5) sources only. */
const PUSH_TIERS = ["T1", "T1_5"];

interface Row {
  article_id: string;
  selected: boolean;
  visibility: string;
  title: string;
  summary: string | null;
  reason: string | null;
  category: CategoryKey | null;
  source_name: string;
  source_tier: string;
  url: string;
  timeline_at: Date;
  published_at: Date | null;
  discovered_at: Date;
  backfill: boolean;
  fact_id: number | null;
  silent: boolean;
}

/** The original's publication date, so a launch introduced again weeks later does not read as today's. */
const published = (at: Date) => `${beijingDay(at)}发布`;

/** Model-written words go into card markdown: its markup characters are shown as written. */
const literal = (text: string) => text.replace(/[&<>*_~`[\]]/g, (c) => `&#${c.charCodeAt(0)};`);

const link = (label: string, url: string, type: string) => ({
  tag: "column", width: "auto",
  elements: [{ tag: "button", text: { tag: "plain_text", content: label }, type, behaviors: [{ type: "open_url", default_url: url }] }],
});

// Card JSON 2.0: a header title has one fixed size, so the title is the first body line, a size above the summary.
function card(r: Row) {
  const category = CATEGORIES.find((c) => c.key === r.category);
  const tag = category ? ` <text_tag color='${category.tagColor}'>${category.label}</text_tag>` : "";
  return {
    schema: "2.0",
    config: { style: { text_size: { title: { default: "heading-3", pc: "heading-3", mobile: "heading-4" } } } },
    body: {
      elements: [
        { tag: "markdown", text_size: "title", content: `**${literal(r.title)}**${tag}` },
        { tag: "markdown", text_size: "notation", content: `<font color='grey'>${literal(publicSourceName(r.source_name))} · ${published(r.published_at!)}</font>` },
        { tag: "markdown", content: literal(r.summary ?? "") },
        ...(r.reason ? [{ tag: "markdown", text_size: "notation", content: `<font color='grey'>**${ITEM_COPY.reasonLabel}**　${literal(r.reason)}</font>` }] : []),
        { tag: "column_set", horizontal_spacing: "8px", columns: [link(`在 ${SITE.name} 阅读`, itemUrl(r.article_id), "primary"), link("原文", r.url, "default")] },
      ],
    },
  };
}

/** The same content for DingTalk's markdown bots: no fonts or buttons, links inline. */
function dingtalk(r: Row): { title: string; text: string } {
  return dingtalkMarkdown({
    title: r.title,
    sourceName: publicSourceName(r.source_name),
    published: published(r.published_at!),
    summary: r.summary,
    reason: r.reason,
    reasonLabel: ITEM_COPY.reasonLabel,
    articleId: r.article_id,
    url: r.url,
  } satisfies DingtalkContent);
}

export async function selectedContent(articleId: string, now = new Date()): Promise<
  | { status: "ready"; article: Row; card: ReturnType<typeof card>; dingtalk: ReturnType<typeof dingtalk> }
  | { status: "skipped"; reason: string }
> {
  const [r] = await sql<Row[]>`
    SELECT p.article_id, p.selected, p.visibility, p.title, p.summary, p.reason, p.category, s.name AS source_name, s.tier AS source_tier, p.url,
           p.timeline_at, p.published_at, p.discovered_at, p.backfill, p.fact_id,
           coalesce((o.fields->>'silent')::boolean, false) AS silent
    FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
    WHERE p.article_id = ${articleId}`;
  if (!r || !r.selected || r.visibility !== "public") return { status: "skipped", reason: "not public selected" };
  if (r.silent) return { status: "skipped", reason: "silenced" };
  if (!r.published_at) return { status: "skipped", reason: "unknown publication time" };
  if (!PUSH_TIERS.includes(r.source_tier)) return { status: "skipped", reason: "not a first-party source" };
  if (r.backfill || now.getTime() - r.timeline_at.getTime() > MAX_AGE_MS) return { status: "skipped", reason: "not live" };

  return { status: "ready", article: r, card: card(r), dingtalk: dingtalk(r) };
}
