# Control coverage: every button has a witness

A journey proves a feature works. Control coverage proves the individual
controls inside it were really driven. This file is the cold-start path: how to
list controls, how to judge whether one has a witness, and how to add one.

Run every command from `verification/`.

## The three files

| path | who writes it | what it is |
| --- | --- | --- |
| `controls/inventory.json` | `cover inventory` | every interactive control of the stable UI: `name`, `role`, `page`, `feature`, `bounds`, `requires` |
| `controls/ledger.json` | `cover derive` + a human | one conclusion per control: `witnesses[]` (covered), `notApplicable[]`, `blocked[]` |
| `controls/COVERAGE.generated.md` | `cover audit` | generated table of every control and its single conclusion; never edit by hand |

`CONTROL_COVERAGE.md` at the verification root is the human report; the JSON
files above are the machine truth.

## List every control

```sh
verification/verify-graph launch
verification/verify-graph ui motion open --run <run>            # a real window on that run's daemon
verification/verify-graph ui motion tree --run <run> --out pages/settings.json
verification/verify-graph cover inventory --ax pages/settings.json --page settings --feature F-14
verification/verify-graph cover inventory --run <run>           # or ingest every AX dump a window lane left
```

`cover inventory` may be called once per page; it merges and dedupes by
`page + role + name`, so a control that appears on every page is one row, not
twenty. The page is a stable location (`rail`, `tabbar`, `composer`, `panel`,
`tray`, `window`, or the feature that owns it), never the journey that happened
to see it.

Read the inventory as a list:

```sh
jq -r '.controls[] | [.page, .role, .name, (.feature // "")] | @tsv' controls/inventory.json
```

## Judge one control

Every row in the inventory must end with exactly one conclusion:

- `covered` — a journey has a real `click` / `type` / `key` step for that
  control **and** a later assertion that observes a visible result. Waiting for
  the clicked label itself does not count (it was already there). A green
  evidence directory for that step must exist, and a menu/tray control may only
  be proven in the `window` / `surface` lane.
- `not-applicable` — with a concrete reason: one-off dialog, external app,
  unreachable state, or a locator that cannot be stable.
- `blocked` — with both a reason **and** a next step (`next`).

`unknown`, an empty verdict, a stale ledger entry, or two conflicting
conclusions are audit failures, not conclusions.

Ask the audit:

```sh
verification/verify-graph cover audit
verification/verify-graph cover audit --require-all-covered   # stricter: blocked is not enough
```

The JSON envelope carries `total / covered / notApplicable / blocked` plus
`problems[]`; `controls/COVERAGE.generated.md` carries the same table for a
human. `data.problems[].code` tells you what to do:

| code | meaning | fix |
| --- | --- | --- |
| `unowned-control` | no witness and no exclusion | drive it in a journey or add an exclusion |
| `witness-unproven` | the claimed journey step/assertion/evidence does not prove it | read the detail, rerun that journey, or fix the ledger |
| `duplicate-conclusion` | two ledger entries claim the same control | keep one |
| `exclusion-without-reason` | not-applicable/blocked without a reason | write the concrete reason |
| `blocked-incomplete` | blocked without a next step | say what the next agent should try |
| `stale-witness`, `stale-exclusion` | the ledger names a control the inventory no longer has | refresh the inventory, then delete the entry |

## Add a witness

1. Write the action **and** the observation into a journey step or a new
   `scenarios/*.json` journey. The action must use the control's accessible
   name (`click` / `type`), and the assertion must come after it and observe
   something that changes (`waitText`, `assertText`, `assertNoText`,
   `assertAccess` with a value, `assertSurfaceText`, `assertWindowVisible`).
2. Run it for real and keep the evidence:

   ```sh
   verification/verify-graph verify --journey F-13
   verification/verify-graph verify --journey F-13 --lane window   # for menus, tray, focus, keyboard
   ```

3. Derive the witnesses from green runs (it never overwrites a manual entry):

   ```sh
   verification/verify-graph cover derive
   ```

4. Re-audit. If the control still has no green journey, either write the
   ledger entry by hand:

   ```json
   {"name": "管理供应商", "role": "button", "page": "rail-settings",
    "action": "click", "journey": "controls-settings", "step": 4}
   ```

   or classify it honestly:

   ```json
   {"name": "打开资源库文件夹", "role": "button", "page": "F-12",
    "reason": "opens Finder, an external app the isolated run cannot observe"}
   ```

5. `cover audit` must be green before `verify --all` is called done.

## Gotchas that cost runs

- A control whose AX name changes with state used to be two rows. After the
   accessibility fixes the name is stable (`30 天`), and `AccessSelected`
   carries selection; if a control still exposes two names, drive the
   unselected one and assert the selected label appears, do not click the
   already-selected one and call it a witness.
- When the headless tester's hit-test cannot reach a control that the real
  window can (for example the labelled `main agent 会话` card), mark those
  steps `"skipInHeadless": true` and prove the journey with `--lane window`.
  The headless run records them as skipped; the audit still accepts the window
  evidence.
- Panel header buttons (`在新标签页打开`, `移除`) exist on every board panel; the
  inventory dedupes them by page, and a journey must navigate to the page it
  means before clicking.
- Some buttons open an external app or a Finder window (`打开 Magpie 配置`,
  `打开资源库文件夹`, `打开装配文件`). That is not reachable evidence; mark it
  `not-applicable` with the external-system reason.
- A click can succeed and change nothing (toggle already in that state). The
  `ui motion press` warning `changed nothing` is the signal: that is not a
  witness. Add an assertion for the *other* state.
- The inventory is a snapshot of one real window. Rebuild it after a UI change;
  otherwise the audit will defend controls that no longer exist.
