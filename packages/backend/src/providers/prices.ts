import { sql } from "../db.ts";

type Rate = string | number | null;

interface ServicePrice {
  service: string;
  model: string;
  currency: string;
  input_per_mtok: Rate;
  cached_per_mtok: Rate;
  output_per_mtok: Rate;
  per_request?: Rate;
}

/** SQL expression for cached prompt tokens across OpenAI-style and DeepSeek/DashScope usage payloads. */
export const cachedTokensSql = (usageCol: ReturnType<typeof sql> = sql`usage`) =>
  sql`coalesce((${usageCol}->'prompt_tokens_details'->>'cached_tokens')::bigint, (${usageCol}->>'prompt_cache_hit_tokens')::bigint, 0)`;

/** Uncached prompt tokens billed at the regular input tariff; never negative if a provider reports cached > prompt. */
export function freshTokens(prompt: number, cached: number): number {
  return Math.max(0, prompt - cached);
}

/** A model's own tariff takes precedence over its service's default. */
export function priceFor(prices: readonly ServicePrice[], service: string, model: string | null) {
  return prices.find(p => p.service === service && p.model === model)
    ?? prices.find(p => p.service === service && p.model === "");
}

/** Estimate in the tariff's currency, from usage whose receipt has no cost of its own. */
export function estimatedCharge(price: ServicePrice, usage: { fresh: number; cached: number; output: number; requests?: number }): number {
  return (usage.fresh / 1e6) * Number(price.input_per_mtok ?? 0)
    + (usage.cached / 1e6) * Number(price.cached_per_mtok ?? price.input_per_mtok ?? 0)
    + (usage.output / 1e6) * Number(price.output_per_mtok ?? 0)
    + (usage.requests ?? 0) * Number(price.per_request ?? 0);
}
