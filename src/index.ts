/** LowRouter provider plugin entrypoint. */
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  isLowRouterCacheTtlModelId,
  LOWROUTER_MODELS_PATH,
  projectLowRouterLiveModels,
  resolveLowRouterDynamicModel,
} from "./models.js";
import { applyLowRouterConfig } from "./onboard.js";
import { buildStaticLowRouterProvider } from "./provider-catalog.js";
import { wrapLowRouterStreamFn } from "./stream.js";

const PROVIDER_ID = "lowrouter";

const lowRouterPlugin: OpenClawPluginDefinition = defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "LowRouter Provider",
  description: "LowRouter provider plugin: EU-run, carbon-aware model router",
  manifest,
  provider: {
    label: "LowRouter",
    docsPath: "https://lowrouter.ai/docs/integrations/openclaw",
    manifestAuth: {
      applyConfig: applyLowRouterConfig,
      noteTitle: "LowRouter",
      noteMessage: [
        "LowRouter routes each request to a European or global host for the model you pick,",
        "preferring low-carbon regions, and fails over between them. Billed in EUR.",
        "Create an API key at: https://lowrouter.ai/app/keys",
      ].join("\n"),
    },
    catalog: {
      buildProvider: buildStaticLowRouterProvider,
      buildStaticProvider: buildStaticLowRouterProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: {
        endpointPath: LOWROUTER_MODELS_PATH,
        timeoutMs: 10_000,
        ttlMs: 5 * 60 * 1000,
        projectRows: (rows) => projectLowRouterLiveModels(rows),
      },
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    resolveDynamicModel: ({ modelId, providerConfig }) => {
      const baseUrl =
        typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined;
      return resolveLowRouterDynamicModel(modelId, baseUrl);
    },
    // Claude's prompt cache expires; other models keep OpenClaw's default.
    isCacheTtlEligible: ({ modelId }) => (isLowRouterCacheTtlModelId(modelId) ? true : undefined),
    wrapStreamFn: wrapLowRouterStreamFn,
    wrapSimpleCompletionStreamFn: wrapLowRouterStreamFn,
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});

export default lowRouterPlugin;
