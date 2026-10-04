import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404, pageExpiresAt } from "../lib/api.server";
import { cachedLoader } from "../lib/page-reuse";
export const clientLoader = cachedLoader<typeof loader>();
export { default, handle, headers, meta } from "./item";

export { shouldRevalidate } from "../lib/page-reuse";
export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original`, { signal: request.signal });
  return { item, expiresAt: pageExpiresAt(600) };
}
