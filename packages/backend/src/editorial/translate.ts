// Full-text Chinese translations: made by the worker after an item
// is selected, for sources whose full text may be shown on the site; a page read never translates.
// Bodies are translated block by block (paragraphs, headings, list items, captions, table cells) so the
// sanitised structure stays as it is. Inside a block, images and inline code never reach the model
// (placeholders) and links keep only their text and an id; a block whose answer loses or repeats any of
// them is asked once more, then kept in the original. Each batch is a receipt, so a re-run reuses
// answers already paid for. A translation missing any block is stored as incomplete, never as whole.
// The post a selected X post quotes is translated too (once per quoted post, shared by every quote).
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import { sql } from "../db.ts";
import { sanitizeBody, textToHtml } from "../content/sanitize.ts";
import { chatJson } from "../providers/llm.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { isEmptyOrLinkOnly } from "../content/posts.ts";
import { sha256 } from "../lib/ids.ts";
import { modelFor } from "./models.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { emit } from "../modules.ts";

export const TRANSLATE_PROMPT_VERSION = promptVersion("translate-body", "translate-post");
const BATCH_CHARS = 3500;
/** Longer bodies get their first part translated and are marked incomplete. */
const MAX_CHARS = 60_000;
/** X posts shorter than this carry their meaning in the Chinese title and summary. */
const X_MIN_CHARS = 60;

const BLOCK = new Set(["p", "h2", "h3", "h4", "h5", "li", "blockquote", "figcaption", "td", "th", "dt", "dd", "caption"]);
const CONTAINER = /^(p|h[2-5]|li|blockquote|figcaption|td|th|dt|dd|caption|ul|ol|table|pre|figure|div)$/;

const Output = z.object({ t: z.array(z.string()) });

class TranslationInterruptedError extends Error {}

const SYSTEM_BODY = promptText("translate-body");

const SYSTEM_POST = promptText("translate-post");

export interface TranslateResult {
  articleId: string;
  status: "translated" | "partial" | "skipped";
  /** The article revision this result is about: the one read and translated, not a later one. */
  revision?: number;
  segments?: number;
  reason?: string;
}

const isChinese = (language: string | null, sample: string) => language === "zh" || (/[一-鿿]/.test(sample.slice(0, 400)) && language !== "en");

/** Leaf text blocks of a sanitised body, in document order, skipping code. */
function segmentsOf($: cheerio.CheerioAPI): Element[] {
  const out: Element[] = [];
  const visit = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      if (el.name === "pre" || el.name === "code") continue;
      const hasBlockChild = el.children.some((c) => c.type === "tag" && CONTAINER.test((c as Element).name));
      if (BLOCK.has(el.name) && !hasBlockChild) {
        if (/[A-Za-zÀ-ɏЀ-ӿ぀-ヿ]/.test($(el).text())) out.push(el);
        continue;
      }
      visit(el.children);
    }
  };
  visit($.root().children().toArray());
  return out;
}

async function translateBatch(articleId: string, revision: number, index: number, parts: string[], system: string, attemptTag?: string): Promise<string[] | null> {
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
  const model = await modelFor("translate");
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
  const res = await chatJson({
    model,
    purpose: "translate_body",
    subject: `article:${articleId}@${revision}#${index}`,
    promptVersion: TRANSLATE_PROMPT_VERSION,
    system,
    user: JSON.stringify({ segments: parts }),
    schema: Output,
    temperature: 0.2,
    maxTokens: Math.min(8000, Math.ceil(parts.join("").length * 1.2) + 400),
    timeoutMs: 180_000,
    attemptTag,
  });
  return res.data.t.length === parts.length ? res.data.t : null;
}

/** Translates batches, halving a batch once when the answer does not line up with the input. */
async function translateAll(articleId: string, revision: number, parts: string[], system: string, attemptTag?: string): Promise<Array<string | null>> {
  const out: Array<string | null> = new Array(parts.length).fill(null);
  let start = 0;
  let index = 0;
  while (start < parts.length) {
    let end = start;
    let chars = 0;
    while (end < parts.length && (end === start || chars + parts[end]!.length <= BATCH_CHARS)) chars += parts[end++]!.length;
    const batch = parts.slice(start, end);
    let done = await translateBatch(articleId, revision, index++, batch, system, attemptTag);
    if (!done && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await translateBatch(articleId, revision, index++, batch.slice(0, mid), system, attemptTag);
      const right = await translateBatch(articleId, revision, index++, batch.slice(mid), system, attemptTag);
      done = left && right ? [...left, ...right] : null;
    }
    if (done) done.forEach((t, i) => (out[start + i] = t));
    start = end;
  }
  return out;
}

/** A block as the model sees it: media and inline code as ⟦n⟧, links as <a id="Ln"> with their attributes kept here. */
interface Shielded {
  html: string;
  tokens: string[];
  links: Array<Record<string, string>>;
}

export function shield(inner: string): Shielded {
  const $ = cheerio.load(inner, null, false);
  const tokens: string[] = [];
  for (const node of $("picture, video, img, code").toArray()) {
    if ($(node).parents("picture, video, code").length) continue;
    tokens.push($.html(node));
    $(node).replaceWith(`⟦${tokens.length - 1}⟧`);
  }
  const links: Shielded["links"] = [];
  $("a").each((i, a) => {
    links.push({ ...(a as Element).attribs });
    (a as Element).attribs = { id: `L${i}` };
  });
  return { html: $.html(), tokens, links };
}

/** The translated block with its media, code and links put back; null when the answer lost or repeated any. */
export function unshield(translated: string, s: Shielded): string | null {
  const counts = new Map<number, number>();
  for (const m of translated.matchAll(/⟦(\d+)⟧/g)) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  if (counts.size !== s.tokens.length || s.tokens.some((_t, i) => counts.get(i) !== 1)) return null;
  const $ = cheerio.load(translated, null, false);
  const seen = new Set<number>();
  let intact = true;
  $("a").each((_i, a) => {
    const n = /^L(\d+)$/.exec((a as Element).attribs.id ?? "")?.[1];
    const attribs = n === undefined ? undefined : s.links[Number(n)];
    if (!attribs || seen.has(Number(n))) intact = false;
    else {
      seen.add(Number(n));
      (a as Element).attribs = attribs;
    }
  });
  if (!intact || seen.size !== s.links.length) return null;
  return $.html().replace(/⟦(\d+)⟧/g, (_m, n: string) => s.tokens[Number(n)]!);
}

export async function translateArticle(articleId: string): Promise<TranslateResult> {
  const [row] = await sql<{ revision: number; channel: string; language: string | null; body_html: string | null; body_text: string | null; x_post: { text?: string } | null; title: string; selected: boolean; body_mode: string; visibility: string }[]>`
    SELECT a.revision, p.channel, a.language, a.body_html, a.body_text, a.x_post, p.title, p.selected, p.body_mode, p.visibility
    FROM publications p JOIN articles a ON a.id = p.article_id WHERE p.article_id = ${articleId}`;
  if (!row) return { articleId, status: "skipped", reason: "not published" };
  const result = (r: Omit<TranslateResult, "articleId" | "revision">): TranslateResult => ({ articleId, revision: row.revision, ...r });
  if (!row.selected || row.visibility !== "public" || row.body_mode !== "full") return result({ status: "skipped", reason: "not a selected full-text item" });

  if (row.channel === "x") {
    const text = String(row.x_post?.text ?? row.body_text ?? "").trim();
    if (isEmptyOrLinkOnly(text)) return result({ status: "skipped", reason: "no text to translate" });
    const meaningful = collapseWhitespace(text.replace(/https?:\/\/\S+/g, ""));
    if (isChinese(row.language, text)) return result({ status: "skipped", reason: "already Chinese" });
    if (meaningful.length < X_MIN_CHARS) return result({ status: "skipped", reason: "short post" });
    const [t] = await translateAll(articleId, row.revision, [text], SYSTEM_POST);
    if (!t) return result({ status: "skipped", reason: "translation did not line up" });
    await store(articleId, row.revision, row.title, textToHtml(t), t, true);
    return result({ status: "translated", segments: 1 });
  }

  if (!row.body_html || isChinese(row.language, row.body_text ?? "")) return result({ status: "skipped", reason: "no foreign-language body" });
  const $ = cheerio.load(row.body_html, null, false);
  const blocks = segmentsOf($);
  if (!blocks.length) return result({ status: "skipped", reason: "no translatable text" });
  // Beyond the cap, only the leading blocks are translated; the rest keep the original text.
  let budget = MAX_CHARS;
  const chosen: Element[] = [];
  for (const el of blocks) {
    const html = $(el).html() ?? "";
    if (html.length > budget) break;
    budget -= html.length;
    chosen.push(el);
  }
  const shielded = chosen.map((el) => shield($(el).html() ?? ""));
  const restore = (answers: Array<string | null>) => answers.map((t, i) => (t === null ? null : unshield(t, shielded[i]!)));
  const translations = restore(await translateAll(articleId, row.revision, shielded.map((b) => b.html), SYSTEM_BODY));
  // Blocks whose answer dropped a link or an image are asked once more, on their own receipt.
  const missing = translations.flatMap((t, i) => (t === null ? [i] : []));
  if (missing.length) {
    const again = await translateAll(articleId, row.revision, missing.map((i) => shielded[i]!.html), SYSTEM_BODY, "retry");
    missing.forEach((i, k) => (translations[i] = again[k] ? unshield(again[k]!, shielded[i]!) : null));
  }
  let done = 0;
  chosen.forEach((el, i) => {
    const t = translations[i];
    if (t) {
      $(el).html(t);
      done += 1;
    }
  });
  if (!done) return result({ status: "skipped", reason: "no batch translated" });
  const complete = done === blocks.length;
  const html = sanitizeBody($.html());
  await store(articleId, row.revision, row.title, html, cheerio.load(html, null, false).root().text().trim(), complete);
  return result({ status: complete ? "translated" : "partial", segments: done });
}

async function store(articleId: string, revision: number, title: string, html: string, text: string, complete: boolean) {
  // Never over a translation of a later revision (a slow run finishing after a newer one).
  await sql.begin(async (tx) => {
    const changed = await tx`
      INSERT INTO translations (article_id, lang, revision, title, body_html, body_text, complete, origin)
      VALUES (${articleId}, 'zh', ${revision}, ${title}, ${html}, ${text}, ${complete}, 'model')
      ON CONFLICT (article_id, lang) DO UPDATE SET revision = EXCLUDED.revision, title = EXCLUDED.title, body_html = EXCLUDED.body_html,
        body_text = EXCLUDED.body_text, complete = EXCLUDED.complete, origin = 'model', created_at = now()
      WHERE translations.origin <> 'source' AND translations.revision <= EXCLUDED.revision
        AND (translations.revision, translations.title, translations.body_html, translations.body_text, translations.complete, translations.origin)
          IS DISTINCT FROM (EXCLUDED.revision, EXCLUDED.title, EXCLUDED.body_html, EXCLUDED.body_text, EXCLUDED.complete, EXCLUDED.origin)
      RETURNING article_id`;
    if (changed.length) await emit("articleChanged", { id: articleId, kind: "body", reason: "body translation" }, tx);
  });
}

/** A quoted post worth translating: at least a few letters beyond its links, and not already Chinese. */
function quoteTranslatable(text: string): boolean {
  const words = collapseWhitespace(text.replace(/https?:\/\/\S+/g, " "));
  return words.length >= 10 && (words.match(/\p{L}/gu) ?? []).length >= 2 && !/[一-鿿]/.test(words);
}

/**
 * The posts that selected X posts of the last `days` quote, translated once per quoted post: the
 * translation of the quoted post's own item is reused when it was collected and translated, else
 * DeepSeek (the translate model) translates it. Returns how many were stored.
 */
export async function translateQuotes(opts: { days?: number; limit?: number; budgetMs?: number } = {}): Promise<number> {
  const started = Date.now();
  const rows = await sql<{ tweet_id: string; text: string; text_hash: string | null; own_zh: string | null }[]>`
    SELECT DISTINCT ON (q.tweet_id) q.tweet_id, a.x_post->'quoted'->>'text' AS text, qt.text_hash,
      (SELECT tr.body_text FROM articles o JOIN translations tr ON tr.article_id = o.id AND tr.lang = 'zh' AND tr.revision >= o.revision
       WHERE o.identity_key = 'x:' || q.tweet_id AND tr.complete AND coalesce(tr.body_text, '') <> '') AS own_zh
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (SELECT substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') AS tweet_id) q
    LEFT JOIN quote_translations qt ON qt.tweet_id = q.tweet_id
    WHERE p.channel = 'x' AND p.selected AND p.visibility = 'public' AND p.body_mode = 'full'
      AND p.discovered_at > now() - make_interval(days => ${opts.days ?? 3})
      AND q.tweet_id IS NOT NULL AND coalesce(a.x_post->'quoted'->>'text', '') <> ''
    ORDER BY q.tweet_id, p.discovered_at DESC`;
  let stored = 0;
  for (const r of rows) {
    if (stored >= (opts.limit ?? 30) || Date.now() - started > (opts.budgetMs ?? 2 * 60_000) || shutdownSignal.signal.aborted) break;
    const hash = sha256(r.text);
    if (r.text_hash === hash || !quoteTranslatable(r.text)) continue;
    let zh = r.own_zh;
    let origin: "reused" | "model" = "reused";
    if (!zh) {
      origin = "model";
      try {
        const res = await chatJson({
          model: await modelFor("translate"), purpose: "translate_quoted", subject: `quote:${r.tweet_id}`, promptVersion: TRANSLATE_PROMPT_VERSION,
          system: SYSTEM_POST, user: JSON.stringify({ segments: [r.text] }), schema: Output, temperature: 0.2,
          maxTokens: Math.min(4000, Math.ceil(r.text.length * 1.5) + 200), timeoutMs: 120_000,
        });
        zh = res.data.t.length === 1 ? res.data.t[0]!.trim() : null;
      } catch (error) {
        // Switched-off calls or an exhausted budget stop the run; one unusable answer skips its post (its
        // receipt is reused next time, so a retry costs nothing).
        if (/disabled|not configured|budget/i.test((error as Error).message)) throw error;
        continue;
      }
    }
    if (!zh) continue;
    const changed = await sql.begin(async (tx) => {
      const saved = await tx`
        INSERT INTO quote_translations (tweet_id, text_hash, text_zh, origin) VALUES (${r.tweet_id}, ${hash}, ${zh}, ${origin})
        ON CONFLICT (tweet_id) DO UPDATE SET text_hash = EXCLUDED.text_hash, text_zh = EXCLUDED.text_zh, origin = EXCLUDED.origin, created_at = now()
        WHERE (quote_translations.text_hash, quote_translations.text_zh, quote_translations.origin)
          IS DISTINCT FROM (EXCLUDED.text_hash, EXCLUDED.text_zh, EXCLUDED.origin)
        RETURNING tweet_id`;
      if (!saved.length) return false;
      const cited = await tx<{ id: string }[]>`
        SELECT a.id FROM articles a JOIN publications p ON p.article_id = a.id
        WHERE substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') = ${r.tweet_id}`;
      for (const { id } of cited) await emit("articleChanged", { id, kind: "body", reason: "quoted post translation" }, tx);
      return true;
    });
    if (changed) stored += 1;
  }
  return stored;
}

/**
 * Every few minutes: selected full-text items discovered or revised in the last three days that lack a
 * translation of their current revision, then the posts selected X posts quote. Stops after a time
 * budget. A translation of an older revision is not shown (items.ts), so a revised item is translated
 * again whatever its age.
 */
export async function translatePending(opts: { limit?: number; budgetMs?: number } = {}): Promise<{ done: TranslateResult[]; quotes: number }> {
  const started = Date.now();
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p JOIN articles a ON a.id = p.article_id
    LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh'
    WHERE p.selected AND p.visibility = 'public' AND p.body_mode = 'full' AND coalesce(a.language, '') <> 'zh'
      AND (p.discovered_at > now() - interval '3 days'
           OR EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id = a.id AND r.revision = a.revision AND r.revision > 1
                      AND r.created_at > now() - interval '3 days'))
      AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND tr.revision < a.revision))
      AND NOT EXISTS (SELECT 1 FROM translation_attempts t WHERE t.article_id = p.article_id AND t.revision = a.revision
                      AND (t.outcome IN ('skipped', 'translated', 'partial') OR t.attempts >= 3))
    ORDER BY p.discovered_at DESC LIMIT ${opts.limit ?? 30}`;
  const done: TranslateResult[] = [];
  for (const r of rows) {
    if (Date.now() - started > (opts.budgetMs ?? 4 * 60_000) || shutdownSignal.signal.aborted) break;
    let outcome: "translated" | "partial" | "skipped" | "failed";
    let reason: string | null = null;
    // The attempt is recorded against the revision actually read: when the text was revised while the
    // model was answering, the new revision still has no attempt and is translated on the next run.
    let revision: number | null = null;
    try {
      const result = await translateArticle(r.article_id);
      done.push(result);
      outcome = result.status;
      reason = result.reason ?? null;
      revision = result.revision ?? null;
    } catch (error) {
      // A deploy stops between paid fragments, never aborts a sent request. Received answers stay
      // in receipts and are reused next run; do not mark an interrupted article terminal/partial.
      if (error instanceof TranslationInterruptedError) break;
      const message = (error as Error).message;
      // Switched-off model calls or an exhausted budget: stop this run without counting an attempt.
      if (/disabled|not configured|budget/i.test(message)) break;
      done.push({ articleId: r.article_id, status: "skipped", reason: message.slice(0, 200) });
      outcome = "failed";
      reason = message.slice(0, 300);
    }
    await sql`
      INSERT INTO translation_attempts (article_id, revision, attempts, outcome, reason)
      SELECT ${r.article_id}, coalesce(${revision}::int, a.revision), 1, ${outcome}, ${reason} FROM articles a WHERE a.id = ${r.article_id}
      ON CONFLICT (article_id) DO UPDATE SET
        attempts = CASE WHEN translation_attempts.revision = EXCLUDED.revision THEN translation_attempts.attempts + 1 ELSE 1 END,
        revision = EXCLUDED.revision, outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, updated_at = now()`;
  }
  const budgetMs = opts.budgetMs ?? 4 * 60_000;
  let quotes = 0;
  const left = budgetMs - (Date.now() - started);
  if (left > 0 && !shutdownSignal.signal.aborted) {
    try {
      quotes = await translateQuotes({ budgetMs: left });
    } catch (error) {
      if (error instanceof TranslationInterruptedError || /disabled|not configured|budget/i.test((error as Error).message)) return { done, quotes };
      throw error;
    }
  }
  return { done, quotes };
}
