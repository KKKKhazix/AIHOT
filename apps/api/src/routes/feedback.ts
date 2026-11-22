import type { FastifyInstance } from "fastify";
import { FeedbackRejected, submitFeedback, type FeedbackInput } from "@aihot/backend/operations/feedback";
import { clientIp, sendProblem } from "../http/respond.ts";

type FeedbackBody = Pick<FeedbackInput, "content" | "email" | "pageUrl" | "screenshot">;

/** The feedback form as the site posts it: multipart, with at most one screenshot file. */
async function readForm(raw: unknown, contentType: string): Promise<FeedbackBody> {
  let form: FormData;
  try {
    form = await new Response(raw as Buffer<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new FeedbackRejected(400, "invalid_request", "提交的数据不完整，请重新发送。");
  }
  const text = (key: string) => {
    const value = form.get(key);
    if (value !== null && typeof value !== "string") throw new FeedbackRejected(400, "invalid_request", "反馈内容未能正常提交，请重新发送。");
    return value;
  };
  const file = form.get("screenshot");
  if (file !== null && !(file instanceof File)) throw new FeedbackRejected(400, "invalid_request", "截图未能正常上传，请重新选择图片。");
  return {
    content: text("content") ?? "", email: text("email"), pageUrl: text("pageUrl"),
    screenshot: file ? { mime: file.type, data: Buffer.from(await file.arrayBuffer()) } : null,
  };
}

export function registerFeedback(app: FastifyInstance) {
  // Bounded by the same request limit as JSON; native multipart parsing avoids base64 on the wire.
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/api/site/feedback", { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    try {
      const body = await readForm(req.body, String(req.headers["content-type"] ?? ""));
      const result = await submitFeedback({ ...body, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "") });
      return reply.header("Cache-Control", "no-store").code(201).send(result);
    } catch (error) {
      if (error instanceof FeedbackRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
      req.log.error({ err: error }, "feedback failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    }
  });
}
