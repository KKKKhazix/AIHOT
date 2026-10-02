import { z } from "zod";
import * as cheerio from "cheerio";
import { sql } from "../db.ts";
import { loadReading, readingImages } from "../content/reading.ts";
import { bodyReadingMode, READING_POLICY } from "../content/reading-config.ts";
import { bodyToMarkdown, markdownToBody } from "../content/markdown.ts";
import { stripTags } from "../lib/text.ts";
import { sha256 } from "../lib/ids.ts";
import { readingAssetImage } from "../media/reading-images.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { audit, Conflict } from "../audit.ts";
import type { AdminBodyReading, BeforeJson } from "@aihot/contracts/admin";

export async function articleReadings(articleId: string) {
  return sql<BeforeJson<AdminBodyReading>[]>`SELECT r.id, r.input_revision, r.generation, r.mode, r.status, r.quality, r.model, r.prompt_version,
    r.body_markdown, r.coverage, r.error, r.silent, r.manual, r.created_at, r.finished_at, r.receipt_ids,
    (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.image_id), '[]') FROM article_image_readings i WHERE i.reading_id = r.id) AS images
    FROM article_readings r WHERE r.article_id = ${articleId} ORDER BY r.id DESC LIMIT 5`;
}

const requestKey = (key: string) => {
  if (!/^[\w-]{8,80}$/.test(key)) throw Object.assign(new Error("需要有效的请求编号"), { statusCode: 400 });
};

/** The article lock makes a repeated HTTP request idempotent, including generation and audit writes. */
export async function requestReading(articleId: string, requestId: string, actor: string, retry = false) {
  requestKey(requestId);
  const mode = bodyReadingMode();
  if (mode === "off") throw Object.assign(new Error("正文读取尚未启用，请先配置 BODY_READING_MODE"), { statusCode: 409 });
  return sql.begin(async (tx) => {
    const [a] = await tx`SELECT a.id, a.reading_generation, s.participation_mode FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE a.id = ${articleId} FOR UPDATE OF a`;
    if (!a) return null;
    if (a.participation_mode !== "editorial") throw new Conflict("只有参与内容编辑的信源可以读取正文");
    const [prior] = await tx<{ after: { jobId: string | null } }[]>`SELECT after FROM audit_log WHERE subject = ${`content:${articleId}`} AND action = 'content.read' AND request_id = ${requestId} LIMIT 1`;
    if (prior) return { jobId: prior.after.jobId };
    const [unknown] = await tx`SELECT 1 FROM receipts WHERE subject LIKE ${`article:${articleId}@%/reading:%`} AND status = 'unknown' LIMIT 1`;
    if (unknown) throw new Conflict("有付费结果尚未确认，请先在运行页核对回执");
    if (mode === "active" && !retry) await tx`UPDATE articles SET reading_generation = reading_generation + 1, processing_state = 'new', processing_error = NULL,
      processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = now() WHERE id = ${articleId}`;
    const jobId = await enqueue(QUEUES.readBody, { articleId, silent: true, requestKey: requestId, mode }, { singletonKey: `reading:${articleId}:${requestId}` }, tx);
    await audit(actor, "content.read", `content:${articleId}`,
      retry ? "重试未完成的图片" : mode === "shadow" ? "生成正文读取对照" : "重新读取正文",
      null, { jobId, retry, mode }, { requestId, db: tx });
    return { jobId };
  });
}

const CorrectionSchema = z.object({
  readingId: z.number().int().positive(), generation: z.number().int().nonnegative(),
  markdown: z.string().min(1).max(READING_POLICY.maxTextChars), reason: z.string().trim().min(1).max(1000),
}).strict();

/** Corrections create a new reading. Pasting an older verified version also provides rollback. */
export async function correctReading(articleId: string, input: unknown, requestId: string, actor: string) {
  requestKey(requestId);
  if (bodyReadingMode() !== "active") throw new Conflict("请启用正文读取后再应用人工修正；对照模式不会改变发布内容");
  const data = CorrectionSchema.parse(input);
  return sql.begin(async (tx) => {
    const [a] = await tx<{ revision: number; reading_generation: number }[]>`SELECT revision, reading_generation FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!a) return null;
    const [prior] = await tx<{ after: { readingId: number } }[]>`SELECT after FROM audit_log WHERE subject = ${`content:${articleId}`} AND action = 'content.reading-correct' AND request_id = ${requestId} LIMIT 1`;
    if (prior) return prior.after;
    if (a.reading_generation !== data.generation) throw new Conflict("正文已更新，请刷新后再修正");
    const old = await loadReading(data.readingId, tx);
    if (!old || old.article_id !== articleId || old.input_revision !== a.revision) throw new Conflict("这份读取结果不属于当前素材修订，请先重新读取正文");
    const html = markdownToBody(data.markdown);
    const $ = cheerio.load(html, null, false);
    const originals = new Set(old.source_blocks.filter((b) => b.kind === "image").map((b) => b.url));
    if ($("img[src]").toArray().some((node) => !originals.has($(node).attr("src")))) throw new Conflict("修正只能引用这份素材已有的图片");
    const images = await readingImages(old.id, tx);
    const retained = new Set($("img[src]").toArray().map((node) => $(node).attr("src")));
    if ([...retained].some((url) => !images.some((i) => i.url === url && i.asset_hash))) throw new Conflict("保留的图片缺少可核对的快照，请先重试下载，或移除图片后填写已核实的正文");
    const coverage = { ...old.coverage, read: images.filter((i) => retained.has(i.url)).length,
      ignored: images.filter((i) => !retained.has(i.url)).length, unreadable: 0 };
    const text = stripTags(html).trim();
    if (!text || text.length > READING_POLICY.maxTextChars) throw new Conflict("请提供完整、可读取的正文文字");
    const generation = a.reading_generation + 1;
    const [r] = await tx<{ id: number }[]>`INSERT INTO article_readings (article_id, input_revision, generation, input_hash, policy_hash, model, prompt_version, mode,
      status, quality, source_blocks, kept_block_ids, body_markdown, body_html, body_text, coverage, manual, silent, finished_at)
      VALUES (${articleId}, ${a.revision}, ${generation}, ${sha256(html)}, ${old.policy_hash}, 'manual', ${old.prompt_version}, 'active',
        'done', 'complete', ${tx.json(old.source_blocks as never)}, ${old.kept_block_ids}, ${bodyToMarkdown(html)}, ${html}, ${text}, ${tx.json(coverage)}, true, true, now()) RETURNING id`;
    await tx`INSERT INTO article_image_readings (reading_id, image_id, url, context_hash, asset_hash, tile_count, etag, last_modified, status, role, markdown, reason, uncertainties, regions, receipt_ids)
      SELECT ${r!.id}, image_id, url, context_hash, asset_hash, tile_count, etag, last_modified, status, role, markdown, reason, uncertainties, regions, receipt_ids
      FROM article_image_readings WHERE reading_id = ${old.id}`;
    for (const image of images) await tx`UPDATE article_image_readings SET status = ${retained.has(image.url) ? "read" : "ignored"},
      reason = ${`人工核对：${data.reason}`}, uncertainties = '[]'::jsonb WHERE reading_id = ${r!.id} AND image_id = ${image.image_id}`;
    await tx`UPDATE articles SET accepted_reading_id = ${r!.id}, reading_generation = ${generation}, processing_state = 'new', processing_attempts = 0,
      processing_error = NULL, processing_retry_at = NULL, processing_queued_at = now() WHERE id = ${articleId}`;
    await enqueue(QUEUES.analyze, { articleId }, { singletonKey: `reading-correct:${articleId}:${requestId}` }, tx);
    await audit(actor, "content.reading-correct", `content:${articleId}`, data.reason,
      { readingId: old.id }, { readingId: r!.id }, { requestId, db: tx });
    return { readingId: r!.id };
  });
}

export async function adminReadingImage(articleId: string, readingId: number, imageId: string): Promise<Buffer | null> {
  const r = await loadReading(readingId);
  if (!r || r.article_id !== articleId) return null;
  const image = (await readingImages(readingId)).find((i) => i.image_id === imageId);
  return image?.asset_hash ? readingAssetImage(image.asset_hash) : null;
}
