# 0045 所有 Agent 共用一个完全访问的执行面

## 状态

已接受，已实施。

## 背景

「沙箱」在这个仓库里曾经是两套东西：一套是 Apple 的 `sandbox-exec` 配方（读写授权、受保护路径、
网络例外），另一套是「标准访问」这层更严的档位——工作副本里只许读、只许跑只读 git，`node -e`
这类内联求值一律拒绝。两套配方分别对应 `ValidateWorkspaceCommand` 与 `newSandboxExecutor` 里的
一长串 `canonicalGrantAll` / `ProtectedPaths` / seatbelt profile 文本。

这条路走到后面有三个代价：

1. **它不成立。** 主 Agent、线程 Agent、图节点、subagent 四类执行者里，只有一部分走严格档位，
   另一部分（`hostCommands := true` 那条分支）本来就在宿主身份下跑。同一句 `bash` 工具在一个
   Agent 里被拒绝、在另一个里放行，用户和模型都没有稳定预期。
2. **它的实现比它保护的东西还难懂。** 策略分支、例外清单、git 元数据特例加起来近 600 行，每加
   一个合法用法就要再开一个例外口子。真正要防的事（Agent 越权改别人的工作副本）另有机制：
   「离你节点的文件列表远一点」这条规则写在 prompt 里，边界由 `git` 的 diff 与文件清单判定。
3. **它挡不住它声称要挡的。** 检查命令要跑真实的 `go test`、要起守护进程、要读用户级缓存，
   这些在严格档位里全是被拒的，于是 check 节点常年靠「换一个能跑过的低层测试」交差——
   `docs/agent/graph-v2.md` 里专门写了一整段来劝退这种做法。

`git log` 里已经有一次落地的裁决：`36b3a070 删掉沙箱：命令直接以宿主身份执行` 删掉了
`runtime_restricted_policy.go`（193 行）与 `runtime_restricted_network.go`（149 行）。但那次删除
留了尾巴：`ReadPaths`/`WritePaths`、`localNetwork`、`gitMetadataWritesInsideScratch` 这些字段还在
被传递、被赋值，只是再没有读者；`ValidateWorkspaceCommand` 与它的只读 git 白名单还在，被
`hostCommands := true` 这条死分支挡住，永不执行。

## 决策

**一个执行面，访问策略固定为完全访问。** 不引入新的沙箱实现，也不保留"更严"的第二档。

1. `OpenWorkspaceCommandRunner` 与 `AcquireRestrictedExecutor` / `OpenRestrictedExecutor` 是同一条
   路径：`sandboxExecutor.Run` 用 `/bin/bash -o pipefail -c exec …` 原样执行解析后的命令，工作目录、
   scratch、环境变量之外没有额外约束。四类 Agent 全部经由 `WorkspaceCommandRunner`，没有第二个构造
   函数，也没有按 Agent 类型分叉的判断。
2. 只为授权存在的代码全部删除：`ReadPaths`/`WritePaths` 字段与它们的传递链、`grantsScratch`、
   `canonicalGrantAll`、`resolveAll`、`containsPathOrSubtree`、严格档位专用的 `workspaceReadOnlyGit` /
   `workspaceInlineNode` 白名单与 `ValidateWorkspaceCommand`。
3. 保留的不是策略而是**进程纪律**：子进程在独立进程组里启动（`Setpgid`），结束、超时、取消时
   `kill(-pgid)` 整组回收；退出前写 quiescence 收据。这些跟「允许访问什么」无关，删掉会漏进程。
4. 验证方式是行为断言，不是读代码：同一份宿主文件在默认策略下可读、可执行、可写落地
   （`TestTheOnlyExecutorRunsWithFullAccess`）；工作副本 runner 不再有拒绝分支
   （`TestTheWorkspaceRunnerHasNoStrictAccessBranch`）；两个入口交出的是同一种执行器
   （`TestEveryAgentUsesTheSameExecutorConstructor`）。

## 与 CubeSandbox 的关系

CubeSandbox（TencentCloud/CubeSandbox）是 Linux 侧的容器沙箱，它的价值在**真隔离**：独立内核
命名空间、可丢弃的文件系统、能跑不受信任的多租户代码。本仓库不需要这些——Agent 改的是用户自己的
仓库，隔离会同时挡住它该做的事（读用户缓存、起守护进程、跑真实构建）。

所以这一版**不引入 CubeSandbox，也不引入任何容器运行时作为命令执行层**。理由与 ADR 0041 一致：
极简、稳定、快、占用小。多一个运行时就是多一份安装负担、多一条版本组合、多一个会让
「拷到别的机器能不能一样用」失效的变量。

将来若真需要隔离（在共享机器上跑陌生人的图、或以服务形式跑不可信代码），插拔点已经在这里：
`RestrictedExecutor` 接口只有 `Run(RestrictedCommand) CommandResult` 与 `Close()` 两个方法。
一个容器后端实现它，在 `OpenRestrictedExecutor` 这一处换掉即可，调用方（四类 Agent）无需改动。
**在那之前不写这层空壳**——没有真实使用者的可插拔层只是多一份要维护的假设。

## 后果

- 「一视同仁」成为可断言的契约：命令在哪个 Agent 里跑，结果只取决于命令本身，不取决于发起者。
  check 节点可以真的运行该节点该跑的那条检查，不必再降级成一条跑得过的低层测试。
- 删掉约 700 行策略代码与它们的例外口子；新增行为只剩进程组回收与 quiescence，两者都有测试。
- 代价：Agent 能读写进程身份所及的一切。这是有意的——它和用户在同一台机器上、同一个账号下，
  用文件权限区分 Agent 与人并没有真实边界可言。真正的边界是「这个 Agent 被允许改哪些文件」，
  那条由任务图的文件清单和 diff 审查承担，不由命令执行层承担。
- 代价：如果将来出现「必须隔离」的场景，第一次真的需要它会重写这一层——但插拔点在
  `RestrictedExecutor`，不在调用方。

## 后续修正

同一轮里 `host-command-worker.mjs` 也被删除：宿主命令原本经由一个 55 行的 Node worker 用
JSON-over-stdio 协议转一手，而它做的事（`spawn` + `detached` 进程组 + 转流 + 杀组 + 回 exit code）
全部是 Go 标准库已有的能力。删掉它之后，Agent 的 shell 命令这条链路上不再需要 Node，详见
ADR 0046。
