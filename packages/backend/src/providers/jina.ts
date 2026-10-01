// Jina Reader (r.jina.ai): browser-rendered page text. Paid per request, reached through the egress
// proxy, always behind receipts and the per-minute/hour/day budget (any zero stops it).
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError } from "./receipts.ts";

export interface JinaPage {
  title: string | null;
  url: string | null;
  publishedTime: string | null;
  markdown: string;
}

export function parseJinaText(text: string): JinaPage {
  const header = text.split(/\nMarkdown Content:\n/)[0] ?? "";
  const body = text.includes("\nMarkdown Content:\n") ? text.split(/\nMarkdown Content:\n/).slice(1).join("\nMarkdown Content:\n") : text;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(header)?.[1]?.trim() ?? null;
  return { title: field("Title"), url: field("URL Source"), publishedTime: field("Published Time"), markdown: body.trim() };
}

/**
 * Reads a page through Jina. The receipt key is the target URL plus the day, so a same-day retry of an
 * article's body or detail reuses it. A listing passes its fetch `round` instead: with the day key each
 * listing was read once a day and every later fetch saw the morning's page, while a key that changed on
 * every call would pay again for a request whose outcome is unknown.
 */
export async function jinaRead(
  targetUrl: string,
  opts: { purpose: string; subject: string; format?: "markdown" | "html"; cacheToleranceSeconds?: number; round?: string },
): Promise<JinaPage & { receiptId: number; raw: string }> {
  const key = credential("collectors", "JINA_API_KEY");
  if (!key) throw new Error("JINA_API_KEY is not configured");
  const base = (credential("collectors", "JINA_BASE_URL") ?? "https://r.jina.ai").replace(/\/$/, "");
  // A listing whose freshness matters (xAI news) caps how old Jina's cached rendering may be.
  const tolerance: Record<string, string> = Number.isInteger(opts.cacheToleranceSeconds) && opts.cacheToleranceSeconds! >= 0 ? { "x-cache-tolerance": String(opts.cacheToleranceSeconds) } : {};
  const day = opts.round ?? new Date().toISOString().slice(0, 10);
  const receipt = await paidRequest(
    { service: "jina", model: null, purpose: opts.purpose, subject: opts.subject, identity: { url: targetUrl, day, format: opts.format ?? "markdown" }, requestSummary: { url: targetUrl } },
    async () => {
      const res = await guardedFetch(`${base}/${targetUrl}`, {
        headers: { authorization: `Bearer ${key}`, "x-return-format": opts.format ?? "markdown", accept: "text/plain", ...tolerance },
        timeoutMs: 60_000,
        maxBytes: 6 * 1024 * 1024,
      });
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 422 || res.status === 400) {
        throw new ProviderRejectedError(`jina HTTP ${res.status}`, res.status, false);
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`jina HTTP ${res.status}`, res.status, true);
      const text = res.text();
      // Billed in tokens; estimated at about ¥0.36 per million. Without the usage header nothing is guessed.
      const tokens = Number(res.headers.get("x-usage-tokens")) || null;
      const cost = tokens ? { amount: (tokens / 1e6) * 0.36, currency: "CNY", basis: "estimated" as const } : null;
      return { response: { text: text.slice(0, 2_000_000), status: res.status }, requestId: res.headers.get("x-request-id"), usage: { bytes: res.body.length, tokens }, cost };
    },
  );
  const raw = String((receipt.response as { text?: string })?.text ?? "");
  return { ...parseJinaText(raw), receiptId: receipt.receiptId, raw };
}
