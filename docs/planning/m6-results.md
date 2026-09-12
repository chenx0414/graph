# M6 执行机制验收

日期：2026-09-12。对应 [实施计划 G16](../implementation-plan.md#m6-执行机制验收) 与验收矩阵 A01–A12。基于 M5 的提交 `989d8c5`。本轮不增加产品功能，而是用真实磁盘 SQLite、临时 Git、macOS 受限进程和 scripted 模型/MCP 响应，把已有机制验收收成一份可重复报告，并补上跨模块故障注入。

## 可运行结果

```sh
pnpm test:m6
pnpm check
```

最终复验中 `pnpm check` 通过：TypeScript 检查及 24 个文件、105 项测试，其中 M0 27、M1 22、M2 27、M3 8、M4 9、M5 8、M6 4。`git diff --check` 无格式错误。不读取项目 `.env`，不调用收费模型。

## 通过范围

| 项 | 值 |
| --- | --- |
| 平台 | Darwin arm64（macOS） |
| Node | 24.20.0（项目 `devEngines` / `node_modules/.bin/node`） |
| 包管理 | pnpm 11.19.0，`pnpm-lock.yaml` 锁定 |
| 命令 | `pnpm typecheck`、`pnpm test`、`pnpm test:m6` |
| 存储 | 真实磁盘 SQLite WAL+FULL；临时 Git 仓库 |
| 执行 | scripted Agent adapter；程序检查可走 `openRestrictedExecutor`；Pi 契约见 M0/M3 |

改实现后应重跑受影响的 `tests/mN` 与 `pnpm test:m6`，再跑 `pnpm check` 做回归。不以截图代替机制证明。

## G16 故障注入

| 场景 | 证据 |
| --- | --- |
| 重复命令与重复报告 | `tests/m6/faults.test.ts` 相同 `requestId` 返回原回执；已结算结果再报冲突 |
| 未知用量与副作用 | 写入 `feature.txt` 后缺 usage；重启不重写；用户补用量后沙箱检查并合入 |
| 杀 worker、旧代次、目标前移 | `tests/fixtures/m6/crash-git.ts` SIGKILL；`stale_generation`；核对后集成副本；目标新增提交触发重检 |
| HTTP 后台停开 | `tests/m6/host.test.ts` 关闭 `openGraphServer` 再打开，暂停仍在，游标续接，begin 幂等 |
| 单所有者与 SIGKILL | `tests/m1/recovery.test.ts` 硬杀释放所有权；旧 generation 报告被拒 |

程序检查在 M6 故障用例中通过 macOS sandbox 读取工作副本中的 `feature.txt`。scripted MCP 的 stdio 与写限制证据仍在 `tests/m0/restricted-process.test.ts`。HTTP 停开是 `openGraphServer.close()` 后再打开；OS 级 SIGKILL 见 `tests/m1/recovery.test.ts` 与 `tests/fixtures/m6/crash-git.ts`。矩阵 A01–A12 由 M0–M5 既有测试加上本轮故障注入共同证明，不是为每一行新写一遍 Web 流程。

## 验收矩阵 A01–A12

A13（MediaBookmarks 真实交付）属于 M7，本轮不宣称通过。

| 编号 | 行为 | 本轮证据 |
| --- | --- | --- |
| A01 | 需求确认、单任务队列、新增功能另建任务 | `tests/m1/task-runtime.test.ts` 队列与确认；`tests/m3/planning.test.ts` 新功能排队；`tests/m5/http.test.ts` HTTP 确认与队列 |
| A02 | Agent 库版本、模型不参与身份、实例/节点一一对应 | `tests/m3/catalog.test.ts` 同定义不同模型；`tests/m3/models.test.ts` 换模型保留 `instanceId`；`tests/m2/loops.test.ts` 返工沿用实例 |
| A03 | 顺序、条件、并行汇合、主管-工人、评估优化 | `tests/m2/templates.test.ts` 流水线/扇出/路由/主管-工人/评估优化；`tests/m2/graphs.test.ts` 嵌套路由 |
| A04 | 对抗、多视角、评委及胜者改进后复验 | `tests/m2/verification.test.ts` 有效反例、必需维度、评委无合格候选、吸收后复验 |
| A05 | 嵌套共用 10 名额、等待释放、恢复重取 | `tests/m2/scheduling.test.ts` 嵌套工人峰值 ≤10；`tests/m1/scheduling.test.ts` 主管等待释放名额 |
| A06 | 20M 额度、缓存去重、重试/恢复不清零、缺失用量暂停 | `tests/m0/pi-calls.test.ts` 缓存/推理只记一次；`tests/m1/execution.test.ts` 20M 与重启后额度；未知用量阻塞 |
| A07 | 模型替换与独立审查排除 | `tests/m3/models.test.ts` 同级替换、审查排除实现模型、无候选成问题 |
| A08 | 暂停逐调用生效、关闭界面继续、重启核查 | `tests/m0/call-broker.test.ts` 与 `pi-calls.test.ts` 发送边缘暂停；`tests/m5/http.test.ts` 断线后任务继续；`tests/m6/host.test.ts` 停开 HTTP；`tests/m1/recovery.test.ts` 重启核查 |
| A09 | 局部阻塞、独立分支继续、三轮无进展介入 | `tests/m2/graphs.test.ts` 必需失败只阻塞汇合；`tests/m2/scheduling.test.ts` 独立分支继续与三轮 stalled |
| A10 | 状态由程序掌握、授权不越界、自主安装可用 | `tests/m0/restricted-process.test.ts` 越界拒绝与授权内成功；`tests/m3/catalog.test.ts` 安装不加任务授权；`tests/m6/faults.test.ts` 沙箱程序检查 |
| A11 | 代码集成、目标变化重检、证据对应准确提交 | `tests/m4/merge.test.ts` 与 `worktrees.test.ts`；`tests/m6/faults.test.ts` 杀进程后集成并重检目标前移 |
| A12 | 任务图、人才库、产物、反馈、token/费用/耗时 | `tests/m5/graph.test.ts` 与 `ui.test.ts` 布局、目录、节点详情；HTTP 游标见 `http.test.ts` |

## 本轮边界

未运行 MediaBookmarks 真实任务（A13/M7）。未对使用者配置的收费供应商做契约请求。受限执行仍只在当前 macOS 宿主验证。故障注入使用 SIGKILL、运行时 close/reopen 与重复 HTTP 事件查询，不模拟磁盘损坏或部分写 SQLite 页。重复命令按 `requestId` 去重；SSE 游标重放同一批事件。
