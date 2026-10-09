// Fixed renditions use the existing signed mode parameter. Responsive candidates reuse the same
// mode as previews and full-size viewers, so identical pixels have one browser/CDN address.
export const IMAGE_WIDTHS = {
  avatar: 96, card: 336, thumb: 720, full: 1600, og: 1200,
  "avatar-48": 48,
  "image-1200": 1200,
} as const;

export type ProxyMode = keyof typeof IMAGE_WIDTHS;
export type ResponsiveImageKind = "avatar" | "card" | "body" | "hero";

export const RESPONSIVE_MODES = {
  avatar: ["avatar-48", "avatar"],
  card: ["card", "thumb"],
  body: ["thumb", "image-1200", "full"],
  hero: ["thumb", "image-1200", "full"],
} as const satisfies Record<ResponsiveImageKind, readonly ProxyMode[]>;
