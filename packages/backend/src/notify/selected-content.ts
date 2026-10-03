// The current selected card and its eligibility, shared by initial delivery, mirrors and recovery.
import { sql } from "../db.ts";
import { itemUrl } from "../publication/links.ts";
import { publicSourceName } from "../publication/rules.ts";
import { CATEGORY_LABELS, type CategoryKey } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";

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
  discovered_at: Date;
  backfill: boolean;
  fact_id: number | null;
  silent: boolean;
}

function card(r: Row) {
  const category = r.category ? CATEGORY_LABELS[r.category] : null;
  const lines = [r.summary, r.reason ? `**推荐理由**：${r.reason}` : null, `来源：${publicSourceName(r.source_name)}`].filter(Boolean);
  return {
    header: { title: { tag: "plain_text", content: r.title }, template: "turquoise" },
    elements: [
      ...(category ? [{ tag: "note", elements: [{ tag: "plain_text", content: category }] }] : []),
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: `${SITE.name} 查看` }, url: itemUrl(r.article_id), type: "primary" },
          { tag: "button", text: { tag: "plain_text", content: "原文" }, url: r.url, type: "default" },
        ],
      },
    ],
  };
}

export async function selectedContent(articleId: string, now = new Date()): Promise<
  | { status: "ready"; article: Row; card: ReturnType<typeof card> }
  | { status: "skipped"; reason: string }
> {
  const [r] = await sql<Row[]>`
    SELECT p.article_id, p.selected, p.visibility, p.title, p.summary, p.reason, p.category, s.name AS source_name, s.tier AS source_tier, p.url,
           p.timeline_at, p.discovered_at, p.backfill, p.fact_id,
           coalesce((o.fields->>'silent')::boolean, false) AS silent
    FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
    WHERE p.article_id = ${articleId}`;
  if (!r || !r.selected || r.visibility !== "public") return { status: "skipped", reason: "not public selected" };
  if (r.silent) return { status: "skipped", reason: "silenced" };
  if (!PUSH_TIERS.includes(r.source_tier)) return { status: "skipped", reason: "not a first-party source" };
  if (r.backfill || now.getTime() - r.timeline_at.getTime() > MAX_AGE_MS) return { status: "skipped", reason: "not live" };

  return { status: "ready", article: r, card: card(r) };
}
