// Manual changes: every change a person or an operations script makes is recorded — who,
// when, what, before and after, and why. A change made against a view that has moved on since is
// refused with a Conflict, which the admin API answers as 409.
import type { AdminAudit, AdminAuditEntry, BeforeJson } from "@aihot/contracts/admin";
import { sql, type Db } from "./db.ts";

export class Conflict extends Error {
  code = "conflict";
}

/** Every manual change: who, when, what, why. With `db`, the row commits with the caller's transaction. */
export async function audit(
  actor: string, action: string, subject: string | null, reason: string | null, before: unknown, after: unknown,
  opts: { requestId?: string; db?: Db } = {},
) {
  const db = opts.db ?? sql;
  await db`INSERT INTO audit_log (actor, action, subject, reason, before, after, request_id)
           VALUES (${actor}, ${action}, ${subject}, ${reason}, ${before === null || before === undefined ? null : db.json(before as never)},
                   ${after === null || after === undefined ? null : db.json(after as never)}, ${opts.requestId ?? null})`;
}

/** The latest manual changes of one subject (`source:<id>`, `content:<id>`), newest first. */
export async function auditHistory(subject: string, limit = 20): Promise<BeforeJson<AdminAuditEntry>[]> {
  return sql<BeforeJson<AdminAuditEntry>[]>`
    SELECT created_at, actor, action, reason, before, after FROM audit_log WHERE subject = ${subject} ORDER BY created_at DESC LIMIT ${limit}`;
}

/** The admin's audit page: every change, or those of one subject or action prefix, 100 a page. */
export async function listAudit(f: { subject?: string; action?: string; page: number }): Promise<BeforeJson<AdminAudit>> {
  const rows = await sql<BeforeJson<AdminAudit["rows"][number]>[]>`
    SELECT id, created_at, actor, action, subject, reason, before, after FROM audit_log
    WHERE (${f.subject ?? null}::text IS NULL OR subject = ${f.subject ?? null}) AND (${f.action ?? null}::text IS NULL OR action LIKE ${`${f.action ?? ""}%`})
    ORDER BY created_at DESC LIMIT 100 OFFSET ${(f.page - 1) * 100}`;
  return { page: f.page, rows };
}
