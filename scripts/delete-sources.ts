// Deletes sources with all their articles (e.g. sources that can no longer be collected).
//   node --env-file=.env scripts/delete-sources.ts "<reason>" <source-id>...
// Items that were ever selected are withdrawn first, so sync clients get a removal; reports stop citing
// the deleted items (a report cites ids it cannot find as published).
import { audit } from "@aihot/backend/audit";
import { setVisibility } from "@aihot/backend/admin/content";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

const ACTOR = "ops-script";
const [reason, ...ids] = process.argv.slice(2);
if (!reason || ids.length === 0) throw new Error('usage: delete-sources.ts "<reason>" <source-id>...');

const sources = await sql<{ id: string; name: string }[]>`SELECT id, name FROM sources WHERE id IN ${sql(ids)}`;
for (const missing of ids.filter((id) => !sources.some((s) => s.id === id))) console.log(`${missing}: no such source`);
const articleIds = (await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id IN ${sql(ids)}`).map((r) => r.id);

const selected = await sql<{ article_id: string; version: number | null }[]>`
  SELECT p.article_id, o.version FROM publications p LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
  WHERE p.source_id IN ${sql(ids)} AND p.selected_ready_at IS NOT NULL AND p.visibility <> 'withdrawn'`;
for (const s of selected) await setVisibility(s.article_id, { visibility: "withdrawn", reason, version: s.version ?? 0 }, ACTOR);

/** Drops array entries and clears fields that point at a deleted item. */
function prune(node: unknown, gone: Set<string>): unknown {
  if (Array.isArray(node)) return node.filter((x) => !(x && typeof x === "object" && gone.has((x as { itemId?: string }).itemId ?? ""))).map((x) => prune(x, gone));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) && gone.has((v as { itemId?: string }).itemId ?? "") ? null : prune(v, gone)]));
  }
  return node;
}
const gone = new Set(articleIds);
let reports = 0;
for (const r of await sql<{ kind: string; key: string; content: unknown }[]>`SELECT kind, key, content FROM reports`) {
  const text = JSON.stringify(r.content);
  if (![...gone].some((id) => text.includes(id))) continue;
  await sql`UPDATE reports SET content = ${sql.json(prune(r.content, gone) as never)} WHERE kind = ${r.kind} AND key = ${r.key}`;
  reports += 1;
}

await sql.begin(async (tx) => {
  await tx`DELETE FROM articles WHERE source_id IN ${tx(ids)}`;
  await tx`DELETE FROM sources WHERE id IN ${tx(ids)}`;
});
for (const s of sources) await audit(ACTOR, "source.delete", `source:${s.id}`, reason, { name: s.name }, null);
console.log(`deleted ${sources.length} sources and ${articleIds.length} articles; withdrew ${selected.length} selected first; ${reports} report(s) no longer cite them`);
await stopBoss();
await closeDb();
