# ADR 0042：内核升到 0.7，主对话按状态呈现

日期：2026-11-11

## 状态

已接受，已实施。

## 背景

PiG `v0.7.0` 删掉了 `durable/harness` 的 `WatchEvents`、`AgentEventStream` 与整套 agent 事件类型
（`AgentEvent`、`MessageChange`、`ToolEventCall`…），改为「按状态渲染」：`pi.live` 文档给出
`run`、进行中的 `generation`、本轮的 `tools` 槽位、压缩与失败原因，`ConversationTranscript` 给出条目。
`Conversation.Watch` 也改成带窗口参数，`chord/sqlite` 的接口多了 `RunCounted`。

我们的适配层（`backend/internal/pigkernel`）原本把事件翻译成 Graph 消费的形状：`agent_start`、
`message_update` 的逐字 `text_delta`、`tool_execution_start/end`、`compaction_*`。上游一删，这段翻译
就没有输入了。

## 决策

**主对话不再做逐字流，按状态呈现。** 每一轮开始时起一个轮询（200ms），读 `pi.live` 的已提交状态与
新增条目，产出同一套事件形状：

| 事件 | 来源 |
| --- | --- |
| `agent_start` / `agent_end` | `pi.live.run` 出现 / 消失 |
| `turn_start` | `run.turns` 增长 |
| `tool_execution_start/end` | `pi.live.tools` 槽位出现、转为 `done`（带保留输出） |
| `message_end` | 本轮新提交条目里的 assistant 消息 |
| `compaction_start` / `compaction_end` | `pi.live.compactions` 出现 / 消失 |

`message_update` 与它的 `text_delta` 不再产生：对话正文在消息落库时一次出现，而不是一个字一个字地长。
下游（控制台、节点叙事、`node_entries`）一行没改，只是收到的事件更少、更大块。

`chord/sqlite` 的 `RunCounted` 用 SQLite 的 `changes()` 实现（`RowsAffected`）。

## 代价

- **对话正文不再是打字机效果**：一个问题提交后，正文在模型答完、消息提交时整段出现。这是刻意的取舍：
  上游不再提供增量，硬造增量要么再写一层 diff，要么留着旧内核。
- **`pi.live` 存储升到版本 3**（`run.turns`、`afterRun`；旧的读得进，新的旧版读不出）。升级前已把
  `~/Library/Application Support/Graph/state/tasks.sqlite` 备份到
  `~/Library/Application Support/Graph/backups/tasks-pre-kernel-0.7.sqlite`（`quick_check` ok，168 个会话）。
  回滚需要换回 `v0.5.3` 并把这份备份放回去；升级之后新产生的会话会丢。
- 轮询意味着一次运行的状态最多晚 200ms 出现；它读的是已提交文档，不会看到半条消息。

## 验证

三个冻结用例（真 daemon + 替身模型 + `go test` 验收）全绿：真实会话跑通、工具调用记录、助手正文落进
`messages`。`go -C backend test ./...` 与 `node --run check` 全绿。`pigkernel` 新增的 diff 用例先红后绿
（删掉 `agent_end` 分支即失败）。
