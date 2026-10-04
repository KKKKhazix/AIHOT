// What the evaluation scripts (scripts/eval-*.ts) share: argument checks, the models to compare, bounded
// concurrency, what their paid attempts used, and safe report names.
import { sql } from "@aihot/backend/db";
import { modelFor } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";

export function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

/** --models as given (`default` or the site's presets), else the model the step uses now. */
export async function evalModels(list: string | undefined, step: string): Promise<string[]> {
  const models = list ? list.split(",").map((model) => model.trim()).filter(Boolean) : [await modelFor(step)];
  if (!models.length) throw new Error("--models did not name any models");
  for (const model of models) if (!MODELS[model]) throw new Error(`unknown model ${model}`);
  return models;
}

/** `fn` over `items`, at most `limit` at a time; results keep the items' order. */
export async function pmap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

/** Every attempt behind these receipts, each receipt once, unusable answers included. */
export async function usageFor(receiptIds: number[]) {
  const ids = [...new Set(receiptIds)];
  if (!ids.length) return { tokensIn: 0, tokensOut: 0, avgLatencyMs: 0 };
  const [usage] = await sql<{ tin: number; tout: number; latency: number }[]>`
    SELECT
      sum(coalesce((usage->>'prompt_tokens')::int, (usage->>'input_tokens')::int, 0)) AS tin,
      sum(coalesce((usage->>'completion_tokens')::int, (usage->>'output_tokens')::int, 0)) AS tout,
      avg(latency_ms) AS latency
    FROM receipt_attempts WHERE receipt_id IN ${sql(ids)}`;
  return {
    tokensIn: Number(usage?.tin ?? 0),
    tokensOut: Number(usage?.tout ?? 0),
    avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
  };
}

/** A user-supplied split may contain path separators; report names must stay inside .data/eval. */
export function safeReportNamePart(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "all";
}
