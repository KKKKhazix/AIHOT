import type { SiteItemDetail, StoryFollowupsResponse } from "@aihot/contracts/site";
import { apiGet, cachedPage, loadOr404, pagePathname } from "../../lib/api.server";
import { apiIn, localeOf, type Locale } from "../../lib/i18n";
import { titleCacheSeconds } from "../../lib/seo";

/** 事件后续 in the first HTML: how search engines reach the event page. An event without any answers 404. */
function loadFollowups(item: SiteItemDetail, locale: Locale, signal: AbortSignal): Promise<StoryFollowupsResponse | null> {
  if (!item.story) return Promise.resolve(null);
  return apiGet<StoryFollowupsResponse>(apiIn(`/stories/${item.story.publicId}/followups`, locale), { signal }).catch(() => null);
}

/** Both article views read the same detail and follow-ups. English already serves the source text. */
export async function loadItemPage(request: Request, id: string, edition: "default" | "original") {
  const locale = localeOf(pagePathname(request));
  const suffix = edition === "original" && locale === "zh" ? "/original" : "";
  const path = apiIn(`/items/${encodeURIComponent(id)}${suffix}`, locale);
  const item = await loadOr404<SiteItemDetail>(path, { signal: request.signal });
  const followups = await loadFollowups(item, locale, request.signal);
  return cachedPage(titleCacheSeconds(600, locale, item.indexable ? item.title : null), { item, followups });
}
