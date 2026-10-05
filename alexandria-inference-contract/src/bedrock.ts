import type { InferenceRoute } from "./schemas.js";

/** Server-owned migration policy. Receipts always name the actual Bedrock ID. */
export const BEDROCK_LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gemma4-31b": "google.gemma-4-31b",
  // Released screen-VLM assignments also use DeepSeek IDs: retain vision.
  "deepseek-v4-flash": "google.gemma-4-31b",
  "deepseek-v4-1-flash": "google.gemma-4-31b",
  "glm-5-3": "zai.glm-5",
  // Flash is also selectable for the harness look lane; preserve images.
  "glm-5-3-flash": "google.gemma-4-31b",
  // Proper catalog ids (ADR-0297): current clients send these.
  "gemma-4-31b": "google.gemma-4-31b",
  "glm-5": "zai.glm-5",
  "gpt-oss-120b": "openai.gpt-oss-120b",
  "glm-4.7-flash": "zai.glm-4.7-flash",
  "qwen3-32b": "qwen.qwen3-32b",
};

export interface BedrockModel {
  readonly id: string;
  readonly basePath: "/v1" | "/openai/v1";
  readonly routes: readonly InferenceRoute[];
  readonly maxOutputTokens: number;
  /** AWS model-card context window, K = 1024. Credit holds must cover it plus the output ceiling. */
  readonly contextTokens: number;
  readonly responsesViaChat?: boolean;
}

export const BEDROCK_MODELS: readonly BedrockModel[] = [
  { id: "zai.glm-5", basePath: "/v1", routes: ["chat.completions", "responses"], maxOutputTokens: 8192, contextTokens: 200 * 1024, responsesViaChat: true },
  { id: "google.gemma-4-31b", basePath: "/openai/v1", routes: ["chat.completions", "responses"], maxOutputTokens: 8192, contextTokens: 256 * 1024 },
  { id: "openai.gpt-oss-120b", basePath: "/v1", routes: ["chat.completions", "responses"], maxOutputTokens: 8192, contextTokens: 128 * 1024 },
  { id: "zai.glm-4.7-flash", basePath: "/v1", routes: ["chat.completions"], maxOutputTokens: 4096, contextTokens: 203 * 1024 },
  { id: "qwen.qwen3-32b", basePath: "/v1", routes: ["chat.completions"], maxOutputTokens: 8192, contextTokens: 32 * 1024 },
];

export function resolveBedrockModel(requestedModel: string, route: InferenceRoute): BedrockModel | null {
  const id = Object.hasOwn(BEDROCK_LEGACY_MODEL_ALIASES, requestedModel)
    ? BEDROCK_LEGACY_MODEL_ALIASES[requestedModel] : requestedModel;
  return BEDROCK_MODELS.find((model) => model.id === id && model.routes.includes(route)) ?? null;
}
