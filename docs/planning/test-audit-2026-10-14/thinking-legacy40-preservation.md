# Independent historical thinking fixture preservation review 40

Read-only review. No repository files changed, no Vitest or daemon launched. Reviewed draft test, plan, full manifest (programmatically every entry), prior preservation39 report, remaining original two thinking declarations, current UI owner/callers, historical runtime options producer and archive generator. Inspected previously executed structured shared-layout probe evidence without reclassifying it as a new root Vitest result.

## Verdict

**Valid genuine compatibility E2E design; conditional approval for cutover after root integration/positive runs/mutation controls.** Current built browser talks to an actual archived production CLI/settings producer, with real config loader, persistence/startup, HTTP/auth and current rendering. No replacement JSON settings server, response interception, patched historical code or fabricated owner output. The whole two-row test file can be routed as E2E once the actual integrated file passes and cleanup below is addressed. It proves historical settings display compatibility only, not current native model execution or historical dependency/model transport compatibility.

The sizeable archived source is justified by the explicit retained older-server/no-field and provider-spelling compatibility contracts; replacing that owner with hand-coded settings would weaken the requested E2E boundary. This is **not a test-support size reduction**: count the real archived executable source and binary payload. Do not present the removal of two helper declarations as substantial total support shrinkage.

## Independent archive provenance verification

I opened the three actual /tmp tar.gz files, checked every manifest archive digest/size, enumerated member types/counts, read every archived file, and compared each version-file with `git rev-parse <revision>:<path>` and `git cat-file blob <blob>`.

| Archive | Actual members | Compressed bytes | SHA256 |
|---|---:|---:|---|
| common | 87 | 771938 | bc21113a40b1100254ec21d2ec5181c85a1e99284450693f4d8061b21f90bdb5 |
| missing-field overlay | 5 | 53619 | 9db8c5f3613b1f67958e96393a999397f69f071e211685d8221bca92cafdf302 |
| provider-none overlay | 8 | 59535 | 5d31c629b014a301e375e601f2c1294d4afd55fad29b160bf0434817d2abe6f7 |

All100 archive members are regular files; no archive symlink/device/directory members. Both reconstructed file inventories92/95 match their manifest. All187 version-file records match original commit/path Git blobs, SHA256 and byte lengths byte for byte; **zero discrepancies**. Shared files are actually identical. Unique `(path,content hash)` entries100; total885092 compressed bytes; historical executable `.ts/.mjs/.cjs/.js` newline LOC **30673**. This is independent content/origin verification against local Git, not a digital publisher signature. Runtime SHA checks protect the frozen reviewed fixture content; runtime need not require historical Git objects.

Exact producer revisions:
- missing-field: 582f21eec92d5fc8e8b8609b60fde2d5a6d54c78
- provider-none: 184e5f579b89d4a3887213faa1fb7ee66e2d82c6

No requirement to archive unused docs/tests follows from this narrow read path. Static dependency closure and prior replay evidence establish this subset can serve the exercised settings flow; they do not establish that every unexercised CLI action is distributable with this subset. State that scope in README.

## Remaining original declarations

1. `a payload without the field keeps the fallback levels, never off` -> **C** first historical row. Direct HTTP positive guard proves genuine model medium and literal absence of thinkingOptions. Current visible slider then proves minimal/low/medium/high, medium current, disabled false and therefore no off. This tests the intentional old-server fallback branch that an unknown *current* model with an explicit list cannot reach. Mutation must change current thinkingView fallback, rebuild current UI and fail the first row's literal browser inventory; archives remain immutable.
2. `levels are shown in the model own vocabulary, never translated` -> **C/D**. Current genuine13-row browser owner already carries high/xhigh/max and other live vocabulary. Historical second row's actual public options include off label none, and current browser asserts provider spelling none both in labels and current. Mutation to prefer option.level rather than label must fail exact none guards after current rebuild. The direct off-format identity example is represented by actual option level identity and provider vocabulary rather than requiring fabricated current off-enabled catalog metadata. `thinkingLabel(undefined)->—` is **D** according to the separate caller/history analysis in preservation39; keep formatter defensive source and do not claim undefined/em-dash E2E proof. Root has already carried current nearest-stronger and persisted stale-level fallback separately; this historical fixture need not repeat native sends.

## Cleanup findings to address before integrated proof

1. **Final kill wait remains unbounded:** stop() waits6s after SIGTERM, then SIGKILL followed by bare `await exited`. Add a bounded final wait with explicit process/PID diagnostics; otherwise a failing compatibility child can wedge the suite even after the promised stop deadline. Startup catch uses same stop() so applies there too. Plan itself already flags this; draft has not implemented it.
2. Nested finally ensures browser failure still stops child, and child failure still closes vendor/removes home; good. But cleanup failures replace the primary assertion error. Preserve the original failure while attaching cleanup diagnostic(s), or let test framework report both via an AggregateError. Do not swallow a teardown deadline violation and claim successful cleanup.
3. Child env currently spreads process.env. Prefer an explicit small environment (PATH, isolated HOME/TMPDIR plus GRAPH_LEGACY_LOCAL_KEY and platform essentials actually needed). Inherited GRAPH_CONFIG/GRAPH_STATE_DIR are overridden by flags, but optional GRAPH_CODEX_AUTH_PATH/GRAPH_GROK_AUTH_PATH and provider env entries need not be inherited for these deterministic local read flows. This is fixture isolation, not a request for new permissions or a broad production env redesign.
4. `tar -xzf` operates after reviewed archive SHA validation and current archives contain regular safe members. Current path validation only checks declared manifest files, not every tar member at runtime. Because fixture bytes are pinned and independently enumerated, this is not a present malformed-archive bug. Preserve regular/safe member validation in offline regeneration; optionally verify tar listings/counts in fixture maintenance rather than adding multiple redundant runtime tests. Never silently skip if fixture unavailable.
5. beforeAll rebuilds current UI once per Vitest invocation and cleans temp root after failed build; afterAll removes archived source, symlink and web output. This is necessary for real current-source mutations to reach browser. Controls must run separate fresh builds; reusing an already built bundle would invalidate failure claims.

## Maintainability/distribution

Commit the three frozen archives, readable manifest and a concise README that gives exact commits, source-only read-flow subset, source+archive digests, shared-overlay reconstruction and deterministic generator command. Ship the reproducible generator or sufficiently complete authoring recipe; /tmp-only author scripts are not durable maintenance provenance by themselves. Generation may require Git history, execution must not require Git/network/pnpm install. Avoid installing obsolete dependencies. Current installed Pi0.86.1 against archived declared0.85.1 is an intentional tested read-flow compatibility arrangement; a future startup import break must fail explicitly, not modify archived production bytes or silently skip.

Report separately: current test/helper LOC, live production LOC, archived historical source LOC30673, binary885092 bytes plus readable metadata/docs. Source frozen inside compressed tar still counts as executable fixture support. Future current source changes do not require rearchiving; only explicit compatibility-fixture maintenance should change immutable files. The current minimal100-file closure is large because production CLI imports are broad, not because arbitrary archived tests are retained. This review does not propose extracting new production seams solely to shrink it.

## Execution evidence boundaries

The prior shared-layout JSON records two actual historical CLI settings200 responses and successful current Chromium render inventories/current/labels with pageerror[] and empty stderr. It supports feasibility of exact final archive topology. It does not prove the unexecuted draft's new live vendor listener/cleanup helpers, runtime tar extraction on every OS, integrated beforeAll/afterAll behavior, or current mutation sensitivity. Root must run integrated keeper and current source controls after cleanup corrections. No full test-suite, coverage<=2%, total reduction or goal-completion claim follows from this narrow review.
