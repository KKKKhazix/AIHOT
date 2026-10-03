// Codex reset monitor DTOs: the public v1 snapshot (GET /api/v1/codex-resets) and the page data
// the site builds from the same snapshot.

/** Upstream collection cadence, also shown in the page and client guidance. */
export const CODEX_RESET_SCAN_MINUTES = 10;

export interface CodexResetContextPost {
  id: string;
  author: string;
  relation: "reply" | "quote";
  text: string | null;
  originalText: string;
  url: string;
}

export interface CodexResetPost {
  id: string;
  publishedAt: string | null;
  stage: string;
  text: string;
  originalText: string;
  fullText: string | null;
  fullOriginalText: string | null;
  context: CodexResetContextPost[];
  url: string;
}

export type CodexPresentationStatus = "announced" | "in_progress" | "confirmed" | "expired_unconfirmed" | "likely_completed";

export interface CodexResetEvent {
  id: string;
  type: "direct_reset" | "reset_credit";
  label: string;
  displayLabel: string;
  presentation: {
    reportedAt?: string | null;
    status: CodexPresentationStatus;
    scopeKnown: boolean;
    scopeLabel: string | null;
    kindExplicit: boolean;
    timeInferred: boolean;
    audienceZh: string | null;
    productsZh: string | null;
  } | null;
  estimate: { from: string | null; through: string | null; basis: string; label: string; reason: string } | null;
  status: "announced" | "confirmed";
  title: string;
  scope: string;
  createdAt: string | null;
  updatedAt: string | null;
  confirmedAt: string | null;
  occurredOn: string | null;
  confirmationBasis: "source_post" | "receipt_review" | null;
  schedule: { precision: string; from: string | null; through: string | null; label: string } | null;
  posts: CodexResetPost[];
  url: string;
}

export interface CodexResetActivity {
  id: string;
  publishedAt: string | null;
  eventIds: string[];
  kind: "event_update" | "related";
  text: string | null;
  originalText: string;
  context: CodexResetContextPost[];
  statusChanged: boolean;
  action: string | null;
  url: string;
}

export interface CodexResetMonitor {
  status: "healthy" | "delayed" | "attention" | "unknown";
  lastAttemptAt: string | null;
  lastCollectedAt: string | null;
  lastVerifiedAt: string | null;
  heldWindowCount: number;
  pendingCount: number;
  reviewCount: number;
}

export interface CodexResetOutage {
  postId: string;
  publishedAt: string | null;
  text: string | null;
  originalText: string;
  recoveredAt: string | null;
  resetEventId: string | null;
  url: string;
}

export interface CodexResetsSnapshot {
  schemaVersion: 1;
  timezone: "Asia/Shanghai";
  today: string;
  checkedAt: string | null;
  historyFrom: string | null;
  count: number;
  events: CodexResetEvent[];
  activities: CodexResetActivity[];
  monitor: CodexResetMonitor | null;
  outage: CodexResetOutage | null;
}

export interface CodexCalendarMark {
  date: string;
  eventId: string;
  type: "direct_reset" | "reset_credit";
  state: "confirmed" | "likely" | "pending";
  label: string;
}

export interface CodexResetPageData extends CodexResetsSnapshot {
  current: CodexResetEvent | null;
  lastLanded: CodexResetEvent | null;
  /** Tibo's X avatar (proxied), when a post of his has been collected. */
  authorAvatar: string | null;
  stats: { resets90: number; credits90: number; medianIntervalDays: number | null; lastResetDate: string | null };
  calendar: CodexCalendarMark[];
  /** Beijing minute of day (0–1439) of each source-confirmed direct reset, for the timing chart. */
  confirmMinutes: number[];
  version: string;
}

/** The site sends bodies for the selected calendar day, while v1 keeps the complete snapshot. */
export interface CodexResetSitePage extends Omit<CodexResetPageData, "activities"> { selectedDate: string }
export interface CodexResetDay { date: string; version: string; events: CodexResetEvent[] }
/** What the open reset page polls: a new version (or a new day) means the page reads itself again. */
export interface CodexResetVersion { version: string; checkedAt: string | null; today: string }
