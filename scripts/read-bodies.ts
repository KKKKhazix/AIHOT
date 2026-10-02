// Bounded, explicit reprocessing. Dry-run by default; queues work, never calls a model here.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { requestReading } from "@aihot/backend/admin/readings";
import { bodyReadingMode } from "@aihot/backend/content/reading-config";
import { sha256 } from "@aihot/backend/lib/ids";

const { values } = parseArgs({ options: {
  id: { type: "string", multiple: true }, source: { type: "string" }, since: { type: "string" },
  limit: { type: "string", default: "20" }, apply: { type: "boolean", default: false },
  "request-id": { type: "string" }, "include-manual": { type: "boolean", default: false }, retry: { type: "boolean", default: false },
} });
try {
  if (!!values.id?.length === !!values.source) throw new Error("指定 --id（可重复）或 --source，二选一");
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (values.id?.length ?? 0) > 50) throw new Error("每批最多 50 篇，--limit 须为 1–50");
  const since = values.since ? new Date(values.since) : null;
  if (since && !Number.isFinite(since.getTime())) throw new Error("--since 须为有效日期");
  if (values.apply && (!values["request-id"] || !/^[\w-]{8,80}$/.test(values["request-id"]))) throw new Error("执行时须提供 8–80 位 --request-id；重试同一批使用相同编号");
  if (values.apply && bodyReadingMode() === "off") throw new Error("先配置 BODY_READING_MODE=shadow 或 active");
  const rows = await sql<{ id: string; title: string; revision: number }[]>`
    SELECT a.id, a.title, a.revision FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN article_readings r ON r.id = a.accepted_reading_id
    WHERE s.participation_mode = 'editorial'
      ${values.id ? sql`AND a.id IN ${sql(values.id)}` : sql`AND s.id = ${values.source!}`}
      ${since ? sql`AND coalesce(a.published_at, a.discovered_at) >= ${since}` : sql``}
      ${values["include-manual"] ? sql`` : sql`AND coalesce(r.manual, false) = false`}
    ORDER BY a.discovered_at DESC, a.id LIMIT ${limit}`;
  console.log(JSON.stringify({ mode: bodyReadingMode(), apply: values.apply, count: rows.length, articles: rows }, null, 2));
  if (values.apply) for (const row of rows) {
    const key = sha256(`${values["request-id"]}:${row.id}`);
    const result = await requestReading(row.id, key, "script:read-bodies", values.retry);
    console.log(JSON.stringify({ articleId: row.id, ...result }));
  }
} finally {
  await stopBoss();
  await closeDb();
}
