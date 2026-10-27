/** LowRouter stream wrapper: keeps OpenClaw's cost in US dollars. */
import type { ProviderPlugin, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { transformProviderStreamMessages } from "openclaw/plugin-sdk/provider-stream-shared";
import { LOWROUTER_BASE_URL } from "./models.js";

type StreamFn = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;

const LOWROUTER_HOST = new URL(LOWROUTER_BASE_URL).host;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * LowRouter's hosted API reports `usage.cost` in USD when asked with `?currency=usd`.
 * Any other base URL, such as a proxy or another LowRouter deployment, may not, so
 * it gets `undefined`.
 */
export function lowRouterUsdBaseUrl(baseUrl: string | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl ?? "");
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.host !== LOWROUTER_HOST) {
    return undefined;
  }
  url.searchParams.set("currency", "usd");
  return url.toString();
}

/**
 * For a request that may report `usage.cost` in EUR, which OpenClaw would record as
 * the provider-billed total in USD: puts back the sum of the per-token parts, which
 * OpenClaw priced from the USD catalog, so OpenClaw shows its own USD estimate.
 * OpenClaw drops the response's `currency` before any plugin hook sees it, so this
 * cannot be decided per response.
 */
export function dropProviderBilledCost(message: unknown): void {
  const cost = asRecord(asRecord(asRecord(message)?.usage)?.cost);
  if (cost?.totalOrigin !== "provider-billed") {
    return;
  }
  delete cost.totalOrigin;
  cost.total =
    finiteOrZero(cost.input) +
    finiteOrZero(cost.output) +
    finiteOrZero(cost.cacheRead) +
    finiteOrZero(cost.cacheWrite);
}

function withEstimatedCost(underlying: StreamFn): StreamFn {
  return (model, context, options) => {
    const stream = underlying(model, context, options);
    return "then" in stream
      ? Promise.resolve(stream).then((resolved) =>
          transformProviderStreamMessages(resolved, dropProviderBilledCost),
        )
      : transformProviderStreamMessages(stream, dropProviderBilledCost);
  };
}

/**
 * Agent turns. OpenClaw's agent runtime streams through its managed transport,
 * which sends base-URL query parameters with each request, so LowRouter's hosted
 * API is asked for USD and its billed total is kept. Other base URLs get the estimate.
 */
export function wrapLowRouterStreamFn(ctx: ProviderWrapStreamFnContext): StreamFn {
  if (!ctx.streamFn) {
    return withEstimatedCost(streamSimple);
  }
  const underlying = ctx.streamFn;
  const estimated = withEstimatedCost(underlying);
  return (model, context, options) => {
    const usdBaseUrl = lowRouterUsdBaseUrl(model.baseUrl);
    return usdBaseUrl
      ? underlying({ ...model, baseUrl: usdBaseUrl }, context, options)
      : estimated(model, context, options);
  };
}

/**
 * One-shot completions. OpenClaw sends these through a transport that appends the
 * route to the base URL as is, so `?currency=usd` cannot be added there; the cost
 * is OpenClaw's USD estimate.
 */
export function wrapLowRouterSimpleCompletionStreamFn(ctx: ProviderWrapStreamFnContext): StreamFn {
  return withEstimatedCost(ctx.streamFn ?? streamSimple);
}
