// A discovery channel is not the publisher. Explicit T1 URL scopes are verified ownership, even
// when collection is paused. Implicit web-list scopes need an actual discovery of this article.
import { audit } from "../audit.ts";
import { sql, type Db } from "../db.ts";
import { publishArticleTx } from "../publication/publish.ts";

/**
 * An UPDATE articles SET fragment: the article's grouping and its "adds value" check are decided again
 * (new material, an editorial publisher, a source turned editorial).
 */
export const groupingReset = () => sql`grouping_status = 'pending', grouped_at = NULL, grouping_receipt_id = NULL, grouping_error = NULL,
  selection_adds_value = NULL, selection_value_reason = NULL`;

interface Publisher {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  participation_mode?: string;
}

function ownershipUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** Explicit ownership scopes also work for shared hosts (e.g. one repository or publication). */
export function publisherOwnsUrl(source: Publisher, rawUrl: string): boolean {
  // Identity normalization folds www/http and strips tracking parameters; that is too broad for
  // ownership. Match the configured origin and path boundary without broadening either.
  const url = ownershipUrl(rawUrl);
  if (!url) return false;
  let scopes: string[];
  if (Array.isArray(source.config.publisherUrlPrefixes)) {
    scopes = source.config.publisherUrlPrefixes.filter((v): v is string => typeof v === "string");
  } else if (source.kind === "web_list" && typeof source.config.url === "string") {
    // A site's configured listing owns only its own path, not all links it points to.
    scopes = [source.config.url];
  } else {
    // Feed/API hosts are often distributors or shared platforms. Their address alone is not proof
    // of ownership; a source with a different article path needs an explicit publisher scope.
    return false;
  }
  return scopes.some((raw) => {
    const scope = ownershipUrl(raw);
    if (!scope) return false;
    if (scope.origin !== url.origin || scope.search || scope.hash) return false;
    const prefix = scope.pathname.replace(/\/$/, "");
    return !prefix || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  });
}

/** The caller holds the article row lock. A provenance-only repair preserves the material revision. */
export async function reconcileMaterialSource(db: Db, articleId: string, observed?: { sourceId: string; author?: string | null }): Promise<boolean> {
  const [article] = await db<{ source_id: string; url: string; author: string | null; participation_mode: string; analyzed: boolean }[]>`
    SELECT a.source_id, a.url, a.author, s.participation_mode,
      EXISTS (SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.input_revision = a.revision AND an.relevance IS NOT NULL) AS analyzed
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId} FOR UPDATE OF a`;
  if (!article) return false;
  const candidates = await db<Publisher[]>`
    SELECT s.id, s.kind, s.config, s.participation_mode FROM sources s
    WHERE s.tier = 'T1' AND (jsonb_typeof(s.config->'publisherUrlPrefixes') = 'array'
      OR (s.kind = 'web_list' AND NOT (s.config ? 'publisherUrlPrefixes')
        AND EXISTS (SELECT 1 FROM article_discoveries d WHERE d.article_id = ${articleId} AND d.source_id = s.id)))`;
  const owned = candidates.filter((s) => publisherOwnsUrl(s, article.url));
  if (owned.length !== 1) return false;
  const publisher = owned[0]!;
  if (publisher.id === article.source_id) return false;
  // Aggregator submitters are not article authors. Keep a name only from the publisher discovery.
  const author = observed?.sourceId === publisher.id ? observed.author?.trim() || null : null;
  // A completed signal has never been judged for editorial use. An existing judgement of this
  // revision is reusable, regardless of the source's current mode or generic processing state.
  const needsProcessing = article.participation_mode !== "editorial" && publisher.participation_mode === "editorial" && !article.analyzed;
  await db`UPDATE articles SET source_id = ${publisher.id}, author = ${author}, updated_at = now()
    ${needsProcessing ? sql`, processing_state = 'new', processing_queued_at = NULL, ${groupingReset()}` : sql``}
    WHERE id = ${articleId}`;
  await audit("system", "article.attribution", `article:${articleId}`, "唯一 T1 原发信源与已验证 URL 范围一致（显式配置或已观察官网列表）",
    { sourceId: article.source_id, author: article.author }, { sourceId: publisher.id, author }, { db });
  // This changes attribution and the public seat, not the judgement or selection threshold.
  await publishArticleTx(db as Parameters<typeof publishArticleTx>[0], articleId);
  return true;
}
