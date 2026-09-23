# B-1 independent review — fail

Reviewed the merged task tree at `7459f12` (catalog snapshot `678082f`, provider API `036c572`, settings `3f1499f`). Program checks passed, but they only exercise pure helpers. The wired two-step flow does not meet the acceptance criteria.

## Findings

### 1. Saving and verifying a provider cannot succeed (provider-configure)

`src/web/Settings.tsx` `saveProvider` / `runProbe` posts `buildProbePayload()` to `/api/app/providers/probe`.

- `src/web/provider-form.ts` `buildProbePayload` does not send `requestId`. `src/server/app.ts` `runProviderProbe` throws `requestId is required` before any vendor call. The page then shows `验证失败：requestId is required`, which is a local wrapper, not the vendor's raw error. One-shot verification never runs.
- `GET /api/app/providers` returns `credentialRef` and `credentialConfigured` (`src/server/providers.ts` `platformCatalogView`). `normalizePlatforms` only reads `secretRef` and `configured`, so a successful catalog response is dropped (`!secretRef` falls back to a synthetic name, but `!baseUrl` is not the issue — `secretRef` is missing so the fallback is used, and `configured` is never set). Worse, the browser calls `/api/app/*`, which `src/server/app.ts` rejects without `x-graph-app-token`. `src/web/api.ts` never sends that token, so the page always falls back to `FALLBACK_PLATFORMS`.
- Fallback DeepSeek base URL is `https://api.deepseek.com`; the server preset and models request are `https://api.deepseek.com/v1`. A later successful probe would still hit the wrong endpoint.
- Supported-platform save does not persist `baseUrl` / `api`. Those live only in React state. Reload loses the configured endpoint, so the provider is not actually saved as a usable connection.

Impact: acceptance item ① (KEY-only save, custom name+URL+format+KEY, automatic minimal request, raw vendor error) is not reachable from the UI.

### 2. Selected models with unknown metadata cannot be saved (provider-model-fetch)

`addSelected` writes `draftToModelEntry()`, which omits `contextWindow` and `maxTokens` when the snapshot misses. `src/server/config.ts` `parseModel` requires both via `positiveInt`. Autosave then fails with `contextWindow must be a positive integer`. The same path also omits `thinkingLevels` entirely (`buildEntryDraft` never copies them), and the UI never offers a model-grade fill from the snapshot (`lookupModelMetadata` has no `grade`).

A matched model can be added, but an unmatched one — the case the requirement says must stay blank and hand-editable — cannot be persisted at all. The page also never calls `fillEntryFromMetadata`, so the "do not overwrite hand edits" rule is only true in the unused helper.

### 3. Concurrency controls are not in the provider step for existing credentials, and the old section contract is broken (concurrency-inline-provider)

New drafts edit limits inside the provider card (`limit-credential-${id}` / `limit-group-${id}`), and the advanced page no longer renders `#settings-limits`. That matches the new requirement's wording, but:

- Existing credentials that are not the currently selected platform preset have no inline editor. There is no credential list, no add control, and no `limit-credential-add` / `limit-group-add`.
- `tests/m8/settings-ui.test.ts` still drives `#settings-limits`, `advanced-setting-toggle-settings-limits`, `credential-add`, `model-add`, and `model-0-*`. `Settings.tsx` removed those controls (`credential-add` / `model-add` / `model-0-price` have zero matches). The B-0 settings UI regression is broken even though this batch's pure tests pass.
- `ADVANCED_SETTINGS` still advertises title `并发限制` and test ids `limit-credential-add` / `limit-group-add` while the advanced page filters that entry out. The data contract and the rendered page disagree.

### 4. Browser verification cannot resolve a keychain secret, and unresolved models remain selectable (secrets-stay-out)

`saveProvider` stores the key only through `bridge.saveSecret` and never calls `POST /api/app/secret`. `runProviderProbe` reads `capabilityConfig.secretValues()` / process env only. A key that exists solely in the keychain is still "凭据未解析" at probe time, so verification fails before any vendor request.

`selectModel` (`src/core/task-runtime.ts`) and `pickModel` (`src/core/model-selection.ts`) accept any directory entry. `live-config.ts` keeps unresolved entries in `directory` and only omits them from `credentials`. Dispatch still binds the unresolved model and fails later inside the adapter, which is not "未解析凭据的模型不会被派发". Config/API responses do keep `secretRef` only (`sanitizeConfig` / `sanitizeProviderView`); that part holds.

## What did land

- Vendored models.dev snapshot (223 providers, `fetchedAt` / source URL / MIT attribution) and `lookupModelMetadata` return `null` or omit `cost` instead of inventing a zero price. Thinking levels are filtered to `MODEL_THINKING_LEVELS`.
- Server pure functions build `/models` and a minimal chat body, and non-2xx parsing keeps vendor text. Platform credential env names match `src/server/usage.ts`.
- Provider form helpers mark `pricing.status='unknown'` and can read/write concurrency drafts.

These are library-level. They do not close the user-facing acceptance items above.

## Checks

- `check-types` exit 0
- `check-provider-rules` 20 passed (pure `providers.ts` only; no route/UI)
- `check-catalog-rules` 9 passed
- `check-provider-form` 22 passed (pure `provider-form.ts` only)

Verdict: fail. The two-step console flow does not verify, does not persist unknown-metadata models, and does not keep unresolved credentials out of dispatch.
