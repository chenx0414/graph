# Node-workcopy owner audit — read-only during batch16

Read full103lines tests/m8/node-workcopy.test.ts and actual production kernel-graph-lane nodeLocation/nodeWorkspace; history fa630bb HB276. All3declarations invoke a TEST-LOCAL function nodeWorkspace defined atline59, not a production function; fake Git.workspace returns the path value asserted by the tests. Production source is never called. Changing production to shared projectroot could not fail ANY declaration. Strong existing genuine E2E tests/m4/worktrees.test.ts3 use nativeWorktreeGraph actual per-node Pi/Git/disk, including simultaneous left/right writes, nested subdirectory location, two actual integrated contents, actual independent review/check/delivery; these catch the named isolation regressions. nodequeue + native-repair-freeze retain same admitted instance across rounds/reopen and binding configurations.

|Declaration|Mark|Evidence|
|W1 differentworkspaces|D|Mock supplies distinct paths and copied testlocal resolver returns them; keeper m4/worktrees parallel native workers actualdistincttrees+separate filecontents+integrated target.|
|W2 repeat sameworkspace|D|Self-comparison on copied resolver with fakeGit purely computing same deterministic string; no production caller. Actual same instance/real node runtime rework existing native-repair-freeze and native worktree graph retain worktree binding. This declaration never detects production lifetime regression.|
|W3 noGit projectroot|D|Copied resolver hardcodes fallbackproject and directly asserts it; actual noGit public native-repair-freeze uses explicit project paths and native prompt/current environment, actual model files; old standin no formal noGit runtime receipt.|

Retire all3 as junk immediately after root validates existing m4/worktrees/native-repair-freeze owner keeper (no new tests needed),103testLOC reduction,0productionLOC. No productionseam to remove: entire testhelper is local; production location function remains active. This is natural pruning, not moving helper under E2E filename. Existing real E2E files unchanged. No repo edits/tests during batch16freeze.

Rootbatch17 m4/worktrees3+native-repair-freeze1 allpassed; removed3junk declarations/103testLOC testlocalmock resolver,0productionLOC. No newE2E added because genuine strongerkeeperevidence alreadycovers observablecontracts.
