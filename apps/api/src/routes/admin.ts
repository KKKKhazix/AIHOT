// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { strToU8, zipSync } from "fflate";
import type { AdminSourceUpdate } from "@aihot/contracts/admin";
import { actorOf } from "@aihot/backend/admin/auth";
import { navCounts } from "@aihot/backend/admin/navigation";
import { listAudit } from "@aihot/backend/audit";
import { importSelectBenchRun, listSelectBenchRuns, selectBenchRun } from "@aihot/backend/admin/selectbench";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { contentChain, overrideFields, rerun, searchContent, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { detachFromFact, mergeStories } from "@aihot/backend/events/corrections";
import { banFeedbackEmail, banSource, eraseFeedback, feedbackScreenshot, listFeedback, unbanSource, updateFeedback } from "@aihot/backend/admin/feedback";
import { requeueFailedArticles, runsOverview } from "@aihot/backend/admin/runs";
import { resolveDelivery } from "@aihot/backend/notify/deliver";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { replaceContactQr, setTargetEnabled, settingsOverview, updateBudget } from "@aihot/backend/admin/settings";
import { createSource, exportSources, fetchNow, listSources, lookupMpAccount, previewSource, previewStoredSource, setSourcesEnabled, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

// What every admin route reads its request with (the modules' admin routes too).
type Q = Record<string, string | undefined>;
export const q = (req: FastifyRequest) => req.query as Q;
export const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
export const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
export const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
export const page = (req: FastifyRequest) => Math.max(1, Number(q(req).page) || 1);

function sourceWorkbook(sources: Awaited<ReturnType<typeof exportSources>>["sources"]): Uint8Array {
  const escape = (value: unknown) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
  const columns = ["ID", "名称", "采集类型", "配置（JSON）", "标签", "等级", "参与方式", "信号组 ID", "主体 ID", "采集间隔（分钟）", "站内全文", "全文再分发", "启用"];
  const rows: unknown[][] = [columns, ...sources.map((s) => [s.id, s.name, s.kind, JSON.stringify(s.config), s.tags.join(", "), s.tier, s.participation_mode, s.signal_group_id, s.owner_entity_id, s.interval_minutes, s.site_fulltext ? "是" : "否", s.syndicate_fulltext ? "是" : "否", s.enabled ? "是" : "否"])];
  const sheet = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((value, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`).join("")}</row>`).join("");
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
  return zipSync({
    "[Content_Types].xml": strToU8(xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')),
    "_rels/.rels": strToU8(xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')),
    "xl/workbook.xml": strToU8(xml('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="信源" sheetId="1" r:id="rId1"/></sheets></workbook>')),
    "xl/_rels/workbook.xml.rels": strToU8(xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')),
    "xl/worksheets/sheet1.xml": strToU8(xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`)),
  }, { level: 6 });
}

function decodeImage(dataUrl: unknown): Buffer {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(String(dataUrl ?? ""));
  if (!m) throw Object.assign(new Error("image must be a PNG, JPEG or WebP data URL"), { statusCode: 400 });
  return Buffer.from(m[2]!, "base64");
}

export function registerAdmin(app: FastifyInstance) {
  // Sources
  app.get("/api/admin/sources", adminHandler(async (req) => {
    const f = q(req);
    return listSources({ q: f.q, kind: f.kind, health: f.health, mode: f.mode, enabled: f.enabled as "true" | "false" | undefined, page: page(req) });
  }));
  app.get("/api/admin/sources/export", adminHandler(async (_req, reply) => reply
    .header("Content-Type", "application/json; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="aihot-sources-${new Date().toISOString().slice(0, 10)}.json"`)
    .send(JSON.stringify(await exportSources(), null, 2))));
  app.get("/api/admin/sources/export.xlsx", adminHandler(async (_req, reply) => {
    const data = await exportSources();
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="aihot-sources-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(Buffer.from(sourceWorkbook(data.sources)));
  }));
  app.post("/api/admin/sources/wechat/lookup", adminHandler(async (req) => lookupMpAccount(body<{ input: string }>(req).input)));
  app.post("/api/admin/sources", adminHandler(async (req, _reply, admin) => createSource(body(req), actorOf(admin))));
  app.post("/api/admin/sources/bulk-enabled", adminHandler(async (req, _reply, admin) => {
    const b = body<{ ids: string[]; enabled: boolean }>(req);
    if (!Array.isArray(b.ids) || typeof b.enabled !== "boolean") throw Object.assign(new Error("请求参数无效"), { statusCode: 400 });
    return setSourcesEnabled(b.ids, b.enabled, actorOf(admin));
  }));
  app.post("/api/admin/sources/preview", adminHandler(async (req) => previewSource(body(req) as never)));
  app.get("/api/admin/sources/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await sourceDetail(param(req, "id")))));
  app.patch("/api/admin/sources/:id", adminHandler(async (req, reply, admin) => {
    const b = body<AdminSourceUpdate>(req);
    return orNotFound(req, reply, await updateSource(param(req, "id"), b, actorOf(admin)));
  }));
  app.post("/api/admin/sources/:id/preview", adminHandler(async (req, reply) => orNotFound(req, reply, await previewStoredSource(param(req, "id")))));
  app.post("/api/admin/sources/:id/fetch", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await fetchNow(param(req, "id"), actorOf(admin)))));

  // Content and events
  app.get("/api/admin/content", adminHandler(async (req) => ({ rows: await searchContent(q(req).q ?? "", q(req).view === "editorial-cases") })));
  app.get("/api/admin/content/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await contentChain(param(req, "id")))));
  app.post("/api/admin/content/:id/visibility", adminHandler(async (req, _reply, admin) => setVisibility(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/seo", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setSeoIndexed(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/content/:id/override", adminHandler(async (req, _reply, admin) => overrideFields(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/rerun", adminHandler(async (req, reply, admin) => {
    const b = body<import("@aihot/contracts/admin").AdminRerun>(req);
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await rerun(param(req, "id"), b.step, requestId, actorOf(admin), { preview: b.preview, version: b.version }));
  }));
  app.post("/api/admin/content/:id/detach", adminHandler(async (req, _reply, admin) => detachFromFact(param(req, "id"), String(body(req).reason ?? ""), actorOf(admin))));
  app.post("/api/admin/stories/merge", adminHandler(async (req, _reply, admin) => {
    const b = body<{ from: number; into: number; reason: string }>(req);
    return mergeStories(Number(b.from), Number(b.into), b.reason, actorOf(admin));
  }));

  // Feedback
  app.get("/api/admin/feedback", adminHandler(async (req) => listFeedback({ status: q(req).status, q: q(req).q, page: page(req) })));
  app.patch("/api/admin/feedback/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateFeedback(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/feedback/:id/erase", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await eraseFeedback(Number(param(req, "id")), String(body(req).reason ?? ""), actorOf(admin)))));
  app.get("/api/admin/feedback/:id/screenshot", adminHandler(async (req, reply) => {
    const file = await feedbackScreenshot(Number(param(req, "id")));
    const data = file ? await readFile(file).catch(() => null) : null;
    if (!data) return notFound(req, reply);
    const ext = file!.split(".").pop();
    return reply.type(ext === "jpeg" || ext === "jpg" ? "image/jpeg" : `image/${ext}`).send(data);
  }));
  app.post("/api/admin/feedback-bans", adminHandler(async (req, reply, admin) => {
    const b = body<{ sourceHash: string; feedbackId?: number; reason: string }>(req);
    if (b.feedbackId !== undefined) await banFeedbackEmail(b.feedbackId, b.reason, actorOf(admin));
    else await banSource(b.sourceHash, b.reason, actorOf(admin));
    return reply.code(204).send();
  }));
  app.delete("/api/admin/feedback-bans/:hash", adminHandler(async (req, reply, admin) => {
    await unbanSource(param(req, "hash"), actorOf(admin));
    return reply.code(204).send();
  }));

  // Runs
  app.get("/api/admin/runs", adminHandler(async () => runsOverview()));
  app.post("/api/admin/receipts/:id/release", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await releaseReceipt(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/deliveries/:id/resolve", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await resolveDelivery(Number(param(req, "id")), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/processing/requeue", adminHandler(async (req, _reply, admin) => requeueFailedArticles(body(req) as never, actorOf(admin))));

  // Settings
  app.get("/api/admin/settings", adminHandler(async () => settingsOverview()));
  app.post("/api/admin/settings/contact-qr", adminHandler(async (req, _reply, admin) => {
    const b = body<{ slot: "wechatQr" | "feishuQr"; image: string }>(req);
    return replaceContactQr({ slot: b.slot, data: decodeImage(b.image) }, actorOf(admin));
  }));
  app.post("/api/admin/notify-targets/:key", adminHandler(async (req, reply, admin) => {
    const b = body<{ enabled: boolean; reason: string }>(req);
    return orNotFound(req, reply, await setTargetEnabled(param(req, "key"), !!b.enabled, b.reason, actorOf(admin)));
  }));
  app.put("/api/admin/budgets/:service", adminHandler(async (req, _reply, admin) => updateBudget(param(req, "service"), body(req) as never, actorOf(admin))));


  // Models and evaluation
  app.get("/api/admin/models", adminHandler(async (req) => modelsOverview(Math.min(90, Number(q(req).days) || 7))));
  app.post("/api/admin/models/:capability", adminHandler(async (req, _reply, admin) => {
    const b = body<{ model: string | null; reason: string }>(req);
    return switchModel(param(req, "capability"), b.model ?? null, String(b.reason ?? ""), actorOf(admin));
  }));

  // SelectBench
  app.get("/api/admin/selectbench", adminHandler(async () => ({ runs: await listSelectBenchRuns() })));
  app.get("/api/admin/selectbench/:id", adminHandler(async (req, reply) => {
    const f = q(req);
    return orNotFound(req, reply, await selectBenchRun(param(req, "id"), { model: f.model, outcome: f.outcome, stratum: f.stratum, disagree: f.disagree === "1" }));
  }));
  app.post("/api/admin/selectbench/import", adminHandler(async (req, _reply, admin) => {
    const b = body<{ label: string; report: unknown }>(req);
    return importSelectBenchRun(b.report, String(b.label || "导入的对比运行"), actorOf(admin));
  }));

  // Attention counts for the navigation, and the audit trail.
  app.get("/api/admin/nav-counts", adminHandler(async () => navCounts()));
  app.get("/api/admin/audit", adminHandler(async (req) => listAudit({ subject: q(req).subject, action: q(req).action, page: page(req) })));
}
