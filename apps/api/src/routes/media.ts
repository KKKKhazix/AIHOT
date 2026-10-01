// Signed image proxy. Unsigned, badly signed or expired requests are 403 without any upstream fetch.
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { enqueue, QUEUES } from "@aihot/backend/jobs/queue";
import { produceImage } from "@aihot/backend/media/images";
import { verifyProxyRequest } from "@aihot/backend/media/imgproxy";
import { looseQuery } from "../http/respond.ts";

export function registerMedia(app: FastifyInstance) {
  app.get("/api/img-proxy", async (req, reply) => {
    const q = looseQuery(req);
    const verdict = verifyProxyRequest({ u: q.u, mode: q.mode, exp: q.exp, sig: q.sig });
    // A caching proxy (nginx auth_request) can check every request with this HEAD sub-request before it reads its image cache (keyed
    // by url and mode only): signature only, no upstream fetch. 401 = malformed query, 403 = bad or
    // expired signature; a valid answer may be cached for the rest of the signature's life.
    if (req.method === "HEAD" && req.headers["x-aihot-img-proxy-auth"] === "1") {
      if (!verdict.ok) {
        const malformed = verdict.reason === "missing" || verdict.reason === "bad-url";
        return reply.code(malformed ? 401 : 403).header("Cache-Control", "no-store").header("X-Img-Proxy-Sig", verdict.reason === "expired" ? "expired" : "invalid").send();
      }
      const remaining = Math.max(1, Number(q.exp) - Math.floor(Date.now() / 1000));
      return reply.code(204).header("X-Img-Proxy-Sig", "valid").header("X-Accel-Expires", String(remaining)).send();
    }
    if (!verdict.ok) {
      return reply.code(403).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Forbidden");
    }
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
      const maxAge = Math.max(1, Math.min(pendingAnimation ? 60 : 7 * 86400, Number(q.exp) - Math.floor(Date.now() / 1000)));
      return reply
        .header("Content-Type", type)
        .header("Cache-Control", pendingAnimation && !queued ? "no-store" : `public, max-age=${maxAge}, s-maxage=${maxAge}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(body);
    } catch (error) {
      req.log.warn({ err: String(error), host: new URL(verdict.url).hostname }, "img-proxy upstream failed");
      return reply.code(502).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Upstream image unavailable");
    }
  });
}
