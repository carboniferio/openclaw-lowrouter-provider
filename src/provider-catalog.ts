/** LowRouter static provider catalog builder. */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticLowRouterModels, LOWROUTER_BASE_URL } from "./models.js";

/** Builds LowRouter's network-free fallback provider catalog. */
export function buildStaticLowRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: LOWROUTER_BASE_URL,
    api: "openai-completions",
    models: buildStaticLowRouterModels(),
  };
}
