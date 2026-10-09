// IndexNow acknowledges at most 10,000 changed URLs per request. The saved identities describe only
// accepted notifications, so a failed request, a dry run or a batch boundary cannot lose changes.
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { siteUrl } from "../publication/links.ts";
import { loadDiscoveryEntries } from "../publication/sitemap.ts";

const MAX_URLS = 10_000;
interface State { fingerprints: Record<string, string>; acceptedAt: string }

export async function submitIndexNow(now = new Date()) {
  const [state] = await sql<{ value: Partial<State> }[]>`SELECT value FROM settings WHERE key = 'indexnow.watermark'`;
  // A time-only watermark cannot prove what was submitted. The first inventory establishes that
  // baseline in bounded batches; no dual tracking or guessed historical state is kept.
  const acknowledged = state?.value.fingerprints ?? {};
  const current = Object.fromEntries((await loadDiscoveryEntries(now)).map((entry) => [
    entry.loc, sha256(stableJson([entry.revision ?? null, entry.lastmod?.toISOString() ?? null])),
  ]));
  // Disappearing from discovery calls for another fetch (withdrawal, redirect or a changed indexing
  // decision). It does not claim that the URL was deleted, or that the engine removed it from results.
  const changes = [...new Set([...Object.keys(acknowledged), ...Object.keys(current)])]
    .filter((loc) => acknowledged[loc] !== current[loc]).sort();
  const sent = changes.slice(0, MAX_URLS);
  const urls = sent.map(siteUrl);
  let status: "sent" | "disabled" | "empty" | "failed" = urls.length ? "disabled" : "empty";
  let httpStatus: number | null = null;
  const key = config.indexNowKey;
  if (urls.length && config.indexNowSubmitEnabled && key) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(config.siteUrl).host, key, keyLocation: siteUrl(`/${key}.txt`), urlList: urls }),
      signal: AbortSignal.timeout(30_000),
    });
    httpStatus = res.status;
    status = res.ok ? "sent" : "failed";
  }
  if (status === "sent") {
    const fingerprints = { ...acknowledged };
    for (const loc of sent) {
      if (current[loc] === undefined) delete fingerprints[loc];
      else fingerprints[loc] = current[loc];
    }
    await sql`INSERT INTO settings (key, value, updated_by)
      VALUES ('indexnow.watermark', ${sql.json({ fingerprints, acceptedAt: now.toISOString() })}, 'worker')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
  return { status, httpStatus, urls: urls.length, more: changes.length > sent.length, sample: urls.slice(0, 3) };
}
