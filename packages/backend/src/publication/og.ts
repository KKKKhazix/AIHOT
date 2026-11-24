// Share images only need public title/summary metadata. Keep the same page visibility rule without
// loading bodies, translations, related stories or signed media that never appear on these cards.
// In English (the English pages' cards) the article reads as its English page does.
import type { Locale } from '@aihot/contracts/i18n';
import { CATEGORY_LABELS, categoryLabel, type CategoryKey } from '@aihot/contracts/taxonomy';
import { beijingDate, longDateEn } from '@aihot/contracts/time';
import { ITEM_COPY, withSubject } from '@aihot/site';
import type { OgCard } from '../media/og.ts';
import type { Poster } from '../media/poster.ts';
import { config } from '../config.ts';
import { sql } from '../db.ts';
import { inEnglish } from './english.ts';
import { hasItemPage, publicSourceName } from './rules.ts';

export async function loadItemShare(id: string, lang: Locale = 'zh') {
  const [row] = await sql<{
    id: string; title: string; summary: string | null; category: CategoryKey | null; selected: boolean;
    score: number | null; timeline_at: Date; source_name: string; source_mode: string; visibility: string;
  }[]>`SELECT p.article_id AS id, p.title, p.summary, p.category, p.selected, p.score, p.timeline_at,
      s.name AS source_name, s.participation_mode AS source_mode, p.visibility
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ${id}`;
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return null;
  const summaryOnly = row.visibility === 'summary-only';
  const share = { id: row.id, title: row.title, summary: row.summary, category: summaryOnly ? null : row.category, selected: !summaryOnly && row.selected,
    score: summaryOnly || row.score === null ? null : Math.round(Number(row.score)), timelineAt: row.timeline_at.toISOString(),
    source: { name: publicSourceName(row.source_name) } };
  if (lang === 'zh') return share;
  // Title and summary together, as on the page; the source by its English name.
  return inEnglish(share, (s, c) => {
    const [title, summary] = c.all([['headline', s.title], ['text', s.summary]], s.id);
    return { ...s, title, summary, source: { name: c.one('name', s.source.name) } };
  });
}

/** The article card used by both HTTP responses and preparation before publishing a link. */
export async function loadItemOgCard(id: string, lang: Locale = 'zh'): Promise<OgCard | null> {
  const item = await loadItemShare(id, lang);
  if (!item) return null;
  if (lang === 'en') {
    return {
      kicker: item.category ? categoryLabel(item.category, 'en') : withSubject('News'),
      title: item.title,
      subtitle: item.summary,
      meta: `${item.source.name} · ${longDateEn(beijingDate(item.timelineAt))}`,
      badge: item.selected && item.score !== null && ITEM_COPY.showScore ? { value: String(Math.round(item.score)), label: 'AI score' } : null,
      lang: 'en',
    };
  }
  return {
    kicker: item.category ? CATEGORY_LABELS[item.category] : withSubject('动态'),
    title: item.title,
    subtitle: item.summary,
    meta: `${item.source.name} · ${beijingDate(item.timelineAt)}`,
    badge: item.selected && item.score !== null && ITEM_COPY.showScore ? { value: String(Math.round(item.score)), label: '精选评分' } : null,
  };
}

/** The article's phone poster: its QR code opens the article's page in the poster's language. */
export async function loadItemPoster(id: string, lang: Locale = 'zh'): Promise<Poster | null> {
  const d = await loadItemShare(id, lang);
  if (!d) return null;
  const en = lang === 'en';
  return {
    url: `${config.siteUrl}${en ? '/en' : ''}/items/${d.id}`,
    kicker: d.category ? categoryLabel(d.category, lang) : withSubject(en ? 'News' : '动态'),
    title: d.title,
    summary: d.summary,
    source: d.source.name,
    date: en ? longDateEn(beijingDate(d.timelineAt)) : beijingDate(d.timelineAt),
    score: d.selected && ITEM_COPY.showScore ? d.score : null,
    // Only an English poster says so: a Chinese one keeps the cache key it had.
    ...(en ? { lang: 'en' as const } : {}),
  };
}
