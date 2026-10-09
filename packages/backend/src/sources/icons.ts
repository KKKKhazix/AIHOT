// Source icons ("来源图标缓存"): the face a source shows next to its reports and on the hot list.
// X accounts take the avatar on their latest post; 公众号 the account avatar on their latest article
// page; sites the best icon their home page declares. A source with none keeps its tinted initial.
import { sql } from "../db.ts";
import { guardedFetch, DEFAULT_UA } from "../lib/http-fetch.ts";
import { produceImage } from "../media/images.ts";
import { sourceOwnsPost } from "./account.ts";

const BATCH = 200;
// A site without an icon rarely grows one; 公众号 misses are mostly WeChat turning the server away for a while.
const RETRY_DAYS = 30;
const MP_RETRY_DAYS = 3;
const MP_PAUSE_MS = 3000;

/** X accounts: the avatar on the account's own latest post, kept current as avatars change. */
async function refreshXAvatars(): Promise<number> {
  const rows = await sql`
    UPDATE sources s SET icon_url = x.avatar
    FROM (
      SELECT DISTINCT ON (a.source_id) a.source_id, a.x_post->>'avatarUrl' AS avatar
      FROM articles a JOIN sources xs ON xs.id = a.source_id AND xs.kind = 'x_search'
      WHERE a.x_post ? 'avatarUrl'
        AND ${sourceOwnsPost(sql`xs.name`, sql`a.x_post->>'handle'`)}
      ORDER BY a.source_id, a.discovered_at DESC
    ) x
    WHERE s.id = x.source_id AND s.icon_url IS DISTINCT FROM x.avatar
    RETURNING s.id`;
  return rows.length;
}

/** A page's HTML; 公众号 article pages run to several megabytes, home pages rarely past four. */
async function page(url: string, maxBytes = 4_000_000): Promise<{ html: string; url: string } | null> {
  try {
    const res = await guardedFetch(url, { timeoutMs: 15_000, maxBytes, headers: { "user-agent": DEFAULT_UA, accept: "text/html,*/*;q=0.8" } });
    return res.status === 200 ? { html: res.text(), url: res.url } : null;
  } catch {
    return null;
  }
}

/** Icons a page declares, best first: touch icons (large PNGs), then sized icons, then the rest, then /favicon.ico. */
export function iconCandidates(html: string, base: string): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.includes("icon")) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || href.startsWith("data:")) continue;
    const size = Math.max(0, ...[...(/\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? "").matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1])));
    const score = (rel.includes("apple-touch-icon") ? 1000 : 0) + Math.min(size, 512) + (/\.svg(\?|$)/i.test(href) ? 200 : 0) - (/\.ico(\?|$)/i.test(href) ? 300 : 0);
    try {
      found.push({ href: new URL(href, base).toString(), score });
    } catch {
      // unusable href
    }
  }
  const ordered = found.sort((a, b) => b.score - a.score).map((f) => f.href);
  return [...new Set([...ordered, new URL("/favicon.ico", base).toString()])];
}

/** The first candidate the image proxy can turn into an avatar (which also warms its cache). */
async function firstUsable(candidates: string[]): Promise<string | null> {
  for (const url of candidates.slice(0, 5)) {
    try {
      await produceImage(url, "avatar");
      return url;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The site behind a source: the host most of its recent reports live on, else its configured address. */
function homeOf(articleUrls: string[], config: Record<string, unknown>): string | null {
  const origins = articleUrls.flatMap((u) => {
    try {
      return [new URL(u).origin];
    } catch {
      return [];
    }
  });
  const counts = new Map<string, number>();
  for (const o of origins) counts.set(o, (counts.get(o) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (top && n >= Math.max(1, origins.length * 0.7)) return top;
  const configured = String(config.url ?? config.feedUrl ?? "").replace(/^https?:\/\/r\.jina\.ai\//, "");
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

async function findIcon(kind: string, articleUrls: string[], config: Record<string, unknown>): Promise<string | null> {
  if (kind === "mp_account") {
    // WeChat answers bursts with "未知错误": take the account's two latest articles, slowly.
    for (const url of articleUrls.slice(0, 2)) {
      await new Promise((r) => setTimeout(r, MP_PAUSE_MS));
      const p = await page(url, 10_000_000);
      const avatar = p && /round_head_img\s*[:=]\s*["']([^"']+)["']/.exec(p.html)?.[1];
      if (avatar) return firstUsable([avatar.replace(/^http:/, "https:")]);
    }
    return null;
  }
  const home = homeOf(articleUrls, config);
  if (!home) return null;
  const p = await page(home);
  return firstUsable(p ? iconCandidates(p.html, p.url) : [`${home}/favicon.ico`]);
}

/** Sites and 公众号 without an icon: a batch per run, looking again after RETRY_DAYS (公众号: MP_RETRY_DAYS). */
async function findMissingIcons(): Promise<{ checked: number; found: number }> {
  const due = await sql<{ id: string; kind: string; config: Record<string, unknown>; urls: string[] | null }[]>`
    SELECT s.id, s.kind, s.config, a.urls
    FROM sources s
    LEFT JOIN LATERAL (SELECT array_agg(url) AS urls FROM (SELECT url FROM articles WHERE source_id = s.id ORDER BY discovered_at DESC LIMIT 10) r) a ON true
    WHERE s.icon_url IS NULL AND s.kind <> 'x_search'
      AND (s.icon_checked_at IS NULL OR s.icon_checked_at < now() - make_interval(days => CASE WHEN s.kind = 'mp_account' THEN ${MP_RETRY_DAYS}::int ELSE ${RETRY_DAYS}::int END))
    ORDER BY s.icon_checked_at NULLS FIRST, s.id
    LIMIT ${BATCH}`;
  let found = 0;
  for (const s of due) {
    const icon = await findIcon(s.kind, s.urls ?? [], s.config ?? {}).catch(() => null);
    if (icon) found++;
    await sql`UPDATE sources SET icon_url = coalesce(${icon}, icon_url), icon_checked_at = now() WHERE id = ${s.id}`;
  }
  return { checked: due.length, found };
}

export async function refreshSourceIcons() {
  const x = await refreshXAvatars();
  const sites = await findMissingIcons();
  return { xAvatars: x, ...sites };
}
