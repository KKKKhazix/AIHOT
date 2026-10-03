// Selected-item pushes to the content groups. One card per new fact: a short same-title lease holds
// back concurrent duplicates until grouping settles the fact, and the fact (or the article when it
// has none) is the dedupe identity per target. Old, backfilled or silenced items are never pushed.
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { deliverContent } from "./deliver.ts";
import { selectedContent } from "./selected-content.ts";

const LEASE_MS = 10 * 60_000;

export type PushOutcome =
  | { status: "pushed" | "skipped"; reason?: string; targets?: Array<{ target: string; status: string }> }
  | { status: "retry"; after: Date; reason: string };

function normalizedTitle(t: string) {
  return t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export async function pushSelected(articleId: string, now = new Date()): Promise<PushOutcome> {
  const content = await selectedContent(articleId, now);
  if (content.status !== "ready") return content;
  const r = content.article;

  // Same-title lease: a concurrent report with the same headline waits for grouping.
  const leaseKey = `selected-title:${sha256(normalizedTitle(r.title)).slice(0, 24)}`;
  const [lease] = await sql<{ holder: string }[]>`
    INSERT INTO delivery_leases (lease_key, holder, expires_at) VALUES (${leaseKey}, ${articleId}, ${new Date(now.getTime() + LEASE_MS)})
    ON CONFLICT (lease_key) DO UPDATE SET holder = CASE WHEN delivery_leases.expires_at < ${now} THEN EXCLUDED.holder ELSE delivery_leases.holder END,
      expires_at = CASE WHEN delivery_leases.expires_at < ${now} THEN EXCLUDED.expires_at ELSE delivery_leases.expires_at END
    RETURNING holder`;
  if (lease && lease.holder !== articleId && !r.fact_id) return { status: "retry", after: new Date(now.getTime() + 2 * 60_000), reason: "same title in flight" };

  const dedupeKey = r.fact_id ? `selected:fact:${r.fact_id}` : `selected:article:${articleId}`;
  // Reports grouped into this fact after one of them was sent under an earlier fact still count as sent:
  // a sent or uncertain sibling among the current members stops the push.
  const siblings = r.fact_id
    ? (await sql<{ article_id: string }[]>`SELECT article_id FROM fact_articles WHERE fact_id = ${r.fact_id} AND article_id <> ${articleId}`).map((x) => x.article_id)
    : [];
  const targets = await deliverContent({ subjectKind: "selected", subjectId: articleId, dedupeKey, contentAt: r.discovered_at, card: content.card, siblings });
  return { status: targets.some((t) => t.status === "sent") ? "pushed" : "skipped", targets, reason: targets.length ? undefined : "no new target" };
}
