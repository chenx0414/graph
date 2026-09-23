# Independent review · B-1 provider/model configuration

Verdict: **fail**

The three program checks that ran are green (`check-types` exit 0, `provider-api` 22 passed, `catalog-models-dev` 12 passed, `provider-form` 26 passed). They do not exercise the joined request path. Crossing the settings page with the server contract shows the two-step flow cannot complete for a custom provider, cannot tell whether a supported provider's credential is resolved, and still keeps a standalone concurrency-limit section in the settings registry.

## Findings

### 1. Custom-provider verification never leaves the page

Acceptance: custom providers require 厂商名 + Base URL + compatibility + API KEY, and save must send one minimal verification request. A failure must show the vendor's raw text.

`src/web/provider-form.ts` `probePayload` sends the display name as `provider.name`. `src/server/providers.ts` `validateProviderDraft` only reads `provider.label`. For `id: 'custom'` a missing label is a hard error (`自定义厂商必须填写厂商名`), even when name, baseUrl, api and secretRef are all present.

Reproduced with the two modules together:

- client payload `{ platformId:'custom', name:'本地', baseUrl:'https://gw.example/v1', api:'anthropic-messages', credentialId:'custom', secretRef:'GRAPH_CUSTOM_KEY' }` plus a requestId
- `validateProbeRequest` returns `{ ok:false, errors:[{ field:'label', message:'自定义厂商必须填写厂商名' }] }`

`Settings.tsx` `runProbe` then catches the 400 and displays `(reason as Error).message`, which is the daemon's wrapped `invalid_input` text, not a vendor response. The minimal chat request is never built. Supported presets still validate because the server fills label/baseUrl/api from the directory, so the unit tests on each side pass while the custom path is broken.

Impact: human step ② (自定义厂商) cannot trigger one-click verification.

### 2. Credential-resolved state is dropped, so unresolved models stay selectable

Acceptance: a model whose credential is not resolved must not be selectable or dispatched, and the card must say why (for example 「凭据未解析：请设置环境变量 X」).

`platformCatalogView` (`src/server/providers.ts`) reports that flag as `credentialConfigured` and the env name as `credentialRef`. `normalizePlatforms` (`src/web/provider-form.ts`) only copies `configured` and `secretRef`. A live catalog entry therefore loses both:

- `secretRef` falls back to a synthesized `GRAPH_${ID}_KEY` (DeepSeek becomes `GRAPH_DEEPSEEK_KEY` instead of `GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY`)
- `configured` is omitted, so `selected?.configured` is always undefined

`ProviderWorkbench` treats a credential as resolved when `keyResolved[id] || credentialState[id] || selected?.configured`. `credentialState` comes from `GET /api/config`, whose `configured` flag (`sanitizeConfig`) is the process env only. A key stored in the keychain and pushed through `/api/app/secret` is visible to `providerSecrets()` / `live.secrets()`, but not to that flag. After a reload, `resolved` is false for a keychain-backed preset, and the blocked-reason string names the wrong env var.

The gate is also UI-only. `addSelected` refuses while `blockedReason` is set, but `pickModel` (`src/core/model-selection.ts`) and `selectModel` still choose any directory entry. Dispatch later fails in `pi-adapter` with `No credential bound`, which is not the same as "will not be dispatched". The pure test only asserts `selectionBlockedReason({ resolved:false })` returns a string; it never checks that the catalog flag survives normalization.

Impact: the settings page cannot reliably disable models for an unresolved credential, and the reason it shows can name an env var the daemon does not read.

### 3. Standalone 「并发限制」 section is still part of the settings contract

Acceptance: concurrency limits move into 「配置厂商」 and the UI no longer has an independent 并发限制 card/section. Existing `limit-credential-*` / `limit-group-*` testids stay.

`Settings.tsx` does inline the three inputs (`limit-credential-${id}`, `limit-group-id-${id}`, `limit-group-${id}`) and filters `settings-limits` out of the advanced-page render. It does not remove the section. `ADVANCED_SETTINGS` still contains:

- `id: 'settings-limits'`
- `title: '并发限制'`
- `testIds: ['limit-credential', 'limit-group', 'limit-credential-add', 'limit-group-add']`

`tests/console/settings-sections.test.ts` still requires that entry and the `limit-credential-add` / `limit-group-add` controls. The Playwright acceptance in `tests/m8/settings-ui.test.ts` still opens `#settings-limits` via `advanced-setting-toggle-settings-limits` and fills `limit-group-0`. Those controls are not rendered anymore, so the B-0 settings UI test now contradicts this batch. The inline editor also cannot add a limit for a credential that is not the platform currently selected, which is what `limit-credential-add` / `limit-group-add` used to do. Field write-back via `writeConcurrency` is fine; the "no separate section" acceptance is not.

## What holds

- `GET /api/providers` and `POST /api/providers/probe` are registered from `PROVIDER_ROUTES` on the session-cookie `/api` face. `/api/app/providers` is gone. Probe rejects a missing `requestId`. Responses from `sanitizeProviderView` / `platformCatalogView` carry refs and flags, not secret values. Config continues to store `secretRef` only.
- Vendored snapshot is present (223 providers, `_meta.sourceUrl/fetchedAt/attribution`). `lookupModelMetadata` maps `provider/model` and bare ids, image modalities, and thinking levels that exist in `MODEL_THINKING_LEVELS`. A total miss returns null. `catalog:refresh` is the only `package.json` script addition.
- Cache fields are a separate issue from the acceptance "never count unknown as 0": `optionalCost` still writes `cacheRead`/`cacheWrite` as `0` when those snapshot fields are absent, while input/output prices are omitted. `estimateCost` will then bill cache usage at zero. Not the primary failure, but it should not be treated as compliant with the unknown-price guard.
- `missingRequiredModelFields` does block `persistDraft` when `contextWindow` or `maxTokens` is missing, and the model card placeholders say 「未知，请填写」. That part of the settings-lane defect fix is in place.

## Checks

| Check | Result |
| --- | --- |
| check-types | pass (exit 0) |
| check-provider-rules | pass (22 tests); does not join the web payload |
| check-catalog-rules | pass (12 tests) |
| check-provider-form | pass (26 tests); asserts each side in isolation |
