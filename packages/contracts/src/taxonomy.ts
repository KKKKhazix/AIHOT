// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, API, RSS) and never change.
// How the public API, RSS and MCP differ from the website is the site's (site/site.ts PUBLIC_CATEGORIES).
import { CATEGORIES, TAG_DISPLAY } from "@aihot/industry/taxonomy";
import { CATEGORY_EN, TAG_EN, TOPIC_EN } from "@aihot/industry/english";
import { PUBLIC_CATEGORIES } from "@aihot/site";

type Category = (typeof CATEGORIES)[number];

export type CategoryKey = Category["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Website tab labels. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

const MERGE: Partial<Record<string, string>> = PUBLIC_CATEGORIES.merge;
const FEED_LABELS: Partial<Record<string, string>> = PUBLIC_CATEGORIES.feedLabels;

/** The categories the public API, RSS and MCP know: a merged category is published as the one it joins. */
export type PublicApiCategoryKey = Exclude<CategoryKey, keyof typeof PUBLIC_CATEGORIES.merge>;
export const PUBLIC_API_CATEGORY_KEYS = CATEGORIES.filter((c) => !Object.hasOwn(MERGE, c.key)).map((c) => c.key) as unknown as readonly [PublicApiCategoryKey, ...PublicApiCategoryKey[]];

export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  const c = CATEGORIES.find((x) => x.key === category);
  if (!c) return null;
  return (MERGE[c.key] ?? c.key) as PublicApiCategoryKey;
}

/** A public category's name in feeds (<category>, a category feed's title): the site's, else the pack's feed label, else its website label. */
export function feedCategoryLabel(key: PublicApiCategoryKey): string {
  const c: { label: string; feedLabel?: string } = CATEGORIES.find((x) => x.key === key)!;
  return FEED_LABELS[key] ?? c.feedLabel ?? c.label;
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部",
  news: "资讯",
  x: "X",
  firstParty: "一手",
};

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/** Reader-facing display label for an article tag; null hides internal-only tags from public cards and chips. */
export function displayTag(tag: string): string | null {
  return Object.hasOwn(TAG_DISPLAY, tag) ? TAG_DISPLAY[tag]! : tag;
}

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

// English edition (/en/…): the same words in English, from the industry pack (industry/english.ts). A word the
// pack has no English for shows as it is.
type Lang = "zh" | "en";

export const CHANNEL_LABELS_EN: Record<ChannelKey, string> = { all: "All", news: "News", x: "X", firstParty: "Official" };

export function categoryLabel(key: CategoryKey, lang: Lang): string {
  return lang === "en" ? CATEGORY_EN[key].label : CATEGORY_LABELS[key];
}

export function channelLabel(key: ChannelKey, lang: Lang): string {
  return lang === "en" ? CHANNEL_LABELS_EN[key] : CHANNEL_LABELS[key];
}

/** displayTag in the reader's language. */
export function displayTagIn(tag: string, lang: Lang): string | null {
  const shown = displayTag(tag);
  return shown === null || lang === "zh" ? shown : (TAG_EN[shown] ?? TAG_EN[tag] ?? shown);
}

export function feedCategoryLabelIn(key: PublicApiCategoryKey, lang: Lang): string {
  return lang === "en" ? CATEGORY_EN[key as CategoryKey]?.feedLabel ?? feedCategoryLabel(key) : feedCategoryLabel(key);
}

/**
 * A report section's name in the reader's language: by the section's key (the first category key that owns it, as
 * issues store it) where it has one, so an issue written before a section was renamed still reads; else by its name.
 */
export function sectionLabelIn(label: string, lang: Lang, key?: string): string {
  if (lang === "zh") return label;
  const category = (key ? CATEGORIES.find((c) => c.key === key) : undefined) ?? CATEGORIES.find((c) => c.section === label);
  return category ? CATEGORY_EN[category.key].section : label;
}

/** A topic's name (topics.json) in the reader's language; `name` is its Chinese name. */
export function topicName(slug: string, name: string, lang: Lang): string {
  return lang === "en" ? TOPIC_EN[slug]?.name ?? name : name;
}

/** A topic's one-line definition in the reader's language; `definition` is the Chinese one. */
export function topicDefinition(slug: string, definition: string, lang: Lang): string {
  return lang === "en" ? TOPIC_EN[slug]?.definition ?? definition : definition;
}
