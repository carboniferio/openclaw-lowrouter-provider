#!/usr/bin/env node
// Regenerates the bundled fallback catalog in openclaw.plugin.json from LowRouter's
// live /v1/models. Run after `npm run build`, before each release:
//
//   LOWROUTER_API_KEY=sk-lr-... npm run gen:catalog
//
// The rows are the same projection the plugin applies to live discovery, so the
// offline picker matches what a signed-in user sees on the release date.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const { LOWROUTER_BASE_URL, LOWROUTER_MODELS_PATH, projectLowRouterLiveModels } = await import(
  "../dist/models.js"
);

const apiKey = process.env.LOWROUTER_API_KEY?.trim();
const url = `${LOWROUTER_BASE_URL.replace(/\/+$/, "")}/${LOWROUTER_MODELS_PATH}`;
const response = await fetch(url, {
  headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`GET ${url} -> ${response.status}`);
}
const body = await response.json();
if (!Array.isArray(body?.data)) {
  throw new Error(`GET ${url}: no data array in the response`);
}

// Generate from the live rows alone: earlier bundled rows must not leak into the snapshot.
const models = projectLowRouterLiveModels(body.data, { useBundledFallbacks: false }).map(
  ({ compat: _compat, ...row }) => row,
);
if (models.length === 0) {
  throw new Error(`GET ${url}: 0 usable models; refusing to write an empty catalog`);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const catalog = manifest.modelCatalog.providers.lowrouter;
if (!models.some((model) => model.id === catalog.defaultModel)) {
  throw new Error(`default model ${catalog.defaultModel} is not in the live catalog`);
}
catalog.models = models;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${models.length} models to openclaw.plugin.json`);
