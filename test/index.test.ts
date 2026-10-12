// LowRouter tests cover plugin registration and onboarding.
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import lowRouterPlugin from "../src/index.js";
import { LOWROUTER_MODEL_CATALOG } from "../src/models.js";
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
