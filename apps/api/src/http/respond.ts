// Shared HTTP helpers: Problem JSON, public API headers, ETag / 304, strict query parsing.
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { POLICY } from "@aihot/site";
import { NO_STORE, PUBLIC_API_CORS } from "@aihot/contracts/http-policy";
import { siteUrl } from "@aihot/backend/publication/links";
import type { JsonNotice } from "@aihot/backend/modules";

const PROBLEM_TITLES: Record<number, string> = {
  400: "Bad request",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  429: "Too many requests",
  500: "Internal error",
  503: "Temporarily unavailable",
};

export interface ProblemInit {
  status: number;
  code: string;
  detail: string;
  type?: string;
  title?: string;
  retryAfter?: number;
  cacheControl?: string;
}

export function sendProblem(req: FastifyRequest, reply: FastifyReply, p: ProblemInit) {
  const body: Record<string, unknown> = {
    type: p.type ?? `/problems/${p.code.replace(/_/g, "-")}`,
    title: p.title ?? PROBLEM_TITLES[p.status] ?? "Error",
    status: p.status,
    detail: p.detail,
    code: p.code,
    requestId: req.id,
  };
  if (p.retryAfter !== undefined) {
    body.retryAfter = p.retryAfter;
    reply.header("Retry-After", String(p.retryAfter));
  }
  return reply
    .code(p.status)
    .header("Content-Type", "application/problem+json")
    .header("X-Request-Id", req.id)
    .header("Cache-Control", p.cacheControl ?? NO_STORE)
    .send(Buffer.from(JSON.stringify(body)));
}

export interface PublicHeadersOptions {
  /** A deprecated endpoint: Deprecation, the day it stops (Sunset, an HTTP date) and its migration guide as a Link. */
  deprecation?: { sunset: string; guide: string };
  cors?: boolean;
}

/** CORS for public machine endpoints, and the site's usage-policy headers (POLICY.terms.headers). */
export function applyPublicHeaders(reply: FastifyReply, opts: PublicHeadersOptions = {}) {
  if (opts.cors !== false) for (const [k, v] of Object.entries(PUBLIC_API_CORS)) reply.header(k, v);
  // Every Link value goes into one header: the terms that come with the policy headers, then the rest.
  const links: string[] = [];
  if (POLICY.terms.headers) {
    for (const [k, v] of Object.entries(POLICY.terms.headers)) reply.header(k, v);
    links.push(`<${siteUrl("/terms")}>; rel="terms-of-service"`);
  }
  if (opts.deprecation) {
    reply.header("Deprecation", "true");
    reply.header("Sunset", opts.deprecation.sunset);
    links.push(`<${opts.deprecation.guide}>; rel="deprecation"`);
  }
  if (links.length) reply.header("Link", links.join(", "));
}

export function weakEtag(prefix: string, body: string): string {
  return `W/"${prefix}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || strip(t) === strip(etag));
}

/**
 * Sends JSON with a weak ETag; answers 304 with an empty body when If-None-Match matches.
 * `etagOf` names the content the tag stands for when the body also carries per-request values
 * (a snapshot's `asOf`), so unchanged content still answers 304.
 */
export function sendJsonWithEtag(req: FastifyRequest, reply: FastifyReply, body: unknown, opts: { etagPrefix: string; cacheControl: string; etagOf?: unknown }) {
  const text = opts.etagOf === undefined ? JSON.stringify(body) : undefined;
  const etag = weakEtag(opts.etagPrefix, text ?? JSON.stringify(opts.etagOf));
  reply.header("ETag", etag).header("Cache-Control", opts.cacheControl).header("Vary", "Accept-Encoding");
  if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.header("Content-Type", "application/json; charset=utf-8").send(text ?? JSON.stringify(body));
}

/**
 * JSON with a reminder for the person behind the request on top (JsonNotice), or as it is without one.
 * The reminder is part of the ETag; one the shared caches cannot tell apart is never kept in them.
 */
export function sendJsonWithNotice(req: FastifyRequest, reply: FastifyReply, body: object, notice: JsonNotice | null, opts: Parameters<typeof sendJsonWithEtag>[3]) {
  if (!notice) return sendJsonWithEtag(req, reply, body, opts);
  return sendJsonWithEtag(req, reply, { ...body, notice: notice.notice }, {
    ...opts,
    ...(notice.private ? { cacheControl: "private, no-store" } : {}),
    etagOf: opts.etagOf === undefined ? undefined : { content: opts.etagOf, notice: notice.notice },
  });
}

export function sendTextWithEtag(req: FastifyRequest, reply: FastifyReply, text: string, opts: { etagPrefix: string; cacheControl: string; contentType: string }) {
  const etag = weakEtag(opts.etagPrefix, text);
  reply.header("ETag", etag).header("Cache-Control", opts.cacheControl).header("Vary", "Accept-Encoding");
  if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.header("Content-Type", opts.contentType).send(text);
}

export class QueryError extends Error {}

/**
 * Strict query parsing for public APIs: only declared parameters, each at most once.
 * Unknown parameters (including cache busters like `_`) and duplicates are 400.
 */
export function strictQuery(req: FastifyRequest, allowed: readonly string[]): Record<string, string> {
  const raw = req.raw.url ?? "";
  const qIndex = raw.indexOf("?");
  const params = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : "");
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key)) throw new QueryError(`Unknown query parameter: ${key}.`);
    if (key in out) throw new QueryError(`Query parameter must not be repeated: ${key}.`);
    out[key] = value;
  }
  return out;
}

/** Lenient parsing for site endpoints: first value wins, unknown keys ignored. */
export function looseQuery(req: FastifyRequest): Record<string, string> {
  const raw = req.raw.url ?? "";
  const qIndex = raw.indexOf("?");
  const params = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : "");
  const out: Record<string, string> = {};
  for (const [k, v] of params) if (!(k in out)) out[k] = v;
  return out;
}
