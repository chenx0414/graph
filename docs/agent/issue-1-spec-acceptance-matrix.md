# Issue #1：Graph v2 逐项验收对应

> 历史实施与验收记录：保留当时的实现和证据，不代表当前进程模型或任务状态。当前 Go + durable 基线见 [2026-10-20 整合说明](../planning/baseline-cleanup-2026-10-20.md)与 [ADR 0032](../adr/0032-go-backend-shared-durable-host.md)。

日期：2026-10-09。依据 [定稿规格](../specs/graph-rebuild-v2.md)、ADR0030 与当前工作树。此表将产品契约对应到生产职责和既有行为验收；不把测试数量或文件存在当作完整交付。最近完整运行为 gate171：267 文件 / 1823 用例通过，181.64 秒；日志 `/tmp/graph-v2-full-check-171.log`。下列测试属于该次运行，桌面交付另列独立证据。

## 正式模型与执行契约

| spec | 契约 | 生产责任 / 行为证据 |
| --- | --- | --- |
| §1–2 | main 外部、多 graph，定义与实例分责 | graph-service、kernel_graph_owners；graph-runtime 的 main management/公开结果与跨拥有者检查，graph-artifact-owner 的 confirmed/managed 两路径 |
| §2–4 | agent + 具名接口，配方与具体任务分责 | interface-spec、kernel-node-host；interface-spec 精确字段/环境校验，recipe-compile 配方发布，node-prompt-ui 实际配置 |
| §2、7 | 独立常驻 Pi，多 turn 保留 PID、历史与额度 | resident-host H1/H2/H3/H4、spike-resident-worker/config-rebind；context-model 实际 Pi 节点隔离、磁盘重开、自身历史重绑 |
| §2、6–7 | 每次投递一次执行，忙时聊天和输入共用串行队列 | kernel-store 三次同边投递；node-queue Q1/Q3/Q4；graph-runner 实际聊天无 submit、提交时下游先开始 |
| §2、4–6 | 多输出一次有效 submit，整体失败零投递，修正与重放 | kernel-store F1–F5/广播；node-submit-bridge、kernel-e2e-real-pi 真实工具→磁盘；无连接提示及必需输出满足 |
| §2、6 | disable 不投递、不覆盖，业务 false 能返工 | kernel-store F6/F10、module-runtime、module-router R1/R3/R4；UI 区分禁用、未投递和实际 false |
| §3 | 稳定 ID、修订快照、Execution/Submission/Transition 因果 | kernel-store 磁盘 reopen、唯一提交、revision/transition；graph-runtime G1/G2 和局部 patch |
| §3、10 | 大 JSON 正文引用、SSE 摘要、分页精确读取 | KernelContent；kernel-explain V6 存储去重与重开；graph-final-acceptance 长 operation 请求/结果及 settled replay；ui-flow 长日志/第25次投递全文 |
| §4、15.1–2 | 正式 JSON、严格 schemaVersion、同协议 ID/版本连接 | interface-spec、proposal parser；interface-spec version mismatch/未知字段；v2-definitions 的文档 JSON 定义与实际路由；旧 proposal 字符串/字段仍拒绝 |
| §4、6、9 | 规则存在性/布尔/比较/对象映射；无 eval；冲突拒绝 | rule-engine 比较/存在性/缺失与 null/冲突；module-router 整体输出校验与级联 |
| §2、6、9 | each、once、最新输入、保留通过、显式重开 | module-runtime M1–M5 与声明控制输入；kernel-explain V4/V5 显示锁存及重开零输出 |
| §5 | 最小宿主工具、真实 sender/execution、直接聊天/产物 | resident node tools、kernel-node-host；node-submit-bridge、tool-failure-record、context-model、node-prompt-ui；主工具精确授权由 agent-tools 所有者验证 |
| §5、8 | main create/patch/inspect/send/control；原子创建及修订冲突 | graph-runtime G7/G1、创建恢复、direct module/public input、局部对象 patch；confirmed graph 路径独立检查 |
| §6–7 | 提交后不可撤回、不重复，下游不等生产者结束 | graph-runner producer-still-finishing；node-queue Q7；node-executor/node-turn-driver 恢复；磁盘回执重放 |
| §7、15.3 | 默认重试2、补交1，分别计数、重启保持 | node-queue Q5/Q6/Q7；node-executor X2–X5；native-repair-freeze 真实 Pi 补交固定 task/recipe，下一执行才采用修改 |
| §7 | 失败保留输入并局部暂停；权限/预算/未知 usage 不盲重试 | node-executor provider holds/recovery/missing model；kernel-node-budget、v2-budget-blocking、graph-runner S4；host-command-lifecycle 未知副作用 |
| §7、12 | 全局名额、实际统计与模型目录 | task-runtime/graph lane 共享容量；m1/scheduling 的 main+native 全局10名额及重新取得；concurrency 实际凭据别名、排队取消及槽释放；kernel-node-budget 计量/额度；m3/models、settings-ui 与 recipe-compile 三级及旧 grade 兼容 |
| §2、7–8 | 工作位置/权限受上限约束，execution 环境冻结 | interface-spec 环境声明；native-repair-freeze、node-executor 环境校验、node-workcopy 真实工作目录，node-prompt-ui 实际快照 |
| §8、15.5 | 禁用边不撤回旧队列；有待办节点/模块禁止直接删 | graph-runtime G2/retirement 与 m2/revision；严格 retire、移除输入约束及当前执行停稳；历史边身份保留 |
| §8、15.6 | idle 与完成分开、完成拒绝外部输入、内部排空、可撤销 | graph-runtime G3/G4/G4b、graph-runner S5、v2-completion；graph-runtime blocked completion withdrawal |
| §8 | stop 显式取消、停稳后结束；失败不假完成 | graph-runtime G5、node-prompt-ui provider abort/writer settlement；graph-failure-visible 去重通知；v2-failure-visible |
| §9、15.7 | 自定义代码隔离、5秒/1MiB/内存硬上限、串行 | module-container 固定 Docker cgroup；spike-module-isolation 实际文件/进程/环境拒绝、OOM/超时/超量输出；command-module、module-runtime 保留失败输入 |
| §9 | 外部操作走宿主 broker，不声称副作用恰好一次 | kernel-operation-broker；host-command-lifecycle、program-check-sandbox、kernel-git-integration、graph-final-acceptance 真实命令与 settled reopen |
| §9 | 子 graph 精确模板、实例隔离、显式公开映射，无额外调度 | subgraph S1–S5、nested/pinned 实例；context-model 两实例实际聊天隔离；graph-runtime 公共输入、node产物同顶层空间 |
| §2、9 | 产物文件/文本/JSON不可变、作者权限、main 修改 | artifact-workspace；graph-artifact-owner 实际 Pi confirmed/managed、跨拥有者拒绝、作者继续修订、旧版不变；artifact-provenance、context-model 文件发布及精确读取 |
| §2、9、12 | 代码 commit 稳定、旧审查不能证明新版本，保留 Git 门 | graph-acceptance；graph-final-acceptance 真实 Pi/Git/check/review/人工确认与 commit 漂移、dirty tree；m4/acceptance、m7/harness、kernel-model-history |
| §10 | 不同对象外形、统一格点/直角避障、运行叠加不移动 | layout、shared orthogonal-routes、GraphCanvas；m5/ui、ui-flow 多同端点/返工/嵌套/局部 patch/显式 relayout 与位置、运行状态不变 |
| §10 | 折叠保留真实公开接口和跨组边、嵌套聊天可查 | ui-flow 真实公开端口/协议/映射、折叠格点避障、点击边完整历史、两层折叠聊天和展开恢复；gate168 先 RED 后 GREEN |
| §10 | 边历史/精确 value/来源状态；模块真假/缺失/触发/重开 | kernel-explain V1–V7、ui-flow 25次大投递及模块历史；HTTP SQL compact/精确读取守归属 |
| §10 | 多独立聊天窗口、system prompt/工具与实际运行同源 | node-prompt-ui 真实 provider prompt/独立 tab/history；ui-flow 排队/日志全文；app-shell-ux 窗口并存及草稿实际接口 |
| §11–13 | 单一源码入口，整体退休旧 DAG/转换器/reader | retireLegacyGraphs 在恢复前执行；schema-upgrade 两份真实旧 SQLite 保留配置/main，丢弃旧图并同库执行 native；旧 graph.ts/router/submit_result/Proposal/context SDK 已删，负向格式仍拒绝 |
| §15.8–9 | 工程细化与产品行为权限 | 本轮未新增产品规则；旧历史 ADR 保留，ADR0030 明确冲突。新增产品行为必须举场景与用户对齐；测试成功不代替授权 |

## 配套与当前文档

能力库、版本化配方编译、Skills/MCP/CLI/extensions 与现有模型配置继续复用；自定义模块是 graph 逻辑，不等同安装能力。配方库支持按需创建专门 planner/reviewer/HR 等身份，节点任务不写入通用配方。低频配置文档由 INDEX 按需触发，正文不常驻 system prompt。recipe-compile、m5/ui、m3/capabilities、agent-context-assembly 与实际 prompt owner 对应各自边界。

CONTEXT、architecture、implementation-plan、graph-mvp 已按当前契约更新。Agent 当前入口 INDEX/README、graph-overview、execution-model、artifacts-and-git 及 graph-v2 使用说明已清除旧执行指令；历史 issue 报告和旧 ADR 留作历史证据。示例采用与 SDK 相同的原生 JSON，不新增 YAML reader。

## 默认桌面交付证据

- 当前安装位置 `/Applications/Graph.app`，持久 `~/.graph/app-root` 指向 `/Users/macmini/.codex/worktrees/graph-v2-complete/13-Graph`。原业务项目 checkout 未改写。实际 packaged Electron 使用原 `~/Library/Application Support/Graph`，daemon 指向当前 cli.ts 与 dist/web。
- 默认用户数据库首次清理18个旧 graph，保留117个main会话、节点、实例和预算，以及110个context binding；逐行对照快照相同，配置和凭据文件字节未变，外键无错误。原状态快照位于 `~/.graph/cutover-backup-169`。
- 首次真实启动60秒/300秒失败暴露21,195个旧operation删除的外键扫描；补删除顺序和两处查询索引后，同份备份5,061ms清理完成。没有重建数据库或缩减历史来规避问题。
- 实际窗口可见，原会话正文完整加载，无pageerror；`/tmp/graph-desktop-default-170-loaded.log`、`/tmp/graph-default-preservation-170.json` 和 `/tmp/graph-desktop-default-169.png` 记录该次验证。
- gate169包构建与bundle实际Pi原子提交/公开结果/patch/稳定布局/relayout已通过；包内真实provider两次请求并生成正式结果。最后SDK/fixture清理及迁移索引在gate171全量验证；最终包已重建并安装，包内自带Node运行实际Pi得到两次provider请求、正式结果及patch/布局复验。`/tmp/graph-v2-app-build-171.log`、`/tmp/graph-v2-packaged-probe-171.log` 与 `/tmp/graph-desktop-default-171.log` 均通过，最终默认窗口再次完整加载，无pageerror。

## 验证边界

大型旧inline内容兼容读取，不批量改写用户历史；新的大型正式字段使用内容引用。Docker自定义判断需要预置固定镜像，不静默拉取或降级。任意外部命令副作用不承诺恰好一次；受限命令缺少可验证崩溃清理凭证时保持未知资源占位，由main处理，不能假造副作用已结束。上述是明确恢复/隔离边界，不把未知当成功。

临时日志属于本机运行证据；仓库记录结论、命令与对应behavior owner。完整门禁不替代真实默认应用证据；最终包和提交状态记录于实施进度。
