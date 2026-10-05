/**
 * Ambient model ids the OpenRouter executor runs, with the OpenRouter slug and
 * the routes each id serves. The executor translates requests with it; Cloud
 * refuses to publish an inference catalog that routes another id to OpenRouter
 * (ADR-0297). Routes are code: adding an id here is an executor change.
 */

// OpenRouter requests carry no price cap: price caps left DeepSeek V4.1 Flash
// with slow endpoints (Morph at ~10 tokens/s) that exceeded the stream deadline.
export const OPENROUTER_PUBLIC_MVP_MODELS = {
  "baai/bge-m3": {
    providerModelId: "baai/bge-m3",
    routes: ["/v1/embeddings"],
  },
  "deepseek-v4-flash": {
    providerModelId: "deepseek/deepseek-v4-flash-0731",
    routes: ["/v1/chat/completions", "/v1/responses"],
  },
  "deepseek-v4-1-flash": {
    providerModelId: "deepseek/deepseek-v4.1-flash",
    routes: ["/v1/chat/completions", "/v1/responses"],
    // Prefer the highest-throughput endpoint over OpenRouter's price-weighted
    // default. Buffered and structured replies are bounded by tokens/second.
    sort: "throughput",
  },
  "glm-5-3": {
    providerModelId: "z-ai/glm-5.3",
    routes: ["/v1/chat/completions", "/v1/responses"],
    alwaysOnReasoning: true,
  },
  "glm-5-3-flash": {
    providerModelId: "z-ai/glm-5.3-flash",
    routes: ["/v1/chat/completions", "/v1/responses"],
    alwaysOnReasoning: true,
  },
  "gemma4-31b": {
    providerModelId: "google/gemma-4-31b-it",
    routes: ["/v1/chat/completions", "/v1/responses"],
  },
  // Proper catalog id (ADR-0297) for the same OpenRouter model as gemma4-31b.
  "gemma-4-31b": {
    providerModelId: "google/gemma-4-31b-it",
    routes: ["/v1/chat/completions", "/v1/responses"],
  },
  "whisper-large-v3": {
    providerModelId: "openai/whisper-large-v3",
    routes: ["/v1/audio/transcriptions"],
  },
  // Keep the old ID executable for cached assignments during rollout.
  "whisper-large-v3-turbo": {
    providerModelId: "openai/whisper-large-v3-turbo",
    routes: ["/v1/audio/transcriptions"],
  },
} as const;

/** Routes the OpenRouter executor serves for an Ambient model id; empty when it cannot run it. */
export function openRouterModelRoutes(modelId: string): readonly string[] {
  return Object.hasOwn(OPENROUTER_PUBLIC_MVP_MODELS, modelId)
    ? OPENROUTER_PUBLIC_MVP_MODELS[modelId as keyof typeof OPENROUTER_PUBLIC_MVP_MODELS].routes
    : [];
}

/** The OpenRouter model an Ambient id runs; null when the executor cannot run it. */
export function openRouterProviderModel(modelId: string): string | null {
  return Object.hasOwn(OPENROUTER_PUBLIC_MVP_MODELS, modelId)
    ? OPENROUTER_PUBLIC_MVP_MODELS[modelId as keyof typeof OPENROUTER_PUBLIC_MVP_MODELS].providerModelId
    : null;
}
