# LowRouter provider for OpenClaw

Adds [LowRouter](https://lowrouter.ai) as a model provider in [OpenClaw](https://openclaw.ai).

LowRouter is an OpenAI-compatible router run from the EU. An `auto/<creator>/<model>` ID can be
served by several European or global hosts. LowRouter prefers low-carbon regions and fails over
between them. Maintained by the LowRouter team.

## Install

Requires OpenClaw `2026.10.2` or newer.

```bash
openclaw plugins install clawhub:@lowrouter/openclaw-provider
openclaw gateway restart
```

OpenClaw asks you to approve the plugin's capabilities during install. In a script, add
`--accept-capabilities`.

Get a key at [lowrouter.ai/app/keys](https://lowrouter.ai/app/keys), then either run onboarding
or export it before starting OpenClaw:

```bash
openclaw onboard --auth-choice lowrouter-api-key
# or
export LOWROUTER_API_KEY=sk-lr-...
```

Pick a model:

```bash
openclaw models list --refresh --provider lowrouter
openclaw models set lowrouter/auto/mistralai/mistral-large-2512
```

Use `openclaw models set`, not `openclaw config set agents.defaults.model.primary`. The config
command validates against the bundled list only and can reject a model that discovery found.

## Models

With a key, the plugin reads `GET /v1/models?currency=usd` and caches it for five minutes. The
picker lists:

- `auto/<creator>/<model>` IDs and your account's `alias/<name>` models;
- chat models with tool calling only, since OpenClaw acts through tools.

Pinned routes (`<host>/<creator>/<model>`) and jurisdiction-scoped IDs
(`auto/<creator>/<model>/eu`) stay out of the list. They still work when you type them, for
example `openclaw models set lowrouter/auto/mistralai/mistral-large-2512/eu`.

Context windows, output limits and input types come from `/v1/models`. So do thinking levels:
a model offers the levels its routes accept, from `auto_routing.reasoning_effort`, and OpenClaw
sends the one you pick as `reasoning_effort`. A model without a published context window gets 32,768 tokens, so OpenClaw compacts early
rather than sending a prompt the model rejects. A model without an output limit gets OpenClaw's
8,192 default.

Without a key or network, OpenClaw uses the snapshot bundled with the release. The snapshot is
generated from the same endpoint by `npm run gen:catalog`; nothing in it is written by hand.

Claude models (`auto/anthropic/...`, and aliases that point at one) use prompt caching. OpenClaw
marks the stable start of each prompt with `cache_control`, and LowRouter serves the repeat from
the cache at the cache-read price.

## Cost

LowRouter bills in euros, for the route that served the request. OpenClaw tracks cost in US
dollars, so the plugin reads USD prices (`?currency=usd`) and OpenClaw shows its own estimate
from them. An `auto/` model has several routes at different prices, and the plugin uses the
dearest one. The estimate can still run low on Claude: where LowRouter publishes no cache price,
cached tokens count as free.

Each response's `usage.cost` is the amount charged, in euros. OpenClaw would record that number
as dollars, so the plugin drops it until LowRouter reports a USD amount. Your charges are on
[lowrouter.ai/app](https://lowrouter.ai/app).

## Development

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

Live tests need a key and explicit opt-in. They run catalog discovery, one streamed completion
and one tool call on the default model (`LOWROUTER_LIVE_MODELS=a,b` picks others), then a
repeated prompt that must hit the cache and a reasoning effort, both on Claude Haiku 4.5:

```bash
OPENCLAW_LIVE_TEST=1 LOWROUTER_LIVE_TEST=1 LOWROUTER_API_KEY=sk-lr-... npm run test:live
```

To release:

1. Bump `version` in `package.json` and refresh the bundled snapshot:
   `LOWROUTER_API_KEY=sk-lr-... npm run gen:catalog`.
2. Check the package: `npx clawhub package validate .`.
3. Push to `main`, then run the **Package Publish** workflow from the Actions tab, first with
   `dry_run` on. It publishes to ClawHub through trusted publishing, with no stored token.

## License

Apache-2.0
