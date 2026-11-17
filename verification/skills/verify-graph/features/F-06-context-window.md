# F-06 上下文窗口三页签

「上下文 / System Prompt / 工具声明」三个页签各自显示真实内容，而不是同一段占位。

- 入口：中栏底部 `当前上下文窗口` 分组里的三个按钮
- 数据源：`GET /api/tasks/{taskId}/nodes/{nodeId}/prompt`（`app/prompt_record.go`）
- 现有自动化覆盖：`app/prompt_record_test.go`（断言 `System Prompt` 页签逐字显示 `SUPERVISOR-PROMPT-EXACT`、并显示「实际发出（最近一次模型请求）」）

## Sub-features

- `上下文`：上下文用量与窗口摘要（`trajectory-context` → `context-overview`）。
- `System Prompt`：系统提示词全文，标题「实际发出（最近一次模型请求）」标明来源。
- `工具声明`：当前可用工具的声明列表。
- 无记录态：还没发过请求时给明确空态文案，不是空白。

## How to get to it (user POV)

窗口底部一行小按钮 → 点 `System Prompt` → 弹层/卡片显示全文 → 点 `工具声明` 换成工具清单。

## Driving it with verify-graph

```sh
verification/verify-graph verify --journey F-06
verification/verify-graph verify --journey F-06 --lane window
verification/verify-graph evidence verify --run <run>
```

本 journey 实测覆盖：上下文窗口在默认白板上；三个页签按钮（上下文 / System Prompt / 工具声明）在可访问树里可点，内容来自当前会话。空实例没有会话时只显示窗口本身，这是预期空态。

人工复核项（**尚未写进 journey**，不要当成已覆盖）：AX 里 `System Prompt` 页签正文与 `prompt.json` 里对应字段逐字一致（取 sha256 比较，不落正文）；`工具声明` 页签条数 = API `tools[]` 长度。

## Gotchas

- 没有 task/node 的实例只有空态：此时判据是「空态文案存在 + 不崩」，并在断言里写 `mode: empty`。
- 系统提示词可能含敏感路径/凭据名：证据只存 sha256 与长度，不存正文（契约要求）。
- 页签名是中文按钮 + 英文混排（`System Prompt`），`--exact` 匹配时注意大小写与空格。
