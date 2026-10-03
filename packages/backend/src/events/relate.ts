// The relation between a report and candidate facts: prompts, schemas, candidate
// descriptions and the pure decision rules. group.ts does the reading and writing around them.
//
// A judgement is three-way. SAME_OCCURRENCE: the same real-world happening (one launch with its
// models, prices and details; the same ruling, report, incident or interview from any outlet).
// SAME_STORY: a direct development of that happening (teaser and launch, launch and a review or a
// third-party listing, an incident and the response). UNRELATED: a different happening, even for the
// same product or company. ROUNDUP: one side is a multi-topic digest. Asking for the three-way
// relation with both reports fully described is what makes the judge usable: a yes/no question with
// "prefer no" refused half of the true merges (measured on labelled pairs).
import { z } from "zod";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const RELATE_PROMPT_VERSION = promptVersion("group-pair", "group-signal");
export const BATCH_PROMPT_VERSION = promptVersion("group-batch");

export const RELATIONS = ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"] as const;
export type Relation = (typeof RELATIONS)[number];

export interface ReportView {
  title: string;
  source: string;
  firstParty: boolean;
  at: Date | null;
  summary: string | null;
  /** Saved source evidence for the current value judgement; identity candidates stay concise. */
  sourceText?: string | null;
  scope?: "single" | "composite" | "unknown";
  frame?: { subject?: string | null; action?: string | null; object?: string | null; occurredAt?: string | null } | null;
}

/** A previously selected report, with its stored source evidence; it has no candidate fact id. */
export interface ReadingContext { report: ReportView; sourceText: string | null }

export interface CandidateView {
  factId: number;
  storyId: number;
  factTitle: string;
  /** Reports already attached to the fact. */
  members: number;
  /** The fact that started its story: developments attach only here (no chaining through developments). */
  storyRoot: boolean;
  /** Recall similarity with the query (cosine of the two embeddings, or the lexical fallback's overlap). */
  score: number;
  report: ReportView;
  /** Only a report already visible in 精选 counts as coverage the reader has seen. */
  selected?: boolean;
  selectedReport?: ReportView | null;
}

export interface SelectionValue { addsValue: boolean; reason: string }

export interface Verdict {
  relation: Relation;
  confidence: number;
  note: string;
}

/**
 * The relation prompts (industry/prompts/group-*.md): a new report against candidate facts with its
 * reading value, a pair, a signal post.
 */
export const BATCH_SYSTEM = promptText("group-batch");
export const PAIR_SYSTEM = promptText("group-pair");
export const SIGNAL_SYSTEM = promptText("group-signal");

const RelationSchema = z.enum(RELATIONS);

export const BatchSchema = z.object({
  query: z.string().max(400).catch(""),
  decisions: z
    .array(z.object({ id: z.string().regex(/^C[1-9]\d*$/), relation: RelationSchema, confidence: z.number().min(0).max(1), note: z.string().max(400).catch("") })),
  selection: z.object({ addsValue: z.boolean(), reason: z.string().trim().min(1).max(400) }),
});

export const PairSchema = z.object({
  a: z.string().max(400).catch(""),
  b: z.string().max(400).catch(""),
  relation: RelationSchema,
  difference: z.string().max(400).catch(""),
  confidence: z.number().min(0).max(1),
});

export const SignalSchema = z.object({
  decisions: z.array(z.object({ id: z.string().regex(/^C[1-9]\d*$/), relation: RelationSchema, confidence: z.number().min(0).max(1) })),
});

function when(at: Date | null): string {
  return at ? `${beijingDate(at)} ${beijingTime(at)}` : "未知";
}

export function describeReport(r: ReportView, label: string, extra = "", summaryLimit = 360): string {
  const f = r.frame;
  return [
    `【${label}】${extra}`,
    `标题：${r.title}`,
    `来源：${r.source}${r.firstParty ? "（当事方/官方）" : ""}｜发布时间：${when(r.at)}`,
    `摘要：${(r.summary ?? "").slice(0, summaryLimit) || "（无）"}`,
    r.scope && r.scope !== "unknown" ? `资料范围：${r.scope === "composite" ? "多个独立发生的综合稿" : "单一具体发生或议题"}` : null,
    f && (f.subject || f.action || f.object)
      ? `事实要素：主体=${f.subject || "?"}；动作=${f.action || "?"}；对象=${f.object || "?"}；日期=${f.occurredAt || "未知"}`
      : null,
    r.sourceText ? `【原文证据】\n${r.sourceText.slice(0, 6000)}\n【原文证据结束】` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export const candidateKey = (index: number) => `C${index + 1}`;

export function batchUser(query: ReportView, cands: CandidateView[], queryLabel = "新报道", reading: ReadingContext[] = []): string {
  const list = cands
    .map((c, i) => [
      describeReport(c.report, `候选 ${candidateKey(i)}`, `（该事实已有 ${c.members} 篇报道；事实标题：${c.factTitle}）`),
      queryLabel === "新报道" ? c.selected && c.selectedReport
        ? describeReport(c.selectedReport, "已公开精选", "（增量只与这篇已展示的内容比较）")
        : "【尚无公开精选】该候选只用于身份判断。" : null,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  const background = reading.map(({ report, sourceText }, i) => [
    describeReport(report, `已公开精选阅读背景 R${i + 1}`, "（只比较信息覆盖，不是事实候选）", 2000),
    sourceText ? `【该已选报道的原文证据】\n${sourceText.slice(0, 6000)}\n【原文证据结束】` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
  return `${describeReport(query, queryLabel)}\n\n${list}${background ? `\n\n${background}` : ""}\n\n${queryLabel}与每个候选的关系是什么？${background ? "同时比较所有已公开精选内容，判断新增价值；无事实候选时 decisions=[]。" : ""}`;
}

export function pairUser(a: ReportView, b: ReportView): string {
  return `${describeReport(a, "报道 A")}\n\n${describeReport(b, "报道 B")}\n\n这两篇报道是什么关系？`;
}

/** An identity answer must address every supplied candidate exactly once. */
export function completeDecisions(decisions: Array<{ id: string }>, count: number): boolean {
  const ids = new Set(decisions.map(d => d.id));
  return decisions.length === count && ids.size === count && Array.from({ length: count }, (_, i) => candidateKey(i)).every(id => ids.has(id));
}

/** Verdicts by fact id; missing answers are failures, never assertions of unrelatedness. */
export function verdictsByFact(decisions: Array<{ id: string; relation: Relation; confidence: number; note?: string }>, cands: CandidateView[]): Map<number, Verdict> {
  if (!completeDecisions(decisions, cands.length)) throw new Error("Identity answer must cover every candidate exactly once");
  const out = new Map<number, Verdict>();
  for (const d of decisions) {
    const n = Number(String(d.id).trim().replace(/^C/i, ""));
    const c = Number.isInteger(n) ? cands[n - 1] : undefined;
    if (c && !out.has(c.factId)) out.set(c.factId, { relation: d.relation, confidence: d.confidence, note: d.note ?? "" });
  }
  return out;
}

/** Candidates the model calls the same occurrence, most confident first (recall similarity breaks ties). */
export function sameOccurrence(cands: CandidateView[], verdicts: Map<number, Verdict>): CandidateView[] {
  return cands
    .filter((c) => verdicts.get(c.factId)?.relation === "SAME_OCCURRENCE")
    .sort((a, b) => (verdicts.get(b.factId)!.confidence - verdicts.get(a.factId)!.confidence) || (b.score - a.score));
}

/** The story a development joins: the most similar candidate that is its story's root occurrence. */
export function storyForDevelopment(cands: CandidateView[], verdicts: Map<number, Verdict>): CandidateView | null {
  return cands.filter((c) => c.storyRoot && verdicts.get(c.factId)?.relation === "SAME_STORY").sort((a, b) => b.score - a.score)[0] ?? null;
}

/** A discussion post counts for a fact it reports, or one it clearly reacts to. */
export function signalTarget(cands: CandidateView[], verdicts: Map<number, Verdict>, minReactionConfidence = 0.8): CandidateView | null {
  return (
    sameOccurrence(cands, verdicts)[0] ??
    cands
      .filter((c) => verdicts.get(c.factId)?.relation === "SAME_STORY" && verdicts.get(c.factId)!.confidence >= minReactionConfidence)
      .sort((a, b) => b.score - a.score)[0] ??
    null
  );
}

/** How sure a relation must be before a report counts as evidence that two stories are one. */
export const TIE_MIN_CONFIDENCE = 0.8;

/** A report is firmly tied to a candidate it calls the same occurrence or a direct development of. */
export function firmlyTied(relation: string | undefined, confidence: number | undefined, minConfidence = TIE_MIN_CONFIDENCE): boolean {
  return (relation === "SAME_OCCURRENCE" || relation === "SAME_STORY") && (confidence ?? 0) >= minConfidence;
}

/**
 * The review model's bar for merging two stories. It reports 0.75 for most developments it agrees
 * with: on the reference pairs story-level precision is 0.944 and recall 0.962 at
 * 0.75, against 0.964 and 0.896 at 0.8, and on 170 real root pairs the extra merges read as right.
 */
export const STORY_REVIEW_MIN_CONFIDENCE = 0.75;

/** The text a report is embedded with: title and the start of the summary, the same on both sides of a comparison. */
export function reportText(title: string, summary: string | null | undefined): string {
  return `${title}。${(summary ?? "").slice(0, 300)}`;
}

/** Lexical stand-in for cosine when embeddings are off (no embedding key): shared character bigrams. */
export function lexicalSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const chars = [...s.replace(/\s+/g, "")];
    return new Set(chars.map((_c, i) => chars.slice(i, i + 2).join("")).filter((g) => g.length === 2));
  };
  const g = grams(a), h = grams(b);
  if (!g.size || !h.size) return 0;
  let inter = 0;
  for (const x of g) if (h.has(x)) inter++;
  return inter / Math.min(g.size, h.size);
}
