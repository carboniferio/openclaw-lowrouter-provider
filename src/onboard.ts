/** LowRouter onboarding config helpers. */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildStaticLowRouterModels,
  LOWROUTER_BASE_URL,
  LOWROUTER_DEFAULT_MODEL_REF,
} from "./models.js";

const lowRouterPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: LOWROUTER_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "lowrouter",
    api: "openai-completions",
    baseUrl: LOWROUTER_BASE_URL,
    catalogModels: buildStaticLowRouterModels(),
  }),
});

/** Applies LowRouter's provider catalog and default model. */
export function applyLowRouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return lowRouterPresetAppliers.applyConfig(cfg);
}
