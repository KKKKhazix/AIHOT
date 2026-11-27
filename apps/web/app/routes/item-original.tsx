import type { Route } from "./+types/item-original";
import { loadItemPage } from "../features/item/page.server";
import { pageReuse } from "../lib/page-reuse";
export { default, handle, headers, meta } from "./item";

export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();
export function loader({ params, request }: Route.LoaderArgs) {
  return loadItemPage(request, params.id, "original");
}
