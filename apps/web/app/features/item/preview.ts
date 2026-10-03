// Phones: what a list card already showed of an item, kept for the moment of the tap, so its article
// opens at once with that while the full text loads (routes/item.tsx clientLoader). Memory only.
import type { FeedItemSummary } from "@aihot/contracts/site";

const previews = new Map<string, FeedItemSummary>();
const MAX_PREVIEWS = 40;

export function rememberPreview(item: FeedItemSummary) {
  previews.delete(item.id);
  previews.set(item.id, item);
  if (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
}

/** The card's data for an article about to open, once. */
export function takePreview(id: string): FeedItemSummary | null {
  const preview = previews.get(id) ?? null;
  previews.delete(id);
  return preview;
}
