// Signed image proxy. Validate before reading prepared bytes or returning 304; calculate a fresh
// remaining lifetime on every request so the CDN never inherits an aged HTTP response's max-age.
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { enqueue, QUEUES } from "@aihot/backend/jobs/queue";
import { produceImage } from "@aihot/backend/media/images";
import { verifyProxyRequest } from "@aihot/backend/media/imgproxy";
import { etagMatches, looseQuery } from "../http/respond.ts";

function imageCacheControl(exp: string, limit: number): string {
  const remaining = Math.min(limit, Number(exp) - Math.floor(Date.now() / 1000));
  return remaining > 0 ? `public, max-age=${remaining}, s-maxage=${remaining}` : "no-store";
}

export function registerMedia(app: FastifyInstance) {
  app.get("/api/img-proxy", async (req, reply) => {
    const q = looseQuery(req);
    const verdict = verifyProxyRequest({ u: q.u, mode: q.mode, exp: q.exp, sig: q.sig });
    if (!verdict.ok) {
      const malformed = verdict.reason === "missing" || verdict.reason === "bad-url";
      return reply.code(malformed ? 400 : 403)
        .header("Cache-Control", "no-store")
        .header("X-Img-Proxy-Sig", verdict.reason === "expired" ? "expired" : "invalid")
        .type("text/plain; charset=utf-8").send(malformed ? "invalid query\n" : "forbidden\n");
    }
    reply.header("X-Img-Proxy-Sig", "valid");
    try {
      const { body, type, pendingAnimation } = await produceImage(verdict.url, verdict.mode);
      let queued = false;
      if (pendingAnimation) {
        try {
          // Readers can arrive before selection, so article preparation alone is insufficient.
          // A null id means a job with this singleton key is already queued.
          const key = createHash("sha256").update(`${verdict.mode}|${verdict.url}`).digest("hex");
          await enqueue(QUEUES.prepareMedia, { url: verdict.url, mode: verdict.mode }, { singletonKey: `rendition:${key}` });
          queued = true;
        } catch (error) {
          req.log.warn({ err: String(error) }, "img-proxy preparation enqueue failed");
        }
      }
      // A validator describes the actual representation, including a GIF replaced by prepared WebP.
      // It is deliberately checked after signature verification and image preparation.
      const etag = `"${createHash("sha256").update(type).update("\0").update(body).digest("hex")}"`;
      reply
        .header("Content-Type", type)
        .header("Cache-Control", pendingAnimation && !queued ? "no-store" : imageCacheControl(q.exp!, pendingAnimation ? 60 : 7 * 86400))
        .header("ETag", etag)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
      return reply.send(body);
    } catch (error) {
      req.log.warn({ err: String(error), host: new URL(verdict.url).hostname }, "img-proxy upstream failed");
      return reply.code(502).header("Cache-Control", imageCacheControl(q.exp!, 60)).type("text/plain; charset=utf-8").send("Upstream image unavailable");
    }
  });
}
