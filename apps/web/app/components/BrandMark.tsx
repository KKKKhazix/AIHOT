import type { Brand } from "@aihot/contracts/site";
import { webModules } from "../site-modules";

/** A company's, vendor's or evaluator's mark on a bordered tile; falls back to a monogram. Marks identify, never endorse. */
export function BrandMark({ brand, size = 28, className = "" }: { brand: Brand | null; size?: number; className?: string }) {
  const radius = Math.round(size * 0.27);
  if (brand?.src) {
    // Logos drawn in white (for a dark tile) sit on their own dark plate.
    const dark = webModules().flatMap((m) => m.darkMarks ?? []).includes(brand.src);
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden border ${dark ? "border-transparent bg-[#111]" : `border-line bg-white ${brand.raster ? "" : "dark:bg-white/95"}`} ${className}`}
        style={{ width: size, height: size, borderRadius: radius }}
        aria-hidden="true"
      >
        <img src={brand.src} alt="" width={size} height={size} loading="lazy" decoding="async" className={`object-contain ${dark ? "h-[66%] w-[66%]" : "h-[64%] w-[64%]"}`} />
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border border-line bg-accent-soft font-semibold text-accent ${className}`}
      style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {brand?.monogram ?? "?"}
    </span>
  );
}
