// One immutable evidence version before editorial judgement. All model calls use paid receipts.
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { newUuid, sha256, stableJson } from "../lib/ids.ts";
import { escapeXml, stripTags } from "../lib/text.ts";
import { chatJson, ModelOutputError, MODELS, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, rejectReceivedResponse } from "../providers/receipts.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { fetchReadingImage, ReadingImageDownloadError, type ReadingAsset } from "../media/reading-images.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { bodyBlocks, cleanTranscription, imageContext, type BodyBlock, type BodyRules } from "./blocks.ts";
import { bodyToMarkdown, markdownToBody } from "./markdown.ts";
import { textToHtml } from "./sanitize.ts";
import { BodySelectionSchema, ImageBatchSchema } from "./reading-schema.ts";
import { bodyReadingMode, readingModel, READING_POLICY as P } from "./reading-config.ts";

interface SourceInput {
  id: string; revision: number; reading_generation: number; title: string; url: string;
  body_html: string | null; body_snapshot_html: string | null; body_snapshot_selector: string | null; body_text: string | null;
  body_status: string; excerpt: string | null; x_post: Record<string, any> | null;
  media: Array<{ kind: string; url: string; alt?: string }>; config: { body?: BodyRules };
  participation_mode: string; accepted_reading_id: number | null;
}

export interface ReadingRow {
  id: number; article_id: string; input_revision: number; generation: number; input_hash: string; policy_hash: string;
  model: string; prompt_version: string; request_key: string | null; mode: "shadow" | "active"; status: string; quality: string;
  source_blocks: BodyBlock[]; kept_block_ids: string[] | null; body_markdown: string | null;
  body_html: string | null; body_text: string | null; coverage: Record<string, number>;
  receipt_ids: number[]; error: string | null; silent: boolean; manual: boolean;
}

export interface ImageRow {
  reading_id: number; image_id: string; url: string; context_hash: string; asset_hash: string | null;
  etag: string | null; last_modified: string | null; status: string; role: string | null; tile_count: number;
  markdown: string; reason: string | null; retryable: boolean; uncertainties: string[]; regions: unknown[]; receipt_ids: number[];
}

async function sourceInput(articleId: string, db: Db = sql): Promise<SourceInput | null> {
  const [a] = await db<SourceInput[]>`
    SELECT a.id, a.revision, a.reading_generation, a.title, a.url, a.body_html, a.body_snapshot_html, a.body_snapshot_selector, a.body_text,
           a.body_status, a.excerpt, a.media, a.x_post, a.accepted_reading_id, s.config, s.participation_mode
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  return a ?? null;
}

function inputBlocks(a: SourceInput): BodyBlock[] {
  if (!a.x_post) {
    const html = a.body_snapshot_html ?? a.body_html ?? textToHtml(a.body_text ?? a.excerpt ?? "");
    const blocks = bodyBlocks(html, a.url, a.config.body);
    // Some feed/ingest entrances carry image attachments separately from their HTML.
    if (!blocks.some((b) => b.kind === "image")) {
      for (const [i, m] of a.media.entries()) if (m.kind === "image" && /^https?:\/\//i.test(m.url)) {
        blocks.push({ id: `attachment-${i}`, kind: "image", html: imageHtml(m.url, m.alt ?? ""), text: "", url: m.url,
          alt: m.alt, owner: "article", before: (a.body_text ?? a.excerpt ?? "").slice(-1600) });
      }
    }
    return blocks;
  }
  const x = a.x_post;
  const sections = [{ owner: "post", label: `原帖 @${x.handle ?? "作者"}`, text: a.body_text || x.text || a.title, media: x.media ?? a.media },
    ...(x.quoted ? [{ owner: `quote-${x.quoted.handle ?? "author"}`, label: `引用 @${x.quoted.handle ?? "作者"}`, text: x.quoted.text ?? "", media: x.quoted.media ?? [] }] : [])];
  return sections.flatMap((s) => bodyBlocks(`<h2>${escapeXml(s.label)}</h2>${textToHtml(s.text)}${s.media
    .filter((m: { kind: string }) => m.kind === "image").map((m: { url: string; alt?: string }) => imageHtml(m.url, m.alt ?? "")).join("")}`, a.url, {}, s.owner));
}

function imageHtml(url: string, alt: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p><img src="${esc(url)}" alt="${esc(alt)}"></p>`;
}

const version = () => promptVersion("body-boundary", "body-reading");
function policyHash(model: string, rules: BodyRules | undefined): string {
  const spec = MODELS[model]!;
  return sha256(stableJson({ policy: P, prompt: version(), model, modelName: spec.model, extra: spec.extra ?? null, rules: rules ?? {} }));
}

export class ReadingInterruptedError extends Error {}
export class ReadingBusyError extends Error {}
function checkRunning() {
  if (shutdownSignal.signal.aborted) throw new ReadingInterruptedError("正文读取在停止进程后等待恢复");
}

export async function readingImages(id: number, db: Db = sql): Promise<ImageRow[]> {
  return db<ImageRow[]>`SELECT * FROM article_image_readings WHERE reading_id = ${id} ORDER BY image_id`;
}

export async function loadReading(id: number, db: Db = sql): Promise<ReadingRow | null> {
  const [row] = await db<ReadingRow[]>`SELECT * FROM article_readings WHERE id = ${id}`;
  return row ?? null;
}

export function validReading(a: { revision: number; reading_generation: number }, r: ReadingRow | null): boolean {
  return !!r && r.mode === "active" && r.status === "done" && r.quality === "complete" && r.input_revision === a.revision && r.generation === a.reading_generation;
}

export async function needsBodyReading(articleId: string, db: Db = sql): Promise<boolean> {
  if (bodyReadingMode() !== "active") return false;
  const a = await sourceInput(articleId, db);
  if (!a || a.participation_mode !== "editorial") return false;
  return !validReading(a, a.accepted_reading_id ? await loadReading(a.accepted_reading_id, db) : null);
}

/** Resumes a partially read version; explicit retries increment generation at enqueue time. */
export async function readArticle(articleId: string, opts: { silent?: boolean; requestKey?: string; mode?: "shadow" | "active" } = {}): Promise<{ reading: ReadingRow | null; activated: boolean; stale: boolean }> {
  const configuredMode = bodyReadingMode();
  const mode = configuredMode === "off" ? "off" : opts.mode === "shadow" ? "shadow" : configuredMode;
  if (mode === "off" || !config.modelCallsEnabled) return { reading: null, activated: false, stale: false };
  const a = await sourceInput(articleId);
  if (!a || a.participation_mode !== "editorial") return { reading: null, activated: false, stale: false };
  const model = await readingModel();
  const policy = policyHash(model, a.config.body);
  const blocks = inputBlocks(a);
  const inputHash = sha256(stableJson({ title: a.title, url: a.url, bodyStatus: a.body_status, blocks, sample: mode === "shadow" ? opts.requestKey ?? null : null }));
  const [reading] = await sql<ReadingRow[]>`
    INSERT INTO article_readings (article_id, input_revision, generation, input_hash, policy_hash, model, prompt_version, mode, source_blocks, silent, request_key)
    VALUES (${articleId}, ${a.revision}, ${a.reading_generation}, ${inputHash}, ${policy}, ${model}, ${version()}, ${mode}, ${sql.json(blocks as never)}, ${opts.silent ?? false}, ${opts.requestKey ?? null})
    ON CONFLICT (article_id, input_revision, generation, input_hash, policy_hash, mode) DO UPDATE SET input_hash = EXCLUDED.input_hash
    RETURNING *`;
  const r = reading!;
  if (r.status === "done" && r.quality === "complete") return activate(a, r);
  checkRunning();
  const lease = newUuid();
  const claimed = await sql`UPDATE article_readings SET status = 'running', error = NULL, request_key = coalesce(${opts.requestKey ?? null}, request_key), lease_id = ${lease}, lease_expires_at = now() + interval '45 minutes'
    WHERE id = ${r.id} AND (lease_id IS NULL OR lease_expires_at < now())`;
  if (!claimed.count) throw new ReadingBusyError("这份正文正在读取，请稍后重试");
  try {
    const textChars = blocks.reduce((n, b) => n + b.text.length, 0);
    if (blocks.length > P.maxBlocks || textChars > P.maxTextChars) return finish(a, r, [], "needs_review", "正文超过读取上限，需要分篇核对");
    let kept = r.kept_block_ids;
    if (!kept) {
      const text = blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
      const linked = (a.body_html ?? "").match(/<a\b/g)?.length ?? 0;
      const ambiguous = !a.x_post && !(a.config.body?.selector && a.body_snapshot_selector === a.config.body.selector) && (a.body_status !== "ok" || text.length < 200 || linked > blocks.length / 2);
      if (ambiguous && blocks.length) {
        checkRunning();
        const answer = await chatJson({ model, purpose: "body_boundary", subject: `article:${articleId}@${a.revision}/reading:${r.id}`,
          promptVersion: version(), system: promptText("body-boundary"), user: stableJson({ title: a.title, url: a.url, policy,
            blocks: blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, ...(b.kind === "image" ? imageContext(b) : {}) })) }),
          schema: BodySelectionSchema, temperature: 0, maxTokens: 6000, rejectTruncated: true, attemptTag: opts.requestKey ?? r.request_key ?? undefined });
        const ids = new Set(blocks.map((b) => b.id));
        if (new Set(answer.data.keepBlockIds).size !== answer.data.keepBlockIds.length || answer.data.keepBlockIds.some((id) => !ids.has(id))) {
          await rejectReceivedResponse(answer.receiptId, "invalid body block references");
          throw new ModelOutputError("正文判断返回了重复或不存在的内容块");
        }
        await sql.begin(async (tx) => {
          await tx`UPDATE article_readings SET receipt_ids = array_append(receipt_ids, ${answer.receiptId}) WHERE id = ${r.id}`;
          await completeReceipt(tx, answer.receiptId);
        });
        if (!answer.data.confirmed || !answer.data.keepBlockIds.length) return finish(a, r, [], "needs_review", answer.data.reason || "无法确认正文范围");
        kept = answer.data.keepBlockIds;
      } else kept = blocks.map((b) => b.id);
      await sql`UPDATE article_readings SET kept_block_ids = ${kept} WHERE id = ${r.id}`;
    }
    const selected = blocks.filter((b) => kept!.includes(b.id));
    const images = selected.filter((b) => b.kind === "image");
    for (const b of images) {
      await sql`INSERT INTO article_image_readings (reading_id, image_id, url, context_hash, status, reason)
        VALUES (${r.id}, ${b.id}, ${b.url!}, ${sha256(stableJson(imageContext(b)))}, ${b.rule === "remove" ? "ignored" : "pending"}, ${b.rule === "remove" ? "信源配置排除" : null})
        ON CONFLICT DO NOTHING`;
    }
    let pending: Array<{ block: BodyBlock; asset: ReadingAsset }> = [];
    let tileCount = 0;
    const flush = async () => {
      if (!pending.length) return;
      checkRunning();
      const user: ContentPart[] = [{ type: "text", text: stableJson({ title: a.title, url: a.url, policy }) }];
      for (const { block, asset } of pending) {
        user.push({ type: "text", text: stableJson({ ...imageContext(block), assetHash: asset.hash, tiles: asset.tiles.map((t, i) => ({ tile: i, ...t.region })) }) });
        asset.tiles.forEach((tile, i) => user.push({ type: "text", text: `${block.id} tile ${i}` }, tile.part));
      }
      const answer = await chatJson({ model, purpose: "body_reading", subject: `article:${articleId}@${a.revision}/reading:${r.id}`,
        promptVersion: version(), system: promptText("body-reading"), user, schema: ImageBatchSchema, temperature: 0, maxTokens: 16000, rejectTruncated: true, attemptTag: opts.requestKey ?? r.request_key ?? undefined });
      const expected = new Set(pending.map((p) => p.block.id));
      if (answer.data.images.length !== expected.size || new Set(answer.data.images.map((i) => i.imageId)).size !== expected.size || answer.data.images.some((i) => !expected.has(i.imageId))) {
        await rejectReceivedResponse(answer.receiptId, "incomplete image coverage");
        throw new ModelOutputError("图片结果未完整覆盖本批图片");
      }
      await sql.begin(async (tx) => {
        for (const value of answer.data.images) {
          const source = pending.find((p) => p.block.id === value.imageId)!;
          const markdown = cleanTranscription(value.markdown);
          const invalid = (value.status === "ignored" && (value.role !== "decorative" || source.block.rule === "keep")) ||
            (value.status === "read" && (!markdown || value.uncertainties.length > 0 || value.role === "unknown" || value.role === "decorative")) ||
            value.regions.some((region) => region.tile >= source.asset.tiles.length);
          const status = invalid ? "unreadable" : value.status;
          await tx`UPDATE article_image_readings SET status = ${status}, retryable = false, role = ${value.role}, markdown = ${status === "read" ? markdown : ""},
            reason = ${invalid ? "识别结果不满足完整性要求" : value.reason}, uncertainties = ${tx.json(value.uncertainties)},
            regions = ${tx.json(value.regions)}, receipt_ids = ${[answer.receiptId]} WHERE reading_id = ${r.id} AND image_id = ${value.imageId}`;
        }
        await tx`UPDATE article_readings SET receipt_ids = array_append(receipt_ids, ${answer.receiptId}) WHERE id = ${r.id}`;
        await completeReceipt(tx, answer.receiptId);
      });
      pending = [];
    };
    const stored = new Map((await readingImages(r.id)).map((i) => [i.image_id, i]));
    const allowed = new Set(images.filter((b) => b.rule !== "remove").slice(0, P.maxImages).map((b) => b.id));
    tileCount = [...stored.values()].filter((i) => i.status === "read").reduce((n, i) => n + i.tile_count, 0);
    for (const block of images) {
      const old = stored.get(block.id)!;
      if (old.status === "ignored" || old.status === "read") continue;
      checkRunning();
      if (!allowed.has(block.id)) {
        await markUnreadable(r.id, block.id, "超过单篇图片上限，需要分批核对");
        continue;
      }
      let asset: ReadingAsset;
      try {
        const [prior] = await sql<ImageRow[]>`SELECT i.* FROM article_image_readings i JOIN article_readings r ON r.id = i.reading_id
          WHERE r.article_id = ${articleId} AND i.url = ${block.url!} AND i.asset_hash IS NOT NULL ORDER BY r.id DESC LIMIT 1`;
        asset = await fetchReadingImage(block.url!, prior?.asset_hash ? { hash: prior.asset_hash, etag: prior.etag, lastModified: prior.last_modified } : undefined);
        if (tileCount + asset.tiles.length > P.maxTiles) throw new Error("超过单篇图片分段上限，需要核对剩余图片");
        tileCount += asset.tiles.length;
        await sql`UPDATE article_image_readings SET asset_hash = ${asset.hash}, etag = ${asset.etag}, last_modified = ${asset.lastModified}, tile_count = ${asset.tiles.length}, status = 'pending'
          WHERE reading_id = ${r.id} AND image_id = ${block.id}`;
      } catch (error) {
        await markUnreadable(r.id, block.id, String(error instanceof Error ? error.message : error).slice(0, 1000), error instanceof ReadingImageDownloadError);
        continue;
      }
      if (pending.length >= P.maxBatchImages || pending.reduce((n, p) => n + p.asset.tiles.length, 0) + asset.tiles.length > P.maxBatchTiles) await flush();
      pending.push({ block, asset });
    }
    await flush();
    const completed = await readingImages(r.id);
    const partial = completed.some((i) => !["read", "ignored"].includes(i.status));
    return finish(a, r, selected, partial ? "partial" : "complete", partial ? "部分图片未读清，请核对或重试" : null);
  } catch (error) {
    await sql`UPDATE article_readings SET status = 'failed', error = ${String(error instanceof Error ? error.message : error).slice(0, 1000)} WHERE id = ${r.id} AND lease_id = ${lease}`;
    throw error;
  } finally {
    await sql`UPDATE article_readings SET lease_id = NULL, lease_expires_at = NULL WHERE id = ${r.id} AND lease_id = ${lease}`;
  }
}

async function markUnreadable(id: number, imageId: string, reason: string, retryable = false) {
  await sql`UPDATE article_image_readings SET status = 'unreadable', retryable = ${retryable}, reason = ${reason} WHERE reading_id = ${id} AND image_id = ${imageId}`;
}

async function finish(a: SourceInput, r: ReadingRow, blocks: BodyBlock[], quality: string, error: string | null) {
  const images = await readingImages(r.id);
  const byId = new Map(images.map((i) => [i.image_id, i]));
  const markdown = blocks.map((b) => {
    if (b.kind === "text") return bodyToMarkdown(b.html);
    const i = byId.get(b.id);
    if (i?.status === "ignored") return "";
    const original = bodyToMarkdown(b.html);
    return [original, i?.status === "read" ? `> 图片${i.role === "table" ? "表格" : "文字"}\n\n${i.markdown}` : `> 此图片尚未完整读取。`].join("\n\n");
  }).filter(Boolean).join("\n\n");
  const html = markdownToBody(markdown, a.url);
  const text = stripTags(html).trim();
  if (!text && !images.some((i) => i.status === "read")) { quality = "needs_review"; error = "没有确认到有效正文"; }
  if (text.length > P.maxTextChars) { quality = "needs_review"; error = "整理后正文超过分析上限，需要分篇核对"; }
  const coverage = { candidates: r.source_blocks.filter((b) => b.kind === "image").length, selected: images.length,
    read: images.filter((i) => i.status === "read").length, ignored: images.filter((i) => i.status === "ignored").length,
    unreadable: images.filter((i) => !["read", "ignored"].includes(i.status)).length };
  const [done] = await sql<ReadingRow[]>`UPDATE article_readings SET status = 'done', quality = ${quality},
    body_markdown = ${markdown}, body_html = ${html}, body_text = ${text}, coverage = ${sql.json(coverage)},
    asset_set_hash = ${sha256(stableJson(images.map((i) => [i.image_id, i.asset_hash])))}, error = ${error}, finished_at = now()
    WHERE id = ${r.id} RETURNING *`;
  return activate(a, done!);
}

async function activate(a: SourceInput, r: ReadingRow): Promise<{ reading: ReadingRow; activated: boolean; stale: boolean }> {
  if (r.quality !== "complete" || r.mode !== "active" || bodyReadingMode() !== "active") return { reading: r, activated: false, stale: false };
  const chosen = await readingModel();
  const now = await sourceInput(a.id);
  if (!now || policyHash(chosen, now.config.body) !== r.policy_hash) return { reading: r, activated: false, stale: true };
  const updated = await sql`UPDATE articles SET accepted_reading_id = ${r.id}, processing_state = 'new', processing_error = NULL,
    processing_attempts = 0, processing_retry_at = NULL
    WHERE id = ${a.id} AND revision = ${r.input_revision} AND reading_generation = ${r.generation}
      AND (accepted_reading_id IS NULL OR accepted_reading_id <= ${r.id})`;
  return { reading: r, activated: updated.count > 0, stale: updated.count === 0 };
}
