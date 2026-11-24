// The report nameplates (site/brand/nameplates/, made by scripts/nameplates.ts from the pack's
// subject word). Each logotype is cached on its own; the two paths take the theme's ink and accent.
import daily from "@aihot/site/brand/nameplates/daily.svg?url&no-inline";
import weekly from "@aihot/site/brand/nameplates/weekly.svg?url&no-inline";
import monthly from "@aihot/site/brand/nameplates/monthly.svg?url&no-inline";
import archive from "@aihot/site/brand/nameplates/archive.svg?url&no-inline";
import viewBoxes from "@aihot/site/brand/nameplates/index.json";
import { SITE } from "@aihot/site";
import { useLocale } from "../../lib/i18n";

const NAMEPLATES = {
  daily: { url: daily, viewBox: viewBoxes.daily },
  weekly: { url: weekly, viewBox: viewBoxes.weekly },
  monthly: { url: monthly, viewBox: viewBoxes.monthly },
  archive: { url: archive, viewBox: viewBoxes.archive },
} as const;

/**
 * English pages set the nameplate in type: the same two parts in the same colours (the subject in the accent;
 * 合订本 is the accent of the archive's), in heavy capitals of the page's own font. Sizes are in the plate's units,
 * the Chinese logotype's: its capitals stand CAPS tall in a HEIGHT-tall box.
 */
const ENGLISH_PLATES: Record<keyof typeof NAMEPLATES, Array<{ text: string; accent: boolean }>> = {
  daily: [{ text: SITE.subject, accent: true }, { text: "DAILY", accent: false }],
  weekly: [{ text: SITE.subject, accent: true }, { text: "WEEKLY", accent: false }],
  monthly: [{ text: SITE.subject, accent: true }, { text: "MONTHLY", accent: false }],
  archive: [{ text: "DAILY", accent: false }, { text: "ARCHIVE", accent: true }],
};
const HEIGHT = 244;
const CAPS = 207;
/**
 * A heavy sans capital is about 0.72 of its size tall and 0.55–0.62 of it wide, a word space about 0.25: the
 * line is set a little wider than that, so the system's own font only ever loosens it slightly.
 */
const TYPE_SIZE = CAPS / 0.72;
const LETTER = TYPE_SIZE * 0.58;
const SPACE = TYPE_SIZE * 0.28;
const MARGIN = 12;

function EnglishNameplate({ which, className }: { which: keyof typeof NAMEPLATES; className: string }) {
  const parts = ENGLISH_PLATES[which];
  const letters = parts.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  const width = Math.round(letters * LETTER + (parts.length - 1) * SPACE);
  return (
    <svg viewBox={`0 ${-HEIGHT / 2} ${width + 2 * MARGIN} ${HEIGHT}`} className={className} aria-hidden="true" focusable="false">
      <text x={MARGIN} y={CAPS / 2} textLength={width} lengthAdjust="spacing" fontSize={TYPE_SIZE} fontWeight={900} className="font-sans">
        {parts.map((p, i) => (
          <tspan key={p.text} className={p.accent ? "fill-accent" : "fill-ink"}>{i > 0 ? ` ${p.text}` : p.text}</tspan>
        ))}
      </text>
    </svg>
  );
}

export function Nameplate({ which, className = "" }: { which: keyof typeof NAMEPLATES; className?: string }) {
  const english = useLocale() === "en";
  const n = NAMEPLATES[which];
  if (english) return <EnglishNameplate which={which} className={className} />;
  return (
    <svg viewBox={n.viewBox} className={className} aria-hidden="true" focusable="false">
      <use href={`${n.url}#accent`} className="fill-accent" />
      <use href={`${n.url}#ink`} className="fill-ink" />
    </svg>
  );
}
