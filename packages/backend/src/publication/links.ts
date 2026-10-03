import { config } from "../config.ts";
import { serverModules } from "../modules.ts";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string): string => `${config.siteUrl}${path}`;
export const itemUrl = (id: string): string => siteUrl(`/items/${id}`);
export const storyUrl = (publicId: string): string => siteUrl(`/story/${publicId}`);
export const dailyUrl = (date: string): string => siteUrl(`/daily/${date}`);
export const periodUrl = (kind: "weekly" | "monthly", key: string): string => siteUrl(`/${kind}/${key}`);

/** Where v1 links stories: the site, unless a module names another origin for now (ServerModule.storyOrigin). */
const storyOrigin = (): string => serverModules().map((m) => m.storyOrigin?.()).find((o) => o) ?? config.siteUrl;
/** A story's page as v1 links it (hot topics' links.story). */
export const v1StoryUrl = (publicId: string): string => `${storyOrigin()}/story/${publicId}`;
/** A story's v1 address as v1 links it (related stories' links.api). */
export const v1StoryApiUrl = (publicId: string): string => `${storyOrigin()}/api/v1/stories/${publicId}`;
