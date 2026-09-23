# B-1 independent review

Verdict: fail

Reviewed the frozen integration worktree at HEAD `34f691c` (branch `graph/copy/362a8f59-d14f-4e89-b3e7-980d40996ef3/review`, clean). Program checks all exited 0:

- `check-types` (`node --run typecheck`) code 0
- `check-provider-rules` 23/23 passed
- `check-catalog-rules` 15/15 passed
- `check-provider-form` 37/37 passed

Those checks only cover the pure helpers they import. They do not exercise `saveProvider` / `runProbe` in `src/web/Settings.tsx` or `runProviderProbe` in `src/server/app.ts`. The two-step flow on the page is broken for the vendors this batch is supposed to configure.

## Findings

### 1. Saving a supported vendor never verifies, and the page reports a generic error instead of the vendor text

Acceptance `provider-configure`: after save, automatically send one minimal request; success marks the provider usable; failure shows the vendor's original error text.

`src/web/Settings.tsx` `saveProvider` always calls `runProbe()` with no model id. `probePayload` (`src/web/provider-form.ts`) does not send `modelsListSupported`, so the daemon uses the preset. For OpenCode Go that preset is `modelsListSupported: false` (`src/server/providers.ts` line 51). `runProviderProbe` (`src/server/app.ts` lines 152-174) then skips `/models`, has no `verifyModel`, and returns:

```text
verification: { ok: false, skipped: true, error: '没有可验证的模型：该端点不支持模型列表，请手动添加模型 id' }
```

The page (`Settings.tsx` lines 451-453) treats any non-ok probe as failure and displays that string. So the required "supported vendor, fill KEY only, save, one minimal request" path never sends the chat request, never marks the vendor usable, and never surfaces a vendor response. The user is told to add a model id in step 2, but step 2 is a separate action and does not re-verify.

The same path breaks custom vendors whose `/models` is unsupported or returns an empty list: `probePayload` never forwards `modelsListSupported: false`, the daemon defaults custom to `true`, a failed or empty list becomes the verification error, and no minimal chat is sent.

Impact: acceptance item ① cannot be completed for the named supported vendor OpenCode Go, and "failure shows the vendor's raw text" is not what the page shows.

### 2. Verification runs before the new key is visible to the daemon

`saveProvider` (`Settings.tsx` 468-495) writes the key via `bridge.saveSecret`, then calls `mutate(...)` (which only schedules autosave, 550ms, `scheduleSave`), then immediately `await runProbe()`.

`pushSecret` (`src/server/start.ts` 542-568) updates the live credential map. The probe does not read that map. `providerSecrets` (`src/server/app.ts` 98-101) reads `capabilityConfig.secretValues()`, which is `capabilitySecretValues` (`src/server/start.ts` 357-367): process env plus `live.secrets()`. `live.secrets()` is the keychain import from startup (`usageService.secretValues()`), not the map `pushSecret` just updated. A key typed in the form is therefore absent from the probe, which returns `凭据未解析：<credentialRef>` (`app.ts` 164-165) even after the keychain write succeeded.

Impact: the automatic post-save verification fails for a newly entered KEY/subscription token. The page shows a local "credential unresolved" string, not a vendor response, and does not mark the provider usable. This blocks both the supported-vendor and custom-vendor legs of acceptance ①.

### 3. Price 0 is erased by the settings inputs, so a free price cannot round-trip

Lane note A requires a price of 0 to be a legal free price: it must save, count as known, and must not be deleted because 0 is treated as empty. `withCostField` / `completeCost` / `costError` do treat 0 as finite (`provider-form.ts` 393-410; tests at `provider-form.test.ts` 346-352). The page does not.

`Settings.tsx` line 675:

```tsx
value={entry.cost?.input ?? ''}
onChange={event => setCost('input', event.target.value)}
```

`setCost` (line 640) maps `''` to `undefined`, and `withCostField` deletes that side. A controlled `<input type="number">` displays `0` as an empty string, so the next edit of any price field (or a re-render that fires change) clears the zero side. The same pattern is on the other three price inputs (lines 676-678). Once a side is missing, `completeCost` returns null and the pill shows `pricing.status=unknown`.

Impact: a free model (all four amounts 0, which the catalog mapper can emit via `finiteAmount`) cannot be kept as a known price in the UI. The regression the lane was told to preserve is only true in the helper, not on the page that saves the model.

### 4. Unresolved credentials are not what disables model selection

Acceptance `secrets-stay-out`: models with an unresolved credential must not be dispatched. Dispatch itself is guarded (`pi-adapter.ts` 201-202 throws `No credential bound` when `credentialFor` misses). The settings contract is not.

`ProviderWorkbench` treats a platform as resolved when any of three flags is true (`Settings.tsx` 423):

```ts
keyResolved[active.credentialId] || credentialState[active.credentialId] || selected?.credentialConfigured
```

`credentialState` comes from `GET /api/config` `configured` (`Settings.tsx` 783-786). `configured` is `Boolean(env[secretRef])` inside `sanitizeConfig`, and `/api/config` passes `providerSecrets()` as that env (`app.ts` 304). `providerSecrets()` returns every resolved capability secret, not a boolean map. `Boolean(env[secretRef])` is therefore true whenever the ref exists as a key, even when the merged value is empty or the credential was revoked. Combined with finding 2, `keyResolved` is set true after a keychain write that the probe cannot see. Either path clears `blockedReason` and enables "获取可用模型" / model checkboxes for a credential that is not actually resolved.

Impact: the page will offer and persist models under a credential the daemon has not resolved. Dispatch later refuses them, but the UI contract ("disable unresolved platforms and name the env var") is wrong in both directions.

### 5. B-0 settings tests now contradict the inlined concurrency UI

`ADVANCED_SETTINGS` is `[]` (`Settings.tsx` 324) and the old `advanced-setting-settings-limits` card is gone, which matches B-1. `tests/console/settings-sections.test.ts` still requires that card:

- line 63: `ADVANCED_IDS` must contain `settings-limits`
- line 72: `ADVANCED.length` must be greater than 0
- lines 90-96: the advanced region must still expose `limit-credential-add` / `limit-group-add`

Those tests are not in this batch's check nodes, so the green checks do not cover the regression. Running the B-0 settings suite against this tree will fail. The B-1 replacement controls (`limit-credential-${id}`, `limit-group-${id}`) do exist inside the provider card (lines 588-590), so this is a stale assertion, not a missing control — but it is an acceptance gap for the concurrency move: the previous batch's check no longer passes, and nothing in B-1 updates it.

## What holds

- Catalog mapping does not invent `defaultThinkingLevel` (`models-dev.ts` 366-368); reasoning models omit it; partial prices omit `cost` entirely; a miss returns null. Snapshot plus `catalog:refresh` are present.
- Provider routes are `GET /api/providers` and `POST /api/providers/probe` on the session face; `/api/app/providers` is absent; probe rejects a missing `requestId`; draft field is `label`, not `name`.
- Config documents store `secretRef` only (`config.ts` CredentialConfig). `sanitizeConfig` / `sanitizeProviderView` do not echo secret values. The desktop bridge stores secrets in the encrypted keychain file and posts the value only to the token-gated `/api/app/secret` bridge, not to the console JSON.
- Per-credential and shared-group limits are edited inside the provider card, and `writeConcurrency` still writes `limits.credentials` / `limits.sharedGroups`. Hot apply still goes through `live.apply` without interrupting in-flight waits (`pi-adapter.ts` refresh path). That part of concurrency-inline is met; finding 5 is the leftover contract break.
- Local connection id vs upstream `modelId` is preserved (`uniqueLocalModelId`, `draftToModelEntry`).
- Thinking-level `<select>` keeps an explicit empty "未指定" option and deletes `defaultThinkingLevel` when cleared (`Settings.tsx` 668-670). That half of lane note A holds; the price-0 half does not (finding 3).

## Checks

Green checks are necessary but not sufficient. `provider-api.test.ts` asserts route strings and pure parsers; it never runs `runProviderProbe`. `provider-form.test.ts` asserts `probeRequest` shape and helper price-0 behavior; it never renders `saveProvider`. The failures above sit in those untested call paths.
