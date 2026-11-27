// Editorial policy contracts implemented by an installed review module and consumed by the editorial pipeline.
import type { ContentPart } from "../providers/llm.ts";

export interface EditorialFact {
  title: string;
  subject?: string | null;
  action?: string | null;
  object?: string | null;
  occurredAt?: string | null;
  evidence: string | null;
  conditions: Array<{ text: string; quote: string }>;
}

export interface EditorialLoadedImages {
  parts: ContentPart[];
  /** Images that could not be inspected (transient fetch failure, unsupported format or beyond review cap). */
  unverifiedCount: number;
}

export interface EditorialReviewInput {
  articleId: string;
  revision: number;
  attemptTag?: string;
  title: string;
  url: string;
  excerpt: string;
  bodyText: string;
  xPostText: string;
  xQuotedText: string;
  xArticleText?: string;
  imageCount?: number;
  loadImages?: () => Promise<EditorialLoadedImages>;
  relevance: "pass" | "block" | "unknown";
  selected: boolean;
  score: number | null;
  titleZh: string | null;
  summaryZh: string | null;
  reasonZh: string | null;
  fact: EditorialFact | null;
  contentRefused: boolean;
}

export interface EditorialReviewOutcome {
  relevance?: "pass" | "block" | "unknown";
  selected?: boolean;
  score?: number | null;
  titleZh?: string | null;
  summaryZh?: string | null;
  reasonZh?: string | null;
  fact?: EditorialFact | null;
  suppressOriginal?: boolean;
  withdrawn?: boolean;
  reused?: boolean;
  receiptIds?: number[];
  review?: Record<string, unknown>;
}

export interface EditorialTranslationReviewInput {
  subject: string;
  title: string;
  sourceText: string;
  translatedText: string;
  contentRefused?: boolean;
}

export interface EditorialStoryDigestReviewInput {
  storyId: number;
  title: string;
  digest: string;
  fallbackTitle?: string;
  fallbackDigest?: string;
}

export interface EditorialEventCopyInput {
  title: string;
  /** The member report's title and summary, to disambiguate a shorter event title. */
  reportContext?: string;
  fallbackTitle?: string | null;
  conditions?: string | null;
  subject?: string | null;
  action?: string | null;
  object?: string | null;
}

export interface EditorialEventCopyOutcome {
  title: string;
  conditions: string | null;
  subject: string | null;
  action: string | null;
  object: string | null;
}

export interface EditorialPolicy {
  /** Receipt purposes produced during analyzeArticle that should resume the article when an unknown receipt is released (jobs/content.ts). */
  analysisPurposes?: readonly string[];
  /** Reviews an analysed or provider-refused item before its analysis row is saved (editorial/analyze.ts). */
  reviewAnalysis?: (input: EditorialReviewInput) => Promise<EditorialReviewOutcome | null>;
  /** Reviews translated body or quote text before it is stored (editorial/translate.ts). */
  reviewTranslation?: (input: EditorialTranslationReviewInput) => Promise<{ allow: boolean; reason?: string; receiptIds?: number[] }>;
  /** Reviews a generated event title and digest before saving (events/digest.ts). */
  reviewStoryDigest?: (input: EditorialStoryDigestReviewInput) => Promise<{ title: string; digest: string; receiptIds?: number[] } | null>;
  /** Sanitizes stored fact and story copy when a report is grouped, revised or overridden. */
  sanitizeEventCopy?: (input: EditorialEventCopyInput) => EditorialEventCopyOutcome;
}
