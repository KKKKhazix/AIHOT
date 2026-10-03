// The report nameplates (site/brand/nameplates/, made by scripts/nameplates.ts from the pack's
// subject word). Each logotype is cached on its own; the two paths take the theme's ink and accent.
import daily from "@aihot/site/brand/nameplates/daily.svg?url&no-inline";
import weekly from "@aihot/site/brand/nameplates/weekly.svg?url&no-inline";
import monthly from "@aihot/site/brand/nameplates/monthly.svg?url&no-inline";
import archive from "@aihot/site/brand/nameplates/archive.svg?url&no-inline";
import viewBoxes from "@aihot/site/brand/nameplates/index.json";

const NAMEPLATES = {
  daily: { url: daily, viewBox: viewBoxes.daily },
  weekly: { url: weekly, viewBox: viewBoxes.weekly },
  monthly: { url: monthly, viewBox: viewBoxes.monthly },
  archive: { url: archive, viewBox: viewBoxes.archive },
} as const;

export function Nameplate({ which, className = "" }: { which: keyof typeof NAMEPLATES; className?: string }) {
  const n = NAMEPLATES[which];
  return (
    <svg viewBox={n.viewBox} className={className} aria-hidden="true" focusable="false">
      <use href={`${n.url}#accent`} className="fill-accent" />
      <use href={`${n.url}#ink`} className="fill-ink" />
    </svg>
  );
}
