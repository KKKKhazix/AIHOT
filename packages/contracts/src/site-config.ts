// Configuration fields the engine reads from each edition's own site package.
export interface ModelPreset {
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  /** Output tokens added to every call's own limit for a reasoning model, which reasons before it answers. */
  reasoningTokens?: number;
  jsonMode: boolean;
  vision?: boolean;
  /** Capability → primary model for which this preset is an evaluated backup. */
  fallbackFor?: Record<string, string>;
  /** The score step's call parameters with this model, instead of the step's own (editorial/analyze.ts). */
  scoreCall?: { temperature: number; maxTokens: number; timeoutMs: number };
}

/** The optional founder shown in the site's structured metadata. */
export interface Founder {
  name: string;
  alternateName?: string;
  jobTitle?: string;
  description?: string;
  url?: string;
  sameAs?: string[];
}

/**
 * A site's English edition (served at /en/…): the reader-facing text the site writes itself, in English. The engine's
 * own text is written in both languages where it is used (apps/web/app/lib/i18n.ts). A site without it exports
 * `ENGLISH = null` and has no English pages.
 */
export interface EnglishEdition {
  /** The home page's full title (browser tab, search results). */
  homeTitle: string;
  /** /topics' title. */
  topicsTitle: string;
  /** One sentence about the site: search engines, share cards, feeds. */
  description: string;
  /** A short line under the name on share images. */
  tagline: string;
  /** The small line in the footer, or null. */
  footerNote: string | null;
  /** Search keywords for the home page's structured data. */
  keywords: string[];
  feedback: { lead: string; example: string; emailHint: string };
  /** What the model's one-line reason is called (ITEM_COPY.reasonLabel). */
  reasonLabel: string;
  /** "Daily at 08:00 (GMT+8)": when each report comes out, in a sentence. */
  editionWhen: { daily: string; weekly: string; monthly: string };
  /** Titles of the entry pages in search results; the page adds " · <name>". */
  seoTitles: {
    hot: string;
    all: string;
    agent: string;
    about: string;
    latestReport: (kind: "daily" | "weekly" | "monthly", date: string) => string;
    topic: (name: string, group: "company" | "field" | "genre", updated: string | null) => string;
  };
  /** Links to the terms and the privacy notice, which have no English edition. */
  policyLinks: { terms: string; privacy: string };
  /** POLICY.terms.notes in English: the usage reminders under the agent page's RSS and API panels (null without them). */
  termsNotes: { rss: string; api: string } | null;
  reports: {
    imprint: string;
    motto: string;
    descriptions: { daily: string; weekly: string; monthly: string };
    /** One entry of an issue: "1 top story", "4 top stories". */
    entry: { one: string; many: string };
    metricUnits: Record<"sourcesCount" | "firstPartyEvents" | "selectedCount" | "reportsCovered", { one: string; many: string }>;
    shareUnit: string;
    quiet: { title: string; paragraph: string };
  };
  about: {
    kicker: string;
    description: string;
    headline: [string, string];
    /** {sources} is the live number of sources. */
    lead: string;
    sourcesFallback: string;
    steps: { collect: string; store: string; select: string; publish: string };
    /** Under the maker's greeting, or null to leave the maker block out. */
    maker: { name: string; greeting: string[] } | null;
    /** Copyright and takedown: the Chinese statement stands; this line points to it. The middle is a link to the Chinese about page. */
    copyright: [string, string, string];
  };
  agent: { search: { scope: string; ask: string } };
  /** Share image text of each page (CARDS). */
  cards: Record<string, { kicker: string; title: string; subtitle: string; accent?: "hot" | "amber" }>;
  /** Names the English of the site's news always writes this way (the site's own people and brands, media the texts name in short), Chinese → English. */
  glossary: Record<string, string>;
}
