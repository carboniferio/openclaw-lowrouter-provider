// LowRouter tests cover the bundled catalog and the live /v1/models projection.
import {
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStaticLowRouterModels,
  isLowRouterCacheTtlModelId,
  isPickerModelId,
  LOWROUTER_BASE_URL,
  LOWROUTER_DEFAULT_MODEL_ID,
  LOWROUTER_DEFAULT_MODEL_REF,
  LOWROUTER_MODEL_CATALOG,
  LOWROUTER_MODELS_PATH,
  projectLowRouterLiveModels,
  resolveLowRouterDynamicModel,
} from "../src/models.js";

const TEST_VALUE = "fixture";

/** A `/v1/models?currency=usd` row as LowRouter serves it, trimmed to the fields read. */
function liveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "auto/fixture/never-bundled",
    modality: "chat",
    context_length: 131_072,
    max_output_tokens: 32_768,
    capabilities: { function_calling: true, input_modalities: ["text", "image"] },
    auto_routing: {
      pricing_range: {
        currency: "USD",
        prompt_per_1m_tokens: { min: 0.4, max: 0.45 },
        completion_per_1m_tokens: { min: 2, max: 2.2 },
        cache_read_per_1m_tokens: { min: 0.04, max: 0.045 },
      },
    },
    ...overrides,
  };
}

async function buildLiveModels(fetchGuard: LiveModelCatalogFetchGuard) {
  const provider = await buildOpenAICompatibleLiveModelProviderConfig({
    providerId: "lowrouter",
    providerConfig: {
      baseUrl: LOWROUTER_BASE_URL,
      api: "openai-completions",
      models: buildStaticLowRouterModels(),
    },
    discoveryApiKey: TEST_VALUE,
    fetchGuard,
    modelDiscovery: {
      endpointPath: LOWROUTER_MODELS_PATH,
      timeoutMs: 10_000,
      ttlMs: 5 * 60 * 1000,
      projectRows: (rows) => projectLowRouterLiveModels(rows),
    },
  });
  return provider.models;
}

describe("LowRouter bundled catalog", () => {
  it("is a well-formed snapshot that contains the default model", () => {
    const models = buildStaticLowRouterModels();
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    expect(LOWROUTER_DEFAULT_MODEL_REF).toBe(`lowrouter/${LOWROUTER_DEFAULT_MODEL_ID}`);
    expect(models.some((model) => model.id === LOWROUTER_DEFAULT_MODEL_ID)).toBe(true);
    for (const model of models) {
      expect(isPickerModelId(model.id), model.id).toBe(true);
      expect(model.contextWindow, model.id).toBeGreaterThan(0);
      expect(model.maxTokens, model.id).toBeLessThanOrEqual(model.contextWindow);
      expect(model.compat).toMatchObject({
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        supportsTools: true,
        supportsReasoningEffort: true,
      });
      expect(model.compat?.cacheControlFormat, model.id).toBe(
        model.id.startsWith("auto/anthropic/") ? "anthropic" : undefined,
      );
      expect(model.reasoning, model.id).toBe(model.thinkingLevelMap !== undefined);
    }
    expect(models.some((model) => model.compat?.cacheControlFormat === "anthropic")).toBe(true);
  });

  it("matches what the generator would write for its own rows", () => {
    // Projecting the bundled rows back through the live path must be a no-op on
    // the fields the generator writes (the bundled catalog is the projection).
    const bundled = LOWROUTER_MODEL_CATALOG.find((model) => model.thinkingLevelMap)!;
    const map: Record<string, string | null> = bundled.thinkingLevelMap!;
    const [model] = projectLowRouterLiveModels(
      [
        liveRow({
          id: bundled.id,
          name: bundled.name,
          context_length: bundled.contextWindow,
          max_output_tokens: bundled.maxTokens,
          auto_routing: { reasoning_effort: Object.values(map).filter(Boolean) },
          capabilities: { function_calling: true, input_modalities: bundled.input },
        }),
      ],
      { useBundledFallbacks: false },
    );
    expect(model).toMatchObject({
      id: bundled.id,
      name: bundled.name,
      reasoning: true,
      contextWindow: bundled.contextWindow,
      maxTokens: bundled.maxTokens,
      input: bundled.input,
    });
    expect(model?.thinkingLevelMap).toEqual(map);
  });
});

describe("LowRouter picker ids", () => {
  it.each([
    ["auto/mistralai/mistral-large-2512", true],
    ["alias/my-coder", true],
    ["auto/mistralai/mistral-large-2512/eu", false],
    ["mistral/mistralai/mistral-large-2512", false],
    ["aws-bedrock/anthropic/claude-haiku-4.5/fr-par", false],
    ["auto//x", false],
    ["alias/", false],
  ])("%s -> %s", (id, expected) => {
    expect(isPickerModelId(id)).toBe(expected);
  });
});

describe("LowRouter live projection", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("maps limits, vision and the dearest USD route price", () => {
    const [model] = projectLowRouterLiveModels([liveRow()]);
    expect(model).toMatchObject({
      id: "auto/fixture/never-bundled",
      name: "auto/fixture/never-bundled",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 131_072,
      maxTokens: 32_768,
      cost: { input: 0.45, output: 2.2, cacheRead: 0.045, cacheWrite: 0 },
      compat: { supportsTools: true, supportsUsageInStreaming: true },
    });
  });

  it("keeps only auto/ and alias/ chat models with tool calling", () => {
    const models = projectLowRouterLiveModels([
      liveRow({ id: "auto/a/chat-tools" }),
      liveRow({ id: "alias/my-coder" }),
      liveRow({ id: "auto/a/chat-no-tools", capabilities: { function_calling: false } }),
      liveRow({ id: "auto/a/embed", modality: "embedding" }),
      liveRow({ id: "auto/a/voice", modality: "realtime" }),
      liveRow({ id: "auto/a/chat-tools/eu" }),
      liveRow({ id: "mistral/a/chat-tools" }),
      liveRow({ id: "auto/a/chat-tools" }),
      { id: 42 },
      null,
      "auto/a/string-row",
    ]);
    expect(models.map((model) => model.id)).toEqual(["auto/a/chat-tools", "alias/my-coder"]);
  });

  it("falls back to a low context window and the default cap when limits are missing", () => {
    const [model] = projectLowRouterLiveModels([
      liveRow({ context_length: null, max_output_tokens: undefined }),
    ]);
    expect(model).toMatchObject({ contextWindow: 32_768, maxTokens: 8_192 });
  });

  it("never asks for more output than the context window", () => {
    const [model] = projectLowRouterLiveModels([
      liveRow({ context_length: 16_384, max_output_tokens: 65_536 }),
    ]);
    expect(model).toMatchObject({ contextWindow: 16_384, maxTokens: 16_384 });
  });

  it("ignores non-USD prices rather than showing euros as dollars", () => {
    const bundled = LOWROUTER_MODEL_CATALOG[0]!;
    const eur = {
      auto_routing: {
        pricing_range: {
          currency: "EUR",
          prompt_per_1m_tokens: { min: 0.4, max: 0.4 },
          completion_per_1m_tokens: { min: 2, max: 2 },
        },
      },
    };
    const [unlisted, known] = projectLowRouterLiveModels([
      liveRow({ id: "auto/x/not-bundled", ...eur }),
      liveRow({ id: bundled.id, ...eur }),
    ]);
    expect(unlisted?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // A bundled model keeps its snapshot price.
    expect(known?.cost).toEqual(bundled.cost);
  });

  it("reads text-only input and keeps bundled input when modalities are absent", () => {
    const bundled = LOWROUTER_MODEL_CATALOG[0]!;
    const [textOnly, known] = projectLowRouterLiveModels([
      liveRow({ capabilities: { function_calling: true, input_modalities: ["text", "document"] } }),
      liveRow({ id: bundled.id, capabilities: { function_calling: true } }),
    ]);
    expect(textOnly?.input).toEqual(["text"]);
    expect(known?.input).toEqual(bundled.input);
  });

  it("takes the display name from the API and falls back to the id", () => {
    const [named, unnamed, blank] = projectLowRouterLiveModels([
      liveRow({ id: "auto/a/one", name: "Model One" }),
      liveRow({ id: "auto/a/two" }),
      liveRow({ id: "auto/a/three", name: "  " }),
    ]);
    expect(named?.name).toBe("Model One");
    expect(unnamed?.name).toBe("auto/a/two");
    expect(blank?.name).toBe("auto/a/three");
  });

  it("offers the thinking levels the routes publish in auto_routing.reasoning_effort", () => {
    const [some, all, none, unlisted] = projectLowRouterLiveModels(
      [
        liveRow({ id: "auto/a/some", auto_routing: { reasoning_effort: ["low", "high"] } }),
        liveRow({
          id: "auto/a/all",
          auto_routing: { reasoning_effort: ["minimal", "low", "medium", "high", "xhigh"] },
        }),
        // `supported_parameters` does not apply once `auto_routing` is published.
        liveRow({
          id: "auto/a/none",
          auto_routing: { reasoning_effort: [] },
          supported_parameters: ["reasoning_effort"],
        }),
        liveRow({ id: "auto/a/unlisted", auto_routing: { reasoning_effort: ["none", "max"] } }),
      ],
      { useBundledFallbacks: false },
    );
    expect(some).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high" },
    });
    expect(some?.thinkingLevelMap).not.toHaveProperty("xhigh");
    expect(all?.thinkingLevelMap).toEqual({
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    for (const model of [none, unlisted]) {
      expect(model?.reasoning, model?.id).toBe(false);
      expect(model, model?.id).not.toHaveProperty("thinkingLevelMap");
    }
  });

  it("falls back to supported_parameters, then the bundled row, without auto_routing", () => {
    const bundled = LOWROUTER_MODEL_CATALOG.find((model) => model.thinkingLevelMap)!;
    const [effort, plain, known] = projectLowRouterLiveModels([
      liveRow({ id: "alias/effort", auto_routing: undefined, supported_parameters: ["reasoning"] }),
      liveRow({ id: "alias/plain", auto_routing: undefined, supported_parameters: ["tools"] }),
      liveRow({ id: bundled.id, auto_routing: undefined }),
    ]);
    expect(effort).toMatchObject({ reasoning: true });
    expect(effort).not.toHaveProperty("thinkingLevelMap");
    expect(plain?.reasoning).toBe(false);
    expect(known).toMatchObject({ reasoning: true, thinkingLevelMap: bundled.thinkingLevelMap });
  });

  it("marks Claude and aliases to Claude for prompt caching", () => {
    const [claude, toClaude, toOther, other] = projectLowRouterLiveModels(
      [
        liveRow({ id: "auto/anthropic/claude-fixture" }),
        liveRow({ id: "alias/Writer", alias_target: "auto/anthropic/claude-fixture" }),
        liveRow({ id: "alias/coder", alias_target: "auto/mistralai/mistral-large-2512" }),
        liveRow({ id: "auto/mistralai/mistral-fixture" }),
      ],
      { useBundledFallbacks: false },
    );
    expect(claude?.compat?.cacheControlFormat).toBe("anthropic");
    expect(toClaude?.compat?.cacheControlFormat).toBe("anthropic");
    expect(toOther?.compat).not.toHaveProperty("cacheControlFormat");
    expect(other?.compat).not.toHaveProperty("cacheControlFormat");
    // OpenClaw passes the cache-TTL hook a lowercased id.
    expect(isLowRouterCacheTtlModelId("auto/anthropic/claude-fixture")).toBe(true);
    expect(isLowRouterCacheTtlModelId("alias/writer")).toBe(true);
    expect(isLowRouterCacheTtlModelId("alias/coder")).toBe(false);
    expect(isLowRouterCacheTtlModelId("auto/mistralai/mistral-fixture")).toBe(false);

    // An alias pointed elsewhere stops being Claude at the next discovery.
    projectLowRouterLiveModels([
      liveRow({ id: "alias/Writer", alias_target: "auto/mistralai/mistral-large-2512" }),
    ]);
    expect(isLowRouterCacheTtlModelId("alias/writer")).toBe(false);
  });

  it("does not consult bundled rows when generating the snapshot", () => {
    const bundled = LOWROUTER_MODEL_CATALOG[0]!;
    const [model] = projectLowRouterLiveModels(
      [liveRow({ id: bundled.id, context_length: undefined, auto_routing: {} })],
      { useBundledFallbacks: false },
    );
    expect(model).toMatchObject({
      name: bundled.id,
      contextWindow: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("fetches the USD model list with the key and does not cache an unusable list", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi
      .fn()
      .mockImplementationOnce(async () => ({
        response: Response.json({ data: [liveRow({ modality: "embedding" })] }),
        finalUrl: "https://api.lowrouter.ai/v1/models?currency=usd",
        release,
      }))
      .mockImplementationOnce(async () => ({
        response: Response.json({ data: [liveRow()] }),
        finalUrl: "https://api.lowrouter.ai/v1/models?currency=usd",
        release,
      }));

    // Nothing usable: the bundled catalog stays in place and the result is not cached.
    await expect(buildLiveModels(fetchGuard)).resolves.toHaveLength(LOWROUTER_MODEL_CATALOG.length);
    await expect(buildLiveModels(fetchGuard)).resolves.toEqual([
      expect.objectContaining({ id: "auto/fixture/never-bundled", contextWindow: 131_072 }),
    ]);

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    const request = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://api.lowrouter.ai/v1/models?currency=usd");
    const headers = request?.init?.headers;
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_VALUE}`);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe("LowRouter dynamic models", () => {
  it("resolves unlisted ids without shadowing bundled rows", () => {
    expect(resolveLowRouterDynamicModel(LOWROUTER_DEFAULT_MODEL_ID)).toBeUndefined();
    expect(resolveLowRouterDynamicModel("auto/mistralai/mistral-large-2512/eu")).toMatchObject({
      id: "auto/mistralai/mistral-large-2512/eu",
      provider: "lowrouter",
      api: "openai-completions",
      baseUrl: "https://api.lowrouter.ai/v1",
      contextWindow: 32_768,
      compat: { supportsTools: true },
    });
    expect(resolveLowRouterDynamicModel("  ")).toBeUndefined();
  });

  it("caches prompts on a scoped Claude id", () => {
    expect(resolveLowRouterDynamicModel("auto/anthropic/claude-opus-5/eu")).toMatchObject({
      compat: { cacheControlFormat: "anthropic" },
    });
    expect(isLowRouterCacheTtlModelId("auto/anthropic/claude-opus-5/eu")).toBe(true);
  });
});
