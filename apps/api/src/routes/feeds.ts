// RSS routes. Unknown query parameters are accepted and never change content.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { feedCacheControl, isFeedCategory, itemFeed, reportFeed, type ItemFeedKind } from "@aihot/backend/publication/feeds";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";

async function sendFeed(req: FastifyRequest, reply: FastifyReply, xml: string, cacheControl: string) {
  applyPublicHeaders(reply, { cors: false });
  return sendTextWithEtag(req, reply, xml, { etagPrefix: "rss", cacheControl, contentType: "application/rss+xml; charset=utf-8" });
}

function feedError(reply: FastifyReply) {
  return reply.code(503).header("Retry-After", "60").header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Feed temporarily unavailable");
}

export function registerFeeds(app: FastifyInstance) {
  // A preflight gets 204 and the allowed methods; feeds send no CORS headers.
  for (const url of ["/feed.xml", "/feed/full.xml", "/feed/all.xml", "/feed/daily.xml", "/feed/weekly.xml", "/feed/monthly.xml", "/feed/category/:file", "/feed/full/category/:file"]) {
    app.options(url, async (_req, reply) => reply.code(204).header("Allow", "GET, HEAD, OPTIONS").send());
  }
  const item = (kind: ItemFeedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await sendFeed(req, reply, await itemFeed(kind, null), feedCacheControl(kind));
    } catch (error) {
      req.log.error({ err: error }, "feed error");
      return feedError(reply);
    }
  };
  app.get("/feed.xml", item("selected"));
  app.get("/feed/full.xml", item("selected-full"));
  app.get("/feed/all.xml", item("all"));
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    app.get(`/feed/${kind}.xml`, async (req, reply) => {
      try {
        return await sendFeed(req, reply, await reportFeed(kind), feedCacheControl(kind));
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
  for (const full of [false, true]) {
    app.get(full ? "/feed/full/category/:file" : "/feed/category/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const slug = file.replace(/\.xml$/, "");
      if (!file.endsWith(".xml") || !isFeedCategory(slug)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      const kind = full ? "selected-full" : "selected";
      try {
        return await sendFeed(req, reply, await itemFeed(kind, slug), feedCacheControl(kind));
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
}
