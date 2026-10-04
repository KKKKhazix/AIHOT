// Story-digest evaluation cases, one event per JSONL line, written by hand or exported from the database
// (scripts/eval-story-digests.ts --stories); the site's digest input made from a case; and the comparison
// a run writes, as Markdown for reading.
import { z } from "zod";
import { byReportTime } from "@aihot/backend/events/digest";
import type { DigestReport } from "@aihot/backend/publication/story-evidence";

const ReportSchema = z.strictObject({
  id: z.string().min(1),
  publishedAt: z.iso.datetime({ offset: true }),
  source: z.string().min(1),
  firstParty: z.boolean().default(false),
  title: z.string().min(1),
  summary: z.string().nullable().default(null),
  fact: z.strictObject({
    id: z.number().int().positive(),
    subject: z.string().nullable().default(null),
    action: z.string().nullable().default(null),
    object: z.string().nullable().default(null),
    conditions: z.string().nullable().default(null),
    evidence: z.string().nullable().default(null),
    /** The analysis's structured fact: its conditions with source quotes, and its evidence. */
    structured: z.unknown().default(null),
  }),
});

const CaseSchema = z.strictObject({
  caseId: z.string().min(1),
  story: z.strictObject({ title: z.string().min(1), previousDigest: z.string().nullable().default(null) }),
  /**
   * incremental: the site's update, with previousDigest (if any) and the reports not in knownArticleIds
   * marked new; with neither, an event's first digest. corrected: rewritten from the reports as they are
   * now, without the previous digest, as after a correction.
   */
  inputMode: z.enum(["incremental", "corrected"]).default("incremental"),
  knownArticleIds: z.array(z.string().min(1)).default([]),
  reports: z.array(ReportSchema).min(1),
});

export type DigestEvalCase = z.infer<typeof CaseSchema>;

/** Blank lines and lines starting with // are skipped. */
export function parseDigestEvalJsonl(text: string): DigestEvalCase[] {
  const rows: DigestEvalCase[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (!raw.trim() || raw.trim().startsWith("//")) continue;
    let row: DigestEvalCase;
    try {
      row = CaseSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(`line ${line}: ${error instanceof z.ZodError ? z.prettifyError(error) : String(error)}`);
    }
    if (ids.has(row.caseId)) throw new Error(`line ${line}: duplicate caseId ${row.caseId}`);
    ids.add(row.caseId);
    rows.push(row);
  }
  return rows;
}

/**
 * An event as the site rewrites its digest from its current reports (digestReports): without the
 * previous digest when it has saved one, the way a correction is rewritten; as a first digest otherwise.
 */
export function caseFromStory(story: { publicId: string; title: string; hasDigest: boolean }, reports: DigestReport[]): DigestEvalCase {
  return {
    caseId: story.publicId,
    story: { title: story.title, previousDigest: null },
    inputMode: story.hasDigest ? "corrected" : "incremental",
    knownArticleIds: [],
    reports: [...reports].sort(byReportTime).map((report) => ({
      id: report.id,
      publishedAt: report.at.toISOString(),
      source: report.source_name,
      firstParty: report.first_party,
      title: report.title,
      summary: report.summary,
      fact: {
        id: report.fact_id,
        subject: report.fact_subject,
        action: report.fact_action,
        object: report.fact_object,
        conditions: report.fact_conditions,
        evidence: report.evidence,
        structured: report.structured_fact ?? null,
      },
    })),
  };
}

/** The case as buildStoryDigestInput's arguments. */
export function toDigestInput(row: DigestEvalCase) {
  return {
    story: { title: row.story.title, digest: row.story.previousDigest },
    reports: row.reports.map((report): Omit<DigestReport, "story_id"> => ({
      id: report.id,
      title: report.title,
      summary: report.summary,
      source_name: report.source,
      first_party: report.firstParty,
      at: new Date(report.publishedAt),
      fact_id: report.fact.id,
      fact_subject: report.fact.subject,
      fact_action: report.fact.action,
      fact_object: report.fact.object,
      fact_conditions: report.fact.conditions,
      evidence: report.fact.evidence,
      structured_fact: report.fact.structured,
    })).sort(byReportTime),
    corrected: row.inputMode === "corrected",
    knownArticleIds: row.knownArticleIds,
  };
}

export function inputForm(row: DigestEvalCase): string {
  if (row.inputMode === "corrected") return "更正后重写（不带上一版综述）";
  return row.story.previousDigest ? "增量更新（带上一版综述）" : "首次撰写";
}

export interface DigestCall {
  title: string | null;
  digest: string | null;
  receiptId: number | null;
  reused: boolean;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  error: string | null;
}

export interface DigestPromptSummary {
  calls: number;
  succeeded: number;
  errors: number;
  reused: number;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
}

/** What a run writes: per model, each case's call with the site's prompt beside the candidate's. */
export interface DigestEvalReport {
  meta: {
    createdAt: string;
    cases: string;
    calls: number;
    prompts: { live: { version: string }; candidate?: { file: string; version: string } };
  };
  models: Record<string, {
    summary: { live: DigestPromptSummary; candidate?: DigestPromptSummary; wallSeconds: number };
    cases: Array<{ caseId: string; storyTitle: string; input: string; reports: number; live: DigestCall; candidate?: DigestCall }>;
  }>;
}

const PROMPTS = [["live", "线上提示词"], ["candidate", "候选提示词"]] as const;

const usage = (call: { receiptId: number | null; reused: boolean; tokensIn: number; tokensOut: number }) =>
  `${call.receiptId === null ? "无回执" : `回执 #${call.receiptId}`} · 输入 ${call.tokensIn} tokens · 输出 ${call.tokensOut} tokens${call.reused ? " · 复用已收到的结果" : ""}`;

/** The report for reading: every case's answers one after another, line breaks kept. */
export function digestComparisonMarkdown(report: DigestEvalReport): string {
  const { meta } = report;
  const lines = [
    "# 事件综述提示词对比",
    "",
    `- 生成时间：${meta.createdAt}`,
    `- 案例：${meta.cases}`,
    `- 线上提示词：${meta.prompts.live.version}`,
    ...(meta.prompts.candidate ? [`- 候选提示词：${meta.prompts.candidate.file}（${meta.prompts.candidate.version}）`] : []),
    `- 模型调用：${meta.calls} 次`,
  ];
  for (const [model, run] of Object.entries(report.models)) {
    for (const [key, label] of PROMPTS) {
      const summary = run.summary[key];
      if (summary) lines.push(`- ${model} · ${label}：成功 ${summary.succeeded}/${summary.calls}，输入 ${summary.tokensIn} tokens，输出 ${summary.tokensOut} tokens，${summary.reused} 次复用已收到的结果`);
    }
  }
  const runs = Object.entries(report.models);
  for (const [index, item] of (runs[0]?.[1].cases ?? []).entries()) {
    lines.push("", `## ${index + 1}. ${item.storyTitle}`, "", `案例 \`${item.caseId}\` · 报道 ${item.reports} 篇 · ${item.input}`);
    for (const [model, run] of runs) {
      for (const [key, label] of PROMPTS) {
        const call = run.cases[index]![key];
        if (!call) continue;
        lines.push("", `### ${label} · ${model}`, "");
        if (call.error !== null || call.digest === null) lines.push(`生成失败：${call.error}`);
        else lines.push(`**${call.title || "（沿用事件标题）"}**`, "", ...call.digest.split("\n").map((line) => (line ? `> ${line}  ` : ">")));
        lines.push("", usage(call));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
