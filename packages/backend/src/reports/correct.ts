// A classification correction moves the same frozen entry; it never composes another issue or pays
// a writer. The override, publication, report revisions and audit commit in the caller's transaction.
import { RELEASE } from "@aihot/industry/taxonomy";
import type { Tx } from "../db.ts";
import { isRelease } from "../editorial/vocabulary.ts";
import { emit } from "../modules.ts";
import { SECTION_ORDER, sectionOf } from "./edition.ts";

interface Entry { itemId: string; followUp?: string; firstParty?: boolean; role?: string; [key: string]: unknown }
interface Group { label?: string; heading?: string; summary?: unknown; items?: Entry[]; storyRefs?: Entry[]; [key: string]: unknown }
interface Content { sections?: Group[]; themes?: Group[]; metrics?: Record<string, number>; [key: string]: unknown }

/** Moves the item to its new section in every issue that carries it; says whether any issue changed. */
export async function correctReportClassification(tx: Tx, articleId: string, reason: string): Promise<boolean> {
  const [item] = await tx<{ category: string | null }[]>`SELECT category FROM publications WHERE article_id=${articleId}`;
  if (!item?.category) return false;
  const reports = await tx<{ id: number; kind: string; content: Content; revision: number; generated_at: Date }[]>`
    SELECT id,kind,content,revision,generated_at FROM reports
    WHERE content @> ${tx.json({ sections: [{ items: [{ itemId: articleId }] }] })}
       OR content @> ${tx.json({ themes: [{ storyRefs: [{ itemId: articleId }] }] })}
    ORDER BY id FOR UPDATE`;
  let changed = false;
  for (const report of reports) {
    const content = structuredClone(report.content);
    const daily = report.kind === "daily";
    const groups = (daily ? content.sections : content.themes) ?? [];
    const labelKey = daily ? "label" : "heading";
    const entriesKey = daily ? "items" : "storyRefs";
    const from = groups.find(g => g[entriesKey]?.some(e => e.itemId === articleId));
    // Older, hand-written theme headings are not taxonomy columns; do not reinterpret their prose.
    if (!from || !SECTION_ORDER.includes(from[labelKey] ?? "")) continue;
    const label = sectionOf(item.category);
    if (from[labelKey] !== label) {
      const moving = from[entriesKey]!.filter(e => e.itemId === articleId);
      from[entriesKey] = from[entriesKey]!.filter(e => e.itemId !== articleId);
      let target = groups.find(g => g[labelKey] === label);
      if (!target) { target = { [labelKey]: label, [entriesKey]: [] }; groups.push(target); }
      target[entriesKey]!.push(...moving);
      if (!daily) { from.summary = null; target.summary = null; }
    }
    const arranged = groups.filter(g => g[entriesKey]?.length).sort((a, b) => SECTION_ORDER.indexOf(a[labelKey]!) - SECTION_ORDER.indexOf(b[labelKey]!));
    if (daily) {
      content.sections = arranged;
      // The release figure (dailyMetrics) follows the new classification; without a RELEASE kind there is none.
      if (RELEASE) {
        const entries = arranged.flatMap(g => g.items ?? []);
        const rows = await tx<{ article_id: string; category: string | null; tags: string[] }[]>`
          SELECT article_id,category,tags FROM publications WHERE article_id IN ${tx(entries.map(e => e.itemId))}`;
        const byId = new Map(rows.map(r => [r.article_id, r]));
        content.metrics = { ...content.metrics, modelsReleased: entries.filter(e => {
          const p = byId.get(e.itemId);
          return p && isRelease(p.category, p.tags) && !e.followUp && (e.firstParty || e.role === "官方" || e.role === "X·官方");
        }).length };
      }
    } else content.themes = arranged;
    if (JSON.stringify(content) === JSON.stringify(report.content)) continue;
    await tx`INSERT INTO report_revisions (report_id,revision,content,generated_at,reason)
      VALUES (${report.id},${report.revision},${tx.json(report.content as never)},${report.generated_at},${`classification ${articleId}: ${reason}`})`;
    await tx`UPDATE reports SET content=${tx.json(content as never)},revision=revision+1,updated_at=now() WHERE id=${report.id}`;
    changed = true;
  }
  if (changed) await emit("reportsChanged", { reason: `report classification ${articleId}` }, tx);
  return changed;
}
