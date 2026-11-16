// 2026-11-14：所有信源每日取数上限（用户决定：海内外统一，每站每天只留最靠前的 10 条）。
//
// 背景：加完 12 个国内信源后，每天新增从 ~50 篇涨到 374 篇，而本地 27B 每晚只能分析 ~80–120 篇，
// 积压越滚越大、日报窗口变空。用户决定：所有站（海内外）每站每天只取最靠前的 10 条。
//
// 做法：按 source_id + 发布日分组，按 published_at DESC 排名，第 11 名以后的文章标 skipped，
// 不再进分析队列（不删除，保留可查）。只处理还处于 new 的文章，已分析的保持原样。
import { sql } from "../db.ts";

export async function capDailyPerSource(limit = 10): Promise<{ capped: number }> {
  const rows = await sql<{ id: string }[]>`
    WITH ranked AS (
      SELECT a.id,
             row_number() OVER (
               PARTITION BY a.source_id, date(coalesce(a.published_at, a.created_at))
               ORDER BY coalesce(a.published_at, a.created_at) DESC
             ) AS rn
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      WHERE s.kind <> 'external'
        AND a.processing_state = 'new'
    )
    UPDATE articles SET processing_state = 'skipped', processing_error = ${`daily-cap-${limit}`}
    WHERE id IN (SELECT id FROM ranked WHERE rn > ${limit})
    RETURNING id`;
  return { capped: rows.length };
}
