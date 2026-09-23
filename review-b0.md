# Review B-0 settings tidy-up

Verdict: fail

Reviewed frozen commits `1ab98f909cf16cf343cd1dd7c88780c2b237c3b3` (settings) and `18220a0bcca057769f50a8d9ebcb3efbee5e1932` (library), merged at `afa0f65e6ffb1909147658726a85818a52d8209f`. Program checks `check-types`, `check-settings-rules`, and `check-library-rules` all exited 0. Those checks only exercise exported data and pure helpers, so they do not cover the UI defects below.

## Findings

1. Concurrency limits are not default-collapsed, and the page does not keep that state.
   - `src/web/Settings.tsx` renders each advanced region as a native `<details>` with `open={setting.defaultCollapsed ? undefined : true}` (around the `ADVANCED_SETTINGS.map` block, lines 886-890 in the merged file).
   - React omits `open={undefined}`, so the element is uncontrolled. The first visit happens to be closed, but after the user opens it, any parent re-render leaves the native open state untouched. Saving a limit calls `mutate` → `setDraft`, which re-renders this page while the user is on it. There is no `useState` for the fold, and no `onToggle` handler.
   - The task required component state, not persistence, and explicitly said the region starts collapsed. The exported `defaultCollapsed: true` flag is never stored as component state, so the acceptance item is not implemented.
   - Impact: the fold does not behave as a default-collapsed controlled section. A later render cannot restore the required closed default, and the implementation diverges from the specified state model.

2. Resource library grouping does not cover the page that actually has configured / unconfigured items, and the guidance can be blank.
   - The new filter and two group headings are rendered only in the `active.items.length` branch (`src/web/ResourceLibrary.tsx` around lines 680-724).
   - The dedicated 配置 page is an earlier branch (`active.id === 'config'`) and still renders `CapabilityConfigPanel` unchanged (around line 678). That panel is the one that already labels entries 已配置 vs 缺少 N 项 / 清单不可读. It has no 已配置/未配置 groups, no 全部/已配置/未配置 filter, and no group counts.
   - Skills / MCP / Pi extensions / Graph extensions / prompt identities do get the new UI, but `capabilityIsConfigured` treats a missing config view as configured (`return config ? config.ready : true`). `capabilityConfigViews` only returns entries that have fields or an error, so ordinary skills with nothing to configure are classified as 已配置. Invalid manifests are classified as 未配置, but `capabilityConfigGuidance` returns `''` when status is `available` and `missing` is empty. The UI always prints that string, so an unconfigured entry can show an empty guidance line.
   - The new test only calls the pure helpers with synthetic records. It never checks that the 配置 page, or any rendered section, consumes the split. It also does not assert the empty-guidance case.
   - Impact: a user looking at the resource page whose items are already marked configured or not configured still sees the old flat list. On the catalog sections that were changed, unconfigured entries are not guaranteed a how-to-configure hint. This misses acceptance item ③.

## Checked and not treated as defects

- Navigation order is exported as `SETTINGS_SECTIONS` and consumed by the sidebar: 通用/偏好 → 常规 → 模型 → 高级设置 → Git 准备 → 归档对话.
- The old independent concurrency `Card` is gone from the model page. The credential-reference card was left in place, which matches the B-0 exclusion.
- Limit field test ids, `limits.credentials` / `limits.sharedGroups` writes, and the existing auto-save path are unchanged. The immediate-effect copy remains, now as the disclosure hint.
- No new vendor platforms, model-list fetching, metadata automation, or usage overrides were added.
- Library selection still uses the existing `resource-entry-${id}` button and `setSelected`. No `agent-context-*` or `agent-tool-*` test ids were removed from this file.

## Check evidence

- `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json`: exit 0.
- `/Users/macmini/Library/Application Support/Graph/state/checks/check-settings-rules.json`: 6 tests passed.
- `/Users/macmini/Library/Application Support/Graph/state/checks/check-library-rules.json`: 7 tests passed.
