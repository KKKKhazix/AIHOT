// External collection scripts push items here (docs/sources.md). They use the ingest
// token (never an admin session) and their own rate limit.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { credential } from "@aihot/backend/config";
import { IngestError, ingestItems } from "@aihot/backend/ingest/items";


const PLACEHOLDER = /^(|changeme|change-me|placeholder|xxx+|todo|test|dev|your[-_]?token.*)$/i;

/** Constant-time check; an empty or placeholder server token rejects everything. */
function authorized(req: FastifyRequest): boolean {
  const expected = credential("auth", "INGEST_TOKEN") ?? "";
  if (PLACEHOLDER.test(expected) || expected.length < 16) return false;
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const windows = new Map<string, number[]>();
function limited(key: string, perMinute: number): boolean {
  const now = Date.now();
  const list = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) return true;
  list.push(now);
  windows.set(key, list);
  return false;
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Unauthorized");
}

export function registerIngest(app: FastifyInstance) {
  app.post("/api/ingest/items", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!authorized(req)) return unauthorized(reply);
    if (limited(`items:${req.ip}`, 10)) return reply.code(429).header("Retry-After", "60").send({ ok: false, error: "rate limited" });
    try {
      return await ingestItems(req.body);
    } catch (error) {
      if (error instanceof IngestError) return reply.code(error.status).send({ ok: false, error: error.message });
      req.log.error({ err: error }, "ingest items failed");
      return reply.code(500).send({ ok: false, error: "internal error" });
    }
  });
}
