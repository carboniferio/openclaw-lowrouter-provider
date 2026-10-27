// LowRouter live tests exercise the real API (OPENCLAW_LIVE_TEST + LOWROUTER_LIVE_TEST gated).
// OpenClaw's own transport package, as its agent runtime streams.
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import lowRouterPlugin from "../src/index.js";
import {
  LOWROUTER_BASE_URL,
  LOWROUTER_DEFAULT_MODEL_ID,
  LOWROUTER_MODEL_CATALOG,
} from "../src/models.js";
import {
  registerSingleProviderPlugin,
  runSingleProviderCatalog,
} from "./helpers/provider-model-test-helpers.js";

const LIVE_VALUE = process.env.LOWROUTER_API_KEY?.trim() ?? "";
const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.LOWROUTER_LIVE_TEST === "1" &&
  LIVE_VALUE.length > 0;
const describeLive = LIVE ? describe : describe.skip;
// Tool calls run on the default model; LOWROUTER_LIVE_MODELS=a,b picks others.
const LIVE_MODEL_IDS = (process.env.LOWROUTER_LIVE_MODELS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
// Prompt caching and reasoning effort run on this Claude model.
const LIVE_CLAUDE_MODEL_ID = "auto/anthropic/claude-haiku-4.5";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runLiveCatalog() {
  const provider = await registerSingleProviderPlugin(lowRouterPlugin);
  const oldNodeEnv = process.env.NODE_ENV;
  const oldVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  try {
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: () => ({ apiKey: LIVE_VALUE, discoveryApiKey: LIVE_VALUE }),
      resolveProviderAuth: () => ({
        apiKey: LIVE_VALUE,
        discoveryApiKey: LIVE_VALUE,
        mode: "api_key",
        source: "env",
      }),
    });
    return catalog.models;
  } finally {
    restoreEnvVar("NODE_ENV", oldNodeEnv);
    restoreEnvVar("VITEST", oldVitest);
  }
}

function asLiveModel(model: ModelDefinitionConfig) {
  return {
    ...model,
    provider: "lowrouter",
    baseUrl: LOWROUTER_BASE_URL,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

async function requireLiveModel(modelId: string) {
  const model = (await runLiveCatalog()).find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`live catalog did not include ${modelId}`);
  }
  return asLiveModel(model);
}

/** Streams an agent turn through the plugin's wrapper and OpenClaw's managed transport. */
async function streamThroughPlugin(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const provider = await registerSingleProviderPlugin(lowRouterPlugin);
  const streamFn = provider.wrapStreamFn?.({
    provider: "lowrouter",
    modelId: model.id,
    model,
    streamFn: createOpenAICompletionsTransportStreamFn(),
  } as never);
  if (!streamFn) {
    throw new Error("expected a LowRouter stream wrapper");
  }
  const response = await (await streamFn(model, context, { apiKey: LIVE_VALUE, ...options })).result();
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || `live completion on ${model.id} failed`);
  }
  // LowRouter's billed total, in USD through `?currency=usd`.
  expect(response.usage.cost).toMatchObject({ totalOrigin: "provider-billed" });
  expect(response.usage.cost.total).toBeGreaterThan(0);
  return response;
}

function liveProbeTool(): Tool {
  return {
    name: "live_probe",
    description: "Return the supplied value.",
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
  };
}

function requireToolCall(message: AssistantMessage) {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (toolCall?.type !== "toolCall") {
    throw new Error(`model did not call the live probe: ${message.stopReason}`);
  }
  return toolCall;
}

describeLive("LowRouter plugin live", () => {
  it("discovers the live catalog, default model included", async () => {
    const models = await runLiveCatalog();
    expect(models.some((model) => model.id === LOWROUTER_DEFAULT_MODEL_ID)).toBe(true);
    // How far the release snapshot has drifted from the live catalog.
    const bundledIds = new Set(LOWROUTER_MODEL_CATALOG.map((model) => model.id));
    console.info(
      `[lowrouter:live] ${models.filter((model) => !bundledIds.has(model.id)).length} models not in the snapshot`,
    );
    expect(models.every((model) => model.id.startsWith("auto/") || model.id.startsWith("alias/"))).toBe(
      true,
    );
    console.info(`[lowrouter:live] discovered ${models.length} models`);
  }, 60_000);

  it("streams a completion through the default model", async () => {
    const models = await runLiveCatalog();
    const defaultModel = models.find((model) => model.id === LOWROUTER_DEFAULT_MODEL_ID);
    if (!defaultModel) {
      throw new Error("live catalog did not include the default model");
    }
    const context: Context = {
      messages: [{ role: "user", content: "Say hello in one word.", timestamp: Date.now() }],
    };
    const response = await streamSimple(asLiveModel(defaultModel), context, {
      apiKey: LIVE_VALUE,
      maxTokens: 512,
    }).result();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "live completion failed");
    }
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage.output).toBeGreaterThan(0);
    console.info(
      `[lowrouter:live] ${defaultModel.id}: ${response.usage.input} in / ${response.usage.output} out`,
    );
  }, 120_000);

  const toolModelIds = LIVE_MODEL_IDS.length ? LIVE_MODEL_IDS : [LOWROUTER_DEFAULT_MODEL_ID];
  it.each(toolModelIds)("runs a tool call through %s", async (modelId) => {
    const models = await runLiveCatalog();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`live catalog did not include ${modelId}`);
    }
    const response = await streamSimple(
      asLiveModel(model),
      {
        systemPrompt: "Call the requested function exactly once.",
        messages: [
          {
            role: "user",
            content: "Call live_probe with value exactly lowrouter.",
            timestamp: Date.now(),
          },
        ],
        tools: [liveProbeTool()],
      },
      { apiKey: LIVE_VALUE, maxTokens: 1024 },
    ).result();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "live tool call failed");
    }
    const toolCall = requireToolCall(response);
    expect(toolCall.name).toBe("live_probe");
    expect(toolCall.arguments).toMatchObject({ value: "lowrouter" });
    console.info(
      `[lowrouter:live] ${modelId} tool call: ${response.usage.input} in / ${response.usage.output} out`,
    );
  }, 120_000);

  it("reads Claude's prompt cache on a repeated long prompt", async () => {
    const model = await requireLiveModel(LIVE_CLAUDE_MODEL_ID);
    expect(model.compat).toMatchObject({ cacheControlFormat: "anthropic" });
    // About 5k tokens, above Claude's minimum cacheable prompt.
    const systemPrompt = Array.from(
      { length: 300 },
      (_, line) => `Reference line ${line}: LowRouter routes each request to a low-carbon host.`,
    ).join("\n");
    const context = (): Context => ({
      systemPrompt,
      messages: [{ role: "user", content: "Reply with the word ok.", timestamp: Date.now() }],
    });
    const first = await streamThroughPlugin(model, context(), { maxTokens: 16 });
    const second = await streamThroughPlugin(model, context(), { maxTokens: 16 });
    console.info(
      `[lowrouter:live] ${model.id} cache: write ${first.usage.cacheWrite} ($${first.usage.cost.total}), then read ${second.usage.cacheRead} of ${second.usage.input + second.usage.cacheRead} ($${second.usage.cost.total})`,
    );
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  }, 120_000);

  it("accepts a reasoning effort on a reasoning model", async () => {
    const model = await requireLiveModel(LIVE_CLAUDE_MODEL_ID);
    expect(model).toMatchObject({ reasoning: true, thinkingLevelMap: { low: "low" } });
    const payloads: unknown[] = [];
    const response = await streamThroughPlugin(
      model,
      { messages: [{ role: "user", content: "What is 17 + 25? Answer with the number.", timestamp: Date.now() }] },
      {
        reasoning: "low",
        maxTokens: 4096,
        onPayload: (payload) => {
          payloads.push(payload);
          return undefined;
        },
      },
    );
    expect(payloads).toEqual([expect.objectContaining({ reasoning_effort: "low" })]);
    expect(response.content.some((block) => block.type === "text" && block.text.includes("42"))).toBe(true);
    console.info(
      `[lowrouter:live] ${model.id} effort low: thinking returned ${response.content.some((block) => block.type === "thinking")}`,
    );
  }, 120_000);
});
