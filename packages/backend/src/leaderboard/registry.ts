// Reader-facing leaderboard vocabulary: evaluation sources, board copy, score formats and brand marks.
// Scoring weights and eligibility never come from here; they come from the computation run.
import type { LeaderboardBoardKey } from "@aihot/contracts/taxonomy";
import type { LbBoardMeta, LbBrand, LbScoreFormat, LbSourceStatus } from "@aihot/contracts/leaderboard";
import { SITE } from "@aihot/industry/site";
import registryData from "./source-registry.json" with { type: "json" };
import { providerSlugOf } from "./providers.ts";

export interface RegistrySource {
  key: string;
  status: LbSourceStatus;
  name: string;
  fullName?: string;
  operator: string;
  area?: string;
  description: string;
  logo: string | null;
  officialUrl: string | null;
  what: string;
  usage: string;
  limits: string;
  license: string;
  attribution?: string;
  components?: { note: string; label: string };
  /** Reference sources that keep every system row instead of one representative per model. */
  allRows?: boolean;
}

export interface RegistryGroup {
  key: string;
  name: string;
  blurb: string;
  sources: RegistrySource[];
}

export const SOURCE_GROUPS = registryData.groups as RegistryGroup[];

const byKey = new Map<string, { source: RegistrySource; group: RegistryGroup }>();
for (const group of SOURCE_GROUPS) for (const source of group.sources) byKey.set(source.key, { source, group });

export function registrySource(key: string) {
  return byKey.get(key) ?? null;
}

/** Signal units carry a metric suffix for multi-metric sources ("artificial-analysis:intelligence"). */
export function sourceKeyOfUnit(unit: string): string {
  return unit.split(":")[0]!;
}

const GENERAL_READING = `${SITE.name} 评分越高，表示本榜综合表现越强；评分不是正确率，具体能力可查看分项成绩。`;

/** Page copy of each board; board names are LEADERBOARD_BOARD_LABELS. */
export const BOARD_COPY: Record<LeaderboardBoardKey, Pick<LbBoardMeta, "title" | "description" | "howToRead">> = {
  overall: {
    title: `${SITE.name} 大模型排行榜`,
    description: `在统一单型号口径下比较公开评测，展示 ${SITE.name} 评分、参考位次与各项原始成绩。`,
    howToRead: GENERAL_READING,
  },
  coding: {
    title: `编程模型排行榜 · ${SITE.name}`,
    description: "从写代码到改仓库，看模型能不能把软件做出来。",
    howToRead: GENERAL_READING,
  },
  reasoning: {
    title: `推理模型排行榜 · ${SITE.name}`,
    description: "数学、逻辑与陌生规则，看模型能不能想明白新问题。",
    howToRead: GENERAL_READING,
  },
  knowledge: {
    title: `知识模型排行榜 · ${SITE.name}`,
    description: "事实问答与研究生级科学知识，看知识掌握与回答准确性。",
    howToRead: "当前知识榜采用 Epoch 的两项评测，来自同一家机构。",
  },
  professional: {
    title: `专业办公模型排行榜 · ${SITE.name}`,
    description: "金融分析、法律咨询与银行业务，看专业任务能否完成。",
    howToRead: "当前覆盖金融分析与专业咨询，尚不能代表全部办公任务；统一工具流程中的成绩可以参与比较。",
  },
};

export const BOARD_LIMIT = 30;

// How each source publishes its numbers: already in percent, a 0–1 fraction, or a plain score.
const PERCENT_SOURCES = new Set(["livebench-general", "livebench-coding", "livebench-reasoning", "livebench-writing", "mercor-apex-agents", "vals-finance-agent", "tau-banking"]);
const PLAIN_SOURCES = new Set(["artificial-analysis", "artificial-analysis-multilingual", "arena-text", "arena-webdev", "arena-vision", "arena-creative-writing", "eq-creative", "eq-longform", "eq-emotional-v4"]);

export function scoreFormat(sourceKey: string, sample?: number | null): LbScoreFormat {
  if (PERCENT_SOURCES.has(sourceKey)) return "percent";
  if (PLAIN_SOURCES.has(sourceKey)) return "number";
  return sample != null && Math.abs(sample) <= 1 ? "fraction" : "number";
}

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatScore(value: number | null | undefined, format: LbScoreFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (format === "fraction") return `${(value * 100).toFixed(1)}%`;
  if (format === "percent") return `${value.toFixed(1)}%`;
  return grouping.format(value);
}

// Every model mark lives in assets/model-providers (served at /model-providers/) and is chosen here.
// Model-family marks win over company marks: a Qwen mark identifies Qwen, not Alibaba.
const FAMILY_MARKS: Array<[RegExp, string]> = [
  [/^claude/, "anthropic.svg"],
  [/^(gemini|gemma)/, "google.svg"],
  [/^(qwen|qwq)/, "qianwen.svg"],
  [/^kimi/, "moonshot.svg"],
  [/^grok/, "xai.svg"],
  [/^deepseek/, "deepseek.svg"],
  [/^(hy-|hunyuan)/, "tencent.svg"],
  [/^(seed|doubao)/, "bytedance.svg"],
  [/^(glm|chatglm)/, "z-ai.svg"],
  [/^mimo/, "xiaomi-mimo.svg"],
];

/** Genuine company marks, used when no family mark applies. */
const PROVIDER_MARKS: Record<string, string> = {
  openai: "openai.svg",
  meta: "meta.svg",
  minimax: "minimax.svg",
  mistral: "mistral.svg",
  nvidia: "nvidia.svg",
  "z-ai": "z-ai.svg",
  "thinking-machines": "thinking-machines.png",
};

export function modelBrand(slug: string, providerSlug: string | null, provider: string | null, name: string): LbBrand {
  const family = FAMILY_MARKS.find(([re]) => re.test(slug))?.[1];
  const company = providerSlugOf({ name, provider, provider_slug: providerSlug });
  const file = family ?? (company ? PROVIDER_MARKS[company] : undefined);
  const label = (provider && provider !== "其他" ? provider : name).replace(/[^\p{L}\p{N}]/gu, "");
  return { src: file ? `/model-providers/${file}` : null, monogram: label.slice(0, 1).toUpperCase() || "?", raster: !!file?.endsWith(".png") };
}

// eqbench.svg and livebench.png carry raster artwork; they get a plate in dark mode.
const RASTER_SOURCE_MARKS = new Set(["eqbench.svg", "livebench.png", "sierra.png", "agents-last-exam.svg", "llm2014.svg"]);

export function sourceBrand(source: RegistrySource): LbBrand {
  return {
    src: source.logo ? `/leaderboard-sources/${source.logo}` : null,
    monogram: source.operator.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?",
    raster: source.logo ? RASTER_SOURCE_MARKS.has(source.logo) : false,
  };
}
