# DSH 「跨 Agent 协作」泳道卡片逆向分析

> 作者：agent-0006（认领见 `coordination/CLAIMS.md`）。
> 目的：给问题3渲染器（agent-0011）提供**从 DSH 真实源码提取**的结构与样式对照，而不是凭空另画。
> 提取源：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（210,011,763 bytes，asar v2，header 5,697,816 bytes / JSON 5,697,805 bytes）。
> 提取方法：`npx @electron/asar list` 定位 + 直接解析 asar header 按 offset/size 取文件（比逐文件 `extract-file` 快且可批量）。

## 0. 结论先行（重要，避免渲染器走错方向）

**DSH 里并不存在一个名字就叫「跨 Agent 协作」且带泳道 + 时间列 + 发送→接收箭头的单一组件。** 用户描述的卡片是 DSH 三个真实部件的合成：

| 用户要的元素 | DSH 真实来源（已提取验证） | 直接照搬程度 |
|---|---|---|
| 每个 Agent 一条泳道，左侧头像/首字母 + 名称 + 模型 + token/成本 + 任务/事件数 | `dsh-client-ui-agent-team/src/client/TeamBoard.tsx` + `TeamBoard.module.css`（owner 标签 + 任务行）；`dsh-experimental-client-ui-stats`（每轮/每步的 token、耗时列） | 结构与数值 1:1，泳道是「按 owner 分组」的新排布 |
| 右侧时间列，事件按时间落位 | `dsh-experimental-client-ui-stats/src/client/stats.module.css` 的 `.stepClock/.turnClock/.table col:nth-child(n)` 固定列宽；时间戳 `MM-DD HH:MM:SS.mmm`，tooltip 完整 `YYYY-MM-DD HH:MM:SS.mmm` | 列宽百分比、tabular-nums、时钟颜色 1:1 |
| 发送方→接收方连线（箭头） | `dsh-agent-team` 的 teammate 消息语义（`send_message`、`team/message/queued|delivered` 记录、发送方归属）；stats README 明确「触发列写明发送方」 | DSH 无箭头绘制代码；箭头是 Go 侧新增，但**语义/字段**来自 DSH |
| 顶部记录数/泳道数/搜索/最早/最新 | `dsh-experimental-client-ui-stats/src/client/StatsTable.tsx` 的 `TotalsRow`、页脚 `SegmentedControl/Switch`、`LOAD_OLDER_THRESHOLD`；`TeamBoard.tsx` 的 `progressLabel`（`完成 n · 进行中 n · 待办 n`，分隔符 `\u2002·\u2002`） | 头部统计 1:1 复用 `progressLabel` 模式 |
| 点击事件看内容 | `TeamBoard.tsx` 的 `TaskRow`（`aria-expanded` + 展开 `.details`）；`StatsView.tsx` 的 `toggleStepDetail` / 详情行 | 交互 1:1 |
| 空态 | `TeamBoard.tsx`：`tasks.length===0 && failure===null → return null`；`stats.module.css .empty{padding:24px 0}` | 空态 1:1（**不要编造 lane**，见下方 agent-0014 FAIL-1） |

## 1. 照搬的组件、CSS 值、尺寸、间距、颜色（逐项，来自源码原文）

### 1.1 `dsh-client-ui-agent-team/src/client/TeamBoard.tsx` + `TeamBoard.module.css`

这是「每个 Agent 一条泳道，左侧头像/首字母 + 名称 + … + 任务数」的**直接原型**。

TSX 结构（112 行，已完整提取）：
- `<section className={css.board} data-with-members={hasMembers} aria-label={t('trigger')} data-team-panel>`
- `<h3 className={css.header}>`：`<span className={css.lead}>`(14px checklist icon) + `<span className={css.title}>任务</span>` + `<span className={css.progress}>{progressLabel(tasks,t)}</span>`
- `progressLabel`：`[完成 n, 进行中 n, 待办 n].join('\u2002·\u2002')`；pending = total − completed − active。
- `TaskRow`：`<li data-team-task={id} data-status={status} data-expanded={expanded}>` →
  `<button className={css.taskRow} aria-expanded aria-controls>` →
  `<span className={css.glyph}><StateDot state={...}/></span>` +
  `<span className={css.subject}>` + `<span className={css.chevron}><IconChevronDownOutlineRegular size={14}/></span>`。
  展开后 `<div className={css.details} id={detailsId}>`：`.description` + `.owner`（`ownerLabel` + `ownerValue`）。
- dot 状态映射：`pending:idle, in_progress:ongoing, completed:done`；blocked（pending && !ready）→ `warning`。
- Tooltip：`delayMs={500} portal side="top" onlyWhenClipped`。

CSS 原文关键值：
```
.board            { padding: 8px 7px; min-width:0 }
.board[data-with-members=true] { margin-top: 4px }
.header           { display:flex; align-items:center; flex-wrap:wrap; gap:4px 7px; margin:0 0 4px; padding:0 }
.lead/.glyph/.chevron { display:grid; flex:none; place-items:center; color: var(--dsw-alias-label-tertiary) }
.title            { flex:none; color: var(--dsw-alias-label-primary); font-size:13px; font-weight:500; line-height:24px }
.progress         { margin-inline-start:4px; color: var(--dsw-alias-label-tertiary); font-size:13px;
                    font-weight:400; font-variant-numeric:tabular-nums; line-height:20px; overflow-wrap:anywhere }
.tasks            { display:flex; flex-direction:column; margin:0; padding:0; list-style:none }
.task             { min-width:0 }
.taskRow          { box-sizing:border-box; display:flex; align-items:center; gap:7px; width:calc(100% + 12px);
                    min-width:0; margin:0 -6px; padding:7px 6px; border:0; border-radius:var(--dsw-radius-md);
                    background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px;
                    line-height:17px; text-align:left; cursor:pointer }
.taskRow:hover/:focus-visible { background: var(--dsw-alias-interactive-bg-hover); focus outline:none }
.glyph            { width:14px; height:17px }
.subject          { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.task[data-expanded=true] .taskRow { align-items:flex-start }
.task[data-expanded=true] .subject { overflow:visible; overflow-wrap:anywhere; white-space:pre-wrap }
.task[data-expanded=true] .chevron { transform:rotate(180deg) }
.chevron          { width:28px; height:17px }
.details          { padding:0 0 8px 21px; color:var(--dsw-alias-label-secondary); font-size:12px;
                    line-height:18px; overflow-wrap:anywhere }
.description      { margin:0; white-space:pre-wrap }
.owner            { display:flex; gap:4px; min-width:0; margin:0; white-space:nowrap }
.description + .owner { margin-top:6px }
.ownerLabel       { flex:none }
.ownerValue       { min-width:0; overflow:hidden; text-overflow:ellipsis }
.error            { display:flex; align-items:flex-start; gap:7px; padding:8px 0;
                    color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:18px; overflow-wrap:anywhere }
```

### 1.2 `dsh-experimental-client-ui-stats/src/client/stats.module.css`（19,161 bytes，已完整提取）

这是「右侧时间列 + 固定列宽 + 时钟/数值排版」的**直接原型**。

关键 CSS 原文：
```
.root             { display:flex; flex-direction:column; box-sizing:border-box; height:100%; min-height:0;
                    padding-bottom: calc(var(--dsh-composer-height,152px) + 8px); overflow:hidden;
                    color:var(--dsw-alias-label-primary); font:var(--dsw-font-xxs-12) }
.scroll           { box-sizing:border-box; flex:1; height:100%; min-height:0; overflow-y:auto; padding:0 20px 16px }
.scroll > :first-child { margin-top:12px }
.empty            { padding:24px 0; color:var(--dsw-alias-label-secondary) }
.table            { width:100%; table-layout:fixed; border-collapse:collapse; border-spacing:0;
                    font:var(--dsw-font-xxs-12); font-variant-numeric:tabular-nums }
/* 列宽百分比：泳道卡片的时间列请沿用第 11 列的 15.5% */
.table col:nth-child(1){13%} (2){15%} (3){13.5%} (4){5.5%} (5){5.5%} (6){6.5%}
                    (7){6%} (8){6%} (9){7.5%} (10){6%} (11){15.5%}
.thLeft,.th       { position:sticky; z-index:2; top:0; box-sizing:border-box; padding:4px 8px;
                    border-bottom:0.5px solid var(--dsw-alias-border-l2);
                    background:var(--dsw-alias-bg-layer-1); background-clip:padding-box;
                    color:var(--dsw-alias-label-tertiary); font:var(--dsw-font-xxs-12); font-weight:500;
                    line-height:1.25; vertical-align:bottom; white-space:normal }
.turnCell,.turnMetric,.turnDid,.promptCellTurn
                  { overflow:hidden; text-overflow:ellipsis; padding:6px 8px;
                    border-top:0.5px solid var(--dsw-alias-border-l2);
                    border-bottom:0.5px solid var(--dsw-alias-border-l1); white-space:nowrap }
.turnCell         { font-weight:600; white-space:normal }
.stepCount        { color:var(--dsw-alias-label-secondary); font-weight:400 }
.toggle           { border-bottom:0.5px dotted var(--dsw-alias-border-l2);
                    color:var(--dsw-alias-label-secondary); font:var(--dsw-font-xxxs-11); font-weight:400 }
.rowToggle:focus-visible { outline:1px solid var(--dsw-alias-state-business-primary); outline-offset:2px }
.older            { display:flex; justify-content:center; padding:2px 0 10px }
.turnClock        { color:var(--dsw-alias-label-tertiary); font-weight:400 }
.stepRowError     { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent) }
.stepCell         { box-sizing:border-box; height:30px; padding:0 8px 0 22px;
                    border-bottom:0.5px solid var(--dsw-alias-border-l1);
                    box-shadow: inset 2px 0 0 var(--dsw-alias-border-l1);
                    color:var(--dsw-alias-label-secondary); white-space:nowrap }
.stepMetric,.stepDid,.promptCell
                  { overflow:hidden; text-overflow:ellipsis; box-sizing:border-box; height:30px;
                    padding:0 8px; border-bottom:0.5px solid var(--dsw-alias-border-l1); white-space:nowrap }
.compactionRow td,.eventRow td
                  { border-bottom:0.5px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2) }
.compactionTag    { display:inline-block; margin-right:6px; padding:0 4px;
                    border:0.5px solid var(--dsw-alias-border-l2); border-radius:4px;
                    color:var(--dsw-alias-label-secondary); font:var(--dsw-font-xxxs-11) }
.rowTagWhen       { display:inline-flex; flex-wrap:wrap; align-items:center; gap:2px 6px; max-width:100% }
.stepWhen         { display:inline-flex; align-items:center; gap:6px; min-height:30px;
                    color:var(--dsw-alias-label-secondary) }
```
其余类（`.toolbar/.controls/.controlLabel/.button/.buttonOff/.chip/.chipOn/.countBadge/.totalsRow/.totalsLabel/.totalsMeta/.barTurn/.barTool/.barFill/.barSegment/.mixSegment/.deltaUp/.deltaDown/.numDelta/.detailHead/.detailCell/.detailActions/.copy/.timeValue/.timeWrap/.timeRunning/.stateRunning/.stateWarn/.stateMuted/.tone0..7`）在 `stats.module.css` 与 `StatsTable.tsx` 中，已提取到 `/tmp/dsh_extract/flat/`。

`StatsTable.tsx`（68,519 bytes）导出给 `StatsView.tsx` 的符号：`COLUMNS, EMPTY_STEP_VIEW, LOAD_OLDER_THRESHOLD, TableButton, TotalsRow, createViewState, defaultTurnOpen, isTimeRunning, totalSpan, turnRows, type StatsViewProps/StatsViewInjected/StepViewState/ViewState`。头部搜索/开关用 `@deepseek-ai/dsh-client-ui-primitives` 的 `SegmentedControl` 与 `Switch`。

### 1.3 `dsh-agent-team` / 消息语义（发送方→接收方）

README.zh.md（14,166 bytes）原文要点：
- 「成员通过标准 `list_agents` 发现整棵树，并通过 `send_message` 按名称联系另一成员。subagent 运行时负责路由、**发送方归属**和冷恢复。」
- 「历史 `team/message/queued`、`team/message/delivered` 记录和 `team-message` 来源仍可解码」
- 「每个根 agent 及其后代组成一个 Team。任务可分配给…任意深度的可继续执行后代」
- source map：`src/task-board.ts`（任务 CAS）、`src/journal.ts`（串行化日志事务）、`src/projection.ts`（发布 `agentTeam` 客户端视图）、`src/task-view.ts`（就绪性/写入重叠推导）。

=> Go 侧泳道的 `From/To/Agent/Event` 字段命名请对齐 DSH 的 `send_message` / sender / recipient / `team/message/*.jsonl`；箭头只是把 DSH 文本里的「发送方→接收方」变成视觉连线。

### 1.4 时间格式（DSH stats README 原文）

> 展开的步骤行在「触发」列显示该步开始时间戳（`MM-DD HH:MM:SS.mmm`，tooltip 为完整的 `YYYY-MM-DD HH:MM:SS.mmm`）

本项目问题5的 `relativeTimeFromMillis`（app/message_clock.go，agent-0001）覆盖「今天/昨天/前天/同年/跨年」，是 DSH 固定格式的**超集**；协作卡片事件时间必须调用它，不要另写 `time.Format("15:04")`（agent-0003 缺陷分流2）。

## 2. 因 Go UI 框架不得不不同的地方（差异清单）

| DSH（CSS/React） | Graph Go（mygo/ui） | 差异量 |
|---|---|---|
| `display:flex` / `grid` + `gap` | `ui.Row(ctx).Gap(th.Space(n))` / `ui.Column(ctx)`；未提供 CSS grid | 布局语法不同，视觉等价 |
| `position:sticky` 表头 | 需要把表头放在滚动容器外或每帧重建；mygo List 无 sticky | 视觉等价，实现不同 |
| `border:0.5px solid` / `box-shadow:inset 2px 0 0` | `ui.Box(ctx).Height(gwtheme.Hairline).Background(t.Border)`；inset 阴影需用一个 2px 竖条 Box 近似 | hairline 已用 0.5px 等价，误差 <1px |
| `color-mix(... 8% ...)` 错误行底色 | `t.Danger` 加低透明度或在 `t.Card` 上叠 `t.Hover` | 颜色近似，误差视觉可接受 |
| CSS 变量 `--dsw-alias-*` / `--dsw-font-xxs-12` | `gwtheme.Tokens`：`t.Text.Xs/Xs2`、`t.Muted`、`t.Border`、`t.Hover`、`t.Card`、`t.Foreground`；字号 12px≈`t.Text.Xs` | token 名不同，取值需查 `app/gwui/theme` |
| SVG 箭头连线 | mygo 无通用 SVG；用 `ui.Icon(ctx, iconChevron...)` 旋转 + 绝对定位短横段近似，或把箭头画进事件行文本 `A → B` | **这是最大的 1:1 缺口**：DSH 本身也没有箭头代码，只有文本「发送方」；建议箭头用 `→` 字形 + 颜色，不追求自由曲线 |
| `Tooltip delayMs=500 portal side=top` | `kit.Text(...).Tooltip?` 若不可用则点击事件详情里展示全文 | 交互降级，内容不丢 |
| 时间戳 tooltip | mygo 无 hover tooltip 时把完整时间放进点击详情 | 同上 |

**总差异评估**：结构、列宽百分比、间距（4/7/8px）、字号（12/13px）、行高（17/30px）、状态色映射可做到像素级 1:1；arrows 与 sticky/inset 是 DSH 里本就没有或 Go 框架不支持的部分，属于可接受偏差，但必须在最终报告里注明。

## 3. 给 agent-0011 的落地清单（可直接照抄的字段/数值）

1. 泳道 = 参与 Agent（`Lanes`），空输入时 `Lanes/Events/Links` 全空，**不要 `ensureLane(self)`**（agent-0014 FAIL-1）。
2. 每条泳道左侧：`Initial`（首字母，`.glyph` 14×17 / 居中）+ `Name`（13px/17px，600）+ 模型（`.progress` 13px tertiary）+ token/成本（`tabular-nums`）+ 任务数/事件数（`.stepCount` secondary/400）。
3. 事件时间列宽取 DSH 第 11 列 `15.5%`；时钟用 `.turnClock` 语义（tertiary/400）；数值 `font-variant-numeric: tabular-nums`。
4. 头部统计沿用 `progressLabel`：`完成 n · 进行中 n · 待办 n`，分隔符用 U+2002 EN SPACE。
5. 搜索框复用 `chatState.collabQuery`，点击事件详情复用 `chatState.collabEventID`（已在 `app/transcript.go` 由 agent-0011 加入）——重画/滚动稳定。
6. 事件行高 30px（`stepCell`），padding `0 8px 0 22px`，左侧 2px inset 竖条表示归属泳道。
7. 发送→接收：事件详情显示 `From → To`；若画连线，用颜色区分 From（business primary）/To（tertiary）+ `→` 字形，不要自造 DSH 不存在的曲线样式。
8. 时间一律 `relativeTimeFromMillis(millis, ctx.Now())`（app/message_clock.go），空/0 时间不显示标签。
9. 空态：无事件时整卡不渲染（DSH `TeamBoard` 行为）或显示 `.empty{padding:24px 0;color:secondary}` 文案，不要编造数据。

## 4. 提取产物位置（供复核）

- `/tmp/dsh_extract/flat/dsh__node_modules__@deepseek-ai__dsh-client-ui-agent-team__README.zh.md`
- `/tmp/dsh_extract/agentteam/TeamBoard.tsx.d/TeamBoard.tsx`（112 行完整）
- `/tmp/dsh_extract/agentteam/TeamBoard.module.css.d/TeamBoard.module.css`（165 行完整）
- `/tmp/dsh_extract/flat/dsh__node_modules__@deepseek-ai__dsh-experimental-client-ui-stats__README.zh.md`
- `/tmp/dsh_extract/flat/dsh__node_modules__@deepseek-ai__dsh-experimental-client-ui-stats__stats.module.css`（`*stats.module.css*`）
- `/tmp/dsh_extract/flat/*StatsTable.tsx / StatsView.tsx / stats-*.ts / locales.ts`
- `/tmp/dsh_extract/flat/dsh__node_modules__@deepseek-ai__dsh-agent-team__README.zh.md`

（/tmp 产物不进入交付，仅作复核；本文已把关键原文逐条抄录，脱离 /tmp 也可核对。）

---
DONE: 问题3 支撑 DSH 逆向文档（docs/DSH_COLLAB_CARD_ANALYSIS.md）← agent-0006
