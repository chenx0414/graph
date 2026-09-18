# Zeron 实时文本流实现调研

研究日期：2026-09-18

状态：研究结论，未修改产品代码。

## 调查范围

- 源码：[zeronsh/zeron@10c9d3e](https://github.com/zeronsh/zeron/tree/10c9d3e284c23f5ae4a8e01e4a8e7f4b4b488e52)
- 固定 revision：`10c9d3e284c23f5ae4a8e01e4a8e7f4b4b488e52`
- tag：`v0.2.77`
- 日期：`2026-09-18`

下文 Zeron 路径均相对于上述 revision。除明确标注“工程推断”的内容外，均为源码事实。

## 结论摘要

Zeron 的实时文本流不是单个 CSS 动画，而是一条从 Agent 协议到最终绘制的完整流水线：

1. 各 harness 将原始 wire event 归一化成统一的 `AgentEvent`。
2. engine 收到事件后立即写 journal、广播并折叠，但按 `120ms` 窗口批量提交会话文档。
3. transcript watch 在流式热路径只发送 `TextAppend`，不重复发送整条 assistant message。
4. UI 按顶层 Markdown block 虚拟化；流式态与完成态使用相同 block ID，只替换真实变化的 block。
5. 流式淡入只修改新增文字区间的透明度；滚动跟底使用带前馈的 spring，并由用户输入明确中断。

Graph 当前并非“没有 delta”：

- Pi adapter 已把文本流按 `60ms` 聚合为 `message.delta`，见 [pi-adapter.ts](../../src/runtime/pi-adapter.ts:359)。
- 客户端也按 operation 原地追加 `liveText`，见 [conversation-projection.ts](../../src/core/conversation-projection.ts:159)。
- SSE 支持从 cursor replay，断线不会静默继续错误状态，见 [task-runtime.ts](../../src/core/task-runtime.ts:1032)。

真正拉开体验差距的是客户端之后的路径：

1. `StreamingMarkdown` 每次都以 `cut:tail.length` 作为 React key，导致当前尾块重新挂载并重解析，见 [Conversation.tsx](../../src/web/Conversation.tsx:254)。
2. 流式行 ID 是 `streaming:${operationId}`，最终持久消息 ID 是 `message.id`；live→durable handoff 会换身份、重新排序和重挂载，见 [transcript-model.ts](../../src/web/transcript-model.ts:117)。
3. fade 挂在整段 `.streaming-tail` 元素上，而不是精确的新增文本区间，见 [styles.css](../../src/web/styles.css:995)。
4. Markdown 没有 block 级增量 parser；每个 delta 都重新解析当前 tail，见 [Markdown.tsx](../../src/web/Markdown.tsx:78)。
5. 跟底是 `ResizeObserver` 加直接 `scrollTop = scrollHeight`，没有前馈速度、用户输入边界和发送后的 runway，见 [use-transcript-follow.ts](../../src/web/use-transcript-follow.ts:73)。

因此，优先修复方向应是“稳定身份 + 追加协议 + block 级解析 + 精确 fade + 跟底状态机”，而不是继续叠加 CSS 动画。

## 1. AgentEvent 归一化

Zeron 为所有 harness 定义了同一套流式事件：

- `SessionStarted`
- `TextDelta`
- `ReasoningDelta`
- `ToolCall`
- `ToolResult`
- `Done`
- 以及 steering、input、error、subagent 等控制事件

定义见 `crates/proto/src/agent.rs:331-453`。

Claude adapter 将 text delta、thinking delta、tool use 和 tool result 映射到这些统一事件，见 `crates/harness/src/claude/normalize.rs:293-346`、`:362-402`、`:497-526`、`:579-628`。Codex adapter 同样把 `item/agentMessage/delta`、reasoning delta 和工具生命周期归一化，见 `crates/harness/src/codex/normalize.rs:28-35`、`:165-179`、`:543-600`。

一个值得借鉴的细节是：Codex 的 reasoning 可能由多个独立 item/index 组成，归一层会主动补换行，避免两个 Markdown 标题被拼成 `**one****two**`，见 `crates/harness/src/codex/normalize.rs:37-97`。

Graph 已有同等方向的事件归一化，但前端协议没有携带足以安全合并的稳定 `entryId`、`partId` 和总长度。

## 2. Engine：journal、broadcast、fold、coalesced commit

Zeron 的事件流水线分四个动作：

1. **持久化**：每个事件以 JSONL 追加写入按 chat 分离的 journal，见 `crates/engine/src/run_journal.rs:1-11`、`:99-145`。
2. **订阅恢复**：subscriber 先 replay journal，再接收 live broadcast；subscribe-then-replay 允许重叠，但不能产生缺口，见 `crates/engine/src/sessions.rs:296-318`。
3. **广播**：`publish` 立即写 journal 并广播事件，见 `crates/engine/src/sessions.rs:900-914`。
4. **折叠**：每个事件立即折叠进当前 segment 的 parts，见 `crates/engine/src/sessions.rs:2192-2206`。

但文档不会在每个 token 上提交。`STREAM_COMMIT_MS = 120`，见 `crates/doc/src/constants.rs:14-15`。第一个脏事件启动一个 120ms 窗口；窗口内所有 delta 合并，到期后 parent 和 dirty subagent 文档各提交一次，见 `crates/engine/src/sessions.rs:1664-1678`、`:2302-2306`。

这个设计同时满足两点：

- 事件级恢复和审计不依赖 120ms 聚合结果。
- UI 每 120ms 只处理一次稳定的 transcript diff，而不是每个 token 一次。

`TextDelta` 会续写尾部 Text part；工具事件会打断 Text part，因此文字与工具活动的真实先后关系保留，见 `crates/doc/src/parts.rs:254-282`、`:317-377`。

工程推断：120ms 不是必须照搬的魔法数。Graph 可继续保留 60ms 或按真实 Web 帧率调整，但不能让每个 delta 都触发完整 Markdown 重挂载。

## 3. Transcript delta 协议

Zeron 的 watch 首帧发送完整 `reset`，之后发送 `upsert`、`append`、`remove` 和 `count`，见 `crates/doc/src/transcript_delta.rs:103-121`。

流式热路径 `TextAppend` 只携带：

```text
entryId
partId
新增文本
追加后的总长度
```

定义见 `crates/doc/src/transcript_delta.rs:132-143`。

只有“同一 entry、同一 part、严格前缀增长”才转换成 append；其他变化退回完整 entry upsert，见 `crates/doc/src/transcript_delta.rs:161-200`。如果 upsert 数量接近整份 transcript，协议直接退化为 `reset`，见同文件 `:251-260`。

客户端原地 `push_str` 应用 append，并用 part 总长度及 entry 总数量做 desync tripwire，见 `crates/doc/src/transcript_delta.rs:269-343`。一旦无法安全应用，UI 丢弃当前流并重新订阅，由 reset 恢复，见 `crates/ui/src/state.rs:2477-2567`。

纯文本 append 只发出 `TranscriptTextChanged`，避免让全部 app-state observer 失效；结构性变化才走完整 notify，见 `crates/ui/src/state.rs:760-772`、`:1224-1245`。

Graph 已经发送 `message.delta`，但当前 payload 只有 `operationId` 和新文本，见 [pi-adapter.ts](../../src/runtime/pi-adapter.ts:359)。它还缺少：

- 稳定的 message/entry ID；
- 稳定 part ID；
- append 后的总长度；
- 对失同步显式 reset 的恢复规则。

当前 SSE 的 cursor 能防止漏帧被静默忽略，但不能判断客户端已有的文本是否与服务端一致。加入长度校验后，Web 层也需要保留“无法匹配就重新拉取完整 projection”的路径。

## 4. Block 级虚拟行和稳定身份

Zeron 的 transcript 不是“一条消息一行”，而是一条顶层 Markdown block 一行；连续工具和 reasoning 组成工具组行，见 `crates/ui/src/transcript.rs:1-15`、`:1294-1400`。

Markdown row ID：

```text
{messageId}#{partId}.{blockIndex}
```

工具组 row ID：

```text
{messageId}#g{groupIndex}
```

见 `crates/ui/src/transcript.rs:1302-1322`、`:1410-1449`。

关键点是：流式 entry 和完成 entry 使用相同的 block 拆分和 row ID。测试明确断言 live→complete 后每个 block 的 ID 不变，因此不会因 handoff 改变身份而闪烁，见 `crates/ui/src/transcript.rs:10039-10067`。

每个 block 的 version 由该 block 的字节 hash 和 streaming 位组成；稳定前缀的 block version 不变，见 `crates/ui/src/transcript.rs:1418-1433`。行集合按 `(id, version)` 求最小 splice，见 `crates/ui/src/transcript.rs:1717-1735`、`:4514-4550`。

完整 entry 使用 fingerprint 缓存；流式 entry 虽然会重建行，但 render cache 只失效真实变化的 block，见 `crates/ui/src/transcript.rs:4613-4647`。

Graph 已有工具组降噪，但没有 block 级消息行：

- 流式 assistant 是单行 `streaming:${operationId}`，见 [transcript-model.ts](../../src/web/transcript-model.ts:117)。
- 持久 assistant 是 `message.id`，见 [transcript-model.ts](../../src/web/transcript-model.ts:95)。
- React 直接以 `row.id` 作为 key，见 [Conversation.tsx](../../src/web/Conversation.tsx:964)。

因此流式结束、持久消息出现时，不能保证完成回复在视觉上继续占用原来的行，也不能保证稳定前缀不重新挂载。

工程推断：Graph 不需要引入虚拟列表才能先获得主要收益。第一步只需让同一个 message/part 在 live 和 durable 两态生成相同 block IDs，并只重渲染尾部 block。

## 5. Incremental Markdown

Zeron 的增量 Markdown parser 从倒数第二个顶层 block 的起始位置重解析，通常只重算最后两个 block，见 `crates/ui/src/markdown/parser.rs:608-628`、`:693-739`。

重算最后两个而非一个，是为了处理“尾部 paragraph 继续增长后并入前一个 list”的合并情况；更早 block 的边界已经由已到达字节确定，见同文件 `:715-722`。

link-reference definition 具有跨块效果，因此出现后自动退化为全量解析，见 `crates/ui/src/markdown/parser.rs:9-12`、`:684-711`、`:779-785`。

未闭合的行内标记只修补 display tree。例如 `**bold` 会临时显示为粗体；canonical tree 仍保持诚实，完成时再自然收敛，见 `crates/ui/src/markdown/mend.rs:1-42`、`:57-205`。未完成链接 URL 使用占位目标，使链接文字先稳定显示，URL 到达时不会重新布局已经画出的文字，见同文件 `:21-27`、`:154-157`。

Graph 的 `stableMarkdownCut()` 只按空行找“稳定前缀”，随后：

- 每次重新渲染整个 `settled` 和 `tail`；
- 每个 delta 都重新解析 tail；
- tail key 包含 `tail.length`，所以 tail 每次增长都重新挂载。

见 [Conversation.tsx](../../src/web/Conversation.tsx:238) 和 [Markdown.tsx](../../src/web/Markdown.tsx:78)。

这会让普通段落在没有空行时长期留在 tail；已显示的段落也可能因为缺一个结束空行而持续参与全量解析，直接放大长回答的流式抖动。

## 6. Paint-only fade

Zeron 的 veil 以“新增字节区间”为单位：

- 旧文本和新增文本求 common prefix；
- 旧 chunk 被裁剪到已提交前缀；
- 只有新后缀登记一个新的 fade chunk；
- 相同文本重复 render 是 idempotent。

见 `crates/ui/src/markdown/veil.rs:101-170`。

默认 cadence EMA 为 `160ms`，单 chunk 时长为：

```text
clamp(ema * 3, 120ms, 400ms)
```

透明度曲线为 `1 - (1 - progress)^1.6`；并发 3 个以上 chunk 时会加速，见 `crates/ui/src/markdown/veil.rs:33-77`。

`apply_veil` 只修改文字、背景、下划线和删除线的颜色透明度，不修改字体、文本长度、字符位置或行高，见同文件 `:236-282`。关键约束是 paint-only 和零位移；已有文字不会重复淡入，live row 完成后 veil 被移除，见 `crates/ui/src/transcript.rs:4492-4503`、`:5934-6017`。

Graph 当前使用：

```css
.streaming-tail {
  animation: stream-fade 190ms ... both;
}
```

见 [styles.css](../../src/web/styles.css:995)。但 React key 每次变化都会让整个 tail 重新挂载，因此动画会作用于 tail 的旧内容和新内容，而不是只作用于本次新增的字。

Graph 若保留 DOM/CSS 方案，可把 Markdown block 拆成稳定节点，并只对当前追加的文本 suffix 做一个短时 `opacity` 过渡。不要给新增块使用 `translateY`、`height`、`margin` 或 `scale`，否则会重新引入布局位移。

## 7. Scroll follow

Zeron 的跟底不是“每次内容变化直接跳到底部”，而是按布局后的真实 target height 驱动 spring：

- damping：`0.7`
- stiffness：`0.05`
- mass：`1.25`
- feed-forward growth EMA：`0.12`
- 最多领先真实底部：`32px`

见 `crates/ui/src/transcript.rs:187-203`、`:242-320`。

用户 wheel/touch 输入会立即打断 pin；用户重新回到底部 `70px` 内且继续向下时，才重新吸附，见 `crates/ui/src/transcript.rs:61-67`、`:3293-3396`。spring 在每一帧布局后读取实际 target，再平滑推进，见 `crates/ui/src/transcript.rs:4016-4075`。

本地发送时还会在最后一行之后建立 viewport reservation，让新 turn 的早期输出有空间生长；内容真正溢出后再交接给普通 tail spring，见 `crates/ui/src/transcript.rs:2444-2481`、`:3508-3544`、`:3673-3699`、`:3717-3760`。reduced-motion 下则直接跳转，见 `:3972-3977`、`:8036-8051`。

Graph 当前逻辑在 [use-transcript-follow.ts](../../src/web/use-transcript-follow.ts:73)：

- 用 `ResizeObserver` 监听增长；
- 用 `requestAnimationFrame` 直接设置 `scrollTop = scrollHeight`；
- 用 `programmatic` timer 区分程序滚动和用户滚动；
- 固定阈值判断是否恢复 pinned。

它能完成基本跟底，但内容增长和用户输入最终都落到一次 scroll jump，没有速度连续性，也没有发送后的预留空间。对高频 block 更新，这会表现为每轮布局后“贴一下底”，而不是连续滑行。

## 8. Graph 已有且应保留的部分

本次不应被视为推翻现有实现：

| 现有能力 | 位置 | 结论 |
| --- | --- | --- |
| Provider delta 到 SSE | [pi-adapter.ts](../../src/runtime/pi-adapter.ts:359) | 保留；补稳定 ID 和长度校验。 |
| 客户端原地累计 delta | [conversation-projection.ts](../../src/core/conversation-projection.ts:159) | 保留；避免退回整条消息替换。 |
| SSE cursor / replay | [task-runtime.ts](../../src/core/task-runtime.ts:1032) | 保留；append desync 后必须走 reset。 |
| 连续工具归组 | [transcript-model.ts](../../src/web/transcript-model.ts:69) | 保留。 |
| 工具活动完成收起 | [Conversation.tsx](../../src/web/Conversation.tsx:192) | 保留，与 Zeron 的方向一致。 |
| debounce 后的完整 snapshot | [Conversation.tsx](../../src/web/Conversation.tsx:651) | 可保留作一致性恢复，不应作为流式热路径。 |

现有的 `ToolActivityGroup` 已实现“active 自动展开、完成后收起、用户手动覆盖”，不要求移植 Zeron 的全部工具组动画。

## 9. 建议的落地顺序

### P0：先消除身份断裂

1. assistant live row 改为 `messageId#partId.blockIndex` 类稳定 ID。
2. live 与 durable 两态使用同一套 block 拆分函数。
3. live→durable 时保留已显示 block 的 React identity，只更新 version 变化的尾部。
4. 最终回答不再从临时 streaming row“跳到”另一条 message row。

这一步价值最高，且不依赖引入第三方 Markdown parser。

### P1：补齐 append 协议

1. `message.delta` 增加稳定 `entryId`、`partId`、`text` 和 `len`。
2. 客户端只接受严格前缀追加；长度不符时丢弃本地 live copy 并拉取完整 projection。
3. 保持现有 `reset` 作为结构变化和恢复路径。
4. 在 Vitest 中覆盖正常追加、重复帧、乱序帧、缺帧和 emoji/非 BMP 字符。

注意统一长度语义。Zeron 的 `TextAppend.len` 是 UTF-8 bytes；JavaScript 字符串长度是 UTF-16 code units。Graph 可明确选用 JS length 或字节长度，但不能两处混用。

### P1：Block 级增量 Markdown

1. 将 assistant response 排序为顶层 Markdown block。
2. 稳定前缀直接复用已渲染节点。
3. 只重新解析最后两个 block，覆盖 list/paragraph 合并情况。
4. 遇到 link-reference definition 时退回全量解析。
5. 为未闭合粗体、斜体、inline code 和链接设计 display-only 修补；canonical 内容仍按真实 Markdown 解析。

如果引入通用 parser，需要先确认其支持安全的 partial parse 或 block range，而不是只在 React 层给完整解析结果加 key。

### P2：精确 paint-only fade

1. 追踪上一帧 flat text 与当前 text 的 common prefix。
2. 只给新增 suffix 建立 fade chunk。
3. chunk 完成后不保留。
4. 只动画 `opacity`，不参与布局。
5. 历史消息和切换会话时先 seed baseline，不能整段重新淡入。

### P2：跟底状态机

1. 将“pinned / user-owned”作为显式状态。
2. 只有用户滚轮、触摸或拖动输入能解除 pinned。
3. 内容增长只更新 target，不冒充用户滚动。
4. 用户回到距底部小范围且方向向下时恢复 pinned。
5. 本地发送后预留一个受控 runway，再平滑交接给 tail follow。
6. 先用 DOM 实测选择 spring 参数，不直接照搬 Zeron 常量。

## 10. 不应照搬的部分

- 不复制 gpui `ListState`、`TextRun`、`window.on_next_frame` 或 tail reservation 的具体实现。
- 不把 fade 做成元素入场动画；Zeron 的约束是 paint-only、零位移。
- 不在每个 delta 上重解析整段 Markdown。
- 不在没有长度校验和 reset 恢复的情况下应用 append。
- 不因为 Zeron 使用 `120ms` 就机械修改 Graph 的 `60ms`；先测量 Web 端每帧成本。
- 不引入 CRDT、Loro 或完整虚拟列表来解决当前首要的 React 身份/解析问题。

## 11. 验收建议

后续实现至少需要证明：

1. 连续追加 100 次时，未变化的 Markdown block 不重新挂载或重新解析。
2. live→durable handoff 后，已显示 block 的 DOM identity 与视口锚点保持连续。
3. fade 只覆盖本次新增文本；旧文本不会重复淡入。
4. 用户在流式过程中向上滚动后，稳定内容不会把视口强制拉回底部。
5. SSE 缺帧或长度不符时，客户端能够 reset 到服务端权威 projection。
6. 长回答和含 emoji/CJK/表格/代码块的内容在流式态与完成态最终一致，无重复、漏字或重排跳变。

## 12. Zeron 自身文档冲突

`ARCHITECTURE.md:180-182` 仍写有“live turn stays unsplit, re-splits on persist”。当前源码已在流式期间按顶层 block 拆行，并在完成后复用同一行 ID，见 `crates/ui/src/transcript.rs:1-15`、`:1410-1450` 和测试 `:10039-10067`。本报告以后者当前源码行为为准。
