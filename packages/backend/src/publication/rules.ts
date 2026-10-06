// Publication rules. Each rule is defined once here and used by every exit.

export interface SourceFacts {
  id: string;
  name: string;
  kind: string;
  tier: string;
  participation_mode: string;
  first_party: boolean;
  site_fulltext: boolean;
  syndicate_fulltext: boolean;
}

export function channelOf(sourceKind: string, hasXPost: boolean): "x" | "news" {
  return sourceKind === "x_search" || hasXPost ? "x" : "news";
}

/** Public pool (/all): editorial sources, AI relevant, with usable copy or an original post. */
export function isPoolEligible(input: {
  participationMode: string;
  relevance: string | null;
  title: string | null;
  summary: string | null;
  originalPost?: boolean;
}): boolean {
  return input.participationMode === "editorial" && input.relevance === "pass" && !!input.title && (!!input.summary || input.originalPost === true);
}

/**
 * Item detail page (and its Markdown export): every unwithdrawn item from an editorial source has one,
 * with or without a Chinese summary (noindex unless indexable). hot_signal material is heat evidence
 * only and has none. A paused source keeps its pages.
 */
export function hasItemPage(p: { visibility: string; sourceMode: string }): boolean {
  return p.visibility !== "withdrawn" && p.sourceMode === "editorial";
}

/** Selected: pool eligible, judged selected, and the source tier may enter the selection. */
export function isSelectable(eligible: boolean, judgedSelected: boolean | null, tier: string): boolean {
  return eligible && judgedSelected === true && tier !== "EXCLUDE_MP";
}

/**
 * Site full text: the source licence allows showing it and we have confirmed body text.
 * WeChat and paywalled content never get it just because it was fetchable (source flag false).
 */
export function bodyModeOf(source: SourceFacts, bodyStatus: string, hasBody: boolean): "full" | "summary" {
  return source.site_fulltext && bodyStatus === "ok" && hasBody ? "full" : "summary";
}

/** Full-RSS redistribution whitelist: only sources that explicitly allow it. */
export function mayRedistribute(source: SourceFacts, bodyMode: "full" | "summary"): boolean {
  return source.syndicate_fulltext && bodyMode === "full";
}

/**
 * Detail pages are noindex by default. Selected items are indexed automatically; an editor
 * can mark any other public page for indexing, or exclude a page, which then stays out.
 */
export function isIndexable(p: { visibility: string; sourceMode: string; hasSummary: boolean; selected: boolean; seoIndexedAt: Date | null; seoExcludedAt: Date | null }): boolean {
  return p.visibility === "public" && hasItemPage(p) && p.hasSummary && p.seoExcludedAt === null && (p.selected || p.seoIndexedAt !== null);
}

/** Display tags exclude internal entity markers. */
export function displayTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith("entity:"));
}

/**
 * The source name readers see. Admin names carry notes for editors in full-width brackets: the channel,
 * what a feed keeps, a person's role or why the account is followed (「OpenAI：官网动态（RSS · 排除企业/客户案例）」,
 * 「某媒体（热点 RSS）」, 「X：Clément Delangue（Hugging Face CEO） (@ClementDelangue)」). Readers get the name
 * without them, and an X account its display name (its handle when the name is only a note). Every
 * exit people read uses this, and search matches it; JSON fields keep the stored name, which programs
 * may match.
 */
export function publicSourceName(name: string): string {
  let bare = name;
  while (/（[^（）]*）/.test(bare)) bare = bare.replace(/（[^（）]*）/g, " ");
  const x = /^X[:：]\s*(.*?)\s*(?:\(@[^)]*\))?\s*$/.exec(bare);
  return (x ? x[1]! : bare).replace(/\s+/g, " ").trim() || /@\w+/.exec(name)?.[0] || name.trim();
}
