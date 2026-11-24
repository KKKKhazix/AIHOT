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
