// LowRouter tests cover plugin registration, onboarding and the stream hooks.
// OpenClaw's own transport package: its agent runtime streams through this managed
// completions transport, while one-shot completions use `streamSimple`.
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
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

/** A LowRouter chat-completions stream whose final usage chunk carries a cost. */
function lowRouterSse(currency: "USD" | "EUR"): Response {
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
        currency,
      },
    }) +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

type StreamHook = "wrapStreamFn" | "wrapSimpleCompletionStreamFn";

/** Streams one Claude turn through a LowRouter stream hook against a mocked API. */
async function streamClaudeTurn(
  hook: StreamHook,
  baseUrl: string,
  currency: "USD" | "EUR",
  reasoning: "low" | "off" = "low",
) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => lowRouterSse(currency));
  vi.stubGlobal("fetch", fetchMock);
  const provider = await registerSingleProviderPlugin(lowRouterPlugin);
  const definition = buildStaticLowRouterModels().find(
    (model) => model.id === "auto/anthropic/claude-haiku-4.5",
  )!;
  const model = {
    ...definition,
    provider: "lowrouter",
    api: "openai-completions",
    baseUrl,
  } as Model<"openai-completions">;
  const streamFn = provider[hook]?.({
    provider: "lowrouter",
    modelId: model.id,
    model,
    streamFn: hook === "wrapStreamFn" ? createOpenAICompletionsTransportStreamFn() : streamSimple,
  } as never);
  if (!streamFn) {
    throw new Error(`expected LowRouter's ${hook}`);
  }
  let payload: Record<string, unknown> | undefined;
  const stream = await streamFn(
    model,
    {
      systemPrompt: "Answer briefly.",
      messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
    },
    {
      apiKey: "fixture",
      reasoning,
      onPayload: (body: unknown) => {
        payload = body as Record<string, unknown>;
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
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage);
  }
  expect(result.usage).toMatchObject({ input: 1_000, cacheRead: 2_000, output: 100 });
  costs.push(result.usage.cost);
  expect(costs).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return { payload, costs, url: String(fetchMock.mock.calls[0]?.[0]) };
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

  it.each<StreamHook>(["wrapStreamFn", "wrapSimpleCompletionStreamFn"])(
    "sends effort and cache_control to Claude through %s",
    async (hook) => {
      const { payload } = await streamClaudeTurn(hook, LOWROUTER_BASE_URL, "USD");
      expect(payload).toMatchObject({ reasoning_effort: "low" });
      expect(JSON.stringify(payload)).toContain('"cache_control":{"type":"ephemeral"}');
    },
  );

  it.each<StreamHook>(["wrapStreamFn", "wrapSimpleCompletionStreamFn"])(
    "sends no reasoning_effort when thinking is off through %s",
    async (hook) => {
      const { payload } = await streamClaudeTurn(hook, LOWROUTER_BASE_URL, "USD", "off");
      expect(payload).not.toHaveProperty("reasoning_effort");
    },
  );

  it("asks LowRouter's API for USD on agent turns and reports its billed total", async () => {
    const { costs, url } = await streamClaudeTurn("wrapStreamFn", LOWROUTER_BASE_URL, "USD");
    expect(url).toBe("https://api.lowrouter.ai/v1/chat/completions?currency=usd");
    for (const cost of costs) {
      expect(cost).toMatchObject({ total: 0.42, totalOrigin: "provider-billed" });
    }
  });

  it.each<[StreamHook, string, string]>([
    // Another deployment may bill in EUR, and OpenClaw drops the response's currency.
    ["wrapStreamFn", "https://proxy.example/v1", "https://proxy.example/v1/chat/completions"],
    // One-shot completions cannot carry `?currency=usd`: their transport would garble the URL.
    [
      "wrapSimpleCompletionStreamFn",
      LOWROUTER_BASE_URL,
      "https://api.lowrouter.ai/v1/chat/completions",
    ],
  ])("shows OpenClaw's USD estimate, not a EUR total, through %s on %s", async (hook, baseUrl, sent) => {
    const { costs, url } = await streamClaudeTurn(hook, baseUrl, "EUR");
    expect(url).toBe(sent);
    // OpenClaw's estimate from the bundled USD prices.
    const price = LOWROUTER_MODEL_CATALOG.find((model) => model.id === "auto/anthropic/claude-haiku-4.5")!.cost;
    const estimate = (1_000 * price.input + 2_000 * price.cacheRead + 100 * price.output) / 1e6;
    for (const cost of costs) {
      expect(cost).not.toHaveProperty("totalOrigin");
      expect(cost).toMatchObject({ total: estimate });
    }
  });
});
