import type { MaterialInput } from "../content/materials.ts";

export interface SourceRow {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, any>;
  tier: string;
  participation_mode: "editorial" | "hot_signal" | "isolated";
  /** Uses besides the news pipeline, each declared by an installed module (sources/uses.ts). */
  uses: string[];
  first_party: boolean;
  interval_minutes: number;
  enabled: boolean;
  cursor: Record<string, any> | null;
  fail_count: number;
}

/**
 * What a fetcher found on a listing, before identity and timeline rules are applied. Whether the
 * article page is then fetched for a body is decided per source (jobs/content.ts route); an entry
 * that has no page says so with bodyStatus "none".
 */
export type Candidate = Omit<MaterialInput, "sourceId" | "via"> & {
  categories?: string[];
};

export class FetchError extends Error {}
