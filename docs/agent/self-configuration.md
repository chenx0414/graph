# Graph Self Configuration

## 目标

Graph 把 Agent 可编辑上下文集中到固定目录：

```text
~/.graph/prompts/
  agents/
  tools/
  rules/
  runtime/
  defaults/
  tools.json
```

首次启动播种默认文件，之后不覆盖用户修改。用户可以通过聊天头部查看最终拼装结果、编辑来源文件、开关工具，或恢复某个文件的原始默认版本。Graph 自身文档不在这里，而是作为只读源码保存在仓库的 `docs/agent/`，并随应用一起打包。

聊天头部「Agent 上下文」抽屉里的 **实际发出** 标签展示的是**某一次真实模型请求**，而不是预览：提示词文本取自该请求的系统消息，工具声明取自同一个请求体的 `tools` 字段，两者都在 provider 调用点（`src/runtime/controlled-openai.ts` 的 fetch 包装器）写入 `operations.system_prompt` / `operations.tool_declarations`。它们是只读展示，不参与发送，也不会使模型多收一份声明。会话里没有真正发过请求（或该请求早于记录功能）时，该标签会明确说「尚未记录到」，而不会拿预览顶替。

`defaults/` 保存用户点击「设为默认」后的基线。该动作同时保存当前内容；空文件也是合法默认值。后续「恢复默认」优先回到用户默认，未设置用户默认时才回到代码内置原版；存在自定义默认时，「恢复内置」会清除该文件并回到代码原版。

**生效层与仓库种子的区别**：`agents/*.md`、`rules/*.md` 等 editable 文件一旦存在于 `~/.graph/prompts/`，就**整份覆盖**代码内置的默认文本（`src/runtime/agent-context-assembly.ts` 的 `input.library?.prompt(...) ?? DEFAULT_*`）。所以仓库里只有一份很短的种子：在仓库里 grep 规则编号（例如 `R18`）会一无所获，但这并不代表规则没有生效。判断一条规则是否真的生效，要看 `~/.graph/prompts/rules/<role>.md` 的实际内容（或聊天头部「Agent 上下文」的最终拼装视图），改规则也应该改那里。

## 结构化 Composer

Graph 自己组装最终 system prompt，顺序为：

```text
identity -> tools -> rules -> docs -> project_context -> capabilities -> cwd
```

Pi 在 0.85.1 中还会自动追加 `Current working directory`。UI 必须把这段标成 Pi-generated，不把它和 Graph 可编辑文件混在一起。

## 可编辑、生成和 Pi 内容

- **editable**：用户维护的 identity、tool guidance、rules 和 runtime prompt 文件。
- **generated**：从当前 definition、实际工具、capability load facts、项目 instructions、worktree 和源码 docs 路径拼出的内容。
- **pi**：Pi 自身自动追加的 system prompt 内容，例如 cwd。

用户编辑 editable 文本不能改变 generated 事实，也不能改变 host-enforced authority。
Docs section 由源码 `docs/agent/README.md`、topic 索引和阅读协议动态生成；docs 正文不进入可编辑来源列表。

`<tools>` section 先列 Pi 原生 coding tools，再以过渡段引出 Graph tools。工具清单只保留名称与简短说明；参数、版本、权限摘要和运行时可用性保留在 UI 工具详情中。

`tools/main.md` 默认留空，不再附加内置的 capability-awareness 长说明；用户添加内容后才会出现在工具清单之后。

## 工具选择

Main Agent 的工具选择保存为 disabled list。关闭工具时：

- provider tool schema 不再提供该工具；
- Agent session allowlist 不再启用；
- system prompt 的 tools/capabilities section 同步更新。

Pi 原生工具 `read/bash/edit/write/ls/find/grep` 以及 Windows 上的 `powershell` 同样可以被 disabled list 关闭，但不能通过 Prompt 绕过它们对应的 host/sandbox 权限。
首次启动时 `powershell` 默认关闭；在支持的 Windows 平台上，用户可以在工具选择中显式开启。

工具详情应显示来源、版本、参数、权限摘要和当前可用性。UI 不伪造实际 tool surface；如果需要 operation 运行后才能确认的动态工具，应明确显示 unknown 或 unavailable。

## 系统变更

直接编辑可编辑 prompt 文件是用户配置行为。安装、更新或替换 capability 属于系统变更：

1. Main Agent 用 `propose_system_change` 创建提案；
2. 用户批准；
3. Main Agent 用 `apply_system_change` 应用；
4. Host 重新扫描并验证。

完全访问模式会自动批准运行授权，但仍应保留提案、应用验证和审计记录。暂停、预算、未知用量和恢复问题不阻塞调用；并发上限、人工验收、模型订阅决策和任务图确认仍独立。

## Harness 自我改进（RSI）

在完全访问模式下，Main Agent 同时是 Graph Harness 的改进者。RSI 不限于修 bug：只要它能给出理由，修缺陷、重构、新增功能、改进命令或文档都可以改。它用 `inspect_rsi_status` 读取源码 checkout、当前分支、待重载请求、仍在运行的 operation 及其身份（task/node/request/archived），再用 `apply_rsi_change` 提交一次结构化改动：

- 修改 Graph 源码 checkout 内的文件（`write` / `replace` / `delete`），拒绝 `.git` 与路径逃逸，要求目标文件没有未提交改动；
- 运行检查（自定义 `node` 检查、`node --run check`，`activate` 时再加 `node --run app:build`）；
- 提交到专用 `rsi/*` 分支；
- `activate` 为真时写出 `<stateDir>/rsi/restart.json`，由桌面进程在 operation 停稳后重启 daemon 让改动生效；`force` 为真时跳过等待、立即重载，可能中断在途 operation。

调用形状是固定的（写错会白跑一个来回，报错会点名缺哪个字段）：`title`、`problem`、`changes`、`checks` 都是**顶层**字段；`changes[]` 的每个条目必须带 `path`（仓储相对路径）与 `action`（`write` / `replace` / `delete`），`write` 配 `content`、`replace` 配 `edits`；`checks` 里每项是 `{ command, args }`，也放顶层，不要塞进单个 change 里。

检查必须能证明它声称的东西：`node --run check` 同时跑 typecheck 与全部测试，是「快检」的下限。只拿单文件 vitest 当检查会漏掉类型错误（实际漏过两次：一次 TDZ、一次忘了提拔 `SCHEMA_VERSION`），所以快检至少写成 `node --run typecheck && node node_modules/vitest/vitest.mjs run <files>`，或者直接用 `node --run check`。

检查失败不会丢弃改动：文件保留在工作区、不提交、不重载，receipt 状态为 `checks_failed`。Main Agent 继续修复同一批文件，或传 `changes: []` 只重跑检查，直到通过；只有意外错误才恢复快照。每次 RSI 操作都会写 `rsi.change` 事件，并在 conversation 中追加 `kind=rsi` 的可见报告，包含问题、证据、诊断、影响、风险、文件、验证、提交和重载状态。

`status=applied` 表示提交完成。`activate=true` 成功后，工具会结束当前回合，`activation.state=pending_reload` 表示等待重载；不要继续调用工具、追加 RSI 改动或报告“已生效”。已有 operation 结束前，新消息保持排队。宿主确认新 daemon 的提交与请求匹配后，报告更新为 `activation.state=active`，`inspect_rsi_status.lastActivation` 返回该次确认，主管会自动恢复原请求，无需用户发送 continue 或“已重载”；排队的新消息在同一轮优先处理。暂停时延后续跑，归档或终止时不自动唤醒。需要先做多个中间提交时使用 `activate=false`（状态 `saved`），最后再请求激活。

RSI 只改"正在运行的这份代码"，所以：

- 在 checkout 里运行（`electron .` 或 CLI）：应用根就是 checkout，默认可用。
- 打包应用：`Graph.app/Contents/Resources/app` 是构建时复制出来的副本，不是 Git 仓库，默认不可用。把 `GRAPH_RSI_ROOT` 指向一个 checkout，启动器会改从该 checkout 运行 daemon，RSI 才会真正生效。
- 不可用时 `inspect_rsi_status` 仍返回 `available: false` 与原因，`apply_rsi_change` 不注册。

### 何时不建图任务（R20）

单点的产品行为、默认值或文案调整（不需要并行车道、独立审查闸门与人工验收闭环）由 Main Agent 用 `apply_rsi_change` 亲力亲为：一次提交 + 宿主完整门禁 + 重载 + 现场自验（真浏览器读 DOM + 截图）+ 交人工验收即可，**不建图任务、也不留待确认的草稿**。只有需要多车道并行、独立审查与人工验收闭环的较大改动才建图。这类改动的草稿若已被取代，用 `withdraw_draft` 作废它，不要挂着误导后续回合。

## 原版恢复

Graph 在代码/preset 中保留每个可编辑 prompt 文件的原始版本。`defaults/` 只保存用户明确设为默认的内容；恢复默认只覆盖对应可编辑文件，不修改能力缓存、用户工具清单或项目文件。只读 Agent docs 直接来自源码，不存在需要恢复的用户覆盖版本。

## Runtime Prompt 注入时机

- `runtime/worker.md`：每次非 Main Agent operation 组装 system prompt 时，注入 `<rules>` 的 runtime 部分。
- `runtime/prompt-suggestion.md`：Main Agent 完成回复后，为下一条输入建议启动独立模型请求时作为该请求的 system prompt。
- `runtime/main-conversation.md`、`runtime/main-graph.md`：早期 Main Agent 工作流文本，当前版本不注入任何 system prompt，仅保留编辑和迁移用途。

## 不应宣称

- 不能宣称 prompt 文件就是权限。
- 不能宣称关闭工具就卸载了 extension 的全部 hook。
- 不能宣称生成内容可以由用户直接编辑。
- 不能把未读取的 docs 内容当成当前事实。
