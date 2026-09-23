# B-1 independent review

Verdict: fail

The three lanes are integrated and the program checks pass (typecheck, provider-api 23, catalog 12, provider-form 27). The two-step flow, session-cookie `/api/providers` routes, secretRef-only config, and inline concurrency fields are present. They do not satisfy the price and model-grade acceptance rules: an unmatched or half-filled price is persisted and billed as zero, and every selected model is saved as grade `medium` even though the vendored snapshot has no grade.

## Findings

### 1. Manual price entry writes the unknown side as 0, and billing treats that as a known price

Acceptance: unmatched or incomplete prices stay empty with `pricing.status='unknown'` and are never counted as 0. The user may fill them by hand.

Evidence:

- `src/web/Settings.tsx:660-662`. Typing only the input price does `output: target.cost?.output ?? 0` (and the same for cache rates). Typing only the output price does `input: target.cost?.input ?? 0`. Clearing the currency deletes `pricing` but leaves the zeroed `cost`.
- `src/catalog/models.ts:112-116` `estimateCost` returns `{ unknown: true }` only when `cost` is absent. A present cost object with a filled-in 0 is billed as a finite amount. `pricing.status` is not consulted.
- `src/runtime/task-gate.ts:71` and `src/core/operation-lifecycle.ts:760` both call that function. A model saved after a one-sided edit is therefore charged as if the missing side were free.
- The page copy at `src/web/Settings.tsx:641` says unknown prices will not be counted as 0. That is true only until the user touches one price field.

Impact: the human check “unknown 不被当作 0” fails on the hand-fill path the requirement explicitly allows. A snapshot miss followed by filling only the input price persists output/cache as 0 and later usage is recorded as a known cost.

The snapshot mapper itself is stricter (`src/catalog/models-dev.ts:118-126` omits the whole cost when input or output is missing). That guard is bypassed by the settings editor. Cache-rate defaulting to 0 inside the mapper is a separate, documented choice and is not this finding.

### 2. Model grade is invented as `medium`; the snapshot cannot supply it

Acceptance: after a model is selected, context, max output, image support, thinking levels, default thinking strength, model grade, and prices/currency are filled from the vendored models.dev snapshot. Fields the snapshot does not match stay empty.

Evidence:

- The vendored snapshot has 8080 models and zero `grade` fields. Sample model keys are `id`, `name`, `family`, `modalities`, `limit`, `cost`, and similar. `src/catalog/models-dev.ts` never reads or emits `grade`.
- `src/web/Settings.tsx:514` always passes `grade: 'medium'` into `buildEntryDraft`.
- `src/web/provider-form.ts:472` then does `grade: draft.grade ?? 'medium'`. An unmatched model is therefore saved as medium, not left blank.
- `src/web/Settings.tsx:648` renders that invented grade in the 模型等级 select with no “未知” state.

Impact: every newly added model, including a manual id the snapshot does not know, is stored and shown as medium. That is not a snapshot fill, and it is not “leave unmatched fields empty”. Grade also drives later model selection (`src/catalog/models.ts` `selectModel` matches `model.grade`), so the invented value changes dispatch, not just a label.

`src/server/config.ts:142-143` still requires a grade to parse a saved model. That constraint does not make the invented value correct. The add path should block save until the user picks a grade, the same way `missingRequiredModelFields` already blocks a missing context window, instead of silently writing `medium`.

## Checks that did pass

- Provider routes are `GET /api/providers` and `POST /api/providers/probe` (`src/server/providers.ts:35-38`, `src/server/app.ts:274-278`). No `/api/app/providers` registration. Probe body field is `label`, not `name` (`src/web/provider-form.ts:221-234`).
- Config and API views store/return `secretRef` plus a resolved flag (`src/server/config-service.ts:12-26`, `src/server/providers.ts:429-456`). Probe replies do not include the key. Unresolved credentials are omitted from `live.credentialFor` (`src/server/live-config.ts:120-128`) and dispatch throws `No credential bound` (`src/runtime/pi-adapter.ts:184-188`).
- Concurrency controls are inside the provider card with `limit-credential-*` / `limit-group-*` (`src/web/Settings.tsx:582-589`). `ADVANCED_SETTINGS` is empty (`src/web/Settings.tsx:323`).
- Snapshot lookup returns null on a miss and omits incomplete input/output prices (`src/catalog/models-dev.ts:246-271`). `catalog:refresh` is present. Snapshot has `_meta` and 223 providers.
- Typecheck and the three vitest files passed. Those tests do not exercise the settings price inputs or the forced grade.

## Not raised as failures

- `requestId` is required but not stored, so a repeated probe is not idempotent (`src/server/app.ts:145` discards it). The lane note asked for an idempotency key, but the user acceptance does not require retry dedupe. A repeated probe is a read against the vendor, not a double save.
- `saveProvider` still calls `runProbe()` after a keychain save failure because the `return` is inside `try` and `runProbe()` is after `finally` (`src/web/Settings.tsx:471-495`). The failed save does not write the key, and the probe then reports the credential as unresolved. That is a UX defect, not an acceptance miss.
- Default thinking level is only guessed as `medium` when the snapshot’s own effort list contains `medium` (`src/catalog/models-dev.ts:268`). The select’s display fallback (`src/web/Settings.tsx:652`) is not written unless the user changes it.
