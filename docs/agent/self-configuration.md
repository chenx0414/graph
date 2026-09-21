# Graph Self Configuration

## 目标

Graph 把 Agent 可编辑上下文集中到固定目录：

```text
~/.graph/prompts/
  agents/
  tools/
  rules/
  runtime/
  tools.json
```

首次启动播种默认文件，之后不覆盖用户修改。用户可以通过聊天头部查看最终拼装结果、编辑来源文件、开关工具，或恢复某个文件的原始默认版本。Graph 自身文档不在这里，而是作为只读源码保存在仓库的 `docs/agent/`，并随应用一起打包。

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

Pi 原生工具 `read/bash/edit/write/ls/find/grep/powershell` 同样可以被 disabled list 关闭，但不能通过 Prompt 绕过它们对应的 host/sandbox 权限。
首次启动时 `powershell` 默认关闭；用户可以在工具选择中显式开启。

工具详情应显示来源、版本、参数、权限摘要和当前可用性。UI 不伪造实际 tool surface；如果需要 operation 运行后才能确认的动态工具，应明确显示 unknown 或 unavailable。

## 系统变更

直接编辑可编辑 prompt 文件是用户配置行为。安装、更新或替换 capability 属于系统变更：

1. Main Agent 用 `propose_system_change` 创建提案；
2. 用户批准；
3. Main Agent 用 `apply_system_change` 应用；
4. Host 重新扫描并验证。

完全访问模式可以自动批准运行授权，但仍应保留提案、验证和审计。

## 原版恢复

Graph 在代码/preset 中保留每个可编辑 prompt 文件的原始版本。恢复默认只覆盖对应可编辑文件，不修改能力缓存、用户工具清单或项目文件。只读 Agent docs 直接来自源码，不存在需要恢复的用户覆盖版本。

## 不应宣称

- 不能宣称 prompt 文件就是权限。
- 不能宣称关闭工具就卸载了 extension 的全部 hook。
- 不能宣称生成内容可以由用户直接编辑。
- 不能把未读取的 docs 内容当成当前事实。
