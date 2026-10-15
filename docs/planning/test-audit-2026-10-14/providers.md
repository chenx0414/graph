# Provider/config/pricing bounded read-only ledger

Baseline: parent pinned HEAD 463fa2c, 271 files / 1852 cases pass; no edits or tests run by lane.

Read full 8 assigned suites; production providers.ts/provider-form.ts/models-dev.ts/models.ts/price-snapshot.ts/catalog thinking/runtime thinking/config-service, entry-point app provider/config handlers and start refresh; callers rg inspected. History: b5e78cb (account thinking), f9dd935 (new model levels), 7c1ddc0 (selected credential), dedadee (account label), 44eeff3 (several accounts), 105d733 (second-strongest default). ADR0010 config/secret/pricing and ADR0017 unknown usage retained. CI package check runs vitest all tests + baseline/evidence; root owns E2E inventory/configuration.

No deletion authorized by this ledger until each C has passing keeper proof. Existing browser E2E and actual HTTP conversation cost flow preserved. No test-only seam deletion yet justified: helpers have production Settings.tsx callers.

## Keeper plan

- **HTTP-PROBE**: New genuine E2E: cookie-authenticated daemon provider directory and probe API -> loopback HTTP vendor -> observed raw requests and public response. Matrix OpenAI/Anthropic auth, paths, tiny ping, raw errors, list shapes/dedupe, manual ids, false advisory flag, explicit skip, unresolved secret; reject invalid requestId/draft before any vendor request.

- **BROWSER-FORM**: Existing tests/m8/settings-ui.test.ts browser -> daemon -> loopback vendor -> config disk. Extend this keeper with custom draft validation and missing fields, manual selection retained after re-probe, missing caps/grade blocks disk revision, partial/free/cleared price roundtrip, account creation and group-cap clearing, provider secret never exposed. Preserve setup-wizard genuine E2E unchanged.

- **BROWSER-METADATA**: Extend settings-ui actual model editor using shipped snapshot asset (no injected mapper): choose deepseek-v4-flash, claude-sonnet-4-6, grok alias and opencode-go-3 account; assert displayed caps/image inputs/pricing provenance and saved config. Unknown/manual id remains unknown without fabricated caps/grade/default. For alternate legacy snapshot wrapper cases, create isolated packaged copy of app+snapshot and launch built application, never inject helper output.

- **HTTP-THINKING**: New genuine E2E: save real config via /api/config, GET /api/settings and /api/config options, create /api/conversations with requested levels; loopback provider records actual reasoning_effort and public conversation telemetry. Matrix grok, deepseek/account, mimo/toggle, unknown/legacy reasoning:false and stale defaults; browser verifies exact option labels and fallback notice.

- **HTTP-HEADERS**: New genuine E2E: /api/config/test plus HTTP conversation create -> real resident worker -> loopback TCP provider. Assert explicit header override/auth and OpenCode default header; config POST invalid name/empty/nonstring keeps file/effective revision; missing model secret does not disable valid model.

- **HTTP-PRICING**: Keeper tests/console/pricing.test.ts second declaration: HTTP create conversation -> real Pi/provider -> persisted invocation cost; extend free/unknown/legacy cost and nonzero cache read/write usage. POST config refresh across two invocations then re-read first persisted snapshot. No direct estimateCost in keeper.

- **HTTP-REFRESH**: New/extended real daemon HTTP /api/pricing/refresh -> config atomic disk -> subsequent conversation invocation snapshot. Assert archived amounts/currency/source/revision, manual/unknown unchanged, failed verification stale retains prior amount. priceVerify injection cannot prove official network verification: start.ts default verifier fetches official source URL and checks modelId, disclose this limit; assertion must test observable refresh policy rather than external freshness.

- **HTTP-RECOVERY**: Genuine E2E view daemon: HTTP create task for valid and removed projects -> close -> execute daemon same disk -> HTTP task view; loopback provider observes recovered master auth, removed-project history retained without dispatch.

## Per-declaration ledger

| Location | Mark | Exact declaration | Keeper / evidence |

|---|---|---|---|

| tests/console/provider-api.test.ts:36 | C | covers the supported vendors and the custom entry | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:41 | D | credential environment variable names match src/server/usage.ts | HTTP-PROBE: Identifier-sensitive source grep or copied runtime inventory; actual cookie probe and directory semantics retain user-facing proof in HTTP-PROBE. |

| tests/console/provider-api.test.ts:51 | C | catalog view flags resolved credentials without any secret value | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:67 | C | OpenAI-compatible platforms list <baseUrl>/models with a bearer token | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:76 | C | Anthropic-compatible targets use x-api-key and the version header | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:84 | C | OpenCode Go carries its session routing header | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:89 | C | an unresolved credential omits auth headers instead of sending an empty one | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:94 | C | parses data/models/array shapes and dedupes by id | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:104 | C | an empty 2xx body is an empty list, not an error | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:108 | C | non-2xx responses surface the vendor wording verbatim | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:119 | C | OpenCode Go is marked as listing models (regression pin) | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:126 | D | every preset still advertises a boolean listing hint | HTTP-PROBE: Identifier-sensitive source grep or copied runtime inventory; actual cookie probe and directory semantics retain user-facing proof in HTTP-PROBE. |

| tests/console/provider-api.test.ts:132 | C | only an explicit probeModels:false skips the model list | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:138 | C | a draft marked modelsListSupported:false still probes /models | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:148 | D | the probe handler no longer hard-gates on modelsListSupported | HTTP-PROBE: Identifier-sensitive source grep or copied runtime inventory; actual cookie probe and directory semantics retain user-facing proof in HTTP-PROBE. |

| tests/console/provider-api.test.ts:154 | C | a vendor rejection keeps its raw error and manual model ids still work | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:166 | C | OpenAI-compatible verification posts one tiny chat request | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:174 | C | Anthropic-compatible verification posts to /messages | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:181 | C | 2xx marks the provider usable, non-2xx keeps the raw error text | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:187 | C | vendorErrorText never generalizes and falls back to the HTTP status | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:194 | C | a supported platform only needs a credential reference | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:209 | C | a custom provider requires name + baseUrl + api + credential ref | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:239 | C | the display-name field is label, not name | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:250 | C | an unknown platform is rejected | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:258 | C | are registered on the session-cookie /api face, not the app-token face | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:268 | C | a probe request must carry the requestId idempotency key | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:295 | C | per-credential limits and shared groups keep their existing semantics | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:311 | C | exposes secret refs and resolved flags but never a plaintext secret | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-api.test.ts:326 | C | a missing config yields an empty credential view | HTTP-PROBE: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:62 | C | accepts a supported platform with just a key | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:66 | C | requires a key (or a resolvable credential) even for a supported platform | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:72 | C | requires label, base URL, compatibility and key for a custom provider | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:79 | C | rejects a non-http base URL and an unknown compatibility mode | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:88 | C | rejects malformed credential ids and credential refs with the daemon wording | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:99 | C | shows OpenCode Go effort levels as soon as metadata is fetched | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:107 | C | reads { platforms, credentials } and keeps credentialConfigured / credentialRef | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:120 | C | keeps the built-in custom entry even when the daemon list omits it | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:124 | C | drops entries without an id instead of crashing | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:128 | C | keeps the built-in credential environment variable names aligned with usage | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:136 | C | targets the console /api/providers path and always carries a requestId | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:153 | C | merges a probed list without overwriting the user’s existing picks | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:166 | C | lets the endpoint without a model list keep manual ids | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:175 | C | fills every field when the snapshot hits | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:201 | C | leaves an unmatched model blank and marks pricing unknown — never zero | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:211 | C | marks pricing unknown when the model matched but has no usable price | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:219 | C | never invents thinking levels that the catalog does not declare | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:225 | C | converts a fully known selection into the existing ModelEntry shape | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:237 | C | omits unknown context/output instead of inventing positive numbers | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:248 | C | never invents a grade when the snapshot (which has none) does not provide one | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:254 | C | does not overwrite values the user already typed | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:266 | C | fills blanks from a later refresh but keeps an unknown price unknown | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:276 | C | blocks saving until contextWindow and maxTokens are known, with a named reason | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:289 | C | passes once the user fills the required caps and picks a grade | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:296 | C | (e) requires the user to pick a grade instead of defaulting to medium | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:303 | C | blocks model selection while the credential is unresolved and names the daemon ref | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:312 | C | (d) rejects a half-filled price and never turns a missing side into 0 | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:324 | C | accepts a complete price (including genuine free prices) and clears to unknown when emptied | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:336 | C | (d) a partial cost blocks the document save | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:342 | C | (d) estimateCost treats a missing price side as unknown, never as 0 | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:350 | C | (A) never fabricates defaultThinkingLevel when the snapshot gives no default | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:359 | C | (A) only writes a default level when one is actually provided | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:367 | C | (A) a zero price round-trips through the cost helpers and is never treated as empty | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:377 | C | (A) a model with a complete zero price passes validation and persists as known | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:391 | C | lists only configured credentials and counts the models of each vendor | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:410 | C | is empty when no credential is configured | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:415 | C | probes a user-defined credential as the custom platform | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:422 | C | carries each vendor’s own endpoint and api instead of a blank one | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:438 | C | auto-probes only when the selected vendor actually changes | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:446 | C | records a vendor as probed only when a request is really issued | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:455 | C | still auto-probes once when the vendor only becomes resolvable later | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:468 | C | keeps the vendor’s own wording in the model-list failure copy | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:476 | C | browser mode explains why there is no key box and points at the desktop app | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:490 | C | desktop mode keeps the keychain input path | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:498 | C | falls back to a real variable name when the ref is blank | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:504 | C | no longer declares an independent 并发限制 advanced section | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:510 | C | reads a credential cap and its shared group from the config | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:519 | C | writes the per-credential and shared-group caps back into the document | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:527 | C | clears caps and groups when the fields are emptied or invalid | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:533 | C | 4 | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:534 | C | 4.5 | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:535 | C | -1 | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:538 | C | keeps the env var name a working credential already stores | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:549 | C | names the account the operator selected, not the platform | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:565 | C | shows the stored name instead of the platform label | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:578 | C | gives an extra account its own credential id and variable name | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:589 | C | records which platform an account belongs to, and keeps what it already had | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/provider-form.test.ts:597 | C | never claims a platform for a custom provider | BROWSER-FORM: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/provider-headers.test.ts:35 | C | configured model headers reach the provider on a real dispatch | HTTP-HEADERS: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/provider-headers.test.ts:83 | C | config parsing validates and keeps per-model request headers | HTTP-HEADERS: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/provider-headers.test.ts:104 | C | OpenCode Go adds its routing header to connection tests and real dispatches | HTTP-HEADERS: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/provider-headers.test.ts:158 | C | an unresolved credential only disables its own model, not dispatch for others | HTTP-HEADERS: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/provider-headers.test.ts:205 | C | tasks created while dispatch was disabled are recovered on the next execute start | HTTP-RECOVERY: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/price-snapshot.test.ts:14 | C | every archived price carries amounts, currency, unit, source and date | HTTP-REFRESH: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/price-snapshot.test.ts:38 | C | template models without a verified snapshot stay unknown, never zero | HTTP-REFRESH: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/price-snapshot.test.ts:58 | C | a successful refresh stamps a new revision while a failed one keeps the old amount as stale | HTTP-REFRESH: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/price-snapshot.test.ts:118 | C | the refresh endpoint is explicit: failure marks the entry stale and keeps the old amount | HTTP-REFRESH: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/price-snapshot.test.ts:133 | C | a verified refresh bumps the revision that the next invocation freezes | HTTP-REFRESH: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/pricing.test.ts:12 | C | cost normalization uses per-million units, keeps currency and never fills unknown with zero | HTTP-PRICING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/pricing.test.ts:27 | R | a price refresh changes future invocations and leaves recorded cost snapshots untouched | HTTP-PRICING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:21 | C | a model offers exactly the effort levels its catalog entry names | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:29 | C | OpenCode Go account models expose their actual effort levels after saving | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:36 | C | the provider spelling of a level is kept as its label | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:43 | C | a model with no discrete effort vocabulary keeps Pi default levels | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:49 | C | a model missing from the snapshot falls back instead of guessing | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:54 | C | every model is thinking-capable, including one flagged otherwise | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:63 | C | a level the model does not accept falls back like the SDK does | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:75 | C | a saved default the model does not accept is not offered, only clamped | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/thinking-levels.test.ts:93 | C | the level map denies off and every unlisted level | HTTP-THINKING: Internal map/helper replay: replace with effective option list, telemetry and wire effort in HTTP-THINKING. |

| tests/console/thinking-levels.test.ts:104 | C | the default is the second strongest level a model accepts | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/thinking-levels.test.ts:7 | C | a model with no options at all is reported, never guessed | HTTP-THINKING: Compatibility contract not emitted by current server: keep browser compatibility scenario against isolated legacy HTTP response; do not claim current GET response exercises it. |

| tests/m8/thinking-levels.test.ts:13 | C | the model own option list drives the control | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/thinking-levels.test.ts:23 | C | a payload without the field keeps the fallback levels, never off | HTTP-THINKING: Compatibility contract not emitted by current server: keep browser compatibility scenario against isolated legacy HTTP response; do not claim current GET response exercises it. |

| tests/m8/thinking-levels.test.ts:30 | C | a selected level the model does not take falls back like the SDK | HTTP-THINKING: Internal map/helper replay: replace with effective option list, telemetry and wire effort in HTTP-THINKING. |

| tests/m8/thinking-levels.test.ts:38 | C | a saved level the model does not take is reported as a fallback | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/m8/thinking-levels.test.ts:53 | C | the default option is the second strongest level | HTTP-THINKING: Internal map/helper replay: replace with effective option list, telemetry and wire effort in HTTP-THINKING. |

| tests/m8/thinking-levels.test.ts:62 | C | levels are shown in the model own vocabulary, never translated | HTTP-THINKING: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:61 | C | maps a built-in snapshot entry onto context, output, modalities and provenance | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:78 | C | reports a built-in price only when all four amounts are present | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:89 | C | resolves a console platform id through its catalog alias (grok → xai) | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:105 | C | resolves models for a second OpenCode Go account and the current catalog | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:110 | C | never invents a default thinking strength for a reasoning model | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:122 | C | keeps only thinking levels the repository models and never invents one | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:130 | C | treats image as supported only when the snapshot lists it as an input modality | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:135 | C | normalizes price and currency per million tokens including cache rates | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:143 | C | returns null when the snapshot, provider or model is missing | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:150 | C | omits cost entirely when the snapshot prices only part of the model | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:159 | C | leaves a price unknown instead of zero-filling it | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:167 | C | leaves unsupported snapshot fields empty rather than defaulting them | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:175 | C | accepts both the bare model id and the vendor/model spelling | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:184 | C | exposes snapshot provenance for ModelPricing | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:193 | C | reads the vendored `_meta` block and the earlier top-level metadata shape | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

| tests/console/catalog-models-dev.test.ts:200 | C | accepts a bare provider map as a snapshot | BROWSER-METADATA: Independent observable contract; carry assertion to keeper before removing direct-helper layer. |

## Cutover scope and risk

Provider API: replace complete direct helper file only after HTTP-PROBE matrix. Pricing: preserve genuine HTTP test, absorb arithmetic and refresh into actual invocation assertions. Headers: replace private host.runReady and runtime.user drivers with public HTTP; startup recovery is independent lifecycle proof. Thinking: consolidate two helper layers into one server-to-wire owner plus browser rendering. Form/catalog: existing browser proof absorbs duplicate happy paths, but broad metadata/legacy compatibility requires deliberate browser additions; do not delete now merely to reach percentage.

Not a relabel: every replacement drives public HTTP/browser, real daemon, durable disk and actual loopback vendor transport; vendor is allowed fake external service, host/runtime logic is real. Snapshot replacement for legacy format is isolated packaged application data, never edit shared running checkout.

Checks: parent should run all changed keepers with node --run test -- <paths>, typecheck, lint, diff check and mandated node --run check; final preservation review mutates auth header/unknown-price/default-level owners and restores byte-for-byte. Report lower-layer coverage separately from E2E exclusion.


## Actual migration authored (awaiting validation)
New tests/e2e/providers.test.ts drives provider API/vendor TCP, header/config conversation flow and restart recovery. New pricing.test.ts drives frozen historical snapshots and actual paid/free/unknown/legacy costs. New thinking.test.ts drives9 catalog configs through real options, conversation telemetry and provider effort. Existing originals retained pending validation. Form/catalog/price-refresh and browser legacy option cases still have independent gaps; no mass deletion justified.

## 独立保留复核后的真实 HTTP 补证

2026-10-14：在同一 provider keeper 中补回零字节 200、原始文本 500、JSON 字符串 429、顶层 message 400；分别检查 modelsError 和 verification 的实际解码正文。真实公开目录核对 OpenCode 默认 API、URL、凭据引用及 listing hint；公开 config 核对 credential=2/sharedGroup=4。OpenAI/Anthropic POST 验证头已补回。坏请求逐行检查实际 message 的字段归属，不只断言 invalid_input。通过真实关闭的 loopback 端口触发 fetch 失败并断言 verification.status=0、ok=false 及非空传输原因。

最终补证命令 `node --run test -- tests/e2e/providers.test.ts`：3 个场景全部通过（2.97 秒），日志 `/tmp/graph-test-audit-provider-preservation3.log`。独立复核中的五类主要缺口已补入真实边界；仍需生产 mutation 验证及全量并行门禁，不能以此宣布整个迁移完成。

## Browser metadata owner consolidation

Real browser tests/e2e/provider-metadata.test.ts passed3formats in parent batch3. External catalog JSON response fixture replaces only independently sourcedcatalogbytes; shippedmapper/editor runs, actual daemon/provider/models requests, actual autosave/disk records remain real. Retired11provider-form declarations now absorbed: probed/manual selections survive reprobe and manual dedupe; complete metadata/image/currency mapping; unmatched fields stayblank, partialcatalogprice staysunknown, caps/grade never fabricated, partialcost blockedautosave, explicit unsetdefault preserved, zero-price persistsknown. Other requiredfields/browser/account/platform/advanced concurrency declarations remain until own distinct flowproof. No blanket form retirement.

Retired4models-dev declarations: actual browser3formats retain legacy `_meta` and top-levelprovenance and baremap; actual persistedfullpriceEUR per-million/source/revision and partialpriceomission. Remaining real shippedsnapshot alias/id/missing/modalities/vocabulary/provenance contracts remain in originals. Only synthetic cases directly absorbed were removed; actual models.dev independent defaultcontracts are not dropped because syntheticUIfixture passed.

## 独立保留契约的 mutation 证明

2026-10-14：只在实际 `buildVerifyRequest` 移除 `authHeaders(target)`，其余生产字节不变；真实 E2E 在实际 POST Bearer 头断言 `providers.test.ts:67` 失败，证明补回的授权契约不是不失败的重复断言。原源码 SHA256 `081100c7139606fae16c4bbfd9d3442f9329a3139b3cec636754477c2e6c7751`；变异 SHA256 `00cf4190e19341ce6eb5b5cb25f7e00e91387c57b8bdade7b43757cbd99c4add`。测试终止后恢复原字节并核对原 SHA256。变异日志 `/tmp/graph-test-audit-provider-auth-mutation.log`。

恢复后的相同 Provider keeper 加上真实聊天 lifecycle5 并行验证：8 个场景全部通过（12.33 秒），日志 `/tmp/graph-test-audit-preservation-candidate.log`。源文件不含变异，未提交临时生产改动。此控制只证明验证请求授权头契约，不把它扩大为整个审计所有删除契约已完成 mutation。
