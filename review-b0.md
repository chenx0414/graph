# Independent review: B-0 settings tidy-up

Verdict: pass

Scope reviewed at HEAD `d9010f351c7240a5452cf5214c059e7cb53bf8b4` (task branch `graph/task/2cc29f90-72ff-44e7-bc96-087a3b7eff50`). Working tree is clean. Review used the frozen sources and the published check artifacts only; the implementation transcript was not read.

## Checks

- typecheck (`/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json`): `node --run typecheck` exited 0.
- settings rules (`check-settings-rules.json`): `tests/console/settings-sections.test.ts` — 8 passed.
- library rules (`check-library-rules.json`): `tests/console/resource-library-split.test.ts` — 10 passed.
- Neither test file imports playwright, jsdom, listens on a port, or spawns a child process.

## 1. Concurrency limits moved into 高级设置, collapsed by default

`src/web/Settings.tsx`

- `SETTINGS_SECTIONS` is exactly 通用/偏好 → 常规 → 模型 → 高级设置 → Git 准备 → 归档对话 (`settings-general`, `settings-overview`, `settings-models`, `settings-advanced`, `settings-git`, `settings-archived`). The sidebar renders that array; there is no top-level 并发限制 nav item or `settings-limits` section.
- The model page (`active === 'settings-models'`) still has the 凭据引用 card and the 模型 card. The concurrency card is gone from that page. Credential merge into model entries was correctly left for B-1.
- `ADVANCED_SETTINGS` contains one region, `settings-limits` / 并发限制, with fields `limits.credentials` and `limits.sharedGroups` and `defaultCollapsed: true`.
- Collapse is controlled, not a native `<details>`: `useState(defaultAdvancedOpen)` starts from `{}`, the header is a `<button data-testid="advanced-setting-toggle-settings-limits" aria-expanded aria-controls>`, and the body is `hidden={!open}`. CSS also forces `[hidden] { display: none }`. The remaining `<details>` elements are the per-credential shared-group disclosure and the per-model advanced disclosure; they are not the concurrency card.
- Field writes still go through `mutate` → `scheduleSave` → `POST /api/config` with the whole draft, so `limits` is still saved. The summary still says 保存后立即对新请求生效；已有调用保留计数，不会中断在途请求.
- That sentence matches the existing runtime, which this batch did not change: `start.ts` `applyConfigNow` calls `live.apply` then `scheduler.wake()`; `model-scheduler.ts` `wake()` only drains waiters; `grant()` increments the in-flight counter and the release closure decrements it. A saved limit is re-read on the next grant (`refresh`), and an already granted slot is not aborted.

## 2. Resource library split

`src/web/ResourceLibrary.tsx` and `src/web/resource-library.css`

- Catalog sections (skills / mcp / pi-extensions / agent-md) call the shared `splitLibraryEntries` and render 已配置 then 未配置, with a 全部/已配置/未配置 toggle and both group counts.
- The 配置 view (`CapabilityConfigPanel`) uses the same function and the same `LIBRARY_FILTERS`, shows both group titles and counts, and puts 未配置 first. It does not keep a second grouping implementation.
- `configGuidance` always returns a non-empty string. Missing env names produce a specific hint; an empty `missing` list falls back to「需要配置：到设置页连接模型或保存对应凭据；保存后立即生效。」. Unconfigured rows in both views render that helper. The pure test asserts every unconfigured entry's hint is non-blank after trim, and that both views call `splitLibraryEntries`.
- Selection is unchanged: catalog rows still `setSelected(item)` and keep `data-testid="resource-entry-<id>"`. Config rows still save/verify through the existing button. No backend files were changed for this batch.
- Styles for the split live in `resource-library.css`, which the page imports. `styles.css` only gained the advanced-setting collapse rules.

## 3. Explicitly out of scope

No new vendor platforms, model-list fetch, automatic metadata, or usage override was added. The model page still offers only the existing OpenAI/Anthropic protocol options inside the pre-existing per-model advanced disclosure. No new dependency was added.

## Residual notes (not acceptance failures)

- The library filter is one piece of state shared by the catalog list and the 配置 view, and `App.tsx` keeps `ResourceLibrary` mounted across `#/catalog/...` because the page key is the pathname prefix. Switching section can therefore carry the selected filter. Both views still expose the three-state control and counts, so the required filter remains available.
- The pure tests assert exported data and helpers, not a rendered DOM. The JSX above is what actually consumes those helpers (`aria-expanded`, `hidden`, both `splitLibraryEntries` call sites, guidance text nodes). Human acceptance is still the place that confirms the live console.

No defect found that breaks the B-0 acceptance criteria.
