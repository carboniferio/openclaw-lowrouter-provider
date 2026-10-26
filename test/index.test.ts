// LowRouter tests cover plugin registration, onboarding and the stream hooks.
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import lowRouterPlugin from "../src/index.js";
import {
  buildStaticLowRouterModels,
  LOWROUTER_BASE_URL,
  LOWROUTER_MODEL_CATALOG,
} from "../src/models.js";
import { applyLowRouterConfig } from "../src/onboard.js";
import {
  registerSingleProviderPlugin,
  runSingleProviderCatalog,
} from "./helpers/provider-model-test-helpers.js";

const TEST_VALUE = "resolved-marker";

describe("LowRouter provider registration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the provider and falls back to the bundled catalog when discovery fails", async () => {
    // Unit tests stay offline: the model-list request fails, as on a machine without network.
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = await registerSingleProviderPlugin(lowRouterPlugin);
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: () => ({ apiKey: TEST_VALUE }),
      resolveProviderAuth: () => ({
        apiKey: TEST_VALUE,
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "env",
      }),
    });

    expect(provider).toMatchObject({
      id: "lowrouter",
      label: "LowRouter",
      docsPath: "https://lowrouter.ai/docs/integrations/openclaw",
      envVars: ["LOWROUTER_API_KEY"],
      resolveDynamicModel: expect.any(Function),
    });
    expect(provider.auth.find((method) => method.id === "api-key")).toBeDefined();
    expect(provider.staticCatalog).toBeDefined();
    expect(catalog).toMatchObject({
      apiKey: TEST_VALUE,
      baseUrl: "https://api.lowrouter.ai/v1",
      api: "openai-completions",
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(catalog.models.map((model) => model.id)).toEqual(
      LOWROUTER_MODEL_CATALOG.map((model) => model.id),
    );
  });

  it("onboards with the manifest default model", () => {
    expect(resolveAgentModelPrimaryValue(applyLowRouterConfig({}).agents?.defaults?.model)).toBe(
      `lowrouter/${manifest.modelCatalog.providers.lowrouter.defaultModel}`,
    );
  });

  it("resolves an unlisted id against the configured base URL", async () => {
    const provider = await registerSingleProviderPlugin(lowRouterPlugin);
    expect(
      provider.resolveDynamicModel?.({
        provider: "lowrouter",
        modelId: "auto/mistralai/mistral-large-2512/eu",
        providerConfig: { baseUrl: "https://proxy.example/v1" },
      } as never),
    ).toMatchObject({
      id: "auto/mistralai/mistral-large-2512/eu",
      provider: "lowrouter",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("declares one auth choice wired to LOWROUTER_API_KEY", () => {
    expect(manifest.setup.providers).toEqual([
      { id: "lowrouter", envVars: ["LOWROUTER_API_KEY"] },
    ]);
    expect(manifest.providerAuthChoices).toEqual([
      expect.objectContaining({
        provider: "lowrouter",
        method: "api-key",
        choiceId: "lowrouter-api-key",
        cliFlag: "--lowrouter-api-key",
        optionKey: "lowrouterApiKey",
      }),
    ]);
  });
});

/** A LowRouter chat-completions stream whose final usage chunk carries a EUR cost. */
function lowRouterSse(): Response {
  const chunk = (extra: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", ...extra })}\n\n`;
  const body =
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    chunk({
      choices: [],
      usage: {
        prompt_tokens: 3_000,
        completion_tokens: 100,
        total_tokens: 3_100,
        prompt_tokens_details: { cached_tokens: 2_000 },
        cost: 0.42,
        currency: "EUR",
      },
    }) +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("LowRouter stream hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits out the prompt cache on Claude only", async () => {
    const provider = await registerSingleProviderPlugin(lowRouterPlugin);
    const eligible = (modelId: string) =>
      provider.isCacheTtlEligible?.({ provider: "lowrouter", modelId, modelApi: "openai-completions" });
    expect(eligible("auto/anthropic/claude-haiku-4.5")).toBe(true);
    expect(eligible("auto/mistralai/mistral-large-2512")).toBeUndefined();
  });

  it("sends effort and cache_control to Claude and reports the USD estimate, not the EUR total", async () => {
    const fetchMock = vi.fn(async () => lowRouterSse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = await registerSingleProviderPlugin(lowRouterPlugin);
    const definition = buildStaticLowRouterModels().find(
      (model) => model.id === "auto/anthropic/claude-haiku-4.5",
    )!;
    const model = {
      ...definition,
      provider: "lowrouter",
      api: "openai-completions",
      baseUrl: LOWROUTER_BASE_URL,
    } as Model<"openai-completions">;
    const payloads: Record<string, unknown>[] = [];
    for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      const streamFn = wrap?.({ provider: "lowrouter", modelId: model.id, model } as never);
      if (!streamFn) {
        throw new Error("expected a LowRouter stream wrapper");
      }
      const stream = await streamFn(
        model,
        {
          systemPrompt: "Answer briefly.",
          messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
        },
        {
          apiKey: "fixture",
          reasoning: "low",
          onPayload: (payload: unknown) => {
            payloads.push(payload as Record<string, unknown>);
            return undefined;
          },
        },
      );
      const costs: unknown[] = [];
      for await (const event of stream) {
        if (event.type === "done") {
          costs.push(event.message.usage.cost);
        }
      }
      const result = await stream.result();
      costs.push(result.usage.cost);

      expect(result.usage).toMatchObject({ input: 1_000, cacheRead: 2_000, output: 100 });
      for (const cost of costs) {
        expect(cost).not.toHaveProperty("totalOrigin");
        expect(cost).toMatchObject({ total: (1_000 * 1.1 + 100 * 5.5) / 1e6 });
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ reasoning_effort: "low" });
      expect(JSON.stringify(payload)).toContain('"cache_control":{"type":"ephemeral"}');
    }
  });
});
