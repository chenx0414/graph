# Agent skills independent preservation review, batch 32

Read-only review: complete tests/console/agent-skills-library.test.ts (3 declarations), complete tests/console/agent-skills.test.ts (2 declarations; only first a cutover candidate), complete tests/e2e/agent-skills.test.ts (2 real CLI workflows), complete src/runtime/agent-skills.ts; catalog/scanner owners read in resource review; relevant capability-bundle, pi-adapter and pi-instance native-load paths, real CLI/provider helpers and settings/raw-catalog HTTP handlers. No tests run and no source/test/routing edits by reviewer.

## Genuine boundary

First keeper starts actual CLI with disk manifests and configured project folders, POSTs real catalog refresh and GETs actual grouped settings plus raw catalog over loopback. Second starts actual executing CLI, posts real main recipes/compilation/conversations, observes SDK request wire through an external OpenAI HTTP fixture, and reads actual disk links after runtime owns creation/retarget/removal. The network fixture supplies vendor responses only; it does not supply asserted skill metadata, prompt structure, mirror ownership or symlink lifecycle. The stub web index is acceptable because these are public CLI/HTTP/native runtime flows with no claimed browser DOM coverage.

## Declaration mapping

| Old declaration | Proposed keeper | Preservation result |
|---|---|---|
| a skill placed in an Agent folder appears in the library with its native fact | actual catalog publishes native folder facts… | C. Exact usable local kind/version/status/owner/name/description; broken local invalid/owner/version plus frontmatter error; bound handoff shown once (symlink not listed twice), available version and disable-model-invocation note. Original full key list is fixture inventory, not an additional user contract; new fixture legitimately contains other entries. |
| skills in a project .pi or .agents folder appear with their project owner | same actual catalog keeper | C with one small carry still needed at source reviewed: repo-skill name:'repo-skill' assertion is absent (old had it); add to existing toMatchObject. All other old kind/local version/status for .agents and exact owner strings for both paths are asserted. |
| same-name skills collapse into one row that names the copies it folded | same actual catalog keeper | C. Grouped settings exactly one notes row, shortest library ID winner, duplicate identities/source labels in original order, and raw GET /api/catalog retains all three identities. These prove view collapse without destroying raw identities across the actual transport. |
| one skills folder per recipe links the bound skills, and hand-made entries survive | real main recipe changes retarget only owned skill links… | C with location carry noted below. Real path graph-home/agents/main/skills receives symlink to v1; next real recipe retargets same path to v2 and prompt changes to v2 without v1; unbind removes only owned link, preserves own real file and external handmade link/target; prompt retains own description and no bound description. This strengthens lifecycle proof via actual runtime producer. |
| the scope loads the Agent folder, the global folders and the project folders | none yet for complete old scope | R. Existing new runtime proof has cwd == projectRoot. Old independently creates cwd workspace and a different projectRoot, requires both directories, and proves absent dirs contribute nothing. Keep this entire old second declaration until a genuine distinct-directory workflow owns it. No routing whole-file E2E while it remains helper-level. |

## Small exact-contract carries before retiring first four

1. Add name:'repo-skill' to the actual settings row assertion, preserving old public catalog display metadata. New id happens equal to name but equality is not a substitute for asserting the actual name field.
2. Original sync declaration asserts specific SDK filePath values for both bound handoff and handwritten my-own, and an exact <location>bound-path</location> prompt fragment. Current new first wire asserts arbitrary occurrence of bound path plus descriptions, but not exact location markup or own file location. Add explicit independently constructed expected <location>…/bound-flow/SKILL.md</location> and <location>…/my-own/SKILL.md</location> strings to first real request. This preserves the real actionable skill location contract and is more useful than checking loaded-array implementation shape.

With these small carries and a root-owned passing candidate, first four declarations can retire. No need to preserve coder specifically rather than main: the contract is per recipe and production helper is join(home,'agents',agentId,'skills'); actual main recipe verifies the concrete canonical path. Do not delete agentSkills/syncAgentSkills exports merely because first test retires: real runtime capability bundle uses them, and retained second test still uses scope.

## Product fix evidence

Current pi-instance combines both options.skillFolder and options.skillPaths before native workspace discovery. Previously the conditional chose skillFolder instead of provided skillPaths, losing explicit host-discovered global paths in sanitized worker env. Root supplied a revert-control failure missing Pi global description on actual request, exact restoration, and 3 files / 7 cases passing at /tmp/graph-test-audit-skills-restored32.log (3.35s). I read that log's terminal summary and source fix; this reviewer did not execute the control or candidate. This is appropriate single native runtime owner regression; no duplicate lower-layer fix test needed.

## Root cutover and discovered defect 32

旧 library3 + owned-links1 的精确 name/description/native location 断言已补入真实 CLI/原生模型 wire；前4声明退休，distinct cwd/projectRoot scope旧sole继续保留。两个新流程通过实际 /api/catalog、/api/settings、配方保存编译、真实 resident Pi/TCP vendor、磁盘链接创建/换版本/移除和三次真实主会话提示，未手造receipt或operation。公共原始catalog保留三个同名身份，settings只显示最短可绑定身份且注明副本来源。

真实流程发现 pi-instance 选择 skillFolder 时丢弃 host 传入的 skillPaths，worker 清理环境后无法重新发现 Pi 全局目录。修改为合并两者再去重，不放宽读授权。候选3文件7项绿4.03秒；同harness仅撤此修复时实际模型请求缺 Pi global description 而红；源码逐字节恢复 SHA f98690ef5b11bcf14f8f40cddcf850fff437eb8b80911a1bc5ae99a3d88b3f53；恢复候选3文件7项绿3.35秒，/tmp/graph-test-audit-skills-restored32.log。携带补全 location/name 后退休候选也在12文件95和11文件80全绿批中通过。此修复只证明当前全局/主会话路径；不声称旧distinct scope已完成迁移。

## Native graph distinct-scope owner defect 35

新增第三测试使用真实CLI/main原生graph_create+graph_send、实际7种独立技能文件与node.workspace.path=work（绑定projectroot不同cwd）。两个隔离row分别全部目录存在与六目录缺失，仅实际skill目录为输入；不SQL、不假agent action、不代理内部owner。记录到的Graph capability facts与SDK原生available_skills的name/description/location分别断言，避免整个prompt metadata碰巧含技能名导致伪阳性。OpenAI completions实际以developer携带系统提示，所以同时读system/developer并只提原生块；不凭空期待system角色。

实际before-f失败暴露两处漏接：nodeSessionRequest未把绑定project根传assembly，能力记录漏projectroot的.pi/.agents；kernel graph worker config只含bound snapshots，清理后的worker环境不能重新发现host Pi全局及projectroot目录，原生提示漏3种技能。修复分别传projectRoot、合并nativeSkillDirs(cwds:[workspace,boundprojectroot])到既有skillPaths；residentLauncher原有grant路径按这些发现的目录授权，不关闭sandbox。候选6文件14项全绿10.82秒，types35通过。撤第一处时仅metadata缺project2红，撤第二处时nativeblock缺Pi-global+project2红；逐字节恢复kernel-node-host SHA06677f6d8ff2abf3f1d71e9f893f3115a3443ea21975fc0c0ec0cd1c5cbaa180、kernel-graph-lane SHA6623029e3d53674d8657be0b1b6fb77af137626d9a54c0006c3feb4501bcd6d2。日志/tmp/graph-test-audit-{scope35-before-f,scope35-candidate,control35-scope-metadata,control35-scope-native-prompt}.log。旧scope sole尚待独立复核与恢复candidate确认再退休。

独立复核scope-preservation35.md确认实际boundroot来自task项目绑定、cwd仍nodeLocation控制；仅已有技能目录进入readonly授权，未改写权限。两个独立control恢复后同harness2文件4用例全绿7.82秒（scope35-restored.log），旧scope sole退休。由此该技能owner原library3+sync1+scope1全部真实迁移完毕。新scope第三keeper没有实际Git worktree variant或显式读取SKILL.md正文，不宣称超出原scope契约的覆盖；仅真实子目录cwd与projectroot不同、原生技能描述与路径及公开metadata已证明。
