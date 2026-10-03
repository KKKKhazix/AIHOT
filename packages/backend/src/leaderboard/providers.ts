// The company behind a model, from the organization a source names or else the model's own name. A
// model a source introduces gets its provider here, and rows that still say "other" are resolved the
// same way when the leaderboard shows their mark or applies the 国产模型 filter. Unknown companies stay
// as the source names them.

export interface Provider {
  name: string;
  slug: string;
}

const BY_ORGANIZATION: Array<[RegExp, string, string]> = [
  [/abacus/i, "Abacus.AI", "abacus"],
  [/anthropic/i, "Anthropic", "anthropic"],
  [/openai/i, "OpenAI", "openai"],
  [/google|deepmind/i, "Google", "google"],
  [/(^|\W)xai(\W|$)/i, "xAI", "xai"],
  [/deepseek/i, "DeepSeek", "deepseek"],
  [/alibaba|qwen|阿里巴巴|通义/i, "Alibaba", "alibaba"],
  [/moonshot|kimi|月之暗面/i, "Moonshot AI", "moonshot"],
  [/zhipu|z\.ai|z-ai|\bzai\b|智谱/i, "Z.ai", "z-ai"],
  [/minimax/i, "MiniMax", "minimax"],
  [/mistral/i, "Mistral AI", "mistral"],
  [/^meta\b/i, "Meta", "meta"],
  [/bytedance|^seed\b|doubao|字节|豆包/i, "ByteDance", "bytedance"],
  [/tencent|hunyuan|腾讯/i, "Tencent", "tencent"],
  [/amazon|aws/i, "Amazon", "amazon"],
  [/microsoft/i, "Microsoft", "microsoft"],
  [/nvidia/i, "NVIDIA", "nvidia"],
  [/cohere/i, "Cohere", "cohere"],
  [/\bthinking[-_ ]?machines\b/i, "Thinking Machines Lab", "thinking-machines"],
  [/xiaomi|小米/i, "Xiaomi", "xiaomi"],
  [/baidu|ernie|百度/i, "Baidu", "baidu"],
  [/stepfun|阶跃/i, "StepFun", "stepfun"],
  [/meituan|美团/i, "Meituan", "meituan"],
  [/inclusion\s*ai/i, "InclusionAI", "inclusionai"],
  [/iflytek|讯飞/i, "iFlytek", "iflytek"],
  [/stability/i, "Stability AI", "stability-ai"],
];

const BY_MODEL: Array<[RegExp, string, string]> = [
  [/^claude\b/i, "Anthropic", "anthropic"],
  [/^(gpt|o[ -]?[134]\b|chatgpt)/i, "OpenAI", "openai"],
  [/^(gemini|gemma)\b/i, "Google", "google"],
  [/^grok\b/i, "xAI", "xai"],
  [/^deepseek\b/i, "DeepSeek", "deepseek"],
  [/^(qwen|qwq)(?:\b|\d)/i, "Alibaba", "alibaba"],
  [/^kimi\b/i, "Moonshot AI", "moonshot"],
  [/^glm\b/i, "Z.ai", "z-ai"],
  [/^minimax\b/i, "MiniMax", "minimax"],
  [/^(mistral|mixtral|magistral|devstral|codestral)\b/i, "Mistral AI", "mistral"],
  [/^(llama|muse)\b/i, "Meta", "meta"],
  [/^(seed|doubao)\b/i, "ByteDance", "bytedance"],
  [/^(hy[ -]?\d|hunyuan)/i, "Tencent", "tencent"],
  [/^nova\b/i, "Amazon", "amazon"],
  [/^phi\b/i, "Microsoft", "microsoft"],
  [/^nemotron\b/i, "NVIDIA", "nvidia"],
  [/^command\b/i, "Cohere", "cohere"],
  [/^inkling\b/i, "Thinking Machines Lab", "thinking-machines"],
  [/^mimo\b/i, "Xiaomi", "xiaomi"],
  [/^ernie\b/i, "Baidu", "baidu"],
  [/^step(?:fun)?\b/i, "StepFun", "stepfun"],
  [/^longcat\b/i, "Meituan", "meituan"],
  [/^ling\b|^ring\b/i, "InclusionAI", "inclusionai"],
];

export function inferProvider(modelName: string, organization?: string | null): Provider | null {
  const hit = BY_ORGANIZATION.find(([re]) => re.test(organization?.trim() ?? "")) ?? BY_MODEL.find(([re]) => re.test(modelName.trim()));
  return hit ? { name: hit[1], slug: hit[2] } : null;
}

/** The stored provider slug, or the inferred one when a row still says "other". */
export function providerSlugOf(m: { name: string; provider: string | null; provider_slug: string | null }): string | null {
  if (m.provider_slug && m.provider_slug !== "other") return m.provider_slug;
  return inferProvider(m.name, m.provider === "其他" || m.provider === "Other" ? null : m.provider)?.slug ?? null;
}
