/** LowRouter stream wrappers: keep OpenClaw's cost in US dollars. */
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamSimple, type StreamFn } from "openclaw/plugin-sdk/llm";
import { transformProviderStreamMessages } from "openclaw/plugin-sdk/provider-stream-shared";
import { asFiniteNumber, asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LOWROUTER_BASE_URL } from "./models.js";

const LOWROUTER_HOST = new URL(LOWROUTER_BASE_URL).host;

/**
 * LowRouter's hosted API reports `usage.cost` in USD when asked with `?currency=usd`.
 * Any other base URL, such as a proxy or another LowRouter deployment, may not, so
 * it gets `undefined`.
 */
function lowRouterUsdBaseUrl(baseUrl: string | undefined): string | undefined {
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
function dropProviderBilledCost(message: unknown): void {
  const cost = asOptionalRecord(asOptionalRecord(asOptionalRecord(message)?.usage)?.cost);
  if (cost?.totalOrigin !== "provider-billed") {
    return;
  }
  delete cost.totalOrigin;
  cost.total =
    (asFiniteNumber(cost.input) ?? 0) +
    (asFiniteNumber(cost.output) ?? 0) +
    (asFiniteNumber(cost.cacheRead) ?? 0) +
    (asFiniteNumber(cost.cacheWrite) ?? 0);
}

function withEstimatedCost(underlying: StreamFn): StreamFn {
  return async (model, context, options) =>
    transformProviderStreamMessages(await underlying(model, context, options), dropProviderBilledCost);
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
