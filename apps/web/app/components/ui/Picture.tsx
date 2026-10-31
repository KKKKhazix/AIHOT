import type { ImgHTMLAttributes } from "react";
import { avifCandidates } from "@aihot/contracts/site";

/**
 * A proxied image whose responsive set is offered as AVIF first; browsers without AVIF load the img's own
 * candidates. The picture lays out as if the img stood alone.
 */
export function Picture({ srcSet, sizes, ...img }: ImgHTMLAttributes<HTMLImageElement>) {
  if (!srcSet) return <img sizes={sizes} {...img} />;
  return (
    <picture className="contents">
      <source type="image/avif" srcSet={avifCandidates(srcSet)} sizes={sizes} />
      <img srcSet={srcSet} sizes={sizes} {...img} />
    </picture>
  );
}
