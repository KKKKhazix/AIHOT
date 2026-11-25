import { translator, type Locale } from "../../lib/i18n";
import { weekdayShort } from "../../lib/format";

/** Release notes carry a little Markdown: **bold** runs. */
export function Inline({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i} className="font-semibold text-ink-2">{part}</b> : part))}</>;
}

export function dateHeading(date: string, locale: Locale): { label: string; weekday: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = translator(locale);
  return { label: t(`${y} 年 ${m} 月 ${d} 日`, new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(date))), weekday: weekdayShort(date, locale) };
}
