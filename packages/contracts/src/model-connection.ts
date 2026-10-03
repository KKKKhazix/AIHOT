// Shared, secret-free connection presets and local recognition hints.
export const MODEL_PROVIDERS = [
  { id: "dashscope", label: "阿里云百炼（北京）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-flash" },
  { id: "dashscope-intl", label: "阿里云百炼（新加坡）", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "deepseek", label: "DeepSeek 官方", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
  { id: "zhipu", label: "智谱官方", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash" },
  { id: "openai", label: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "" },
  { id: "custom", label: "第三方中转 / 自定义", baseUrl: "", model: "" },
] as const;

export type ModelProvider = typeof MODEL_PROVIDERS[number]["id"];
export interface ModelConnectionInput {
  provider: ModelProvider | "auto";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  extraJson?: string;
}
export interface ModelConnectionView {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  extraJson: string;
  hasKey: boolean;
  source: "env" | "admin";
}

/** Hints only. Generic sk- keys and model names cannot identify a vendor or a relay. */
export function recognizeModelProvider(apiKey: string): ModelProvider | null {
  const key = apiKey.trim();
  if (/^sk-ws-[A-Za-z0-9_.-]+$/.test(key)) return "dashscope";
  if (/^sk-(?:proj|svcacct)-[A-Za-z0-9_-]+$/.test(key)) return "openai";
  return null;
}

export function providerForUrl(baseUrl: string): ModelProvider {
  const normalized = baseUrl.replace(/\/+$/, "");
  return MODEL_PROVIDERS.find((p) => p.baseUrl && p.baseUrl === normalized)?.id ?? "custom";
}

export function defaultModelExtra(provider: ModelProvider, model: string): Record<string, unknown> {
  // Relay parameters follow the selected model, not the relay's brand.
  const name = model.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^qwen(?:3|[-+])/.test(name)) return { enable_thinking: false };
  if (/^(?:deepseek-flash|deepseek-v[34])/.test(name)) return { thinking: { type: "disabled" } };
  if (provider === "zhipu" && /^glm-5/.test(name)) return { thinking: { type: "enabled" }, reasoning_effort: "low" };
  return {};
}
