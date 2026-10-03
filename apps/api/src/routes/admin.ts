// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FEATURES } from "@aihot/industry/features";
import { actorOf } from "@aihot/backend/admin/auth";
import { navCounts } from "@aihot/backend/admin/navigation";
import { listAudit } from "@aihot/backend/audit";
import { importSelectBenchRun, listSelectBenchRuns, selectBenchRun } from "@aihot/backend/admin/selectbench";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { contentChain, overrideFields, rerun, searchContent, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { detachFromFact, mergeStories } from "@aihot/backend/events/corrections";
import { banSource, eraseFeedback, feedbackScreenshot, listFeedback, unbanSource, updateFeedback } from "@aihot/backend/admin/feedback";
import { listMonitorEvents, listMonitorPosts, relinkPost, resolveMonitorPost, reviewReceipt, setWithdrawn, updateMonitorEvent } from "@aihot/backend/admin/monitor";
import { requeueFailedArticles, runsOverview } from "@aihot/backend/admin/runs";
import { resolveDelivery } from "@aihot/backend/notify/deliver";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { replaceContactQr, setTargetEnabled, settingsOverview, updateBudget } from "@aihot/backend/admin/settings";
import { createSource, fetchNow, listSources, previewSource, previewStoredSource, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

type Q = Record<string, string | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
const page = (req: FastifyRequest) => Math.max(1, Number(q(req).page) || 1);

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
  app.post("/api/admin/sources", adminHandler(async (req, _reply, admin) => createSource(body(req), actorOf(admin))));
  app.post("/api/admin/sources/preview", adminHandler(async (req) => previewSource(body(req) as never)));
  app.get("/api/admin/sources/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await sourceDetail(param(req, "id")))));
  app.patch("/api/admin/sources/:id", adminHandler(async (req, reply, admin) => {
    const b = body<{ patch: unknown; version: string; reason?: string }>(req);
    return orNotFound(req, reply, await updateSource(param(req, "id"), b, actorOf(admin)));
  }));
  app.post("/api/admin/sources/:id/preview", adminHandler(async (req, reply) => orNotFound(req, reply, await previewStoredSource(param(req, "id")))));
  app.post("/api/admin/sources/:id/fetch", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await fetchNow(param(req, "id"), actorOf(admin)))));

  // Content and events
  app.get("/api/admin/content", adminHandler(async (req) => ({ rows: await searchContent(q(req).q ?? "") })));
  app.get("/api/admin/content/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await contentChain(param(req, "id")))));
  app.post("/api/admin/content/:id/visibility", adminHandler(async (req, _reply, admin) => setVisibility(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/seo", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setSeoIndexed(param(req, "id"), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/content/:id/override", adminHandler(async (req, _reply, admin) => overrideFields(param(req, "id"), body(req) as never, actorOf(admin))));
  app.post("/api/admin/content/:id/rerun", adminHandler(async (req, reply, admin) => {
    const b = body<{ step: "extract" | "analyze" | "group" }>(req);
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await rerun(param(req, "id"), b.step, requestId, actorOf(admin)));
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
    const b = body<{ sourceHash: string; reason: string }>(req);
    await banSource(b.sourceHash, b.reason, actorOf(admin));
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

  // Reset monitor corrections (an optional module, industry/features.ts)
  if (FEATURES.codexResetMonitor) {
    app.get("/api/admin/monitor/events", adminHandler(async (req) => listMonitorEvents({ withdrawn: q(req).withdrawn === "1" })));
    app.get("/api/admin/monitor/posts", adminHandler(async (req) => listMonitorPosts({ filter: q(req).filter as never, page: page(req) })));
    app.patch("/api/admin/monitor/events/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateMonitorEvent(param(req, "id"), body(req) as never, actorOf(admin)))));
    app.post("/api/admin/monitor/events/:id/receipt-review", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await reviewReceipt(param(req, "id"), body(req) as never, actorOf(admin)))));
    app.post("/api/admin/monitor/events/:id/withdrawn", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setWithdrawn(param(req, "id"), body(req) as never, actorOf(admin)))));
    app.post("/api/admin/monitor/relink", adminHandler(async (req, _reply, admin) => relinkPost(body(req) as never, actorOf(admin))));
    app.post("/api/admin/monitor/posts/:id/resolve", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await resolveMonitorPost(param(req, "id"), body(req) as never, actorOf(admin)))));
  }

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
