/** LowRouter stream wrapper: keeps OpenClaw's cost in US dollars. */
import type { ProviderPlugin, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { transformProviderStreamMessages } from "openclaw/plugin-sdk/provider-stream-shared";

type StreamFn = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Stopgap until LowRouter reports a USD amount in usage (carboniferio/lowrouter#966).
 * LowRouter's `usage.cost` is in EUR, and OpenClaw records it as the provider-billed
 * total in USD. Putting back the sum of the per-token parts, which OpenClaw already
 * priced from the USD catalog, shows its USD estimate instead. The EUR amount
 * charged stays on lowrouter.ai/app.
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

/** Wraps a LowRouter stream so every partial and final message carries the USD estimate. */
export function wrapLowRouterStreamFn(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying: StreamFn = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    const stream = underlying(model, context, options);
    return "then" in stream
      ? Promise.resolve(stream).then((resolved) =>
          transformProviderStreamMessages(resolved, dropProviderBilledCost),
        )
      : transformProviderStreamMessages(stream, dropProviderBilledCost);
  };
}
