import type { SiteItemDetail, StoryFollowupsResponse } from "@aihot/contracts/site";
import { apiGet } from "../../lib/api.server";

/** 事件后续 in the first HTML: how search engines reach the event page. An event without any answers 404. */
export function loadFollowups(item: SiteItemDetail, signal: AbortSignal): Promise<StoryFollowupsResponse | null> {
  if (!item.story) return Promise.resolve(null);
  return apiGet<StoryFollowupsResponse>(`/api/site/stories/${item.story.publicId}/followups`, { signal }).catch(() => null);
}
