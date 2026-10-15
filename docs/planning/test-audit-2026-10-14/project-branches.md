# Branch naming owner cutover

Baseline 11 direct-helper/source-inventory declarations in tests/m3/branch-naming.test.ts; 3 project-branch UI helpers. Full owners branch-naming/pinyin table + GitIntegration prepareTask/workspace and browser shared useTargetBranch read; callers/history8121a83 inspected. Remaining proof tests/e2e/project-branches.test.ts first scenario passed parent batch4 at actual public graph creation -> Git integration branches/worktrees -> native Pi dispatch -> actual workcopy branch/retained occupied path.

## Declaration decisions

C offline pinyin mappings: real Chinese task branch names, unknownHan real branch remains readable. D table size>400 and arbitrary ASCII pinyin lookup are implementation inventories; exact real Chinese known expectation retained.
C Chinese summaries: three real named graph integration refs.
C mixed Latin/digits/punctuation/unknownHan: five graph rows, fixed independent expected slug.
C branchsafe/bounded: real long Chinese graph creates a 40character slug and Git check-ref-format accepts all observed refs. D same input self-comparison/idempotent helper replay duplicates names owner.
C short IDs: actual runtime-created graph UUID prefix independently observed in real branch, directories and native workcopy. Empty/nonUUID IDs cannot originate from real graph and have no user API contract.
C branch/worktree naming: public graph record, actual Git branch, on-disk directory and actual worker branch all asserted.
C collision: sameChinese summary twice creates distinct Git branches and paths, all10rows unique.
C reuseddirectories: owner lists actual occupied disk dirs, real native workcopy uses suffix; original passedworker-2 plus new fixtureworker/worker-2/worker-3 now requiresworker-4 (await next validation), original sentinel remains untouched.
D integration source/import grep: real integration owner behavior strongest proof.
D no pinyin package inventory: implementation dependency choice not independent runtime user contract; offline known mapping proven actual Git flow, no external pinyin access needed.

Original branch-naming suite retired after native first candidate passed; new suffix4 assertion awaiting next validation and no claim fully final. Project-branch3 originals retained while actual browser default proposal failed invalidfixture acceptanceempty; corrected to real valid human acceptance criterion and wait actualdraft v1; await nextcandidate. Fallback prepared-only/unknown branch compatibility needs real browser transport fixture before retiring those3.

No production source changes needed; branch helper exports all still real GitIntegration callers. Empty summary cannot become graph definition; do not invent internal entry hooks to replay unreachable helper inputs.

## Product defect discovered in genuine browser keeper

Batch5 real proposal/browser main branch unexpectedly 'main' even though actual repo HEAD feature/current. Public settings project DTO came from user.projects() with only id/root/grants/preparation and no live branch; newly started daemon had no preparedsnapshot, so pure helper tests imaginary branch field had missed wiring regression. Repair user.projects real checkedOutBranch(root) readonly projection while keeping preparation and nullable fallback. Public settings API and same browser confirmation assert actualfeature/current independently; user editsrelease/manual still authoritative. First failing browser proof /tmp/graph-test-audit-owner-batch5.log; candidate/control awaited root. Original projectbranch3helpers still retained until fallback honest browser/API proof.

## Final branch batch proof

Parent /tmp/graph-test-audit-owner-batch6.log: real current-branch browser and nativeGit names passed after DTO projection repair. Parent /tmp/graph-test-audit-owner-batch7.log: all4branchcases passed under parallel load (native names + current/prepared-detached/unknown-detached browser rows), paired genuine composer lifecycle3cases,7passed10.97seconds. Old project-branch3declarations retired: currentbranch primary proofactual repo/API/browser, preparedfallback proofactual preparedrepo then detachedHEAD/API/browser, no trustworthy branch proofactual detached unpreparedrepo/API/browser fallbackmain. Null project helper input is unreachableconfirmation until projectbound; actual guard exists in current browser, no seam added. defaultTargetBranch kept because real useTargetBranch caller. Test-only seams removed: none. Sourcebug firstredbatch5/greenbatch6 and fullfixtureparallelbatch7 recorded separately from testpruning.
