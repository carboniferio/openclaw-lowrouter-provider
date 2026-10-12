/**
 * LowRouter model catalog, compat metadata, and live `/v1/models` projection.
 */
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "../openclaw.plugin.json" with { type: "json" };

const LOWROUTER_MANIFEST_CATALOG = manifest.modelCatalog.providers.lowrouter;

// Used only when /v1/models publishes no window for a model. Deliberately low:
// overstating a window sends prompts the model rejects, understating it only
// makes OpenClaw compact earlier.
const DEFAULT_CONTEXT_WINDOW = 32_768;
// OpenClaw's own default answer cap when a model publishes no output limit.
const DEFAULT_MAX_TOKENS = 8_192;

// LowRouter streams a final usage chunk and accepts OpenAI tool calling on every
// listed model. Some upstream hosts reject the `developer` role and `store`.
const LOWROUTER_MODEL_COMPAT: ModelCompatConfig = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsTools: true,
};

/** Base URL for LowRouter's OpenAI-compatible API. */
export const LOWROUTER_BASE_URL = LOWROUTER_MANIFEST_CATALOG.baseUrl;
/**
 * Model-list path. `currency=usd` returns USD price ranges (OpenClaw tracks cost in
 * USD); without it EUR-billed routes are listed in EUR.
 */
export const LOWROUTER_MODELS_PATH = "models?currency=usd";
/** Default LowRouter model id used for onboarding. */
export const LOWROUTER_DEFAULT_MODEL_ID = LOWROUTER_MANIFEST_CATALOG.defaultModel;
/** Default LowRouter model ref used for onboarding. */
export const LOWROUTER_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "lowrouter",
)!;
/**
 * Bundled fallback rows, used until live discovery succeeds. Generated from
 * `/v1/models` at release time by `scripts/gen-catalog.mjs`; never edited by hand.
 */
export const LOWROUTER_MODEL_CATALOG = LOWROUTER_MANIFEST_CATALOG.models;

/** Builds the network-free fallback catalog. */
export function buildStaticLowRouterModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "lowrouter",
    catalog: LOWROUTER_MANIFEST_CATALOG,
  }).models.map((normalized) => ({
    ...normalized,
    compat: { ...LOWROUTER_MODEL_COMPAT, ...normalized.compat },
  }));
}

type PriceRange = { min?: unknown; max?: unknown };

type LowRouterLiveModelRow = {
  id?: unknown;
  name?: unknown;
  modality?: unknown;
  supported_parameters?: unknown;
  context_length?: unknown;
  max_output_tokens?: unknown;
  capabilities?: { function_calling?: unknown; input_modalities?: unknown };
  auto_routing?: {
    pricing_range?: {
      currency?: unknown;
      prompt_per_1m_tokens?: PriceRange;
      completion_per_1m_tokens?: PriceRange;
      cache_read_per_1m_tokens?: PriceRange;
    };
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Upper bound of a per-1M price range. An `auto/` model is served by several routes
 * at different prices and the response does not say which one will serve, so the
 * dearest route is shown: OpenClaw's estimate may run high, never low.
 */
function readRangeMax(range: PriceRange | undefined): number | undefined {
  const max = range?.max;
  return typeof max === "number" && Number.isFinite(max) && max >= 0 ? max : undefined;
}

/**
 * Picker ids: `auto/<creator>/<model>` (LowRouter picks and fails over between
 * routes) and the account's own `alias/<name>` models. Pinned routes
 * (`<host>/<creator>/<model>`) and jurisdiction-scoped ids
 * (`auto/<creator>/<model>/<scope>`) stay out of the list; they still work when
 * typed, through dynamic model resolution.
 */
export function isPickerModelId(id: string): boolean {
  const parts = id.split("/");
  if (parts.some((part) => part.length === 0)) {
    return false;
  }
  return (parts[0] === "auto" && parts.length === 3) || (parts[0] === "alias" && parts.length === 2);
}

function readInput(
  value: unknown,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig["input"] {
  if (!Array.isArray(value)) {
    return fallback?.input ?? ["text"];
  }
  return value.includes("image") ? ["text", "image"] : ["text"];
}

function readName(value: unknown, id: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : id;
}

/**
 * A model reasons when `/v1/models` lists a reasoning control for it. Without
 * `supported_parameters` the bundled row decides; OpenClaw then sends no effort.
 */
function readReasoning(value: unknown, fallback: ModelDefinitionConfig | undefined): boolean {
  if (!Array.isArray(value)) {
    return fallback?.reasoning ?? false;
  }
  return value.includes("reasoning_effort") || value.includes("reasoning");
}

function projectLiveModel(
  row: LowRouterLiveModelRow,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig | undefined {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || !isPickerModelId(id)) {
    return undefined;
  }
  // OpenClaw acts through tools: embeddings, realtime and tool-less chat models
  // would fail on the first turn.
  if (row.modality !== "chat" || asRecord(row.capabilities)?.function_calling !== true) {
    return undefined;
  }

  const pricing = asRecord(row.auto_routing)?.pricing_range as
    | NonNullable<NonNullable<LowRouterLiveModelRow["auto_routing"]>["pricing_range"]>
    | undefined;
  // OpenClaw costs are USD. A range in any other currency is ignored rather than
  // shown under the wrong symbol.
  const usd = pricing?.currency === "USD" ? pricing : undefined;

  const contextWindow =
    readPositiveInteger(row.context_length) ?? fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.min(
    readPositiveInteger(row.max_output_tokens) ?? fallback?.maxTokens ?? DEFAULT_MAX_TOKENS,
    contextWindow,
  );

  return {
    id,
    name: readName(row.name, id),
    reasoning: readReasoning(row.supported_parameters, fallback),
    input: readInput(row.capabilities?.input_modalities, fallback),
    cost: {
      input: readRangeMax(usd?.prompt_per_1m_tokens) ?? fallback?.cost.input ?? 0,
      output: readRangeMax(usd?.completion_per_1m_tokens) ?? fallback?.cost.output ?? 0,
      cacheRead: readRangeMax(usd?.cache_read_per_1m_tokens) ?? fallback?.cost.cacheRead ?? 0,
      cacheWrite: fallback?.cost.cacheWrite ?? 0,
    },
    contextWindow,
    maxTokens,
    compat: fallback?.compat ?? { ...LOWROUTER_MODEL_COMPAT },
  };
}

/** Projects LowRouter's authenticated `/v1/models` rows into OpenClaw model rows. */
export function projectLowRouterLiveModels(
  rows: readonly unknown[],
  options: { useBundledFallbacks?: boolean } = {},
): ModelDefinitionConfig[] {
  const fallbacks = new Map(
    options.useBundledFallbacks === false
      ? []
      : buildStaticLowRouterModels().map((model) => [model.id, model]),
  );
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    const model = projectLiveModel(record as LowRouterLiveModelRow, fallbacks.get(String(record.id)));
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/**
 * Resolves an id the catalog does not list (a scoped `auto/…/eu`, a pinned route,
 * a model released after the last refresh) so it can still be selected by name.
 */
export function resolveLowRouterDynamicModel(
  modelId: string,
  baseUrl?: string,
): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id || LOWROUTER_MODEL_CATALOG.some((model) => model.id === id)) {
    return undefined;
  }
  return {
    id,
    name: id,
    provider: "lowrouter",
    api: "openai-completions" as const,
    baseUrl: baseUrl?.trim() || LOWROUTER_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { ...LOWROUTER_MODEL_COMPAT },
  };
}
