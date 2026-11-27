import { inLanguage, type Locale } from "@aihot/contracts/i18n";
import { config } from "../config.ts";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string, lang: Locale = "zh"): string => `${config.siteUrl}${inLanguage(path, lang)}`;
export const itemUrl = (id: string, lang: Locale = "zh"): string => siteUrl(`/items/${id}`, lang);
export const storyUrl = (publicId: string, lang: Locale = "zh"): string => siteUrl(`/story/${publicId}`, lang);
export const dailyUrl = (date: string, lang: Locale = "zh"): string => siteUrl(`/daily/${date}`, lang);
export const periodUrl = (kind: "weekly" | "monthly", key: string, lang: Locale = "zh"): string => siteUrl(`/${kind}/${key}`, lang);

/** A story's v1 address as v1 links it (related stories' links.api). */
export const v1StoryApiUrl = (publicId: string): string => siteUrl(`/api/v1/stories/${publicId}`);
