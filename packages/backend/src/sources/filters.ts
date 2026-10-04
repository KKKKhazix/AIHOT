// Source-list admission rules shared by collection and the administrator's preview.
import { FUTURE_TOLERANCE_MS } from "../content/materials.ts";
import type { Candidate } from "./types.ts";

/** A fixed publication boundary excludes history and dates that cannot prove an item is in range. */
export function filterPublicationWindow(candidates: Candidate[], publishedAfter: string | undefined, now = Date.now()): Candidate[] {
  if (!publishedAfter) return candidates;
  const after = Date.parse(publishedAfter);
  const latest = now + FUTURE_TOLERANCE_MS;
  return candidates.filter(c => !!c.publishedAt && c.publishedAt.getTime() > after && c.publishedAt.getTime() <= latest);
}
