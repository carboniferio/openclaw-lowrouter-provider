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

// LowRouter caches Claude only where the request carries `cache_control`.
const CLAUDE_MODEL_COMPAT: ModelCompatConfig = {
  ...LOWROUTER_MODEL_COMPAT,
  cacheControlFormat: "anthropic",
};

const CLAUDE_ID_PREFIX = "auto/anthropic/";

// `reasoning_effort` values LowRouter publishes, in OpenClaw's level order.
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevelMap = NonNullable<ModelDefinitionConfig["thinkingLevelMap"]>;

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
    compat: {
      ...modelCompat(isClaudeModelId(normalized.id), normalized.thinkingLevelMap),
      ...normalized.compat,
    },
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
  alias_target?: unknown;
  capabilities?: { function_calling?: unknown; input_modalities?: unknown };
  auto_routing?: {
    reasoning_effort?: unknown;
    pricing_range?: {
      currency?: unknown;
      prompt_per_1m_tokens?: PriceRange;
      completion_per_1m_tokens?: PriceRange;
      cache_read_per_1m_tokens?: PriceRange;
      cache_write_per_1m_tokens?: PriceRange;
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

function isClaudeModelId(id: string): boolean {
  return id.toLowerCase().startsWith(CLAUDE_ID_PREFIX);
}

/**
 * Compat for one model. OpenClaw sends no `reasoning_effort` to a non-OpenAI base
 * URL unless told to, so it is turned on for a model with published effort levels,
 * and only those: listed as `supportedReasoningEfforts`, they keep OpenClaw from
 * sending an unpublished `"none"` for the `off` level. A model without them gets
 * no effort, as before.
 */
function modelCompat(claude: boolean, levels?: ThinkingLevelMap): ModelCompatConfig {
  const efforts = levels
    ? Object.values(levels).filter((effort): effort is string => typeof effort === "string")
    : undefined;
  return {
    ...(claude ? CLAUDE_MODEL_COMPAT : LOWROUTER_MODEL_COMPAT),
    ...(efforts ? { supportsReasoningEffort: true, supportedReasoningEfforts: efforts } : {}),
  };
}

// `alias/` ids whose `alias_target` was Claude in the last live discovery. The
// cache-TTL hook gets only a model id, and only `/v1/models` names an alias's target.
// Rebuilt by each projection, so a deleted or retargeted alias drops out.
const claudeAliasIds = new Set<string>();

/**
 * Whether OpenClaw's cache-TTL pruning should wait out a model's prompt cache:
 * Claude ids, and aliases that discovery saw pointing at one.
 */
export function isLowRouterCacheTtlModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return isClaudeModelId(id) || claudeAliasIds.has(id);
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
 * OpenClaw's thinking levels mapped onto the `reasoning_effort` values the model's
 * routes accept. An unpublished base level is `null`, so OpenClaw does not offer
 * it; `xhigh` is offered only when mapped. `off` stays unmapped: OpenClaw then
 * sends no effort and the model keeps its default.
 */
function thinkingLevelMap(levels: readonly unknown[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  for (const level of EFFORT_LEVELS) {
    if (levels.includes(level)) {
      map[level] = level;
    } else if (level !== "xhigh") {
      map[level] = null;
    }
  }
  return map;
}

/**
 * Reasoning support. `auto_routing.reasoning_effort` lists the levels every
 * default route applies as sent; an `auto/` row without it gets no effort. A row
 * without `auto_routing` (most `alias/` models) falls back to
 * `supported_parameters`, then to the bundled row.
 */
function readReasoning(
  row: LowRouterLiveModelRow,
  fallback: ModelDefinitionConfig | undefined,
): Pick<ModelDefinitionConfig, "reasoning" | "thinkingLevelMap"> {
  const routing = asRecord(row.auto_routing);
  if (routing) {
    const published = Array.isArray(routing.reasoning_effort) ? routing.reasoning_effort : [];
    return EFFORT_LEVELS.some((level) => published.includes(level))
      ? { reasoning: true, thinkingLevelMap: thinkingLevelMap(published) }
      : { reasoning: false };
  }
  const params = row.supported_parameters;
  // A published list is authoritative: without a reasoning control the bundled row
  // must not turn effort back on.
  if (Array.isArray(params) && !params.includes("reasoning_effort") && !params.includes("reasoning")) {
    return { reasoning: false };
  }
  return fallback?.thinkingLevelMap
    ? { reasoning: fallback.reasoning, thinkingLevelMap: fallback.thinkingLevelMap }
    : { reasoning: Array.isArray(params) || (fallback?.reasoning ?? false) };
}

/** Claude rows: `auto/anthropic/` ids, and `alias/` ids whose `alias_target` is one. */
function readClaude(id: string, aliasTarget: unknown): boolean {
  if (!id.startsWith("alias/")) {
    return isClaudeModelId(id);
  }
  return typeof aliasTarget === "string" && isClaudeModelId(aliasTarget.trim());
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
  const reasoning = readReasoning(row, fallback);
  const maxTokens = Math.min(
    readPositiveInteger(row.max_output_tokens) ?? fallback?.maxTokens ?? DEFAULT_MAX_TOKENS,
    contextWindow,
  );

  return {
    id,
    name: readName(row.name, id),
    ...reasoning,
    input: readInput(row.capabilities?.input_modalities, fallback),
    cost: {
      input: readRangeMax(usd?.prompt_per_1m_tokens) ?? fallback?.cost.input ?? 0,
      output: readRangeMax(usd?.completion_per_1m_tokens) ?? fallback?.cost.output ?? 0,
      cacheRead: readRangeMax(usd?.cache_read_per_1m_tokens) ?? fallback?.cost.cacheRead ?? 0,
      cacheWrite: readRangeMax(usd?.cache_write_per_1m_tokens) ?? fallback?.cost.cacheWrite ?? 0,
    },
    contextWindow,
    maxTokens,
    compat: modelCompat(readClaude(id, row.alias_target), reasoning.thinkingLevelMap),
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
  claudeAliasIds.clear();
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
    if (model.id.startsWith("alias/") && model.compat?.cacheControlFormat === "anthropic") {
      claudeAliasIds.add(model.id.toLowerCase());
    }
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
    // Same test as the cache-TTL hook, so an alias discovery saw pointing at Claude
    // also gets `cache_control`.
    compat: modelCompat(isLowRouterCacheTtlModelId(id)),
  };
}
