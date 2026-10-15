# Usage boundary preservation review 39

Read-only independent review; no Vitest executed and no repository files modified. Reviewed `/tmp/graph-usage-e2e39.test.ts` in full, original `tests/m8/usage.test.ts` in full, all of `src/server/usage.ts`, CLI parser/main, relevant daemon startup/config-test/config API routing, UsagePage, CONTEXT/standards/CAMPAIGN and ADR 0020. History examined: original dashboard lineage, 44eeff3 multi-account contract, d0c1334 missing-key/live secrets regression, 5b239a5 OpenCode session routing header.

## Verdict

The candidate is genuine E2E: public CLI child daemon, production config loader/startup/service/global fetch, loopback public HTTP handlers and actual Chromium built app. No service injection, no patched fetch, no fabricated Graph-owned snapshot/receipts. External vendor substitution is correctly outside the owned boundary. However the two-case draft reviewed is **not yet a complete replacement** of all four old tests; preserve old tests until the gaps below are carried and owner proof is green.

## Per-declaration ledger

1. Missing unresolved account: C -> new first real daemon test. Carries two platform cards, exact extra account ID/name, configured false/status unconfigured/error null, and zero vendor requests. A primary platform card must remain present as well. New default API is stronger than constructor-injected service. Needs no production change.
2. Several accounts: C -> new all-vendor test. Carries primary `opencode-go` with `account:null`, extra stable composite ID/platform/name, quota12 versus70 and distinct actual wire Bearer tokens; summary6 instead of2 is intentional five-platform+one-extra-account consolidation. `connected:6` prevents silent missing provider failure. New filter/find assertions establish account identity and values; summary does not alone replace these.
3. Normalize five sources: C pending gaps. Carries all original window labels, Command monthly balance46.42/70/23.58, Deepseek CNY88.5, ChatGPT2windows, Grok37.5, OpenCode expected two models, exact OpenCode session header, responses unsupported marker, Command context131072, Deepseek nonreasoning, ChatGPT unsupported, Grok model, pricing IDs/equality via public pricing API, and provider-to-secretRef via public credentials API. **Missing secretValues import behavior:** query source selection and secret-free output do not prove `start.ts` receives imported values. Removing the `usageService.secretValues()` import may leave the draft green. Carry real public `/api/config/test` binding with a key available only in vendor CLI config; record actual provider authorization. **Missing original OpenCode CLI source:** draft uses Graph env for OpenCode and CLI file only for Command. Restore OpenCode file entry too, remove main env key, and positively test zen connection (see below). Exact11 fetch count is not an independent product contract; external topology now has an extra account and UI force refresh. Retire that implementation-count assertion while retaining actual identities/auth/result proof.
4. Synthetic usage UI: C pending one gap -> real all-vendor browser plus real missing-key browser. Carries nav label, OpenCode card, money formatting (new correct source fixture46.42 instead of synthetic12.60), hidden pricing heading and element, plus refresh actual wire call and12->34 visible change. Stronger than recording `get(force)` flag. **Missing unconfigured UI empty-card text:** new all-vendor scenario has no unconfigured cards. First missing-key test should launch Chromium and assert real Deepseek and named OpenCode extra-account cards contain 未检测到凭据, plus account-name text. After browser load zero vendor sends must still hold.

## Minimal carry fragment

`/tmp/graph-usage-secret-carry39.fragment.ts` provides missing-key browser checks and Command-only CLI-secret public connection proof. `/api/config/test` owner in start.ts sends nonstream POST and checks response status, then cancels body; an SSE fixture is unnecessary. It really calls `live.credentialFor(entry)` and global fetch. Add standard Command secretRef binding plus command-import model. Vendor must reject wrong/empty auth (401), and test asserts200 and actual wire Bearer command-key. Keep Command key absent from child env.

For original OpenCode CLI fallback preservation, add `opencode-go` with main-key to actual OpenCode config; remove GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY from child environment. Keep zen's standard reference. A `/zen/go/v1/chat/completions` vendor endpoint returning200 only for POST+Bearer main-key, plus real `/api/config/test` zen check, proves startup found/imported that CLI-owned value. The live merged env can subsequently resolve primary Graph credentials; this does not fake source import because the process starts without the key.

For the remaining env-provider values formerly checked through `secretValues`, also verify captured billing/model wire auth for Deepseek, ChatGPT and Grok. Public credentials API already verifies their standardized ref mapping. This pairs each value/ref selection at observable boundaries while Command/OpenCode positive connection proves generic startup import consumption. Existing settings-ui has a real daemon Command configured:true UI import proof, but no provider request and does not replace this stronger import correctness check by itself.

## TLS/proxy review

HTTPS URLs retain production hostnames and paths. The child alone receives --use-env-proxy, HTTP(S)_PROXY and NODE_EXTRA_CA_CERTS. Generated certificate SAN lists every allowed production external host. CONNECT only accepts allowlisted host with443, and connects exclusively to the local TLS fixture port. No accepted CONNECT is forwarded online. TLS production fetch remains intact; CA trust is scoped to child, no rejectUnauthorized bypass. Loopback NO_PROXY prevents self API proxying. The fixture serves wire vendor payloads and observes actual host/path/auth/method, not owned UsageSnapshot fields. The raw5-byte Grok fixed32 protobuf is legal parser input already used by original proof; it does not claim grpc-framing coverage. Models.dev fixture plus actual installed Pi metadata models intentionally covers current model normalization, not a live vendor catalog.

Use root's actual candidate run/typecheck result for runtime portability: review itself does not prove Node launch support, cert acceptance, browser readiness, or cleanup. Current shell Node v26.3.0; package declares >=24.20.0. Avoid claiming all supported Node/OS versions verified. Root identified bodyless JSON POST and Duplex typing during execution; apply body{} and Duplex type before using results.

## Suggested deliberate mutations

- Suppress unresolved account creation or invoke runner despite empty account.value: first public missing-key flow must fail intended count/status/zero-wire guard.
- Reuse primary credential for extra account: actual12/70 and wire auth guard fail.
- Return {} from secretValues (or replace startup importedSecrets with {}): imported CLI-only connection check must fail `ok:true` / wire send, while current draft without carries likely stays green.
- Break only OpenCode CLI credential fallback: zen imported connection must fail while Command still passes.
- Disable forced refresh bypass: UI remains12 and changed actual vendor-call count guard fails.
- Remove OpenCode session header/model API marker: public snapshot contract fails.
- Remove unconfigured message rendering: genuine missing-key browser text guard fails.

Restore every production mutation byte for byte and rerun candidate after controls. Negative controls have not been executed by this reviewer. No statement here authorizes deleting tests before root has carried gaps, run intended controls and owner/sibling proof.

## Limits

No live vendor account, network reliability, OAuth refresh, auth-file JWT extraction, gRPC framing/reset timestamp, billing error presentation or cache TTL/dedup claim follows from this candidate; original four tests did not prove those either. The original phrase “without model pricing” meant no pricing UI even when pricing data exists, which the candidate continues accurately; it does not require deleting the local pricing fixture. The reworked test must not claim live pushed-key/revocation coverage merely from startup env/file import (d0c1334's other history topic is independently owned).
