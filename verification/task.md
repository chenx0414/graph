# 愿望：把第二轮收口到可提交

第二轮已经做到 23/23 headless、23/23 真窗口、测试通过，但还不能提交。`FINAL` 和 `VERIFICATION_REPORT.md` 是第二轮基线，不是最终状态。

现在只做收口，不扩展功能：

1. 让仓库门禁真正变绿：`go -C backend run ./cmd/graphcheck tokens --changed` 必须通过。超过 5000 token 的文件要么拆小，要么用仓库允许的 `graph:allow-large-file` 指令说明理由；不要为了过门禁删证据或放宽断言。
2. `verification/cmd/verify-graph/runs.go` 目前 547 行，超过仓库 500 行源文件上限；拆到 500 行以内，行为保持不变。
3. 重新跑一次 headless `verify --all` 和一次真窗口 `verify --all --lane window`，两次都必须全绿；把**这两次的证据目录保留在 `verification/evidence/`**，并在 `VERIFICATION_REPORT.md` 里写真实存在的 runId、证据路径、文件数。
4. 更新 `FINAL` 为最终一次全绿结果；旧的、指向已删除证据的路径必须从报告里移除或改正。

仍然只写 `verification/`，不要 git commit，不要碰用户实例。完成后写新的 `FINAL`，captain 只验收和提交。

## 收口确认（captain，2026-11-17 16:01）

captain 已确认：

- `graphcheck tokens --changed` 通过；
- `go test ./...`（verification）通过；
- `runs.go` 494 行；
- 报告 §1 引用的 headless `a8290242`/`e353d253` 与 window `6473fb09`/`c0405509` 证据目录都存在，`evidence verify` 可复核。

不要再跑任何 verify 或改代码。现在只做：把 `FINAL` 覆盖为最终一次全绿结果（headless + window 两个 run），然后结束。
