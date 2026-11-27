import { inLanguage } from "@aihot/contracts/i18n";
// RSS routes. Unknown query parameters are accepted and never change content. On a site with an English edition every
// feed is also at /en/feed…, in English (publication/feeds.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { READER_LANGUAGES } from "@aihot/contracts/english";
import { REPORT_KINDS } from "@aihot/contracts/reports";
import { isFeedCategory, itemFeed, reportFeed, type FeedLanguage, type ItemFeedKind } from "@aihot/backend/publication/feeds";
import { serverModules } from "@aihot/backend/modules";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";

async function sendFeed(req: FastifyRequest, reply: FastifyReply, xml: string, lang: FeedLanguage) {
  applyPublicHeaders(reply, { cors: false });
  for (const m of serverModules()) m.on?.exitServed?.("rss", req);
  return sendTextWithEtag(req, reply, xml, { etagPrefix: lang === "en" ? "rss-en" : "rss", cacheControl: "public, max-age=300, s-maxage=300, must-revalidate", contentType: "application/rss+xml; charset=utf-8" });
}

function feedError(reply: FastifyReply) {
  return reply.code(503).header("Retry-After", "60").header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Feed temporarily unavailable");
}

export function registerFeeds(app: FastifyInstance) {
  for (const lang of READER_LANGUAGES) registerIn(app, lang);
}

function registerIn(app: FastifyInstance, lang: FeedLanguage) {
  const at = (path: string) => inLanguage(path, lang);
  // A preflight gets 204 and the allowed methods; feeds send no CORS headers.
  for (const url of ["/feed.xml", "/feed/full.xml", "/feed/all.xml", "/feed/daily.xml", "/feed/weekly.xml", "/feed/monthly.xml", "/feed/category/:file", "/feed/full/category/:file"]) {
    app.options(at(url), async (_req, reply) => reply.code(204).header("Allow", "GET, HEAD, OPTIONS").send());
  }
  const item = (kind: ItemFeedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await sendFeed(req, reply, await itemFeed(kind, null, { lang }), lang);
    } catch (error) {
      req.log.error({ err: error }, "feed error");
      return feedError(reply);
    }
  };
  app.get(at("/feed.xml"), item("selected"));
  app.get(at("/feed/full.xml"), item("selected-full"));
  app.get(at("/feed/all.xml"), item("all"));
  for (const kind of REPORT_KINDS) {
    app.get(at(`/feed/${kind}.xml`), async (req, reply) => {
      try {
        return await sendFeed(req, reply, await reportFeed(kind, lang), lang);
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
  for (const full of [false, true]) {
    app.get(at(full ? "/feed/full/category/:file" : "/feed/category/:file"), async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const slug = file.replace(/\.xml$/, "");
      if (!file.endsWith(".xml") || !isFeedCategory(slug)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      const kind = full ? "selected-full" : "selected";
      try {
        return await sendFeed(req, reply, await itemFeed(kind, slug, { lang }), lang);
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
}
