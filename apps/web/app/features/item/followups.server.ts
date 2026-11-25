import type { SiteItemDetail, StoryFollowupsResponse } from "@aihot/contracts/site";
import { apiGet } from "../../lib/api.server";
import { apiIn, type Locale } from "../../lib/i18n";

/** 事件后续 in the first HTML: how search engines reach the event page. An event without any answers 404. */
export function loadFollowups(item: SiteItemDetail, locale: Locale, signal: AbortSignal): Promise<StoryFollowupsResponse | null> {
  if (!item.story) return Promise.resolve(null);
  return apiGet<StoryFollowupsResponse>(apiIn(`/stories/${item.story.publicId}/followups`, locale), { signal }).catch(() => null);
}
