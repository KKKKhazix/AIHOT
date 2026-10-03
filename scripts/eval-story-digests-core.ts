import { z } from "zod";

const ReportSchema = z.object({
  id: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  source: z.string().min(1),
  firstParty: z.boolean().default(false),
  title: z.string().min(1),
  summary: z.string().nullable().default(null),
});

const CaseSchema = z.object({
  caseId: z.string().min(1),
  reports: z.array(ReportSchema).min(1).max(40),
});

export type DigestEvalCase = z.infer<typeof CaseSchema>;

export function parseDigestEvalJsonl(text: string): DigestEvalCase[] {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return CaseSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid digest eval JSONL line ${index + 1}: ${String(error)}`);
    }
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.caseId)) throw new Error(`duplicate digest eval caseId: ${row.caseId}`);
    seen.add(row.caseId);
  }
  return rows;
}
