# laneC evidence — P4 探测上下文 + P9 配置口径与写保护

基线 `df871afb`（laneA/laneB 已合流）。本目录只放可复现的运行输出，不改任何源码。

## 命令

```sh
# 两个 keeper（先红后绿用的是同一份文件、同一台机器）
node node_modules/vitest/vitest.mjs run \
  tests/e2e/go-desktop-permission-context.test.ts \
  tests/e2e/go-provider-api-vocabulary.test.ts
```

红色输出取自**未改产品代码的 df871afb**（`git worktree add --detach /tmp/laneC-red df871afb`，只拷入两个新测试文件）：
`red-baseline-df871afb.txt`。绿色输出取自本车道树：`green-laneC.txt`。

## 先红（基线 df871afb，实测原串）

| 用例 | 实际看到的 |
|---|---|
| P4 上下文 | `expected error.details.executionContext on the host refusal; got {"accessibility":"denied","checked":"agent-desktop permissions","source":"graph-desktop-tool"}: expected undefined to match object { sandbox: false, …(3) }` |
| P9 目录 | `the catalog still offers chatgpt as usable: {"id":"chatgpt",…,"notes":["…真实补全与工具调用均已按此传输实测。"]}: expected undefined to be true` |
| P9 记录 | `the catalog still presents chatgpt as a usable platform: expected undefined to be true` |
| P9 线上配置 | `expected the live configuration write to be refused; got 200 {"revision":1,…,"applied":true}: expected 200 to be 400` |

P9 的第四条（`api: "responses"` 被拒并点名三个可用值、文件字节不变）在基线就是对的——它是既有语义的 keeper，
本次只保证不被放宽（`server_config_parse.go` 的拒绝分支一行未动）。

## 后绿（本车道）

```
✓ tests/e2e/go-desktop-permission-context.test.ts (1 test)  1699ms
✓ tests/e2e/go-provider-api-vocabulary.test.ts    (4 tests) 2111ms
Test Files 2 passed (2) | Tests 5 passed (5) | Duration 2.23s
```

## 门禁那一层的 11 个失败文件是环境/凭据，不是本车道引入

`node --run check` 在 `check:tests` 停下，报 11 个文件连跑两次失败。同一批文件在**基线树**上以 `--bail=0`
跑出来的结果一致（真机复现命令：`git worktree add --detach /tmp/b <df871afb>`，拷 11 个文件名进去跑）：

```
基线 df871afb：Test Files 11 failed (11) | Tests 30 failed | 2 passed | 1 skipped (33)
本车道     ：Test Files 11 failed (11) | Tests 30 failed | 3 passed | 1 skipped (34)
```

同一批文件、同一个数量级；失败原因是本机能力缺失（seatbelt 内 Electron 必崩、缺真实 Grok/ChatGPT 订阅、
MCP/harness 需要宿主进程），与 P4/P9 的改动无关。逐文件对照见下面两份日志：

- 基线：`gate-11-baseline-df871afb.txt`
- 本车道（`node --run check` 的完整输出）：`gate-laneC-check.txt`

## 静态门禁（本车道全绿）

```sh
node --run check:backend      # 构建通过
node --run typecheck          # 无输出=通过
node --run lint               # No unawaited expect().resolves/.rejects chains found.
node --run check:ownership    # the package writes no owned table outside its owner
node --run check:tokens:changed
# file budget: 14 changed file(s) within the 5,000-token budget.
```
