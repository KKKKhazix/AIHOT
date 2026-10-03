// Daily IndexNow submission of newly indexable URLs and topic pages with new reports.
// INDEXNOW_SUBMIT_ENABLED is the safety valve: off (the default) the list is computed and recorded but
// nothing is sent. Needs INDEXNOW_KEY.
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { siteUrl } from "../publication/links.ts";
import { evidenceCondition, listedCondition } from "../publication/scope.ts";
import { topicPageCounts } from "../publication/topics.ts";

const MAX_URLS = 10_000;
const MAX_STORIES = 3_000;

export async function submitIndexNow(now = new Date()) {
  const [state] = await sql<{ value: { since: string } }[]>`SELECT value FROM settings WHERE key = 'indexnow.watermark'`;
  const since = state ? new Date(state.value.since) : new Date(now.getTime() - 86400_000);
  const reports = await sql<{ kind: string; key: string }[]>`SELECT kind, key FROM reports WHERE generated_at > ${since} AND generated_at <= ${now}`;
  // Stories the sitemap lists: with listed evidence of their own.
  const storyRows = await sql<{ public_id: string; created_at: Date }[]>`
    SELECT public_id::text, created_at FROM stories WHERE merged_into IS NULL AND created_at > ${since} AND created_at <= ${now} AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = stories.id AND ${evidenceCondition()} AND ${listedCondition(now)})
    ORDER BY created_at, id LIMIT ${MAX_STORIES + 1}`;
  const stories = storyRows.slice(0, MAX_STORIES);
  // Indexed topic pages a report reached since the last run (their first page; the rest only shift).
  const topics = (await topicPageCounts()).filter((t) => t.indexable && t.changedAt && t.changedAt > since && t.changedAt <= now);
  // Items fill the rest of the batch, oldest change first. What does not fit is sent by the next run:
  // the watermark stops at the last row sent (rows of that same millisecond are sent again, not skipped).
  const room = MAX_URLS - reports.length - stories.length - topics.length;
  const items = await sql<{ id: string; updated_at: Date }[]>`
    SELECT article_id AS id, updated_at FROM publications WHERE visibility = 'public' AND indexable AND updated_at > ${since} AND updated_at <= ${now}
    ORDER BY updated_at, article_id LIMIT ${room + 1}`;
  const sent = items.slice(0, room);
  const stops = [
    items.length > room && sent.length ? sent[sent.length - 1]!.updated_at.getTime() - 1 : null,
    storyRows.length > MAX_STORIES ? stories[stories.length - 1]!.created_at.getTime() - 1 : null,
  ].filter((t): t is number => t !== null);
  const watermark = stops.length ? new Date(Math.min(...stops)) : now;
  const urls = [
    ...sent.map((i) => siteUrl(`/items/${i.id}`)),
    ...reports.map((r) => siteUrl(`/${r.kind}/${r.key}`)),
    ...stories.map((s) => siteUrl(`/story/${s.public_id}`)),
    ...topics.map((t) => siteUrl(`/topics/${t.slug}`)),
  ];
  let status: "sent" | "disabled" | "empty" | "failed" = urls.length ? "disabled" : "empty";
  let httpStatus: number | null = null;
  const key = config.indexNowKey;
  if (urls.length && config.indexNowSubmitEnabled && key) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(config.siteUrl).host, key, keyLocation: siteUrl(`/${key}.txt`), urlList: urls }),
      signal: AbortSignal.timeout(30_000),
    });
    httpStatus = res.status;
    status = res.ok ? "sent" : "failed";
  }
  if (status !== "failed") {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('indexnow.watermark', ${sql.json({ since: watermark.toISOString() })}, 'worker')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
  return { status, httpStatus, urls: urls.length, more: stops.length > 0, sample: urls.slice(0, 3) };
}
