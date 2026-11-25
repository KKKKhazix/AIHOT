import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { titleCacheSeconds } from "../lib/seo";
import { apiIn, localeOf } from "../lib/i18n";
import { loadFollowups } from "../features/item/followups.server";
import { pageReuse } from "../lib/page-reuse";
export { default, handle, headers, meta } from "./item";

export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();
export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeOf(pagePathname(request));
  // An English article page already reads the original.
  const path = locale === "en" ? apiIn(`/items/${encodeURIComponent(params.id)}`, locale) : `/api/site/items/${encodeURIComponent(params.id)}/original`;
  const item = await loadOr404<SiteItemDetail>(path, { signal: request.signal });
  return cachedPage(titleCacheSeconds(600, locale, item.indexable ? item.title : null), { item, followups: await loadFollowups(item, locale, request.signal) });
}
