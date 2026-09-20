# Graph Agent System Prompt 与 Docs 研究

研究日期：2026-09-20

研究范围：读取本地 Pi 0.86.0 源码、Graph 实际安装的 Pi 0.85.1 包，以及 Graph 当前的
prompt、工具、系统自省和 UI 接入点，用于判断 Pi system prompt / docs 的组装方式及其对
Graph 的适用边界，并形成可实施的 Graph 设计。本文不修改产品源码、测试或配置。

状态：研究完成，尚未进入实施。

## 版本与引用基线

| 对象 | 版本 / commit | 本地路径 |
| --- | --- | --- |
| Pi 研究源码 | `0.86.0`，commit `d1230ea2000d876b479a69b8b061f9d670f262f5` | `/Users/macmini/Downloads/pi` |
| Graph 实际使用 | `@earendil-works/pi-coding-agent@0.85.1` | `/Users/macmini/workspace/13-Graph/node_modules/@earendil-works/pi-coding-agent` |
| Graph 基线 | `ada065290cb4f6f1de7f3690ba7b2463a770309e` | `/Users/macmini/workspace/13-Graph` |

Graph 将 Pi 三个包都精确锁在 `0.85.1`，见
`/Users/macmini/workspace/13-Graph/package.json:48-50` 与
`/Users/macmini/workspace/13-Graph/pnpm-lock.yaml:197-200`。

Pi clone 的 `package.json` 是 `0.86.0`，但该 commit 的 changelog 仍有 `Unreleased`
区段，见 `/Users/macmini/Downloads/pi/packages/coding-agent/CHANGELOG.md:1-9`。
因此本文所说 “Pi 0.86.0” 是该本地源码快照，而不仅是 npm 上某个不可变 tag 的推断。

引用格式：

- `Pi 0.86.0:相对路径:行号` 表示
  `/Users/macmini/Downloads/pi/相对路径`。
- `Pi 0.85.1:相对路径:行号` 表示
  `/Users/macmini/workspace/13-Graph/node_modules/@earendil-works/pi-coding-agent/相对路径`。
- `Graph:相对路径:行号` 表示 `/Users/macmini/workspace/13-Graph/相对路径`。

## 结论摘要

1. Pi 0.86.0 的默认 system prompt 是“带稳定 section 名的分层 prompt”。固定顺序为：
   identity、tools、rules、docs、addendum、project context、skills、cwd、扩展自定义
   sections。除 `preamble` 外，每一段都包进同名 XML 标签。
2. Pi 0.85.1 的默认文本内容和先后顺序与 0.86.0 基本一致，但实现只是拼一个普通字符串：
   没有 `sections`、没有 section diff、没有 `forceSystemPrompt`，也没有按工具名传入的
   `toolGuidelines` map。
3. `customPrompt` 不是“只替换身份的一句话”，而是替换默认 prompt 的前缀，并直接跳过默认
   tools、rules、docs 三段；addendum、project context、skills、cwd 仍会在后面追加。
   如果 Graph 用 `agent.md` 作为 custom prompt，又想保留 Pi 风格的 tools/rules/docs，
   这些段必须由 Graph 自己组装为最终 prompt 或受控全量替换文本；只升级到 0.86.0 并利用
   结构化 sections 也不能直接得到“自定义 preamble + 默认 tools/rules/docs”，因为
   0.86.0 明确禁止自定义 `preamble`，而 `customPrompt` 仍会跳过那三段默认内容。
4. Pi 原生没有 `agent.md` 这个 prompt 类型。它的 `agent.md` 等价物是启动时发现的
   `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md`，进入的是 `project_context`，
   不进入 identity。
5. Pi 的 docs 和 skills 都采用渐进披露：system prompt 只放绝对路径、主题索引或
   skill 的名称/描述/文件位置；完整内容由模型按需用通用 `read`（没有 `read` 时用
   `bash`）读取。没有单独的 docs loader，也没有自动把 docs 全文塞入 prompt。
6. Pi 0.85.1 与 0.86.0 的 docs 目录文件集合基本相同，system prompt 中生成的 docs 指针
   文本逐字一致；0.86.0 的导航 JSON 只多了一个 Environment Variables 入口。因此
   “docs 路径 + 按需读取”的结论可直接用于 Graph；真正需要升级或适配的是 prompt
   结构化、增量 patch 和 provider stream contract。
7. Graph 当前使用 0.85.1，并且主动禁用了 Pi 的 AGENTS、默认 skills、context files 等
   discovery，自建 `systemPrompt + appendSystemPrompt`。因此 Pi 原生 tools/rules/docs
   分段当前并没有自动出现在 Graph Agent 中；Graph 需要自行增加 docs/rules 段，或改变
   接入方式。
8. 0.86.0 升级有一个直接影响 Graph broker 的 breaking change：provider stream 输入从
   `Context` 变成 `TranscriptContext`。Graph 当前的 custom stream 仍从
   `context.systemPrompt` / `context.tools` 读取，升级后必须改为从
   `messages` 中的 system message replay 出当前 prompt 和 tools。

## Pi 0.86.0 的精确组装模型

### 输入数据

`buildSystemPrompt` 的输入包括 custom/forced prompt、selected tools、tool snippets、
每工具 guidelines、额外 guidelines、append prompt、自定义 sections、cwd、context files
和 skills，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:9-32`。

标准化会补齐默认值：

- 默认 selected tools 是 `read`、`bash`、`edit`、`write`。
- context files 与 skills 默认空数组。
- append prompt、sections、guidelines 等默认空值。

见 `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:53-70`。

### 最终顺序

0.86.0 的 section 插入顺序是对象属性顺序，具体如下：

| 顺序 | section | 条件 | 标签 | 来源 |
| ---: | --- | --- | --- | --- |
| 1 | `preamble` | 总是 | 无标签 | 默认身份句，或 `customPrompt` |
| 2 | `tools` | 仅默认 prompt 分支 | `<tools>` | selected tools + tool snippets |
| 3 | `rules` | 仅默认 prompt 分支 | `<rules>` | 内置、tool guidelines、额外 guidelines |
| 4 | `docs` | 仅默认 prompt 分支 | `<docs>` | Pi package 内的 README/docs/examples 绝对路径 |
| 5 | `addendum` | `appendSystemPrompt` 非空 | `<addendum>` | `APPEND_SYSTEM.md`、CLI 或 SDK 传入 |
| 6 | `project_context` | context files 非空 | `<project_context>` | AGENTS/CLAUDE 文件 |
| 7 | `skills` | 至少加载一个可见 skill，且 active tools 含 `read` 或 `bash` | `<skills>` | skill 名称、描述、SKILL.md 绝对路径 |
| 8 | `cwd` | 总是 | `<cwd>` | AgentSession 的 cwd，反斜杠会转成 `/` |
| 9 | 自定义 sections | 每个非空 section | 同名 XML 标签 | extension 传入或修改 |

对应源码：

- preamble、tools、rules、docs：
  `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:142-161`
- addendum、project context、skills、cwd、自定义 sections：
  `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:163-173`
- 最终 XML 包装：
  `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:175-179`

除 `preamble` 外，每段都是：

```xml
<section_name>
内容
</section_name>
```

`getSystemMessageText` 将 prompt content 与所有 section 值用两个换行连接，见
`Pi 0.86.0:packages/ai/src/utils/text.ts:14-20`。

### 身份认知 / identity

无 `customPrompt` 时，identity 是固定的一句：

> You are an expert coding assistant operating inside pi, a coding agent harness...

见 `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:143-147`。

有 `customPrompt` 时，它直接成为 `preamble`，见同一文件 `143-145`。因此 Pi 的
custom prompt 是 identity 和默认能力说明整体前缀的替换入口，而不是只会覆盖一行角色介绍。

### tools

默认分支才生成 `tools` section，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:148-151`。

规则是：

1. 从 `selectedTools` 开始。
2. 只有对应 `toolSnippets[name]` 非空的工具，才出现在 “Available tools” 列表。
3. 一个工具即使实际可调用，只要没有 prompt snippet，也不会出现在这一人类可读的工具段里。
4. 列表后会固定追加一句：除此之外可能还有项目相关的 custom tools。

这与工具的真实 schema 是两套表示：prompt 的 `<tools>` 是摘要，可执行工具定义另有
provider tool declaration。0.86.0 的工具声明随 transcript 的 `toolsAdded` /
`toolsRemoved` 变化，见
`Pi 0.86.0:packages/agent/src/agent-loop.ts:281-320`。

自定义工具通过 `promptSnippet` 进入该段，通过 `promptGuidelines` 进入 rules；二者只在
工具 active 时生效，见
`Pi 0.86.0:packages/coding-agent/docs/extensions.md:1952-1960`。

### rules

默认 rules 的顺序在 `buildRules` 中是固定的，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:81-118`：

1. 如果只有 bash/PowerShell，且没有 grep/find/ls，则加入文件探索建议。
2. 按 `selectedTools` 的顺序，加入每个工具的 `toolGuidelines`。
3. 加入显式传入的 `promptGuidelines`。
4. 始终加入 “Be concise in your responses”。
5. 始终加入 “Show file paths clearly when working with files”。
6. 按首次出现去重并 trim。

因此 tool guideline 并不是按工具名字母排序，也不是全局 map 遍历顺序，而是跟随 active
tools 的顺序。

### docs

默认分支的 docs section 只包含路径和阅读规则，不包含文档正文，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:153-160`。

它明确要求：

- 只在用户询问 Pi 自身、SDK、extension、theme、skill 或 TUI 时读取。
- Main documentation、Additional docs、Examples 分别给出绝对路径。
- `docs/...` 要相对 Additional docs 解析，`examples/...` 要相对 Examples 解析，
  不能相对当前项目 cwd 解析。
- 用户问 extension/theme/skill/prompt template/TUI/keybinding/SDK/custom provider/
  model/package/environment variables 时，分别读取列出的 `docs/*.md` 或
  `examples/*`。
- 处理 Pi 主题时要读 docs 和 examples，并沿 Markdown 交叉引用继续读。
- 必须完整读取 Pi `.md` 文件，再跟随相关链接。

### project context / “agent.md”

Pi 没有叫 `agent.md` 的内置身份文件。它的项目上下文来源是：

`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`

每个目录按以上顺序选择第一个存在的普通文件，见
`Pi 0.86.0:packages/coding-agent/src/core/resource-loader.ts:71-90`。

加载顺序是：

1. global `agentDir/AGENTS.md`（或上列其它候选）。
2. 从文件系统根目录到 cwd 的 ancestor context files。
3. cwd 自身的 context file。

同一目录只取优先级最高的一个；路径去重；linked worktree 会避免重复加载被主 worktree
shadow 的同一文件，见
`Pi 0.86.0:packages/coding-agent/src/core/resource-loader.ts:119-157`。

所有 context files 最终进入一个 `project_context` section，每个文件包成：

```xml
<project_instructions path="/absolute/path/AGENTS.md">
...
</project_instructions>
```

见 `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:72-79` 与
`164`。

文档确认用户可见的设置方式：global `~/.pi/agent/AGENTS.md`，project 的
`AGENTS.md` / `CLAUDE.md` 和父目录逐层继承，`AGENTS.override.md` 优先，见
`Pi 0.86.0:packages/coding-agent/docs/quickstart.md:86-105` 与
`Pi 0.86.0:packages/coding-agent/docs/usage.md:100-119`。修改后需重启或 `/reload`，
见 `Pi 0.86.0:packages/coding-agent/docs/quickstart.md:105` 与
`Pi 0.86.0:packages/coding-agent/docs/usage.md:59`。

SDK 还可以通过 `agentsFilesOverride` 追加虚拟 context file，见
`Pi 0.86.0:packages/coding-agent/docs/sdk.md:706-723`。

### skills

只有当 active tools 里存在 `read` 或 `bash`，且有加载到的 skill 时，才生成 skills
section，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:165-169`。

system prompt 中每个 skill 只有：

- name
- description
- `SKILL.md` 的绝对 location

格式由 `formatSkillsForPrompt` 生成，见
`Pi 0.86.0:packages/coding-agent/src/core/skills.ts:347-383`。
`disable-model-invocation: true` 的 skill 不进入 prompt。

完整 skill 内容不会自动注入。prompt 明确提示模型在任务匹配时用 `read`，或者在没有
`read` 时用 `bash` 读取 `SKILL.md`；相对路径要相对 skill 目录解析。文档也把这一点
定义为 progressive disclosure，见
`Pi 0.86.0:packages/coding-agent/docs/skills.md:65-72`。

### cwd

cwd 无条件追加，Windows 反斜杠会先转为 `/`，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:170`。
它来自 AgentSession 构造时的 `_cwd`，该值来自 session 创建时的 resolved cwd，见
`Pi 0.86.0:packages/coding-agent/src/core/agent-session.ts:392-423`。

### 自定义 sections

0.86.0 在 cwd 之后处理 extension 自定义 sections，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:171-173`。

- section 名必须匹配 `^[a-z][a-z0-9_-]*$`。
- `preamble` 是保留名，不能作为自定义 section。
- 空字符串不会写入。
- 如果自定义名与内置名相同，会覆盖该 section 内容；这是 extension 修改内置段的正式
  方式之一。
- 覆盖已有 section 时，JavaScript 对象会保留原插入位置；如果是 `customPrompt` 分支下
  新加名为 `tools`、`rules` 或 `docs` 的 section，它们只能作为 cwd 之后的新属性插入，
  不会自动恢复默认分支中的原型位置。

校验位置见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:136-140`。

## `customPrompt`、append 与 forced prompt 的区别

| 入口 | 0.86.0 行为 | 仍会保留哪些段 | 主要用途 |
| --- | --- | --- | --- |
| `customPrompt` | 只设置 `preamble`，跳过默认 tools/rules/docs | addendum、project context、skills、cwd、自定义 sections | 用外部 SYSTEM.md 或 Graph identity 替换默认前缀 |
| `appendSystemPrompt` | 增加 `addendum` | 默认分支下所有段都会保留 | 追加用户或宿主指令 |
| 自定义 `sections` | 增加或覆盖指定 section | 其它段保留 | extension/宿主结构化修改 |
| `forceSystemPrompt` | 完全替换最终 prompt，无 sections | 不保留其它段 | `before_agent_start` handler 的精确全量替换 |

`forceSystemPrompt` 的状态生成见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:186-197`。

这是一个重要设计分界：

- 想保留 Pi 默认 tools/rules/docs，只追加内容，用 `appendSystemPrompt`。
- 想换 identity，但自己提供 tools/rules/docs，用 `customPrompt`。
- 0.86.0 想精细修改单段，应优先修改结构化 `sections`。
- 只有确实需要整段替换时，才使用 forced prompt。

需要特别注意：0.86.0 的 `sections.preamble` 是保留名，不能由调用方直接设置；同时
`customPrompt` 一旦存在，默认 tools/rules/docs 就不会生成。因此 “保留 Pi 默认
tools/rules/docs，同时把 identity 换成 Graph 的 `agent.md`” 不是 0.86.0 原生 builder
直接提供的组合。若 Graph 要求精确顺序和完整可视化，最稳妥的路径仍是 Graph 维护结构化
模型并生成最终 prompt，再把最终结果交给 Pi；或者使用受控的全量替换通道。

## 运行时注入与可编辑性

### 基础 prompt 的构建

0.86.0 的 `AgentSession` 从 ResourceLoader 取得：

- custom system prompt
- append prompt
- loaded skills
- loaded AGENTS files

再把 active tools、tool snippets 和 tool guidelines 合并成 base prompt options，见
`Pi 0.86.0:packages/coding-agent/src/core/agent-session.ts:1113-1137`。

### 每轮请求前

每次 prompt 在真正运行 Agent 前触发 `before_agent_start`：

- handler 拿到当前 chained system prompt。
- handler 拿到可变的 `systemPromptOptions`。
- 多个 handler 可以按 extension 加载顺序继续修改。

见
`Pi 0.86.0:packages/coding-agent/src/core/agent-session.ts:1406-1433` 与
`Pi 0.86.0:packages/coding-agent/src/core/extensions/runner.ts:1174-1225`。

0.86.0 推荐修改：

- `sections`
- `selectedTools`
- `promptGuidelines`

如果 handler 返回 `systemPrompt`，runner 会把它写入 `forceSystemPrompt`，后续 request
使用完整替换文本。文档说明这些语义见
`Pi 0.86.0:packages/coding-agent/docs/extensions.md:532-568`。

### section diff 与持久化

0.86.0 不再每轮直接覆盖一个大字符串，而是：

1. 从 transcript 回放当前 system message sections。
2. 与期望 sections 做 diff。
3. 只生成变化的 section patch。
4. 同时把可执行工具设置更新为 selected tools。

见 `Pi 0.86.0:packages/coding-agent/src/core/agent-session.ts:1149-1162`。

forced prompt 不写进 transcript；transcript 仍记录结构化 sections。request-time
projection 会把 forced text 放到 provider 的首个 system message，见
`Pi 0.86.0:packages/coding-agent/src/core/agent-session.ts:1165-1188`。

session-format 文档明确：首个请求会持久化完整 prompt section 和工具声明，后续变化作为
system message patch，`sections` 用 `null` 删除，工具用 `toolsAdded` /
`toolsRemoved` 表达，见
`Pi 0.86.0:packages/coding-agent/docs/session-format.md:226-235`。

### 用户可编辑入口

0.86.0 中可直接落到 prompt 的用户入口：

| 来源 | 文件 / 入口 | 行为 |
| --- | --- | --- |
| CLI | `--system-prompt <text>` | 作为 `customPrompt`；文本或存在的文件路径都可 |
| CLI | `--append-system-prompt <text>` | 可重复，追加为 `addendum` |
| Project prompt | `.pi/SYSTEM.md` | 项目受信任时替换默认 prefix |
| Global prompt | `~/.pi/agent/SYSTEM.md` | 全局替换默认 prefix |
| Project append | `.pi/APPEND_SYSTEM.md` | 项目 append |
| Global append | `~/.pi/agent/APPEND_SYSTEM.md` | 全局 append |
| Project instructions | AGENTS/CLAUDE 文件 | 进入 `project_context` |
| Skills | `SKILL.md` | 进入 `skills` section，正文按需读取 |
| Tool definitions | `promptSnippet` / `promptGuidelines` | 进入 tools/rules |
| Extensions | `before_agent_start` | 每轮修改 sections/tools 或全量替换 |
| SDK | ResourceLoader overrides | 程序化覆盖 prompt、append、skills、context |

CLI 解析见
`Pi 0.86.0:packages/coding-agent/src/cli/args.ts:110-114`；
主程序把值传入 ResourceLoader，见
`Pi 0.86.0:packages/coding-agent/src/main.ts:766-778`。

`SYSTEM.md` / `APPEND_SYSTEM.md` 的 project 优先、global fallback 逻辑见
`Pi 0.86.0:packages/coding-agent/src/core/resource-loader.ts:1023-1049`。
显式 `systemPrompt` 配置优先于 discovery，见
`Pi 0.86.0:packages/coding-agent/src/core/resource-loader.ts:526-545`。

SDK override 示例见
`Pi 0.86.0:packages/coding-agent/docs/sdk.md:503-518`。

## Docs 如何被 Pi 自己按需读取

### 路径来源

Pi 的 docs paths 不是项目目录，而是当前 Pi package 目录下的资源：

- README：`getReadmePath()` = package root `README.md`
- docs：`getDocsPath()` = package root `docs/`
- examples：`getExamplesPath()` = package root `examples/`

见 `Pi 0.86.0:packages/coding-agent/src/config.ts:439-452`。

### 注入方式

Pi 只把上述绝对路径和主题映射写进 `<docs>` section，见
`Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:153-160`。
它不会把 README、docs 或 examples 正文自动注入 context。

### 实际读取机制

没有专门的 `read_pi_docs` 工具。模型按普通文件读取路径：

- 首选 `read` 工具。
- 没有 `read` 时才用 `bash`。

这也正是 skills 的文档化行为，见
`Pi 0.86.0:packages/coding-agent/docs/skills.md:65-72`。
内置 `read` 接受相对或绝对路径，并支持文本与图片，见
`Pi 0.86.0:packages/coding-agent/src/core/tools/read.ts:15-23` 与
`64-77`。

### Docs catalog

0.86.0 的 `docs/docs.json` 是人类文档导航 catalog，定义 Start here、Customization、
Reference、Programmatic Usage、Platform Setup、Development 六组，见
`Pi 0.86.0:packages/coding-agent/docs/docs.json:1-149`。

`docs/index.md` 同时给出各组入口和用途，见
`Pi 0.86.0:packages/coding-agent/docs/index.md:39-84`。

但 system prompt 没有要求模型先读 `docs.json`，也没有把 catalog 自动注入。模型可以：

- 根据 `<docs>` 中明确列出的主题和相对路径直接读取；
- 或先用 `read`/`bash` 列出 Additional docs；
- 再沿 Markdown 链接读取。

因此 “Pi 自己能按需读取全部 docs” 是 prompt 指令和通用文件工具的组合能力，不是一个被
代码强制执行的检索层；模型仍可能不读取。

## Pi 0.86.0 与 Graph 实际使用的 0.85.1 对比

### 无影响差异

以下事实在两版中实质相同，可以直接沿用：

1. 默认 prompt 的文案骨架相同：
   identity、Available tools、Guidelines、Pi documentation、append、project context、
   skills、cwd。
   对比 `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:142-170` 与
   `Pi 0.85.1:dist/core/system-prompt.js:7-117`。
2. docs 指针和主题列表逐字一致：
   `Pi 0.86.0:packages/coding-agent/src/core/system-prompt.ts:153-160` 与
   `Pi 0.85.1:dist/core/system-prompt.js:91-98`。
3. README/docs/examples 路径算法一致：
   `Pi 0.86.0:packages/coding-agent/src/config.ts:439-452` 与
   `Pi 0.85.1:dist/config.js:357-367`。
4. AGENTS/CLAUDE 候选、global + ancestor + cwd 加载顺序和 linked worktree 去重逻辑一致：
   `Pi 0.86.0:packages/coding-agent/src/core/resource-loader.ts:71-157` 与
   `Pi 0.85.1:dist/core/resource-loader.js:32-109`。
5. `SYSTEM.md` / `APPEND_SYSTEM.md` 的 project/global discovery 一致：
   `Pi 0.86.0:packages/coding-agent/src/core/resource-loader.ts:1023-1049` 与
   `Pi 0.85.1:dist/core/resource-loader.js:809-830`。
6. skills 的 XML 格式、`disable-model-invocation` 排除和 on-demand read 文案一致：
   `Pi 0.86.0:packages/coding-agent/src/core/skills.ts:347-383` 与
   `Pi 0.85.1:dist/core/skills.js:267-307`。
7. docs 文件集合基本相同；0.86.0 的 `docs.json` 仅在 Reference 增加
   Environment Variables 导航入口，见
   `Pi 0.85.1:docs/docs.json:82-88` 与
   `Pi 0.86.0:packages/coding-agent/docs/docs.json:82-92`。

### 影响设计的差异

| 能力 | Pi 0.85.1 | Pi 0.86.0 | Graph 影响 |
| --- | --- | --- | --- |
| `buildSystemPrompt` 返回值 | 一个完整 string | structured state：content 或 sections | 0.86.0 的结构化能力不能直接从 0.85.1 使用 |
| section 名称 | 无；只是普通文本结构 | preamble/tools/rules/docs/addendum/project_context/skills/cwd/custom | 可做 section 级查看、编辑和 patch |
| `toolGuidelines` | 不接收 map；AgentSession 先按 active tool 顺序拍平为 `promptGuidelines` | 按 selected tools 顺序直接应用 per-tool guidelines | 最终规则顺序可直接复用；API 形态需适配 |
| 自定义 sections | 无 | 支持并可按名字覆盖 | 0.86.0 才能原生实现 |
| forced full prompt | 无；extension 返回的是 per-turn `systemPrompt` 全量字符串覆盖 | `forceSystemPrompt`，request-time leading system prompt projection | 0.86.0 语义更稳定 |
| 每轮 prompt 更新 | 覆盖 `agent.state.systemPrompt`，下一轮未修改时恢复 base | section diff + transcript patch | 0.86.0 才能保留稳定前缀和跨 resume/branch prompt 状态 |
| session 持久化 | session-format 只有 user/assistant/toolResult 等消息，没有 SystemMessage | 首个 system message 持久化完整 sections/tools，后续 system message patch | 升级会改变 Graph 对 session JSONL 的解释方式 |
| provider stream contract | provider 接收普通 `Context`，包含 `systemPrompt` / `tools` | provider 接收 `TranscriptContext`，必须从 `messages` replay | Graph 的 broker/custom stream 必须适配 |

底层证据：

- 0.85.1 system prompt API 只定义 `customPrompt`、`selectedTools`、`toolSnippets`、
  `promptGuidelines`、append、cwd、context files、skills，返回 string，见
  `Pi 0.85.1:dist/core/system-prompt.d.ts:5-27`。
- 0.85.1 AgentSession 把 per-tool guidelines 拍平到 `promptGuidelines`，再调用
  `buildSystemPrompt`，见
  `Pi 0.85.1:dist/core/agent-session.js:738-767`。
- 0.85.1 per-turn extension override 是整个 `systemPrompt` 字符串，见
  `Pi 0.85.1:dist/core/extensions/runner.js:881-934` 与
  `Pi 0.85.1:dist/core/agent-session.js:914-939`。
- 0.85.1 session format 没有 SystemMessage，见
  `Pi 0.85.1:docs/session-format.md:203-211`。
- 0.86.0 把 transcript-aware prompt/tool updates 列为新能力，并把 provider stream
  从 `Context` 改成 `TranscriptContext` 列为 breaking change，见
  `Pi 0.86.0:packages/coding-agent/CHANGELOG.md:13-27`。
- 0.86.0 明确要求 custom provider 从 `context.messages` 读取 system prompt/tools，见
  `Pi 0.86.0:packages/coding-agent/docs/custom-provider.md:409-432`。

## 对 Graph 的直接适用性判断

### 可以直接采用的结论

1. 分层语义可以直接采用：
   identity、tools、rules、docs、agent context、skills、cwd。虽然 0.85.1 不做 section
   对象，Graph 可以自己在 prompt 层维持同等结构。
2. `AGENTS.md` 类文件应作为 project context，不应冒充 identity。
3. docs 与 skills 都应只向模型暴露稳定路径和摘要，正文按需读取。
4. docs 路径必须是宿主提供的绝对根路径，并明确说明 `docs/...` 相对该根解析，而不是相对
   Agent workspace。
5. tools 的人类可读条目只显示有 snippet 的工具；无 snippet 的 custom tool 仍可执行但
   不可见。Graph 如果增加“用户可精简工具”UI，应同时控制可执行 tool list 和 prompt
   可见性，不能只隐藏文案。
6. 0.86.0 的稳定 section 思路可以作为 Graph 自己 prompt 文档模型的设计参考，即使暂不
   升级：人可编辑的是结构化 section，而不是要求用户维护一整块不可验证的字符串。

### 需要在 0.85.1 上自建或适配

1. Graph 当前禁用 Pi 原生 discovery：
   `noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`、`noContextFiles`
   全部为 true，见 `Graph:src/runtime/pi-instance.ts:223-239`。
   因此不能直接依赖 Pi 自动加载 AGENTS/SYSTEM/skills/docs。
2. Graph 当前把自己生成的 capability inventory 作为 `appendSystemPrompt`，并把 Agent
   identity 作为 `systemPrompt`，见
   `Graph:src/runtime/pi-adapter.ts:743-744` 与
   `Graph:src/runtime/capabilities.ts:1306-1354`。
   这里的 `systemPrompt` 在 Pi 0.85.1 中是 `customPrompt`，所以 Pi 默认
   tools/rules/docs 三段会被跳过；Graph 现在也没有另行生成 Pi 风格 docs section。
3. Graph 当前通过 `skillsOverride` 把所有已加载 skill 的
   `disableModelInvocation` 设为 true，见
   `Graph:src/runtime/pi-instance.ts:230-235`。所以 skill 即使有独立路径，也不会由
   Pi 自己出现在 system prompt；当前只能由 Graph 的 capability inventory 表达。
4. Graph 当前已经有集中 prompt 文件层，包含 identity、tool awareness、main
   conversation、main graph、worker 和 suggestion prompts，见
   `Graph:src/runtime/agent-context.ts:80-100` 与 `135-250`。
   但它还不是 Pi 式完整 system prompt：
   docs section、通用 rules、tool rules 的独立视图与 Pi 原生 section diff 尚不存在。
5. 0.85.1 不支持 `sections`、`diffSystemPromptSections` 或
   `forceSystemPrompt`。若 Graph 要提供“完整 prompt 可视化 + 单段修改 + 预览最终拼装”
   而不升级，就应在 Graph 自己的一层完成组装，再把最终 string 传给 Pi；
   Pi 0.85.1 只负责消费结果。

### 需要升级到 0.86.0 才能原生获得

1. prompt section 级 patch 和跨 resume/branch 保留。
2. extension/宿主按 section 名字修改 prompt。
3. request-time forced prompt 与 transcript 结构化记录分离。
4. 工具变化与 prompt section 变化在同一条 system message 更新路径内管理。

### 升级 0.86.0 的额外适配项

1. `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和
   `@earendil-works/pi-coding-agent` 当前一起锁在 0.85.1；升级不能只改 coding-agent
   一个包。
2. Graph 当前 custom stream 从 provider `context.systemPrompt` / `context.tools`
   读取。0.86.0 改成 `TranscriptContext` 后，这些值要从 `context.messages` replay，
   相关入口是 `Graph:src/runtime/pi-worker.ts:106-114` 与
   `Graph:src/runtime/worker-requests.ts:21-34`。
3. Graph 对 session JSONL、fork、transcript audit 的解释需要纳入 0.86.0 新增的
   SystemMessage / sections / toolsAdded / toolsRemoved checkpoint。
4. Graph 的 sandbox、调用 gate、compact、桥接工具仍是独立控制面；升级 Pi 不会自动
   解决这些边界。

## 建议的最终 Prompt 骨架

如果 Graph 要按 Pi 0.86.0 的用户体验组织自己的 Agent prompt，可参考以下逻辑骨架；
这不代表当前 0.85.1 原生支持这些 section：

```text
<identity>
Graph Agent 的 agent.md / 集中身份文件
</identity>

<tools>
本次实际 active 的 Skills、MCP tools、Pi extension tools、宿主工具
只列有 snippet 的工具；无 snippet 工具仍可按策略执行
</tools>

<rules>
通用行为规则
Graph 特定安全、问题所有权、预算、暂停、任务图规则
tool-specific guidelines
</rules>

<docs>
Graph README / docs / examples / source maps 的绝对根路径
主题到文件的映射
要求按需完整读取并跟随 Markdown 链接
</docs>

<project_context>
AGENTS.md / 等价项目 instruction
</project_context>

<skills>
skill name / description / SKILL.md absolute path
</skills>

<cwd>
当前 Git worktree 的绝对路径
</cwd>
```

关键区别是：Pi 0.86.0 可以在内部把上述段分别保存、diff 和 patch；Pi 0.85.1 只能把
最终结果当字符串消费。Graph 当前若要在 0.85.1 上得到同等“单段可编辑和可预览”体验，
必须在 Graph 层维护这套结构。

## Pi 研究的未确认项与限制

1. 本次没有运行真实模型来验证它是否总会遵循 `<docs>` 或 skills 的按需读取指令。
   代码和文档只能证明路径被注入，不能证明模型必然使用。
2. 本次没有测试所有 Pi 0.86.0 的 provider/model 分支。transcript-aware prompt patch
   的具体 provider wire 表现依赖模型兼容标志，不能仅从
   `buildSystemPromptSections` 推断。
3. 0.85.1 安装包只提供 `dist/*.js`、`.d.ts` 和 sourcemap，没有发布 `src/*.ts`；
   本文对 0.85.1 的行号引用以实际安装的 `dist` 为准。
4. Pi clone 虽是 `0.86.0`，但其 `CHANGELOG.md` 还有 Unreleased 修复；若后续决定升级，
   应锁定 exact npm version 或 exact commit，并重新检查 `0.86.0` 发布包与 clone 的
   少量差异。
5. 本次没有用真实模型验证“完整预览与运行时实际发送内容逐字相同”；该一致性必须由
   实现阶段的程序测试保证。

## Graph 当前实现盘点

### 1. 已有的人类可编辑 Prompt 层

Graph 已经有 `~/.graph/prompts`，并在首次启动时写入一份不会被覆盖的默认文件：

| 文件 | 当前用途 | 当前注入位置 |
| --- | --- | --- |
| `agents/main.md` | Main Agent 身份 | Pi `customPrompt` / `systemPrompt` |
| `agents/<definition-id>.md` | 任意 Agent 定义的可选身份覆盖 | Pi `systemPrompt` |
| `tool-awareness.md` | 能力使用说明 | Pi `appendSystemPrompt` |
| `runtime/main-conversation.md` | Main Agent 讨论、规划、问题分流规则 | 追加到本轮 user briefing |
| `runtime/main-graph.md` | 任务图 schema 与工具规则 | 追加到本轮 user briefing |
| `runtime/worker.md` | Worker/Reviewer 通用运行规则 | 追加到本轮 user briefing |
| `runtime/prompt-suggestion.md` | 输入建议生成器自己的 system prompt | 独立的模型请求 |

这一层由 `AgentContextLibrary` 提供，默认文件、模板变量和原子保存见
`Graph:src/runtime/agent-context.ts:56-100`、`Graph:src/runtime/agent-context.ts:135-250`。

结论：用户提案中的“集中、可编辑”已经实现了一半。缺口不是没有文件，而是这些文件还没有
被组织成 Pi 那种可解释、可预览的完整 system prompt。

### 2. 当前真正进入 Pi system prompt 的内容

运行时先解析当前 Agent 定义的身份：

- Main Agent 优先读取 `agents/main.md`；
- 其它定义优先读取 `agents/<definition-id>.md`；
- 没有中央覆盖时，回退到绑定 Agent 定义或 bootstrap 中的身份 Prompt。

见 `Graph:src/runtime/pi-adapter.ts:309-329`。

随后：

- 身份文本作为 `systemPrompt`；
- 生成的 capability inventory 作为 `appendSystemPrompt`；
- 两者一起传给 Pi session。

见 `Graph:src/runtime/pi-adapter.ts:741-748` 与
`Graph:src/runtime/capabilities.ts:1306-1354`。

在 Pi 0.85.1 中，这分别对应 `customPrompt` 和 append addendum。由于 Graph 使用了
`customPrompt`，Pi 默认分支中的 tools、rules、docs 段不会生成；Pi 仍会追加 skills
（Graph 当前隐藏）和 cwd。这个事实是本提案最重要的技术依据。

### 3. 当前“rules”其实不是 system prompt

`runtime/main-conversation.md`、`runtime/main-graph.md` 和 `runtime/worker.md` 当前没有
传给 `systemPrompt` 或 `appendSystemPrompt`，而是在每轮调用前拼到 user briefing 后面：

```text
session.prompt(`${briefing}${hint}`)
```

见 `Graph:src/runtime/pi-adapter.ts:788-842`。

这带来三个结果：

1. 规则每轮都作为 user message 的一部分重复进入上下文；
2. system prompt 预览无法代表模型真正看到的稳定指令；
3. system prompt、任务说明和普通用户输入混在同一角色坐标系里。

规则内容本身适合继续由用户编辑，但注入位置应从“每轮 user hint”提升为稳定的 system
instructions。

### 4. 当前 tools 感知和工具精简

Graph 已有：

- 宿主工具工厂 `agentTools(...)`；
- Skills、MCP、Graph extension、Pi extension 的绑定和加载；
- 由真实加载结果生成的 capability inventory；
- Main Agent 的 `tools.json` 禁用列表；
- 聊天头部工具清单和复选框 UI。

相关位置：

- `Graph:src/runtime/agent-tools.ts:113-617`；
- `Graph:src/runtime/capability-bundle.ts:121-210`；
- `Graph:src/runtime/capabilities.ts:1306-1354`；
- `Graph:src/runtime/agent-context.ts:209-229`；
- `Graph:src/server/app.ts:52-94`；
- `Graph:src/web/AgentContext.tsx:101-118`、`Graph:src/web/AgentContext.tsx:219-244`。

工具过滤本身已经同时作用于 provider `tools`、operation 工具数组和生成的能力说明，见
`Graph:src/runtime/capability-bundle.ts:138-155`。因此用户关闭工具不只是“从文案隐藏”，
这一层方向正确。

但当前 UI 的工具模型还有四个偏差：

1. `mainAgentToolView` 先硬编码所有 `HOST_MAIN_TOOLS`，即使当前会话根本不具备该工具；
2. 运行时动态工具依赖最近一次 master `nodeRun`，首次运行或没有实例时看不全；
3. 只显示名称、描述和来源，不显示参数、权限影响、当前可用性、为何被禁用；
4. 禁用列表只用于 `role === 'master'`，尚未形成 per-definition 的工具策略模型。

因此用户现在能看到“候选工具”，但还没有看到“本次真实生效的工具 surface”。

### 5. 当前 docs 与 cwd

Main Agent 可以只读访问：

- 用户能力目录；
- 正在运行的 Graph application/source root。

见 `Graph:src/runtime/pi-adapter.ts:333-341`。

但没有：

- 一份面向 Agent 的 Graph docs 索引；
- “Graph docs 根路径”这一稳定概念；
- 在 system prompt 中告诉 Agent 应何时、按什么相对路径读取哪些文档；
- 可供用户集中查看或维护的 Agent docs 目录。

当前 cwd 由 Pi 自己在 system prompt 尾部追加为
`Current working directory: <workspace>`。Graph 传入的 workspace 是 operation 的实际
worktree，见 `Graph:src/runtime/pi-adapter.ts:269` 与
`Graph:src/runtime/pi-instance.ts:223-259`。因此 cwd 已存在，但没有被 Graph 的 prompt
模型、预览或审计记录显式表达。

### 6. 当前聊天头部 UI

现有抽屉有两页：

- Prompt：分别编辑六类 prompt 文件；
- 工具：勾选 Main Agent 工具。

见 `Graph:src/web/AgentContext.tsx:130-251`。

它解决了“能找到并编辑文件”，但没有解决：

- 展示一份完整、按最终顺序拼装的 system prompt；
- 展示每段来自哪个文件、是否由宿主动态生成；
- 展示 Pi 在 Graph 文本之后自动追加的 cwd；
- 展示本次实际 active tools 与它们的来源；
- 预览“这次修改后下一轮会变成什么样”；
- 对比默认值、恢复默认、查看 revision/history。

### 7. 当前自省与审计

Graph 已有 `read_system_capabilities` 和 `inspect_graph_system`，能读取模型、配方、
编译定义、问题、失败节点和系统变更，见
`Graph:src/runtime/agent-tools.ts:475-521`。

`capabilityPrompts(...)` 也会生成一个含 prompt 文本的 legacy digest，见
`Graph:src/runtime/capabilities.ts:1345-1354`。但：

- digest 没有作为用户可见的 `promptRevision` 暴露；
- 没有保存“某个 operation 实际使用的完整 prompt 快照”；
- 没有让 Main Agent 或用户从历史记录回看当时到底注入了什么。

这对“系统完全开放给 Agent 自己理解”仍不够；Agent 能看到当前状态，却不能可靠解释某次
历史行为使用了哪一版系统说明。

## 与目标形态的差距

| 目标 | 当前状态 | 差距 |
| --- | --- | --- |
| 简单身份认知 | 已有 `agent.md` | Main 和其它定义已有覆盖机制；需要纳入统一 composer |
| 充足文档 | 有源码/能力只读根，无 Agent docs section | 缺 docs root、index、主题映射和按需读取协议 |
| 可编辑系统 | 有集中文件 | rules 仍在 user briefing；缺完整预览、revision、diff/reset |
| tools | 能加载、过滤和显示候选工具 | 缺真实生效 surface、分组、来源、可用性、权限影响 |
| rules | 已有三份运行规则 | 缺 common rules，且未作为稳定 system section |
| pi 风格 docs | 无对应 section | 需要 Graph 自己生成，不能依赖当前 customPrompt 分支 |
| cwd | Pi 自动追加 | Graph 未显式预览、记录或解释 worktree 含义 |
| 完整 system prompt | 只能看分散层 | 缺与 runtime 共用同一组装器的 full preview |
| 工具精简 | 已能关闭 Main 工具 | 需改为声明式 tool catalog 和 per-Agent policy 的扩展基础 |
| 审计复现 | 有部分 digest | 缺 prompt revision、快照、operation 绑定和 UI 回看 |

## 建议设计

### 1. 保留 `~/.graph/prompts`，把它升级为结构化 Context Library

不建议再建第二套全局目录。保留现有路径可以兼容已经编辑过的用户文件，并在其中增加
明确的 section 语义：

```text
~/.graph/prompts/
  README.md
  agents/
    main.md
    coder.md
    reviewer.md
  tools/
    main.md
    worker.md
  rules/
    common.md
    main.md
    worker.md
    reviewer.md
  docs/
    INDEX.md
    graph-overview.md
    execution-model.md
    capabilities.md
    permissions-and-recovery.md
    artifacts-and-git.md
    troubleshooting.md
  runtime/
    main-conversation.md
    main-graph.md
    worker.md
    prompt-suggestion.md
```

职责：

- `agents/*.md`：稳定的身份认知；
- `tools/*.md`：人类写的工具使用指导和分类说明，不替代生成的工具清单；
- `rules/*.md`：通用规则和角色规则；
- `docs/INDEX.md`：只放主题索引和阅读协议，正文按需读取；
- `runtime/*.md`：确实只属于某一运行阶段的动态规则；
- `tools.json` 或后续 `policy.json`：工具 enablement。

如果担心兼容旧文件，第一阶段可以继续使用现有六个 key，只新增 `rules/common.md`、
`tools/main.md`、`docs/INDEX.md` 和 docs 文件；后再做目录迁移。

### 2. 建立一个唯一的 Prompt Composer

核心原则：运行时注入和 UI 预览必须调用同一个纯函数，不能各自拼一遍。

建议接口：

```ts
type AgentPromptSection = {
  id: 'identity' | 'tools' | 'rules' | 'docs' | 'project_context' | 'skills' | 'cwd';
  title: string;
  content: string;
  source: string;
  editable: boolean;
  digest: string;
};

composeAgentSystemPrompt(input): {
  sections: AgentPromptSection[];
  text: string;
  revision: string;
};
```

输入至少包括：

- Agent definition 与 role；
- 用户可编辑 prompt 文件；
- 本次实际 active tools；
- 实际 capability facts；
- docs root 和主题索引；
- 实际 worktree cwd；
- 运行时变量，如模型、requirement version 和 full-access 状态。

输出顺序建议与 Pi 对齐：

```text
identity
tools
rules
docs
project_context（有项目 instructions 时）
skills
cwd
```

Graph 当前使用 Pi 0.85.1，因此可以在 Graph 层生成一个完整字符串，再交给 Pi。Pi 仍会
追加自己的 cwd；为了避免重复，可以选择：

- 方案 A：Graph 不生成 cwd，full preview 单独显示“Pi 自动追加的 cwd”；
- 方案 B：升级 Pi 0.86.0 后，使用 section 模型，并明确哪一段由 Pi 生成；
- 方案 C：Graph 自己生成 cwd，并接受 Pi 再追加一次，不建议采用。

推荐先采用方案 A，不把 Pi 升级和 prompt UI 绑定在一起。

### 3. 将 rules 提升到 system instructions

`runtime/main-conversation.md` 和 `runtime/main-graph.md` 中真正稳定的规则应移入
`rules/`，并进入 system prompt；每轮变化的任务说明、图状态、进度和用户消息继续留在
briefing。

建议拆分：

- `rules/common.md`：证据、诚实、工具失败、不要伪造结果等通用规则；
- `rules/main.md`：问题分流、用户沟通、图确认、系统自省、模型选择；
- `rules/worker.md`：文件、测试、结果提交、交接格式；
- `rules/reviewer.md`：独立审查、只能看冻结证据、不得修改；
- `runtime/main-graph.md`：当前 requirement version、模型和 proposal schema 等动态内容。

用户编辑规则不能改变宿主控制面。预算、暂停、权限、工具过滤、审计、恢复和任务确认仍由
程序强制执行；prompt 编辑只能改变模型收到的指导。

### 4. 增加 Graph docs 渐进披露

建议把 Agent docs 作为 `~/.graph/prompts/docs` 下的用户副本，并由安装包中的默认内容
首次播种。Main Agent 只读读取该目录；Write 仍通过 UI/文件所有者进行。

system prompt 只注入：

- docs 根路径；
- `INDEX.md` 的路径；
- 主题到文件的简短映射；
- 何时必须读取 docs；
- 相对路径解析规则；
- 要求读完相关 `.md` 并跟随交叉引用。

不要把所有 docs 正文塞入每轮 prompt。

首批 docs 建议覆盖：

| 文档 | 应回答的问题 |
| --- | --- |
| `graph-overview.md` | Graph 是什么，谁是 Main Agent/Worker/Program Node |
| `execution-model.md` | 任务图、operation、激活、回环、问题和恢复 |
| `capabilities.md` | Skills、MCP、Pi extension、Graph extension、工具绑定 |
| `permissions-and-recovery.md` | 调用门、暂停、预算、未知结果、问题所有权 |
| `artifacts-and-git.md` | worktree、handoff、artifact、证据、最终合并 |
| `self-configuration.md` | 哪些系统内容可编辑，哪些是不变量 |
| `troubleshooting.md` | 出错时应读取哪些系统事实、如何处理 |

`read_system_capabilities` 应新增：

```json
{
  "agentContext": {
    "root": "/Users/.../.graph/prompts",
    "docsRoot": "/Users/.../.graph/prompts/docs",
    "revision": "sha256:...",
    "definitionVersion": "main@7"
  }
}
```

这样 Main Agent 既能从 system prompt 知道 docs 在哪里，也能从实时工具确认当前 revision。

### 5. 用 Tool Catalog 替代静态 HOST_MAIN_TOOLS

工具 UI 的数据源不应是单独硬编码的一份名称表。建议从实际 tool policy 解析出统一 catalog：

```ts
type AgentToolView = {
  name: string;
  description: string;
  source: 'graph' | 'skill' | 'mcp' | 'pi-extension' | 'graph-extension' | 'main-agent';
  capabilityId?: string;
  capabilityVersion?: string;
  category: 'filesystem' | 'artifact' | 'command' | 'network' | 'graph' | 'system' | 'extension';
  declared: boolean;
  runtimeAvailable: boolean | null;
  enabled: boolean;
  requiredByHost?: boolean;
  permissionSummary: string;
  rolePolicy: string[];
};
```

关键要求：

- provider `tools`、allowlist 和 prompt `<tools>` 都以同一启用集合为准；
- 工具名称来自实际注册，不从静态数组猜测；
- `runtimeAvailable: null` 表示需要 operation 启动后才能确认；
- 关闭工具时同步更新 prompt preview；
- 如果宿主工具是功能性必需项，可以允许关闭，但必须显示后果和恢复入口。

第一阶段仍然只让用户精简 Main Agent。接口应保留 `rolePolicy`，为后续 per-Agent 定义
策略留空间，但不要在本提案中同时扩大范围。

### 6. 增加 Prompt Revision 和实际快照

建议把“可编辑层”与“某次 operation 实际使用的内容”分开：

```text
AgentContextRevision
  revision
  files[]
  toolPolicyDigest
  createdAt

OperationPromptSnapshot
  operationId
  revision
  definitionVersion
  activeTools[]
  renderedPromptDigest
  renderedPrompt (content-addressed, optional)
```

最少必须记录 `revision + renderedPromptDigest + activeTools`。完整快照可以按内容寻址
只保存一份，避免每个 operation 重复存大文本。

保存 prompt 后：

- 当前 active operation 不变；
- 下一轮新 operation 使用新 revision；
- UI 明确显示“当前编辑将用于下一轮”；
- 历史 operation 可显示其实际 revision。

## 完整 System Prompt 示例

下面是目标体验的示意，不代表所有工具都会在每个 Agent 上启用。动态变量在预览时应替换成
实际值，并由 UI 标记每个 section 的来源。

```text
<identity>
你是某个 Graph feature task 的 Main Agent。你直接与用户沟通，调查项目，暴露不确定性，
把已确认目标转成可审查的任务图。

保持身份跨模型稳定。你可以提出和维护图，但不能直接实现业务改动。只问会改变计划的问题，
保留已确认的 decision，用户改变方向时提交新草案。
</identity>

<tools>
当前 Agent definition: main@7
本次实际可用工具：

- read: 读取 workspace、能力快照或 Graph docs 中的文本和图片
- list_dir: 列出 workspace 或只读根目录
- write_file: 写入当前实例 worktree
- search_resources: 搜索用户能力库
- get_resource: 读取一个能力的 metadata
- read_system_capabilities: 读取模型、配方、定义和能力事实
- inspect_graph_system: 读取失败节点、开放问题和系统变更
- propose_graph: 提交待用户确认的任务图
- resolve_problem: 处理由 Main Agent 负责的执行问题
- ...

工具名称、来源、版本和可用性由宿主从实际 capability bundle 生成。
</tools>

<rules>
通用：
- 工具结果是证据；不能声称未发生的调用或结果。
- 失败时报告实际阻塞，不能通过另一条未授权路径规避。
- 结论、风险和未知项要区分清楚。

Graph：
- propose_graph 只创建草案；用户确认前不派发任何工作。
- 权限、预算、暂停、恢复和任务范围由宿主强制控制。
- 执行问题先由 Main Agent 诊断，再决定 retry、respond、rework 或 escalate。
- 独立审查只使用冻结证据和独立模型，不继承实现 transcript。
</rules>

<docs>
Graph 文档按需读取；不要把全部正文当作当前上下文事实。

- Graph docs root: /Users/me/.graph/prompts/docs
- 索引: /Users/me/.graph/prompts/docs/INDEX.md
- 系统总览: graph-overview.md
- 执行模型: execution-model.md
- 能力与工具: capabilities.md
- 权限、预算与恢复: permissions-and-recovery.md
- Artifact、Handoff 与 Git: artifacts-and-git.md
- 自配置边界: self-configuration.md
- 故障排查: troubleshooting.md

当用户询问 Graph 自身、工具为何不可用、任务为何阻塞、如何修改系统时，先读取索引和相关
文档，再给出结论。docs/... 相对 docs root 解析，不相对当前业务 worktree 解析。
</docs>

<cwd>
当前 Git worktree: /Users/me/.graph/state/worktrees/task-123/instance-456
所有相对文件路径默认相对此目录解析。它不是项目根目录，也不是其它 Agent 的 worktree。
</cwd>
```

如果保留 Pi 0.85.1 的自动 cwd 追加，完整预览最终还会再显示一行：

```text
Current working directory: /Users/me/.graph/state/worktrees/task-123/instance-456
```

因此实际实施时必须在 preview 中明确标记“Pi generated”，或选择不重复生成 Graph cwd
section。

## UI 建议

聊天头部入口可以保留，但抽屉应改为三个视图：

### 1. 完整预览

- 默认显示最终拼装文本；
- 左侧是 section outline，右侧是完整内容；
- 每段显示来源文件、editable、generated、current revision；
- tools、cwd 和 skill 摘要显示“宿主生成”；
- 提供复制、下载 JSON/Markdown、查看 diff。

### 2. 可编辑来源

- 按 identity、tools guidance、rules、docs、runtime 分组；
- 点击 section 直接编辑对应文件；
- 显示 revision、上次保存时间和“下一轮生效”；
- 提供恢复默认和查看差异；
- 未知模板变量不静默删除，显示错误或 warning。

### 3. 工具

- 按 source、category、role 分组；
- 显示 enabled、declared、runtimeAvailable、permission summary；
- 关闭后立即更新完整预览中的 `<tools>` 段；
- 对可能破坏 Main Agent 核心流程的工具给出明确警告；
- 保存按钮同时写 tool policy，下一轮生效。

建议头部摘要从：

```text
6 层 Prompt · 42/47 个工具可用
```

改成：

```text
system r8 · 1,842 tokens · 42/47 tools
```

token 数只作估算并明确标注，不能把估算当成 usage。

## 测试与验收

实现时应优先测试组装契约，而不是只测 UI 出现了几个按钮。

### Prompt Composer

1. 固定 section 顺序：identity、tools、rules、docs、project context、skills、cwd；
2. Main、worker、reviewer 使用各自正确的 identity/rules/tools；
3. 动态变量被替换，未知变量不会被静默吞掉；
4. 用户文件缺失时回退到默认，已存在时绝不覆盖；
5. 保存后 active operation 不变，下一 operation 使用新 revision；
6. preview 的 text 与 runtime 交给 Pi 的文本逐字一致。

### Tools

1. 关闭工具后，provider tool list、allowlist 和 prompt tools section 同时消失；
2. declared tool 与 runtime discovered tool 的差异可见；
3. discussion read-only 模式不显示实际上不可用的写工具；
4. 没有 capability、没有 master instance 时仍能显示 host core tools；
5. Pi extension 的 prompt 可见性与实际 active set 一致。

### Docs

1. Main Agent 能读取 docs root 和 `INDEX.md`；
2. docs 路径被正确注入且相对路径按 docs root 解析；
3. Worker/Reviewer 不因 Main 的 docs root 自动扩大读取范围；
4. docs 不写进普通业务 worktree，也不能被 write tool 直接改写；
5. 用户修改 docs 后，下一轮 revision 更新。

### cwd 与审计

1. preview 显示实际 operation worktree，而不是项目源目录；
2. Pi 自动 cwd 不会被 Graph preview 漏掉或重复理解；
3. 每个 operation 记录 prompt revision、digest 和 active tools；
4. 历史记录能区分不同 revision，不把旧 prompt 当成当前 prompt；
5. prompt 编辑不改变权限、预算、暂停和恢复状态。

### UI

1. 完整预览能展开所有 section 并显示来源；
2. 点击可编辑 section 打开正确文件；
3. 编辑后 preview 和工具变化在同一轮刷新；
4. 工具开关保存后反映在 preview；
5. 默认、修改、恢复默认三种状态清晰可辨；
6. 移动端和桌面端不出现文本溢出或遮挡。

## 实施阶段

### 阶段 1：结构化 Composer

- 抽出 `composeAgentSystemPrompt(...)`；
- 将稳定 rules 从 user briefing 迁移到 system instructions；
- 保持 Pi 0.85.1 不变；
- preview 与 runtime 共用 composer；
- 加 prompt revision 和 operation digest。

### 阶段 2：Docs

- 增加默认 Agent docs 与 `INDEX.md`；
- 增加 docs root read-only grant；
- 在 system prompt 中加入渐进披露 section；
- 在 `read_system_capabilities` 中暴露 docs root 和 revision。

### 阶段 3：工具目录与 UI

- 建立 Tool Catalog；
- 替换静态 `HOST_MAIN_TOOLS` 展示；
- 完成三页抽屉：预览、来源、工具；
- 完善 enablement、warning、diff/reset。

### 阶段 4：Pi 0.86.0 迁移评估

- 单独评估 `TranscriptContext`、SystemMessage、section patch 和 broker 适配；
- 不把升级与 prompt UI 绑定；
- 若升级，增加版本契约测试，证明启动、恢复、fork、compact 和工具变化后的 prompt 仍一致。

## 最终建议

这个方向值得做，而且不应只是把现有 drawer 再加一个 textarea。真正有价值的目标是：

1. **系统说明结构化**：identity、tools、rules、docs、cwd 都有明确来源；
2. **组装只有一份实现**：运行时和 UI 不可能显示不同内容；
3. **文档渐进披露**：Agent 知道 Graph docs 在哪里，并在需要时读取正文；
4. **工具以实际 surface 为准**：用户选择同时影响可执行工具和模型可见工具；
5. **编辑不影响安全边界**：用户可以优化文本，但不能通过 prompt 放开程序权限；
6. **每次执行可解释**：历史 operation 绑定具体 prompt revision 和工具集。

建议实施顺序是“Composer → Rules → Docs → Tool Catalog/UI → 可选的 Pi 0.86.0”。
Pi 的启发应被复制为 Graph 自己的结构合同，而不是简单依赖 Pi 的内部默认 prompt。

## 待明确的产品决策

1. Agent docs 是否完全允许用户编辑，还是只允许追加本地覆盖？
2. 工具精简是只针对 Main，还是最终所有 Agent 定义都可配置？
3. 完整 prompt 快照是否要长期保存正文，还是只保存 digest 和按需重建？
4. 是否允许用户删除“核心安全规则”？建议允许编辑文案，但宿主不变量必须始终注入。
5. 是否需要独立导出“默认 prompt 与当前 prompt 的 diff”作为支持材料？
