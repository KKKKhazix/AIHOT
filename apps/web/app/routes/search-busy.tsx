import { SearchBusy } from "./all";
import type { Screen } from "../components/shell/screens";
import { titled } from "../lib/seo";

export const handle: Screen = { tab: "featured" };

export function meta() {
  return [{ title: titled("搜索繁忙") }, { name: "robots", content: "noindex, follow" }];
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default SearchBusy;
