# 文件系统能力库与配方编译

状态：2026-09-17 已实施并完成全量测试。能力不再由数据库安装状态管理。

## 背景

旧实现把 Skills、MCP 和 Pi extensions 作为 preset 资源复制到 daemon state，再在 SQLite 中记录 `installing | installed | failed`。资源目录同时维护一份大型推荐清单，导致“可搜索来源”“已安装能力”“Agent 配方引用”成为三套状态。用户无法直接用文件管理器增删能力，Main Agent 也容易把来源目录误当成可直接使用的能力。

## 决策

### 1. 唯一能力根目录

默认根目录是 `~/.graph`，可用 `GRAPH_HOME` 或 `--graph-home` 覆盖：

```text
~/.graph/
  capabilities/
    skills/
    mcp/
    pi-extensions/
    agent-md/
      <capability directory>/
        capability.json
        ...files
  agent-combinations.json
```

四类目录分别承载 Skill、MCP、Pi extension 与 Agent.md。`capabilities` 下的目录仍可继续嵌套；扫描器遇到 `capability.json` 即把该目录视为一个能力，不再继续向下扫描。每份清单至少包含 `id`、`kind`、`version`、`name`，并按 kind 声明入口文件或运行参数。Skill 必须有 `SKILL.md`；prompt 必须有 `agent.md` 或 `tool.md`；MCP 必须有 `command` 或 `url`；extension 与 Pi extension 必须有存在的入口文件。

MCP 的网络范围属于能力清单：普通服务用 `networkDomains` 声明主机或 `${ENV}` 基址，浏览器类服务用 `networkAccess: "unrestricted"` 显式选择任意站点。两者互斥，且网络放行不构成工具授权，见 [ADR 0013](0013-capability-declared-mcp-network.md)。

扫描结果只有“可用”与“清单无效”，没有安装状态。导入到正确路径后，下一次扫描或 APP 启动即可使用。无效清单仍会出现在资源库中，并显示具体错误，便于用户修复。

### 2. Main Agent 与用户看到同一份能力库

资源库、Main Agent 的 `search_resources` / `get_resource`、Agent 定义解析和受限 Pi 进程全部读取同一批文件系统记录。不存在“推荐但未安装”的第二套目录。

能力可用不等于获得任务权限。实际模型、命令、MCP 与 extension 调用仍通过 Graph 的暂停、预算、并发、授权和恢复门。

### 3. 配方是引用，不是新能力

`agent-combinations.json` 保存用户可编辑的 Agent 配方。配方成员只引用已有能力的 `resourceId` 与精确 `version`，并按 role 映射：

- `identity` -> `prompts.agent`
- `tool` -> `prompts.tool`
- `skill`、`mcp`、`pi-extension`、`extension` -> `capabilities`

编译器验证所有必需引用、kind 和 prompt role 后生成 `DefinitionSpec`，再发布为版本化 Agent 定义。相同配方内容重复编译会复用同一版本。Main Agent 可通过 `save_agent_combination`、`delete_agent_combination` 和 `compile_agent_combination` 创建、编辑并取得可直接放入 `propose_graph` 的 `definitionVersion`。

用户与 Main Agent 可以新增或修改配方；任何 Agent 都不得自行伪造新的 Skill、MCP、extension 或身份 Prompt。外部能力只能由用户放入能力根目录，或由用户在明确指示下提供来源后导入。

### 4. `presets` 只保留 bootstrap

`presets/` 不再保存第三方 Skills、MCP、推荐目录或用户配方。它只保存 Graph 自身不可删除的 bootstrap：`bootstrap/` 下的 master/tool-awareness 及核心 Agent 身份 Prompt、核心定义描述。bootstrap Prompt 直接注入运行时，不进入用户能力库，也不以“可安装能力”的身份出现。

## 后果

- 用户可以查看、备份、增删能力目录，不需要操作 SQLite。
- 运行实例仍按定义版本固定能力 ID 与版本；升级能力文件不会静默改变已开始的操作。
- 资源库中的错误清单需要用户修复；系统不会自动生成或补全第三方能力。
- 旧数据库的 `installations` 与 capability 行仅为历史兼容，不参与生产可用性判断。
