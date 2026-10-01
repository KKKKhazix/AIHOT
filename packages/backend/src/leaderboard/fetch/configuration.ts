// Configurations (reasoning tiers) and the fixed selection priority published on the rules page:
// the representative row of a model is its highest first-party tier; the choice never looks at scores.
// Hybrid or fallback runs and pre-release builds are kept for reference but cannot represent a model.

export type ConfigurationKind = "FIRST_PARTY" | "SOURCE_DEFAULT" | "SCAFFOLDED";

export interface Configuration {
  key: string;
  label: string;
  kind: ConfigurationKind;
  /** The stored priority (scaffolded systems are stored as 0). */
  priority: number;
  /** Ordering used to choose the representative row; any first-party or default row ranks above a scaffolded system. */
  rank: number;
  /** Why the row can never be the representative one, if so. */
  ineligible: string | null;
}

export const REASONS = {
  firstParty: "按预先固定的规则，采用该来源可用的最高第一方推理档位；选择不参考跑分高低。",
  sourceDefault: "该来源没有区分推理档位，采用其官方默认配置。",
  lowerPriority: "该配置已保留供核对，但固定优先级低于本指标的代表配置。",
  scaffoldedSelected: "该来源对所有模型使用同一受控系统；按预先固定的推理档位优先级选择，配置明细保留，成绩归到基础模型。",
  scaffoldedLower: "该配置已保留供核对，但固定优先级低于本指标选中的系统配置。",
  hybrid: "混合模型或回退配置，不能代表单个模型的能力。",
  preRelease: "来源明确标为发布前版本，不能代表可使用的正式模型。",
  special: "来源为专用系统或尚未核实的运行配置，无法归到单个公开模型。",
  cloaked: "匿名测试时期的型号，尚不能把该次评测对应到已公开的固定版本。",
} as const;

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Tokens that describe how a model was run (as opposed to dates, channels or editions). */
const CONFIG_TOKEN = /^(reasoning|non-reasoning|thinking|non-thinking|adaptive-reasoning|(x?high|medium|low|max|minimal)(-effort)?|thinking-(\d+k|minimal)|high-\d+k|default-fallback|.+-fallback|\d+|\d+-\d+)$/;

const TIERS: Array<[RegExp, number, string]> = [
  [/^max(-effort)?$/, 600, "Max 推理"],
  [/^xhigh(-effort)?$/, 550, "xHigh 推理"],
  [/^high(-effort|-\d+k)?$/, 500, "High 推理"],
  [/^medium(-effort)?$/, 300, "Medium 推理"],
  [/^low(-effort)?$/, 200, "Low 推理"],
  [/^minimal$/, 100, "Minimal 推理"],
];

/**
 * Builds the configuration from the run descriptors a source gives (e.g. "(Adaptive Reasoning, High
 * Effort)"). Effort tiers win over reasoning / non-reasoning; adaptive reasoning ranks just above the
 * same tier; a fallback run ranks just below it and is not a single model.
 */
export function configurationOf(descriptors: string[], opts: { defaultKind?: ConfigurationKind; numericTokens?: boolean } = {}): Configuration {
  const tokens = new Set<string>();
  for (const d of descriptors) {
    for (const part of d.split(/\s*,\s*/)) {
      const t = slug(part);
      // Bare numbers are run settings only where a source uses them that way (e.g. "_1" suffixes), not versions like "(0902)".
      if (t && CONFIG_TOKEN.test(t) && (opts.numericTokens || !/^\d+(-\d+)?$/.test(t))) tokens.add(t);
    }
  }
  // "thinking-minimal" style descriptors also name their tier.
  for (const t of [...tokens]) {
    const m = /^thinking-(minimal|low|medium|high)$/.exec(t);
    if (m) tokens.add(m[1]!);
  }
  // Adaptive runs also carry their bare tier (high/xhigh/medium/low; "max effort" stays as is).
  if (tokens.has("adaptive-reasoning")) {
    for (const t of [...tokens]) {
      const effort = /^(x?high|medium|low)-effort$/.exec(t);
      if (effort) tokens.add(effort[1]!);
    }
  }
  if (!tokens.size) {
    return { key: "source_default:default", label: "来源默认配置", kind: opts.defaultKind ?? "SOURCE_DEFAULT", priority: 400, rank: 400, ineligible: null };
  }
  const list = [...tokens].sort();
  const adaptive = tokens.has("adaptive-reasoning");
  const fallback = list.some((t) => t.endsWith("-fallback"));
  let priority = 400;
  let label = "来源默认配置";
  for (const [re, p, l] of TIERS) {
    if (list.some((t) => re.test(t))) {
      priority = p;
      label = l;
      break;
    }
  }
  if (priority === 400 && tokens.has("non-reasoning") && list.length === 1) {
    priority = 50;
    label = "非推理配置";
  }
  // Adaptive low/medium runs sit just above the default tier; other adaptive tiers just above their own.
  const adaptiveLow = adaptive && (priority === 300 || priority === 200);
  if (adaptiveLow) priority = 450;
  if (adaptive) priority += 2;
  if (fallback) priority -= 1;
  if (adaptive) label = adaptiveLow ? "自适应推理" : `${label} · 自适应`;
  const budget = list.map((t) => /^(?:thinking|high)-(\d+k)$/.exec(t)?.[1]).find(Boolean);
  if (budget) label = `${label} · ${budget}`;
  if (fallback) label = `${label} · 含来源回退`;
  return {
    key: `first_party:${list.join("+")}`,
    label,
    kind: "FIRST_PARTY",
    priority,
    rank: priority,
    ineligible: fallback ? REASONS.hybrid : null,
  };
}

/**
 * A run through a fixed harness or agent system (e.g. "codex-harness"): represents a model only without a
 * first-party row. The label names the tier (or "完整系统") and then the system, as the source names it.
 */
export function scaffolded(base: Configuration, systemTokens: string[], systemLabels: string[]): Configuration {
  const tier = base.key.startsWith("first_party:") ? base.key.slice("first_party:".length).split("+") : [];
  const list = [...tier, ...systemTokens].sort();
  const label = [base.kind === "SOURCE_DEFAULT" ? "完整系统" : base.label, ...systemLabels].join(" · ");
  // Keys are capped at 108 characters (system ids can be long); ranked by tier, just below first-party.
  return { key: `scaffolded:${list.join("+")}`.slice(0, 108), label, kind: "SCAFFOLDED", priority: 0, rank: base.priority - 1, ineligible: base.ineligible };
}

/** LiveBench-style suffixes: "-thinking-64k-high-effort" → "high-effort"; "-xhigh" / "-max" only for tiered families. */
export function peelEffortSuffix(name: string): { base: string; tier: string | null } {
  const m = /^(.*?)(?:-thinking(?:-[a-z0-9]+)?)?-((?:x?high|medium|low|max|minimal)-effort)$/i.exec(name);
  if (m) return { base: m[1]!, tier: m[2]!.toLowerCase() };
  return peelTierSuffix(name);
}

/** Families whose names carry reasoning-effort tiers; elsewhere "max" or "medium" is part of the product name (Qwen Max, Mistral Medium). */
const TIERED_FAMILY = /^(claude|gemini|gpt-[5-9]|grok|muse)/i;

/** Peels a trailing tier from a hyphenated name: "gpt-5.4-high" → ["gpt-5.4", "high"]; "…-high-32k" → ["…", "high-32k"]. */
export function peelTierSuffix(name: string): { base: string; tier: string | null } {
  const m = /^(.*?)-((?:x?high|medium|low|minimal|max)(?:-\d+k)?)$/i.exec(name);
  return m && TIERED_FAMILY.test(name) ? { base: m[1]!, tier: m[2]!.toLowerCase() } : { base: name, tier: null };
}

/** Splits "GPT-5 (high)" into the base name and its parenthesised descriptors. */
export function splitName(name: string): { base: string; descriptors: string[] } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(name.trim());
  if (!m) return { base: name.trim(), descriptors: [] };
  return { base: m[1]!.trim(), descriptors: [m[2]!] };
}
