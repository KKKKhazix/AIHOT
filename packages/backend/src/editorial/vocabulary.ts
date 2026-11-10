// Tag normalization and company identity over the industry pack's vocabulary (industry/taxonomy.ts),
// which the topics (industry/topics.json) are built on.
import { ACTIVE_CATEGORIES, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, RELEASE, TAG_SYNONYMS, TOPIC_TAGS } from "@aihot/industry/taxonomy";

export { CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, TOPIC_TAGS } from "@aihot/industry/taxonomy";

const ALLOWED_TAGS = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);

/**
 * Known tags only, synonyms mapped, duplicates dropped; the category tag goes first, and a
 * list without one gets the pack's last category tag (其他).
 */
export function normalizeTags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，]/g) : [];
  const tags: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().replace(/^#/, "");
    const tag = ALLOWED_TAGS.has(t) ? t : (TAG_SYNONYMS[t] ?? TAG_SYNONYMS[t.toLowerCase()] ?? t);
    if (tag && ALLOWED_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  const isCategory = (t: string) => (CATEGORY_TAGS as readonly string[]).includes(t);
  const categoryIndex = tags.findIndex(isCategory);
  const category = categoryIndex >= 0 ? tags[categoryIndex]! : CATEGORY_TAGS[CATEGORY_TAGS.length - 1]!;
  return [category, ...tags.filter((t) => t !== category)];
}

/** The category boundaries the structure step reads, one line per category. */
export const CATEGORY_GUIDE = ACTIVE_CATEGORIES.map((c) => `- ${c.key}（${c.label}）：${c.guide}`).join("\n");

/** The industry's headline launch (RELEASE): narrower than its category, which also holds prices and benchmarks. */
export const isRelease = (category: string | null, tags: readonly string[]) => RELEASE !== null && category === RELEASE.category && tags.includes(RELEASE.tag);

/** Every name the vocabulary knows a company by. */
export const entityNames = (e: (typeof ENTITIES)[string]) => [e.name, ...e.aliases, ...(e.orgNames ?? []), ...(e.otherNames ?? [])];

const key = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
/** Exact entity/alias only: mentions embedded in a sentence are not ownership. */
export function entityIdentity(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = key(value);
  const matches = Object.entries(ENTITIES).filter(([id, entity]) => [id, ...entityNames(entity)].some((alias) => key(alias) === normalized));
  return matches.length > 1 ? null : matches[0]?.[0] ?? null;
}
