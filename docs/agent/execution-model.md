# Graph Execution Model

当前 graph 由接口投递驱动。构建、投递、patch 和控制的准确参数见 [graph-v2.md](graph-v2.md)；可运行设计范例见 [design-graph-examples.md](../design-graph-examples.md)。本文说明执行与恢复，不把历史 DAG 当作当前调用格式。

## 定义、实例与修订

main 位于 graph 外部，可创建多个 graph。配方提供身份、规则和能力；节点提供任务、验收、具名接口和运行配置。定义包含 agent、模块、边及子 graph；子 graph 精确引用模板版本，公开输入输出显式映射，每次使用生成独立实例。

graph_create 整体验证并创建空闲节点，graph_send 启动工作。用户确认草稿的路径使用 propose_graph/confirm，再显式发送初始输入。运行中 graph_patch 要求 baseRevision；当前执行配置不变，下一次执行使用新修订。节点引用精确配方版本，发布新的配方不会自动改写现存节点。

## 投递、执行与提交

边保存连接，Delivery 保存一次实际发送。一次有效投递触发一次 execution；聊天也进入同一队列，忙时等待，空闲时开始。聊天默认只回复。每个节点同时最多一次 execution，不在忙碌 turn 中注入聊天。

一次 execution 至多一次有效 submit；可同时提交多个具名输出，缺省输出 disable。宿主整体校验所有目标，再原子写入提交、投递与队列。提交失败可以修正；成功后下游立即可以执行，无需等待发送者结束。同内容重放返回原回执，异内容拒绝。提交不可撤回。

必需输出由 submission.required/requiredAnyOf 声明；缺项补交沿用当前 execution 和会话。默认异常重试 2 次、缺项补交 1 次，分别计数并跨重启保留。已提交执行不重发原输入；失败保留输入并暂停自身队列，其他节点可继续。

## 常驻会话与配置

每个节点拥有独立常驻 Pi 进程及自己的历史。首次 prompt 包含 graph 概述、任务、验收、接口、输入与提交要求；后续只发送新输入和必要变化。工作位置由 workspace 与宿主准备结果决定，实际权限不能超过授权上限。执行、补交冻结环境；配置变化在 turn 之间重绑，保留实例、自己的历史与预算。

进程空闲释放全局执行名额。main 与多个 graph 共用名额及调用门；凭据并发与权限在实际调用前检查；token 用量只记账，不再作为上限拦截。工具次数按实际启动事件累计，有限预算不把未知 usage 当零。

## 路由、汇合与返工

router 保留每个输入最近一次有效 value；未收到与收到 false/null 分别记录。each 每次输入到达判断；once 条件满足触发一次，之后仍更新输入。reopen 保留输入、解除锁存，等下一次投递再判断。需要汇合时显式声明 requiredInputs。

返工是一条普通边，返回原节点并沿用身份和会话。路由可保留旧通过状态，但审查产物仍绑定实际 commit；最终验收核对精确版本。自定义判断代码与宿主命令操作的边界见 [graph-v2.md](graph-v2.md#自定义模块运行环境)。

## 完成、停止与恢复

空闲不是完成。complete 关闭外部新输入及执行型聊天，允许内部后继排空；失败待处理、执行、队列或模块待处理 transition 未清空时不完成。main 可以处理失败、撤销完成请求或 stop。stop 显式取消剩余工作，停稳后结束内部进程；聊天和成果仍可查看。

重启恢复正式队列、execution、提交与模块 outbox，不重复已成功提交。外部命令先写 operation intent，记录 dispatched/settled 等边界。结果明确可复用；未知副作用保持 uncertain，交 main 核查。权限、预算和未知结果不能靠盲重试绕过。

业务输出通过 graph 公开接口交给 main；错误、介入、完成和停止使用独立去重通知。排查时读取 graph_inspect 对应 queue/executions/module/operations 与节点记录，按精确 ID 处理。完整日志与大 value 按需读取，摘要不作为完整验收证据。

## 工具返回与大结果

每个工具结果都要经过 agent loop 的 `afterToolCall` 接缝（`backend/internal/graph/runtime_tool_results.go`），它只替换 `content`，工具的 `details` 与 `terminate` 提示照旧存活：

- 小于 `TOOL_RESULT_LIMIT`（4,000 字符）的结果原样交给模型；
- 大于该阈值的结果，同一会话/工具/参数/内容的**前两次**仍全量返回，**第三次起**换为不超过 `SUMMARY_LIMIT`（1,024 字符）的首尾视图；
- `bash` 另有 `SHELL_OUTPUT_LIMIT`（20,000 字符）封顶，与只读 `git` 同口径，从第一次视图就生效；`read_system_capabilities` 同样单发封顶 `SYSTEM_SUMMARY_LIMIT`（12,000 字符）——它是一次性大结果，懒加载永远碰不到它；
- 被压缩的结果总是形如 `[large tool result: N chars, M lines]` … `... omitted X of N chars ...` … `handle: <路径>` … `Read the whole result with the read tool (offset/limit) on that path.`。数字的**单位是字符，不是字节**（非 ASCII 结果在磁盘上比它长），句柄是 `<instance>/tool-results/<key>.txt`，仍然包含逐字节完整的原文。

**工具返回不是证据**，因此压缩不影响验收；但「按需拉全」必须真的可行：需要完整内容时用 `read` 读句柄路径（`offset`/`limit` 分段），不要凭摘要下结论。上游 `read`/`bash` 自带的上限与 `offset` 继续读、完整输出临时文件路径照旧保留，本接缝不重复实现；`read` 与 `edit` 不在 Graph 侧封顶（`edit` 的模型可见内容本来就只有一行）。

四条边界保证它长期诚实：occurrence 映射每个 scope 最多记 256 个键（按最近使用淘汰——被遗忘的键最坏只是再全量一次，绝不会静默截断）；同一时刻最多 64 个 scope；每个实例目录最多留 256 个句柄文件，超出按最旧回收，**因此句柄是尽力保留**：读到不存在的句柄说明它已被回收，重跑那次工具即可。计数与句柄放在一起（`<instance>/tool-results/counts.json`，按 scope 分组、原子替换），所以同一 binding 的实例被重开（含 daemon 重载）后接着原来的次数往下数，而不是从零开始。

收益是量出来的，也可以再量（溢出文件就是**没进提示词**的字节）：

```sh
find "<stateDir>/instances" -path '*tool-results*' -name '*.txt' -exec stat -f '%z' {} \; \
  | awk '{n++; s+=$1; if($1>m) m=$1} END {printf "%d 个 / %.1f MiB / 单个最大 %.0f KiB\n", n, s/1048576, m/1024}'
```

实测（2026-09-27，本机保留窗口内——`state-retention` 会裁旧实例，所以这是一段窗口而非长期均值）：**5 个 / 0.3 MiB**，最大一个 233 KiB（正好是 master 读自己整段转录那次，218,978 字符），最小 5.3 KiB。最小那个只比阈值高一点，说明 `TOOL_RESULT_LIMIT = 4,000` 正好落在拐点附近：**不调**。

节点记录在每轮结束时补发最后一条 assistant 消息，轮询间隔内提交的回复不会丢。
