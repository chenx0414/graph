# Thinking 10 / settings 7 preservation review 36

Independent read-only review. Re-read all 118 lines of original console/thinking-levels.test.ts and all 93 lines of original console/settings-sections.test.ts, actual current e2e/thinking matrix and provider-metadata account body, runtime/catalog/default/browser owners and installed SDK implementations. No source/test/routing edits or Vitest runs here. Candidate execution evidence is root's reported 4 files/24 passed/20.15s; this report itself is source/contract review, not separate test execution.

## Verdict

Retire settings 7 after root's currently planned real archive click/general return carry (the original seven did not themselves test activation; exact label inventory already carried). Retire thinking 10 after root adds a no-request DeepSeek three-level default row. Current single/empty rows cover their original residual inputs at the actual producer/transport boundary. No other unique independent contract from these 17 declarations remains missing.

## Thinking preservation matrix

1 exact model options: e2e/thinking grok and deepseek literal level arrays, both config/settings HTTP views, actual selected wire.
2 account provider names: account/bunny model IDs remain actual catalog account vocabularies after config save, actual wire.
3 provider spelling/absence off: every API option exact `{level,label:level}`; supported arrays literal exclude off. Public contract retains labels, not internal map encoding.
4 toggle model defaults: toggle case exact Pi minimal/low/medium/high and actual default medium wire.
5 unknown model fallback: unknown actual entry through configured daemon, exact default levels and stale xhigh->high wire.
6 legacy reasoning:false: legacy case API exact nonoff vocabulary, actual requested off->low wire.
7 invalid-request fallback: grok max->xhigh, minimal->low, deepseek medium->high, legacy off->low, newly deepseek-off->low; actual model request distinguished by main tools+user prompt, not auxiliary same-model request.
8 stale saved default doesn't expand vocabulary: account xhigh->max, unknown xhigh->high, exact levels saved/read first.
9 map denial of off/minimal/max/xhigh and reasoning:false: actual API vocabulary + real request clamps above protect the externally meaningful mapping. Map contains null vs omitted is not a separate user/SDK boundary contract once actual SDK selected behavior is exercised. Keep production map implementation, remove only redundant private shape assertions.
10 second-strongest default: default grok high, bunny xhigh, toggle medium, newly single high, newly empty off. Missing as of review: no-request deepseek-default -> high to explicitly carry old three-level default assertion. Root confirms adding it. Once present and green, whole file is eligible.

### Empty vocabulary correction (important)

My initial broad report incorrectly accepted the runtime comment "Never empty". Independent source review rejects that assumption. Actual snapshot entry llmgateway-providers/novita/ling-3.0-flash has reasoning_options [{type:effort, values:[none]}]. `models-dev.ts` alias none -> off. `catalog/thinking.ts` sees nonempty listed map; explicitly sets off=null and every unlisted level=null. Installed pi-ai/dist/models.js getSupportedThinkingLevels filters all mapped nulls, so returns []. clampThinkingLevel falls through to availableLevels[0] ?? off. Therefore defaultThinkingLevelFor([]) is a real reachable route. New empty row asserts BOTH APIs expose [], telemetry off, and positive main actual request exists with expected model but no reasoning_effort. This is stronger full-route proof than directly asserting helper returns undefined, because undefined itself is internal representation subsequently clamped off. Do not delete the helper's empty guard as dead code.

Actual one-level entry nano-gpt/openai/gpt-5-pro has [{type:effort,values:[high]}]. New single row uses no requested/default override and proves API exactly [high], actual telemetry high and wire high. This replaces the original artificial single-element array while retaining its supported model behavior.

Separate issue: only-none model's actual off behavior contradicts the production comment/all-models-think product claim. Campaign must record the discrepancy; fixing it would change genuine current behavior and is not necessary to justify retaining/removing these duplicate tests. Do not misreport empty as impossible or claim thinking always on globally.

## Settings preservation matrix

1 exact settings sections order/labels: provider-metadata actual browser visit /#/settings; polled .settings-nav-item allTextContents exact ['常规','归档对话']; root will click archived then return general as stronger activation proof.
2 no top-level concurrency: exact literal sidebar inventory excludes it, plus real model editor #settings-limits absence and positive visible inline keyed controls. Avoid relying only on a negative missing selector.
3 old advanced registry empty: private no-caller registry obsolete; actual no advanced heading + inline controls protects UI contract. Delete registry implementation inventory.
4 credential/group controls keyed per credential: actual first account reads 3/old-group/8, writes5/team/9 and persisted disk; second account switches actual credential and asserts all three opencode-go-2 keyed controls exist. Existing local account real settings workflow also persists all three controls across restart. No duplicate concurrencyControlIds literal unit needed.
5 SAMPLE starts collapsed: D self-created fixture with no production region/caller.
6 defaultAdvancedOpen(SAMPLE) all closed: D dead API no caller.
7 isAdvancedOpen explicit boolean map: D dead API no caller.

Repo-wide rg confirms AdvancedSetting, ADVANCED_SETTINGS, ADVANCED_SETTING_IDS, defaultAdvancedOpen, isAdvancedOpen appear only in src/web/Settings.tsx definitions and original settings-sections.test.ts imports/assertions. There is no actual React/UI caller, no other source reference. Remove interface + empty constants + helpers together. SETTINGS_SECTIONS still has real Settings() caller at ~1069, so deexport/private it (and optionally private SettingsSection type) rather than deleting the real navigation. concurrencyControlIds is real provider form policy; do NOT delete it.

## Validation / preservation controls

After all edits settled, root should run both actual keepers and appropriate sibling model/settings owners. A deliberate actual model vocabulary/default corruption must trip literal API or actual wire assertions. Sidebar label/order mutation must trip actual DOM assertion; removing/incorrectly binding inline second credential controls must trip second-account controls or real disk persistence. Removing uncalled advanced helpers has no meaningful production mutation behavior and requires no made-up test to prove their absence.

No wholesale routing change for unreviewed files. No claim about other small UI/desktop candidates; see /tmp/graph-smallui-plan36.md for separate residual contracts.

## Root carries and cutover evidence

Final matrix now has13 literal catalog models, including no-request deepseek-default→high, real nano-gpt/openai/gpt-5-pro singleton high, actual only-none→empty-options model, and requested deepseek off→low. Both actual config/settings reads and native main transport are asserted; empty has positive model request and absence reasoning_effort, not blanket thinking-on claim. Provider account keeper clicks actual archived navigation section then returns general, retains exact2 labels/order and positive3 distinct second-account concurrency controls. Root final-carry4files24green18.46s, types36e green.

Controls: allowing off in actual catalog map is caught by real offered vocabulary; swapping settings navigation is caught by exact browser labels/order; mapping only second account's group input to first account is caught by second account positive field guard. All restored byte-for-byte: thinking SHA ccec01c8fbc6349ec19bc1c3fa5822558b5bead6b9ad57fda96e3d134137bf00, Settings SHA50f123eaf60c7cb165bb56d7dcd23e6f287b411e0ebfc4397886b44d1174ee4d (before dead-code removal), provider-form SHA0288ac8fef79516455f7a827bc2518123e35197f16c1753be075102a15168abf. Logs /tmp/graph-test-audit-controls36-settings.log and individual control36-*.log. Restored4files24green18.45s before final two additional carries, final-carry24green then retirement.

17 old helper declarations removed after independent review and carried proof. Actual catalog/default/clamp functions remain. Settings removes obsolete AdvancedSetting/ADVANCED_SETTINGS/ADVANCED_SETTING_IDS/defaultAdvancedOpen/isAdvancedOpen (no production callers), deexports still-real in-module SettingsSection/SETTINGS_SECTIONS, updates test-only comment. After retirement, new keepers+real settingsUI+m8lower thinking siblings4files24green21.26s, types36f green. No original e2e deleted.
