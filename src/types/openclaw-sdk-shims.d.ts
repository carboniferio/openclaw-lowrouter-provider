// Type declarations for the OpenClaw plugin SDK subpaths this plugin imports;
// the published openclaw package ships their JavaScript without .d.ts files.
declare module "openclaw/plugin-sdk/provider-model-shared" {
  import type {
    ProviderPlugin,
    ProviderRuntimeModel,
  } from "openclaw/plugin-sdk/plugin-entry";

  export type ModelCompatConfig = NonNullable<ProviderRuntimeModel["compat"]>;

  export type ModelDefinitionConfig = Omit<
    ProviderRuntimeModel,
    "provider" | "api" | "baseUrl"
  > & {
    api?: ProviderRuntimeModel["api"];
    baseUrl?: string;
  };

  export type ModelProviderConfig = {
    baseUrl: string;
    api?: ProviderRuntimeModel["api"];
    models: ModelDefinitionConfig[];
  };

  export function buildProviderReplayFamilyHooks(options: {
    family: "openai-compatible";
    dropReasoningFromHistory?: boolean;
  }): Pick<
    ProviderPlugin,
    "buildReplayPolicy" | "sanitizeReplayHistory" | "resolveReasoningOutputMode"
  >;
}

declare module "openclaw/plugin-sdk/provider-catalog-shared" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
  import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

  export type ConfiguredProviderCatalogEntry = {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: Array<"text" | "image" | "audio" | "video" | "document">;
  };

  /** Normalizes one manifest `modelCatalog.providers.<id>` block into runtime provider config (openclaw >= 2026.8.1). */
  export function buildManifestModelProviderConfig(params: {
    providerId: string;
    catalog: unknown;
  }): ModelProviderConfig;

  export function readConfiguredProviderCatalogEntries(params: {
    config?: OpenClawConfig;
    providerId: string;
    publishedProviderId?: string;
  }): ConfiguredProviderCatalogEntry[];

  export function readManifestProviderDefaultModelRef(
    manifest: unknown,
    providerId: string,
  ): string | undefined;
}

declare module "openclaw/plugin-sdk/provider-entry" {
  import type {
    OpenClawConfig,
    OpenClawPluginDefinition,
    ProviderPlugin,
  } from "openclaw/plugin-sdk/plugin-entry";
  import type {
    ModelDefinitionConfig,
    ModelProviderConfig,
  } from "openclaw/plugin-sdk/provider-model-shared";

  type SingleProviderDefinition = Omit<
    ProviderPlugin,
    "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog" | "staticCatalog"
  > & {
    id?: string;
    label: string;
    docsPath: string;
    aliases?: string[];
    envVars?: string[];
    manifestAuth?: {
      applyConfig?: (config: OpenClawConfig) => OpenClawConfig;
      noteTitle?: string;
      noteMessage?: string;
    };
    catalog: {
      buildProvider?: () => ModelProviderConfig;
      buildStaticProvider?: () => ModelProviderConfig;
      allowExplicitBaseUrl?: boolean;
      liveModelDiscovery?:
        | true
        | {
            /** Relative path appended to the provider base URL. Defaults to `models`. */
            endpointPath?: string;
            timeoutMs?: number;
            ttlMs?: number;
            projectRows?: (rows: readonly unknown[]) => ModelDefinitionConfig[];
          };
    };
  };

  export function defineSingleProviderPluginEntry(options: {
    id: string;
    name: string;
    description: string;
    manifest?: unknown;
    provider?: SingleProviderDefinition;
  }): OpenClawPluginDefinition;
}

declare module "openclaw/plugin-sdk/provider-tools" {
  import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

  export function buildProviderToolCompatFamilyHooks(
    family: "deepseek" | "gemini" | "llamacpp-gbnf" | "openai",
  ): Pick<ProviderPlugin, "normalizeToolSchemas" | "inspectToolSchemas">;
}

declare module "openclaw/plugin-sdk/provider-onboard" {
  import type {
    OpenClawConfig as PluginOpenClawConfig,
    ProviderRuntimeModel,
  } from "openclaw/plugin-sdk/plugin-entry";
  import type {
    ModelDefinitionConfig,
  } from "openclaw/plugin-sdk/provider-model-shared";

  export type OpenClawConfig = PluginOpenClawConfig;

  export function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
    primaryModelRef: string;
    resolveParams: (
      config: PluginOpenClawConfig,
      ...args: TArgs
    ) =>
      | {
          providerId: string;
          api: ProviderRuntimeModel["api"];
          baseUrl: string;
          catalogModels: ModelDefinitionConfig[];
        }
      | null
      | undefined;
  }): {
    applyProviderConfig: (
      config: PluginOpenClawConfig,
      ...args: TArgs
    ) => PluginOpenClawConfig;
    applyConfig: (config: PluginOpenClawConfig, ...args: TArgs) => PluginOpenClawConfig;
  };

  export function resolveAgentModelPrimaryValue(value: unknown): string | undefined;
}


declare module "openclaw/plugin-sdk/llm" {
  import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

  export const streamSimple: NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;
}

declare module "openclaw/plugin-sdk/provider-stream-shared" {
  /** Mutates streamed and final message objects without replacing or buffering events. */
  export function transformProviderStreamMessages<T>(
    stream: T,
    transformMessage: (message: unknown) => void,
  ): T;
}
