// Model per capability: the code default (the site's choice in site/models.ts, else `default`, the deployment's
// own model), an environment override, and an admin switch kept in settings (every switch is audited).
// Read at call time and cached for a minute, so a switch applies to the next call without a restart; a
// changed model only affects work done from then on (history is not re-judged).
import { DEFAULTS } from "@aihot/site/models";
import { sql } from "../db.ts";
import { serverModules } from "../modules.ts";
import { MODELS } from "../providers/llm.ts";

export interface Capability {
  /** The step's name on the admin page, with an explanation in full-width brackets if it needs one; alerts use the name alone. */
  label: string;
  env: string;
  default: string;
  /** Receipt purposes this capability produces (for the admin statistics). */
  purposes: string[];
  /** The step needs a model that reads images. */
  vision?: boolean;
}

export const CAPABILITIES = {
  prefilter: { label: "精选预筛（是否属于这个行业，宽召回）", env: "PREFILTER_MODEL", default: DEFAULTS.prefilter ?? "default", purposes: ["prefilter_article"] },
  score: { label: "精选评分（两次独立评分，按信源分级门槛）", env: "SCORE_MODEL", default: DEFAULTS.score ?? "default", purposes: ["score_article"] },
  understand: { label: "内容理解（入选和接近入选的标题、摘要、推荐理由，能看图时看首图）", env: "UNDERSTAND_MODEL", default: DEFAULTS.understand ?? "default", purposes: ["understand_article"] },
  summarize: { label: "标题摘要（其余文章的中文标题与摘要）", env: "SUMMARIZE_MODEL", default: DEFAULTS.summarize ?? "default", purposes: ["summarize_article"] },
  structure: { label: "结构抽取（分类、标签、主体公司、事件事实，不写读者文字）", env: "STRUCTURE_MODEL", default: DEFAULTS.structure ?? "default", purposes: ["structure_article"] },
  group: { label: "事件归组（新报道与候选事实的关系：同一次发生、同一事件的进展、无关；被同一篇报道连起来的两个事件是否同一事件）", env: "GROUP_MODEL", default: DEFAULTS.group ?? "default", purposes: ["group_article", "group_signal", "group_story"] },
  groupReview: { label: "归组复核（相似度不高的合并、两个事件的合并，写入前再读一遍；最好换一家模型）", env: "GROUP_REVIEW_MODEL", default: DEFAULTS.groupReview ?? "default", purposes: ["group_review", "group_story_review"] },
  digest: { label: "事件综述", env: "DIGEST_MODEL", default: DEFAULTS.digest ?? "default", purposes: ["story_digest"] },
  // Dailies are computed by rule; report_lead and report_daily remain for their older receipts.
  report: { label: "周报月报的总述与主题（日报由规则算出，不用模型）", env: "REPORT_MODEL", default: DEFAULTS.report ?? "default", purposes: ["report_weekly", "report_monthly", "report_lead", "report_daily"] },
  translate: { label: "精选全文翻译（含引用帖）", env: "TRANSLATE_MODEL", default: DEFAULTS.translate ?? "default", purposes: ["translate_body", "translate_quoted"] },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

/** Every step: the engine's, then the installed modules' (their defaults also from site/models.ts). */
export function capabilities(): Record<string, Capability> {
  const all: Record<string, Capability> = { ...CAPABILITIES };
  for (const m of serverModules()) for (const [key, step] of Object.entries(m.models ?? {})) all[key] = { ...step, default: DEFAULTS[key] ?? "default" };
  return all;
}

/** Names of the steps whose default model belongs to a service: what stops when that service refuses us. */
export function stepsOnService(service: string): string[] {
  return Object.values(capabilities())
    .filter((c) => MODELS[c.default]?.service === service)
    .map((c) => c.label.split("（")[0]!);
}

let cache: { at: number; overrides: Record<string, string> } | null = null;

async function overrides(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.overrides;
  const rows = await sql<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
  const map: Record<string, string> = {};
  for (const r of rows) if (r.value?.model && MODELS[r.value.model]) map[r.key.slice("models.".length)] = r.value.model;
  cache = { at: Date.now(), overrides: map };
  return map;
}

export function invalidateModelCache() {
  cache = null;
}

/** Whether a registered model explicitly declares image input support. Unspecified means text-only. */
export function modelSupportsVision(model: string): boolean {
  return MODELS[model]?.vision === true;
}

/** Whether a step can use a registered model. A model that reads images writes text as well. */
export function capabilityAcceptsModel(capability: Capability, model: { vision?: boolean }): boolean {
  return !capability.vision || model.vision === true;
}

/** The model a capability uses now: admin switch, else environment, else the code default. */
export async function modelFor(capability: CapabilityKey | (string & {})): Promise<string> {
  const c = capabilities()[capability];
  if (!c) throw new Error(`unknown model step: ${capability}`);
  const chosen = (await overrides())[capability] ?? process.env[c.env] ?? c.default;
  return MODELS[chosen] ? chosen : c.default;
}

/** Where the current choice comes from, for the admin page. */
export async function modelSources(): Promise<Record<string, { model: string; source: "admin" | "env" | "default" }>> {
  const o = await overrides();
  const out: Record<string, { model: string; source: "admin" | "env" | "default" }> = {};
  for (const [key, c] of Object.entries(capabilities())) {
    if (o[key]) out[key] = { model: o[key]!, source: "admin" };
    else if (process.env[c.env] && MODELS[process.env[c.env]!]) out[key] = { model: process.env[c.env]!, source: "env" };
    else out[key] = { model: c.default, source: "default" };
  }
  return out;
}
