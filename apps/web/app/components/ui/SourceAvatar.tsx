import { useState } from "react";
import { sourceInitial } from "../../lib/format";

/** Round avatar for X accounts (or a source icon); a tinted initial when there is no image. */
export function SourceAvatar({ id, name, iconUrl, avatarUrl, iconSrcSet, avatarSrcSet, size = 18 }: { id?: string | null; name: string; iconUrl?: string | null; avatarUrl?: string | null; iconSrcSet?: string; avatarSrcSet?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = avatarUrl ?? iconUrl;
  if (src && !failed) {
    return (
      <img
        src={src}
        srcSet={avatarUrl ? avatarSrcSet : iconSrcSet}
        sizes={`${size}px`}
        decoding="async"
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full bg-bg-sunk object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  let h = 0;
  for (const ch of id || name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)), background: `oklch(0.6 0.07 ${h})` }}
    >
      {sourceInitial(name)}
    </span>
  );
}
