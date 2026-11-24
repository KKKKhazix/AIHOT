import { useLocation } from "react-router";
import { SITE } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { counterpart, useLocale, useT, zh, type Locale } from "../../lib/i18n";
import { dismissEnglishHint } from "./EnglishHint";

/** Each language named in itself. */
const OPTIONS: Array<{ key: Locale; label: string; lang: string }> = [
  { key: "zh", label: zh("中文"), lang: SITE.locale },
  { key: "en", label: "English", lang: "en" },
];

/**
 * The page in the other language (更多 menu, 我的), on a site with an English edition. The address decides the
 * language (lib/i18n.ts), so each option is a link to this page at the other address, its query and anchor kept; a
 * page with no English edition leads to the English home. Plain links: the whole page changes language at once.
 * Choosing 中文 also says no to the English hint (EnglishHint) in this browser.
 */
export function LanguageSwitch({ className = "", compact = false, page }: { className?: string; compact?: boolean; page?: string }) {
  const t = useT();
  const locale = useLocale();
  const { pathname, search, hash } = useLocation();
  if (!ENGLISH) return null;
  const index = OPTIONS.findIndex((o) => o.key === locale);
  const href = (to: Locale) => {
    // A shared, queryless page supplies its canonical path for the rendered links.
    if (page) return counterpart(page, to) ?? "/en";
    const path = counterpart(pathname, to);
    return path ? `${path}${search}${hash}` : "/en";
  };
  return (
    <nav aria-label={t("语言", "Language")} className={`relative grid ${compact ? "h-7" : "h-[34px]"} grid-cols-2 rounded-full border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/2)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)]"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o) => (
        <a
          key={o.key}
          href={href(o.key)}
          lang={o.lang}
          hrefLang={o.lang}
          onClick={o.key === "zh" ? dismissEnglishHint : undefined}
          aria-current={o.key === locale ? "page" : undefined}
          className={`relative z-10 flex items-center justify-center rounded-full ${compact ? "text-ui-caption" : "text-ui-label"} transition-colors duration-150 touch:before:absolute touch:before:inset-x-0 touch:before:top-1/2 touch:before:h-11 touch:before:-translate-y-1/2 touch:before:content-[''] ${o.key === locale ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.label}
        </a>
      ))}
    </nav>
  );
}
