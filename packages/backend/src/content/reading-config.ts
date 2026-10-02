import { config, credential } from "../config.ts";
import { modelFor } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";

/** Resource ceilings, versioned with the reading. Reaching one is never reported as complete. */
export const READING_POLICY = {
  version: "body-reading-v1", maxImages: 12, maxTiles: 32, maxTilesPerImage: 8,
  maxBatchTiles: 8, maxBatchImages: 4, maxBlocks: 500, maxTextChars: 60_000,
  tileWidth: 1600, tileHeight: 1800, overlap: 120, maxPixels: 40_000_000,
} as const;

export function bodyReadingMode(): "off" | "shadow" | "active" {
  const value = process.env.BODY_READING_MODE ?? "off";
  if (value !== "off" && value !== "shadow" && value !== "active") throw new Error("BODY_READING_MODE must be off, shadow or active");
  return value;
}

export function readingConcurrency(): number {
  const value = process.env.BODY_READING_CONCURRENCY ?? "1";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 8) throw new Error("BODY_READING_CONCURRENCY must be between 1 and 8");
  return Number(value);
}

export async function readingModel(): Promise<string> {
  const key = await modelFor("bodyReading");
  const model = MODELS[key];
  if (!model?.vision) throw new Error(`正文读取需要支持图片的模型：${key}（默认模型需设置 LLM_VISION=true）`);
  if (!model.model || !credential("models", model.baseUrlEnv) || !credential("models", model.apiKeyEnv)) throw new Error(`正文读取模型未配置完整：${key}`);
  return key;
}

export async function checkReadingConfig(): Promise<void> {
  const mode = bodyReadingMode();
  readingConcurrency();
  if (mode !== "off" && config.modelCallsEnabled) await readingModel();
}
