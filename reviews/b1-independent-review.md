# Independent review · 批 B-1（模型厂商与模型配置）

Reviewed integration HEAD ac5971bc7cd1c7910a014eb08575648a29ce23cf (same tree as this work copy). Program checks all exited 0:

- check-types: `node --run typecheck` code 0
- check-provider-rules: provider-api.test.ts 23 passed
- check-catalog-rules: catalog-models-dev.test.ts 14 passed
- check-provider-form: provider-form.test.ts 33 passed

Those checks do not cover the two UI/runtime defects below. Verdict: **fail**.

## Findings

### 1. Default thinking strength is invented as `medium` when the snapshot does not name one

Acceptance ② says a selected model is auto-filled for 默认思考强度 from the vendored models.dev snapshot, and unmatched fields stay blank. Lane notes say unmappable reasoning options must be omitted, not invented, and grade must not be silently defaulted. The thinking default has the same failure mode.

- `src/catalog/models-dev.ts` sets `defaultThinkingLevel: 'medium'` whenever `reasoning` is true and the mapped level list happens to contain `'medium'`:

```
...(reasoning && levels.includes('medium') ? { defaultThinkingLevel: 'medium' as ModelThinkingLevel } : {}),
```

models.dev `reasoning_options` has no default field (the interface only has `type` / `values`). The catalog test then locks `lookupModelMetadata('grok', 'grok-4.3').defaultThinkingLevel === 'medium'` as if the snapshot said so (`tests/console/catalog-models-dev.test.ts`).

- `src/web/Settings.tsx` renders the select as `value={entry.defaultThinkingLevel ?? (entry.reasoning === false ? 'off' : 'medium')}`. A controlled select with no matching option still displays the first option, but this expression displays `medium` for every reasoning model the snapshot did not score. The first change of any other field on that card runs `mutate`, which clones the draft and schedules `persistDraft`. The select's `onChange` is not required: any sibling edit (context window, grade, image checkbox, price) persists the displayed `medium` into `models.entries[].defaultThinkingLevel`.
- `src/core/task-runtime.ts` uses that stored value: `requestedLevel ?? effective?.defaultThinkingLevel`. A new conversation therefore starts at medium even when the user never chose a strength and the snapshot never published one.

Impact: 默认思考强度 is not "filled from the snapshot or left blank". It is a silent default, the same class of defect the lane was told not to repeat for `grade`.

### 2. A genuine zero price cannot be saved, so a free model cannot complete step 2

Acceptance and lane note (d) say a missing price side must not be stored as 0, and a real 0 must not be treated as missing. `estimateCost` in `src/catalog/models.ts` already distinguishes the two: a non-finite or negative side is unknown; a finite 0 is a real free rate. The settings path collapses them.

- `src/web/Settings.tsx` `setCost`: an empty input becomes `undefined`, but `Number('0')` is `0`, which is finite, so it is passed to `withCostField`.
- `src/web/provider-form.ts` `withCostField` only deletes a side when `value === undefined || !Number.isFinite(value)`. `0` is stored.
- `src/web/provider-form.ts` `costError` treats "present" as `cost[field] !== undefined`. A draft `{ input: 0, output: 1.1, cacheRead: 0, cacheWrite: 0 }` (free input, real output, zero cache — a normal models.dev shape, and exactly what a user types for a free model) has all four sides present and finite, so `costError` returns null and `completeCost` would accept it.
- The card never reaches that state. The inputs bind `value={entry.cost?.input ?? ''}` (and the same for output / cacheRead / cacheWrite). In JavaScript `0 ?? ''` is `0`, but a React number input with value `0` is the same DOM value as an empty cleared field after the user deletes a digit. The next `onChange` sees `raw === ''` and deletes the side. Clearing the visible `0` is how a user "leaves it blank"; the handler cannot tell a typed zero from a cleared field. After any such edit the cost is partial, `costError` returns the 成套填写 message, and `persistDraft` refuses the whole document.

Impact: a model whose real per-million price is 0 on any side (free input, free cache, or an entirely free model) cannot be saved through the two-step form. The user is told the price is incomplete. That blocks acceptance ② ("可手填") for the price fields, and it blocks human-b1 for any model the snapshot or the user prices at zero. The guard that was supposed to stop a missing side being billed as 0 now also rejects a genuine 0.

## What was checked and holds

- Provider routes are `GET /api/providers` and `POST /api/providers/probe` (`src/server/app.ts`, `PROVIDER_ROUTES` in `src/server/providers.ts`). Probe requires `requestId`. Custom drafts require `label` + `baseUrl` + `api` (`openai-completions` | `anthropic-messages`) + `credentialRef`. Presets only need the credential ref. Probe failure text comes from `vendorErrorText` / `parseVerifyResponse`, not a wrapped generic error.
- `ADVANCED_SETTINGS` is an empty list (`src/web/Settings.tsx`). The per-credential cap and shared-group cap are edited inside the ① 配置厂商 card (`data-testid="provider-concurrency"`, `limit-credential-${id}` / `limit-group-${id}`). The advanced page only renders the moved-note. `writeConcurrency` still writes `limits.credentials` and `limits.sharedGroups`; desktop save goes through `applyConfig` (`src/server/app.ts`), which hot-applies and does not cancel in-flight slots.
- Config stores `secretRef` only (`src/server/config.ts` credential parse; `sanitizeConfig` / `sanitizeProviderView` return the ref plus a boolean). Probe responses carry `credentialRef` and `credentialConfigured`, not the key. The page password input is cleared after `bridge.saveSecret`. Unresolved credentials are not placed in `live-config`'s credential map (`src/server/live-config.ts`, `if (!resolved?.value) continue`), and `pi-adapter.ts` refuses to send when `credentialFor` returns nothing.
- `lookupModelMetadata` omits `cost` unless input, output, cache_read and cache_write are all finite (`optionalCost`). A miss returns `null`. No `grade` is written by the snapshot mapper. The settings grade select starts empty and `modelFieldErrors` blocks save until the user picks one.
- Local connection id is `provider:modelId` via `uniqueLocalModelId`; upstream id stays in `modelId`.

## Not claimed

Human console walkthrough (human-b1) was not run. Real vendor HTTP and keychain storage are outside this review. The two defects above are visible in the frozen tree without that walkthrough.
