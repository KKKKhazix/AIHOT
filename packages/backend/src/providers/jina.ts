// Jina Reader (r.jina.ai): browser-rendered page text. Paid per request, reached through the egress
// proxy, always behind receipts and the per-minute/hour/day budget (any zero stops it).
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { assertAccepted, paidRequest } from "./receipts.ts";

/** Jina's answer starts with header lines (Title, URL Source, Published Time); the page follows this line. */
const CONTENT = "\nMarkdown Content:\n";

/**
 * Reads a page through Jina: `raw` is the whole answer, `markdown` the page after its header lines.
 * The receipt key is the target URL plus the day, so a same-day retry of an article's body or detail
 * reuses it. A listing is read afresh on every fetch (`perRead`): with the day key every later fetch saw
 * the morning's page. Each such read has a receipt of its own, so after one whose outcome is unknown the
 * next fetch pays for a new read instead of waiting on it.
 */
export async function jinaRead(
  targetUrl: string,
  opts: { purpose: string; subject: string; format?: "markdown" | "html"; cacheToleranceSeconds?: number; perRead?: boolean },
): Promise<{ markdown: string; raw: string; receiptId: number }> {
  const key = credential("collectors", "JINA_API_KEY");
  if (!key) throw new Error("JINA_API_KEY is not configured");
  const base = (credential("collectors", "JINA_BASE_URL") ?? "https://r.jina.ai").replace(/\/$/, "");
  // A listing whose freshness matters (xAI news) caps how old Jina's cached rendering may be.
  const tolerance: Record<string, string> = Number.isInteger(opts.cacheToleranceSeconds) && opts.cacheToleranceSeconds! >= 0 ? { "x-cache-tolerance": String(opts.cacheToleranceSeconds) } : {};
  const now = new Date().toISOString();
  const day = opts.perRead ? now : now.slice(0, 10);
  const receipt = await paidRequest(
    { service: "jina", model: null, purpose: opts.purpose, subject: opts.subject, identity: { url: targetUrl, day, format: opts.format ?? "markdown" }, requestSummary: { url: targetUrl } },
    async () => {
      const res = await guardedFetch(`${base}/${targetUrl}`, {
        headers: { authorization: `Bearer ${key}`, "x-return-format": opts.format ?? "markdown", accept: "text/plain", ...tolerance },
        timeoutMs: 60_000,
        maxBytes: 6 * 1024 * 1024,
      });
      const text = res.text();
      assertAccepted("jina", res.status, text);
      // Billed in tokens; estimated at about ¥0.36 per million. Without the usage header nothing is guessed.
      const tokens = Number(res.headers.get("x-usage-tokens")) || null;
      const cost = tokens ? { amount: (tokens / 1e6) * 0.36, currency: "CNY", basis: "estimated" as const } : null;
      return { response: { text: text.slice(0, 2_000_000), status: res.status }, requestId: res.headers.get("x-request-id"), usage: { bytes: res.body.length, tokens }, cost };
    },
  );
  const raw = String((receipt.response as { text?: string })?.text ?? "");
  const at = raw.indexOf(CONTENT);
  return { markdown: (at < 0 ? raw : raw.slice(at + CONTENT.length)).trim(), raw, receiptId: receipt.receiptId };
}
