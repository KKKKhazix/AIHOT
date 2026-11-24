import { Select } from "../ui/Controls";
import { setFontPreference, useFontPreference } from "../../lib/local-state";

/** The reader's font: the site's default or the browser's own (我的 page and the desktop 更多 menu). */
export function FontSelect() {
  const font = useFontPreference();
  return (
    <Select aria-label="字体" value={font ?? "system"} onChange={(e) => setFontPreference(e.target.value === "browser" ? "browser" : null)}>
      <option value="system">默认字体</option>
      <option value="browser">浏览器默认字体</option>
    </Select>
  );
}
