# feat/master-agent-entry × feat/app-console 合并报告

日期：2026-09-14。分支：`feat/unified-console`；工作树 `/Users/macmini/workspace/graph-unified-dev`；合并提交 `695bbc5`。本报告不代替独立验收。

## 输入与结果

| 项 | 提交 |
| --- | --- |
| `main`（未改动） | `688dd1f` |
| `feat/master-agent-entry`（未改动） | `c917fc5`（第四轮返工，独立简验通过） |
| `feat/app-console`（未改动） | `7f94c6c` |
| 两分支合并基点 | `c8a6816`（app-console 自该点分叉） |
| 合并结果 `feat/unified-console` | `695bbc5` |

合并方式：以 `feat/master-agent-entry` 为起点，`git merge --no-ff feat/app-console`。没有合并进 `main`，没有推送，没有改动另外两个分支的引用，没有触碰主工作区的未跟踪文件。

## 冲突与解决

冲突文件 5 个，另有 4 个两侧同改的文件自动合并。

| 文件 | 解决 |
| --- | --- |
| `src/web/App.tsx` | 以 app-console 的设计系统外壳（侧栏、主题、收件箱、向导、insights）为基座，加回主 Agent 入口：`ConversationList` 置于概览、`#/conversations/:id` 路由渲染 `ConversationPanel`（保留 `key` 重挂载），标签与共享组件改为从 `labels.ts`/`shared.tsx` 导入，删除本地重复实现 |
| `src/web/shared.tsx` | `ErrorBox` 采用 app-console 的设计系统样式（`hint-card` + `Icon`/`Button`），保留下方的 `useAsync`/`useEventStream`/`useTaskStream` |
| `src/web/Questions.tsx` | 单一共享 `QuestionReply` 采用设计系统组件（`Pill`/`Button`）并保留 toast 反馈；逻辑与两侧一致（预算、等待、未知用量补记/核对、权限、重试） |
| `src/web/event-cursor.ts` | 统一为单个 `StreamEvent`（含 `data`/`timestamp`），既服务 app-console 的收件箱/通知，也保留主 Agent 增量事件负载 |
| `src/core/task-runtime.ts` | 保留较新的恢复逻辑：`phase IN ('discussing','chatting')`、`createMasterNode`、对话工作区不因项目移除而复活的规则（覆盖 app-console 的 discussing-only 版本） |
| `docs/usage.md` | 两个新章节都保留（「与主 Agent 对话（推荐入口）」与「桌面 APP（开发预览）」） |
| `tests/m8/rework.test.ts` | 保留新增返工回归（app-console 侧为空） |
| 自动合并 | `src/core/execution.ts`、`src/runtime/pi-adapter.ts`、`tests/m8/integration.test.ts`、`README.md` 两侧改动共存 |

## 合并后验证（全部真实退出码）

代码提交 `695bbc5` 上执行：

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`：rc=0。
- `vite build`：通过。
- `vitest run` **两轮均为 58 文件 / 286 项通过**（master-entry 248 + app-console 38，无跳过、无新增失败）。
- 主 Agent 入口端到端探针（真实无头 Chromium + 本地受控供应商）：
  - `history-global-seq`：`afterClicks [400,501,501]`、最早可见、无外来消息、passed。
  - `history-cache-consistency`：2/2 passed。
  - `conversation-ui-boundaries`：passed（合并后的可见控件多了主题切换，不影响断言）。
  - `message-state-millisecond`：同毫秒转换 0。
  - `decision-empty-snapshot`：passed。
- app-console 端到端探针：`app-a3-flow` rc=0（时间线 10 条、MiniMap、图 2 节点、收件箱显示问题）；`app-ui-restyle` rc=0（明暗主题、任务/图/收件箱/设置/向导页面文本与截图）。
- 8 个历史沙箱/监听探针：全部 rc=0。
- 裸/探针运行会覆写其截图，已在验证后恢复为被合并提交的字节；代码与文档无探针副作用。
- 原始输出：`acceptance-evidence/merge-verification/verification.output.txt`。

## 后续注意

- 新分支上的功能范围、验收与未闭合项沿用两条分支各自的记录；长会话自动摘要与真实模型对话质量评估仍未完成。
- app-console 的 A6（签名/公证操作手册）等后续阶段未在此分支新增。
- 未合并进 `main`；若需要发布或继续集成，请在获得明确要求后再操作。
