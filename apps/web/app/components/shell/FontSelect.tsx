import { Select } from "../ui/Controls";
import { setFontPreference, useFontPreference } from "../../lib/local-state";
import { useT } from "../../lib/i18n";

/** The reader's font: the site's default or the browser's own (我的 page and the desktop 更多 menu). */
export function FontSelect() {
  const font = useFontPreference();
  const t = useT();
  return (
    <Select aria-label={t("字体", "Font")} value={font ?? "system"} onChange={(e) => setFontPreference(e.target.value === "browser" ? "browser" : null)}>
      <option value="system">{t("默认字体", "Default")}</option>
      <option value="browser">{t("浏览器默认字体", "Browser default")}</option>
    </Select>
  );
}
