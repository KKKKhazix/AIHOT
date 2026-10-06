import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
export { default, handle, headers, meta } from "./item";

export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();
export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original`, { signal: request.signal });
  return cachedPage(600, { item });
}
