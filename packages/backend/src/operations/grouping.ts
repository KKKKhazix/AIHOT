// Selected candidates waiting for a news identity: one reader-impact view for alerts and the admin.
import type { AdminRuns, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { AUTO_RELEASE_NOTE } from "./recover.ts";

export const GROUPING_WARN_AFTER_MS = 10 * 60_000;
type WaitingNews = Omit<BeforeJson<AdminRuns>["grouping"]["items"][number], "since"> & { since: Date };

export async function waitingSelectedNews(): Promise<WaitingNews[]> {
  const rows = await sql<Array<Omit<WaitingNews, "recovery"> & { running: boolean; receipt_status: string | null; released: boolean }>>`
    SELECT p.article_id AS "articleId", p.title,
           -- Waiting since it became a candidate, its last revision or an admin's regroup request (requestRegroup's job).
           greatest(coalesce(p.selected_ready_at, p.discovered_at), revision.created_at,
                    (SELECT max(j.created_on) FROM pgboss.job j WHERE j.name = 'events.group' AND j.data->>'articleId' = a.id
                       AND j.singleton_key LIKE 'manual:group:%')) AS since,
           a.grouping_status = 'failed' AS failed, a.grouping_receipt_id AS "receiptId", a.grouping_error AS error,
           r.status AS receipt_status,
           EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = 'events.group' AND j.state IN ('created', 'retry', 'active')
                   AND j.data->>'articleId' = a.id) AS running,
           EXISTS (SELECT 1 FROM receipt_attempts attempt WHERE attempt.receipt_id = r.id
                   AND attempt.error LIKE ${AUTO_RELEASE_NOTE + "%"}) AS released
    FROM publications p JOIN articles a ON a.id = p.article_id LEFT JOIN receipts r ON r.id = a.grouping_receipt_id
    LEFT JOIN article_revisions revision ON revision.article_id = a.id AND revision.revision = a.revision
    WHERE p.selection_candidate AND p.eligible AND p.visibility = 'public' AND a.grouping_status <> 'complete'
    ORDER BY since, p.article_id`;
  return rows.map(({ running, receipt_status, released, ...row }) => ({
    ...row,
    recovery: receipt_status === "unknown" ? (released ? "manual" : "receipt")
      : !row.failed || running || receipt_status === "pending" ? "automatic" : "manual",
  }));
}

export function groupingOverview(items: WaitingNews[], now = Date.now()): BeforeJson<AdminRuns>["grouping"] {
  return {
    waiting: items.length,
    needsAttention: items.filter((item) => now - item.since.getTime() >= GROUPING_WARN_AFTER_MS).length,
    items: items.slice(0, 30),
  };
}
