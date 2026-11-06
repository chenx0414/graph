graph:allow-large-file: 2026-09-17 的能力目录调研快照，按外部 package 逐条成表；按主题拆分只会把同一份证据切成碎片，故保留单篇。
# Graph 资源库能力目录调研

日期：2026-09-17

范围：为 Graph 的“资源库”增加可发现、可选择、可安装的能力目录。本文只做只读调研和 schema 建议，不修改产品源码、配置或测试，也不代表任何外部能力已经安装，或任何付费 API 已被调用。

## 结论摘要

1. 外部能力仓库没有统一安装格式。Skills 至少存在四种真实布局：`skills/<category>/<skill>/SKILL.md`、`skills/<skill>/SKILL.md`、仓库根级 `SKILL.md`、以及顶层多个技能目录混排。目录条目必须记录“仓库 + 精确子路径 + commit”，不能只存仓库名。
2. 许可证必须按目录条目判断。`anthropics/skills` 仓库整体不是单一开源许可，部分 skill 为 Apache 2.0，部分为 source-available；`mcncarl/yichen-skills` 是个人学习和非商业许可；`obra/superpowers-skills` 虽为 MIT，但 GitHub API 显示仓库已归档。三者都不能被简化成“MIT 仓库”。
3. MCP 的 `mcpServers` JSON 只是客户端配置格式，不是 MCP 协议本身。官方协议定义了 stdio 与 Streamable HTTP 两种标准 transport；stdio 凭据通常来自环境变量，HTTP 推荐 OAuth 2.1，旧 HTTP+SSE 只作为历史兼容。[MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
4. 用户给出的 MCP 配置里有若干过期信息：`@modelcontextprotocol/server-github` 已弃用，官方 GitHub MCP Server 现在提供远程 HTTP 和本地 Docker 路径；`@railway/mcp-server` 已弃用，应使用 Railway CLI 的 `railway mcp`；Browserbase 的 npm 包已迁移到 `@browserbasehq/mcp`。
5. Pi package 有明确的 `package.json` manifest 规范：可以在 `pi` 字段声明 `extensions`、`skills`、`prompts`、`themes`，没有 manifest 时按约定目录发现。Pi 官方文档明确警告：Pi package 以完整系统权限运行，扩展可执行任意代码。[Pi Packages](https://pi.dev/docs/latest/packages)、[Pi Extensions](https://pi.dev/docs/latest/extensions)
6. “加入资源库”只能是候选或已安装快照，不能同时等于“绑定到 Agent”或“授权给任务”。Graph 现有模型已经区分 capability binding、definition version 和 task grant，新增目录时必须保持这条边界。

## 1. Skills 仓库的真实结构

### 1.1 用户列出的仓库抽样

下表通过 GitHub API 读取默认分支的 recursive tree，统计 `SKILL.md` 数量和顶层目录。`许可证` 和 `归档` 来自 GitHub 仓库元数据，不代表每个子技能的最终授权条款。

| 仓库 | 许可证 | 归档 | `SKILL.md` 数 | 真实布局 | 目录建议 |
| --- | --- | --- | ---: | --- | --- |
| [obra/superpowers-skills](https://github.com/obra/superpowers-skills) | MIT | 是 | 31 | `skills/` 下按领域分类 | 可作为来源，但默认标记“已归档”；安装必须 pin commit |
| [garrytan/gstack](https://github.com/garrytan/gstack) | MIT | 否 | 65 | 根级 `SKILL.md` + 顶层技能目录 | 不能假设有 `skills/`；按每个顶层目录建条目 |
| [mattpocock/skills](https://github.com/mattpocock/skills) | MIT | 否 | 37 | `skills/engineering/*`、`skills/productivity/*`；有 Claude plugin manifest | 适合作为首批结构化来源 |
| [mcncarl/yichen-skills](https://github.com/mcncarl/yichen-skills) | 自定义个人非商业许可 | 否 | 19 | 顶层技能目录 + `plugins/` | 商业或产品打包前必须单独法律审查；默认不进入公开内置目录 |
| [American-Embedded/kistack](https://github.com/American-Embedded/kistack) | GitHub 未识别 SPDX | 否 | 10 | `skills/` | 先读取仓库 LICENSE，再决定是否进入首版 |
| [luongnv89/skills](https://github.com/luongnv89/skills) | MIT | 否 | 47 | `skills/` | 适合做通用工程目录，但需按技能质量筛选 |
| [tscircuit/skill](https://github.com/tscircuit/skill) | MIT | 否 | 1 | 仓库根级 `SKILL.md` | 单条目录条目，source path 为 `.` |
| [KKKKhazix/khazix-skills](https://github.com/KKKKhazix/khazix-skills) | MIT | 否 | 6 | 顶层技能目录 | 中文内容类来源，按单技能选择 |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) | MIT | 否 | 903 | `.agents/`、`.cursor/`、`.kiro/`、`skills/`、文档等 | 不能整仓安装；必须限定 curated subpath，避免带入无关配置 |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) | MIT | 否 | 16 | `.agents/skills/`、`skills/` 与产品代码共存 | 只提取 skill 子路径，不能把整个产品仓库当技能 |
| [anthropics/skills](https://github.com/anthropics/skills) | 仓库无单一 SPDX | 否 | 20 | `skills/<skill>/SKILL.md`；每个 skill 可能另有 LICENSE | 逐条读取 skill 内许可证；文档类 source-available skill 默认排除 |
| [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | MIT | 否 | 166 | `skills/<skill>/SKILL.md` | 适合做大型领域目录，但首版只内置少量代表性条目 |
| [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) | MIT | 否 | 0 | README/列表型仓库 | 是“发现目录”而非可安装技能仓库，不能直接安装 |
| [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | GitHub 未识别 SPDX | 否 | 4 | 顶层技能目录；有 Claude plugin manifest | 先核验 LICENSE；适合作为领域来源而非首版默认 |
| [Fokkyp/SoftwareCopyright-Skill](https://github.com/Fokkyp/SoftwareCopyright-Skill) | MIT | 否 | 2 | `software-copyright-materials/`，含 vendor 子技能 | 需要记录 vendor 内容和嵌套许可证 |
| [handsomestWei/patent-disclosure-skill](https://github.com/handsomestWei/patent-disclosure-skill) | MIT | 否 | 9 | 根级 `SKILL.md` + `skills/` | 需区分根级总入口和两个独立子技能 |
| [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | MIT | 否 | 6 | `skills/<skill>/SKILL.md` | 适合作为 Obsidian 领域首批来源 |

### 1.2 代表性仓库的安装和 frontmatter

#### `obra/superpowers-skills`

README 说明该仓库由 superpowers plugin 自动克隆到 `~/.config/superpowers/skills/`，并不是一个独立的通用 installer。[README](https://github.com/obra/superpowers-skills/blob/main/README.md)

代表性 `SKILL.md` 的 frontmatter 包含：

```yaml
name: Preserving Productive Tensions
description: ...
when_to_use: ...
version: 1.1.0
```

来源：[`skills/architecture/preserving-productive-tensions/SKILL.md`](https://github.com/obra/superpowers-skills/blob/main/skills/architecture/preserving-productive-tensions/SKILL.md)

目录不能假定 frontmatter 只有 `name` 和 `description`。应保留原始 frontmatter，并把可识别的 `name`、`description`、`version`、`when_to_use` 提升为可筛选字段。

#### `anthropics/skills`

Anthropic README 说明：每个 skill 是独立文件夹，包含 `SKILL.md`；基础 frontmatter 只要求 `name` 和 `description`；仓库中的文档创建类 skills 是 source-available，不是开源。[README](https://github.com/anthropics/skills/blob/main/README.md)

代表性条目：

```yaml
name: algorithmic-art
description: ...
license: Complete terms in LICENSE.txt
```

来源：[`skills/algorithmic-art/SKILL.md`](https://github.com/anthropics/skills/blob/main/skills/algorithmic-art/SKILL.md)、[`skills/algorithmic-art/LICENSE.txt`](https://github.com/anthropics/skills/blob/main/skills/algorithmic-art/LICENSE.txt)

因此 catalog 条目必须有 `licensePath`、`licenseExpression` 和 `commercialUse`，不能把仓库级许可当作所有 skill 的许可。

#### `mattpocock/skills`

仓库提供 Claude Code plugin manifest，也支持 `npx skills@latest add mattpocock/skills`。其 plugin manifest 显式列出所有 skill 路径。[README](https://github.com/mattpocock/skills/blob/main/README.md)、[plugin.json](https://github.com/mattpocock/skills/blob/main/.claude-plugin/plugin.json)

这类仓库适合作为“首批精选”来源，因为可以直接读取 manifest 得到稳定子路径，而不必扫描并猜测技能边界。

#### `K-Dense-AI/scientific-agent-skills`

仓库 README 说明它同时是 Agent Skills 仓库和 Agent Plugins 包，支持 `npx skills add`、`gh skill install` 和插件目录；每个 skill 包含 `SKILL.md`，并可能声明 `license`、`compatibility`、`metadata`。[README](https://github.com/K-Dense-AI/scientific-agent-skills/blob/main/README.md)

代表性条目：

```yaml
name: adaptyv
description: ...
license: MIT
compatibility: Requires Python 3.10+, an Adaptyv Foundry account, and an API key...
metadata:
  version: "1.3"
  skill-author: K-Dense Inc.
```

来源：[`skills/adaptyv/SKILL.md`](https://github.com/K-Dense-AI/scientific-agent-skills/blob/main/skills/adaptyv/SKILL.md)

这说明 catalog 不能只看 `name` 和 `description`。`compatibility`、外部账号、API key、Python 版本和系统依赖都应成为安装前的元数据。

#### 中文和领域仓库

`mcncarl/yichen-skills` 的 README 明确写出个人学习和非商业限制，商业用途需要书面授权。[README.zh.md](https://github.com/mcncarl/yichen-skills/blob/main/README.zh.md)、[LICENSE](https://github.com/mcncarl/yichen-skills/blob/main/LICENSE)

`tscircuit/skill` 使用仓库根级 `SKILL.md`，通过 `npx skills add tscircuit/skill` 安装。[README](https://github.com/tscircuit/skill/blob/main/README.md)

`KKKKhazix/khazix-skills`、`kepano/obsidian-skills` 和 `handsomestWei/patent-disclosure-skill` 说明领域目录适合按主题分组，但每个技能的许可证、外部命令和资源路径仍要独立记录。

### 1.3 建议的 Skills catalog 字段

最低限度应包含：

| 字段 | 作用 |
| --- | --- |
| `source.type` | `github`、`npm`、`git`、`local` 或 `builtin` |
| `source.repo` | `owner/repo` |
| `source.path` | 精确技能子路径；根级技能为 `.` |
| `source.requestedRef` | 用户选择的分支、tag 或 commit |
| `source.resolvedCommit` | 解析后的不可变 commit SHA |
| `contentDigest` | 安装快照内容摘要 |
| `frontmatter` | 原始 frontmatter；至少提升 `name`、`description`、`version`、`whenToUse`、`compatibility` |
| `license` | `expression`、`path`、`commercialUse`、`redistribution` |
| `source.archived` | 来源仓库是否归档 |
| `install.requirements` | Python、Node、Docker、外部 CLI、账号、系统依赖 |
| `security.codeExecution` | 是否包含脚本、安装脚本或可执行文件 |
| `security.network` | 是否需要网络访问 |
| `security.filesystem` | 是否读写用户文件，以及默认范围 |
| `mapping.capabilityKind` | 映射到 Graph 的 `skill` |

## 2. MCP 配置与真实包

### 2.1 协议和配置的边界

MCP 官方规范定义两种标准 transport：

- stdio：客户端启动子进程，JSON-RPC 从 stdin/stdout 传输，stderr 只用于日志，stdout 不能混入非 MCP 内容。[Transports: stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)
- Streamable HTTP：使用 HTTP POST/GET，单端点，可选择 SSE 流，使用 `Mcp-Session-Id` 维护会话。[Transports: Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)

旧 HTTP+SSE transport 已被 Streamable HTTP 取代，只用于向后兼容。目录条目应把 `transport` 作为明确字段，不能根据 URL 猜测。

HTTP transport 的授权推荐 OAuth 2.1；stdio transport 通常从环境变量取凭据，不应套用 HTTP OAuth 流程。[Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

本地参考文件 `/Users/macmini/workspace/07-ECC-main/mcp-configs/mcp-servers.json` 使用的是 `mcpServers` 风格配置，混合了 stdio 的 `command/args/env` 与远程 HTTP 的 `type/url/headers`。它可以作为“安装模板来源”，但不能直接作为 Graph 的授权记录。

### 2.2 用户列出的 MCP 真实情况

| 用户条目 | 真实包/端点 | transport | 凭据和运行条件 | 来源 |
| --- | --- | --- | --- | --- |
| jira | `uvx mcp-atlassian`；也支持 Docker、HTTP/SSE | stdio 默认 | Cloud 需要 `JIRA_URL`、`JIRA_USERNAME`、`JIRA_API_TOKEN`；Server/DC 可用 PAT；也支持 OAuth | [mcp-atlassian README](https://github.com/sooperset/mcp-atlassian/blob/main/README.md) |
| github | 官方远程 `https://api.githubcopilot.com/mcp/`；本地 `ghcr.io/github/github-mcp-server` | HTTP 或 Docker stdio | 远程支持 OAuth 或 PAT；本地 Docker 需要 Docker，PAT 可用 `GITHUB_PERSONAL_ACCESS_TOKEN` | [github-mcp-server README](https://github.com/github/github-mcp-server/blob/main/README.md) |
| firecrawl | `npx -y firecrawl-mcp`；远程 `https://mcp.firecrawl.dev/v2/mcp` | stdio 或 HTTP | keyless 免费层只开放部分工具；完整工具和更高额度需要 OAuth 或 `FIRECRAWL_API_KEY` | [firecrawl-mcp README](https://github.com/firecrawl/firecrawl-mcp-server/blob/main/README.md) |
| supabase | `@supabase/mcp-server-supabase`；远程 `https://mcp.supabase.com/mcp` | stdio 或 HTTP | 推荐 OAuth；也可用 `SUPABASE_ACCESS_TOKEN` 和 project ref；建议 `read_only=true`、project scope、features 限制 | [Supabase MCP docs](https://supabase.com/docs/guides/getting-started/mcp) |
| sequential-thinking | `@modelcontextprotocol/server-sequential-thinking` | stdio | 无外部凭据；可选 `DISABLE_THOUGHT_LOGGING=true` | [server README](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) |
| vercel | 官方远程 `https://mcp.vercel.com` | HTTP | OAuth；部分公开工具可不认证，项目/部署/分析工具需要授权 | [Vercel MCP docs](https://vercel.com/docs/agent-resources/vercel-mcp) |
| railway | `railway mcp`（CLI）；远程 `https://mcp.railway.com` | stdio proxy 或 HTTP | CLI 路径复用 `railway login`；HTTP 路径使用 OAuth；旧 npm 包已弃用 | [Railway CLI MCP docs](https://docs.railway.com/cli/mcp) |
| cloudflare-docs | 官方远程 `https://docs.mcp.cloudflare.com/mcp` | Streamable HTTP | 文档 server 通常可只读使用；账户级 server 使用 OAuth 或 API token | [Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) |
| cloudflare-workers-builds | 官方远程 `https://builds.mcp.cloudflare.com/mcp` | Streamable HTTP | 账户授权后使用 | 同上 |
| cloudflare-workers-bindings | 官方远程 `https://bindings.mcp.cloudflare.com/mcp` | Streamable HTTP | 账户授权后使用 | 同上 |
| cloudflare-observability | 官方远程 `https://observability.mcp.cloudflare.com/mcp` | Streamable HTTP | 账户授权后使用 | 同上 |
| clickhouse | `mcp-clickhouse`；也支持 HTTP/SSE 部署 | stdio 默认 | stdio 需要 `CLICKHOUSE_HOST`、`PORT`、`USER`、`PASSWORD` 等；HTTP 必须配置 bearer/OIDC，默认只读 | [mcp-clickhouse README](https://github.com/ClickHouse/mcp-clickhouse/blob/main/README.md) |
| exa-web-search | `exa-mcp-server`；远程 `https://mcp.exa.ai/mcp` | stdio 或 Streamable HTTP | 远程端点可用；API key 和额度能力需按 Exa 账户核验 | [exa-mcp-server README](https://github.com/exa-labs/exa-mcp-server/blob/main/README.md) |
| context7 | `@upstash/context7-mcp`；远程 `https://mcp.context7.com/mcp` | stdio 或 HTTP | API key 可选，用于更高限速和私有仓库 | [Context7 README](https://github.com/upstash/context7/blob/master/README.md) |
| magic | `@magicuidesign/mcp` | stdio | 官方 MCP server；当前元数据未显示必需凭据 | [Magic UI MCP](https://github.com/magicuidesign/mcp) |
| filesystem | `@modelcontextprotocol/server-filesystem` | stdio | 无 API key；必须提供允许目录，或客户端实现 Roots；没有允许目录会启动失败 | [filesystem README](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) |
| playwright | `@playwright/mcp` | stdio | 无 API key；需要浏览器运行时；适合浏览器自动化但不等于任务写权限 | [Playwright MCP README](https://github.com/microsoft/playwright-mcp/blob/main/README.md) |
| fal-ai | `fal-ai-mcp-server` | stdio | 需要 `FAL_KEY`；模型调用可能产生费用 | [fal README](https://github.com/derekalia/fal-mcp-ts/blob/main/README.md) |
| browserbase | `@browserbasehq/mcp`；远程 `https://mcp.browserbase.com/mcp` | stdio 或 HTTP | stdio 需要 `BROWSERBASE_API_KEY`、`BROWSERBASE_PROJECT_ID`，自定义模型另需模型 key；旧包名已迁移 | [Browserbase MCP README](https://github.com/browserbase/mcp-server-browserbase/blob/main/README.md) |
| browser-use | 本地 `uvx --from 'browser-use[cli]' browser-use --mcp`；云 `https://api.browser-use.com/v3/mcp` | stdio 或 HTTP | 本地需要自己的 LLM key；云使用 `x-browser-use-api-key` | [Browser Use local MCP](https://docs.browser-use.com/open-source/customize/integrations/mcp-server)、[Browser Use cloud MCP](https://docs.browser-use.com/cloud/guides/mcp-server) |
| laraplugins | `https://laraplugins.io/mcp/plugins` | HTTP | 端点存在；本轮未核验其独立授权/凭据文档，标记“未验证” | 用户提供的本地配置；未找到第一方公开说明 |
| confluence | `confluence-mcp-server` | stdio | 环境变量使用 `CONF_BASE_URL`、`CONF_TOKEN`、`CONF_USERNAME`、`CONF_PASSWORD`；也可在启动后配置连接 | [confluence-mcp-server README](https://github.com/qihaze123/confluence-mcp-server/blob/main/README.md) |

### 2.3 必须纠正的旧配置

| 旧配置 | 状态 | 新路径 |
| --- | --- | --- |
| `@modelcontextprotocol/server-github` | npm 元数据标记为弃用 | 官方远程 GitHub MCP 或 `ghcr.io/github/github-mcp-server` |
| `@railway/mcp-server` | npm 元数据标记为弃用 | `railway mcp` / `railway mcp install` |
| `@browserbasehq/mcp-server-browserbase` | npm 元数据标记为已迁移 | `@browserbasehq/mcp` |

### 2.4 MCP catalog 字段

建议区分：

- 可目录化元数据：显示名、描述、官方/社区、package、transport、文档 URL、许可证、工具类别、是否需要账号、是否需要本地运行时。
- 安装时解析：具体版本、包完整性、运行命令、安装脚本、系统依赖、浏览器/Node/Python/Docker 版本。
- 启用时解析：credential reference、环境变量名、header 名、OAuth scopes、project scope、read-only 选项、domain allowlist。
- 任务授权时解析：`mcp:<capabilityId>:<toolName>` grant、可写工具、外部副作用级别、预算/暂停门。

绝不能把 API key、token、cookie 或 OAuth secret 写入 catalog 条目、事件、日志或浏览器存储。目录只保存 `credentialRef`，实际值由宿主的凭据管理器在启用或派发时解析。

## 3. Pi extensions

### 3.1 Pi package 规范

Pi package 可以在 `package.json` 中声明：

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

来源：[Pi Packages](https://pi.dev/docs/latest/packages)

没有 `pi` manifest 时，Pi 会按约定目录发现：

- `extensions/`：`.ts` 和 `.js`
- `skills/`：递归寻找 `SKILL.md`，顶层 `.md` 也可作为 skill
- `prompts/`：`.md`
- `themes/`：`.json`

Pi 文档明确说明：package 可能执行代码并影响 Agent 行为；extension 以完整系统权限运行；第三方 package 安装前必须审查源代码。[Pi Packages security note](https://pi.dev/docs/latest/packages)、[Pi Extensions security note](https://pi.dev/docs/latest/extensions)

### 3.2 用户列出的五个 package

| Package | 版本/许可证 | manifest 和工具 | 额外依赖/凭据 | 来源 |
| --- | --- | --- | --- | --- |
| `pi-agent-browser-native` | 0.6.13 / MIT | `pi.extensions = ["./dist/extensions/agent-browser/index.js"]`；注册 `agent_browser` | 需要先安装 `agent-browser` CLI 并放入 PATH；完整录屏还依赖 ffmpeg；不是自带浏览器引擎 | [package page](https://pi.dev/packages/pi-agent-browser-native) |
| `pi-mcp-extension` | 1.5.0 / MIT | `pi.extensions = ["./src/index.ts"]`；把 MCP tools 桥接为 Pi tools | 支持 stdio、`streamable-http`、legacy `sse`；配置在 `~/.pi/agent/mcp.json` 或 `.pi/mcp.json`；自身不等于任何具体 MCP server | [package page](https://pi.dev/packages/pi-mcp-extension) |
| `pi-web-access` | 0.29.0 / MIT | `pi.extensions = ["./index.ts"]`；提供 `web_search`、`fetch_content`、`get_search_content`、`source_check` | 默认可通过 Exa MCP 零配置使用；更多 provider 可配置 API key；远程 hosted fetch 需要显式 opt-in；YouTube 帧提取可选 ffmpeg/yt-dlp | [package page](https://pi.dev/packages/pi-web-access) |
| `@ff-labs/pi-fff` | 0.10.6 / MIT | `pi.extensions = ["./src/index.ts"]`；注册 `fffind`、`ffgrep`、`fff-multi-grep` | 本地搜索；官方 README 说明没有网络调用，也没有额外凭据；使用本地索引 | [package page](https://pi.dev/packages/@ff-labs/pi-fff)。**已于 2026-11-07 从 Graph 卸载** |
| `pi-docparser` | 4.0.0 / MIT | `pi.extensions` + `pi.skills`；提供 `document_parse`、`document_search`、`document_screenshot` | 本地 LiteParse；无需 LLM/API key；OCR 可能下载语言数据；Office 文件可能需要 LibreOffice | [package page](https://pi.dev/packages/pi-docparser) |

### 3.3 兼容性风险

`pi-mcp-extension` 当前 npm peerDependencies 仍引用旧包名：

```text
@mariozechner/pi-ai
@mariozechner/pi-coding-agent
```

而当前 Pi 官方文档和核心包使用 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`。因此该 package 不能仅凭“官方页面存在”就标记为与当前 Graph 固定 Pi 版本兼容。目录需要单独记录：

- `piVersionRange`
- `peerDependencyScope`
- `compatibilityVerifiedAt`
- `compatibilityStatus: verified | unverified | incompatible`

Graph 现有 `pi-extension` 加载器只读取 `capability.json` 的 `entry` 和 `tools`，并不自动读取 Pi package 的 `package.json.pi` manifest。因此从 Pi package 到 Graph capability snapshot 需要一个明确的适配步骤，不能直接复制 npm 包后假定可加载。

## 4. `agent.md` 目录

本地样本目录：`/Users/macmini/workspace/07-ECC-main/agents/`

只读统计结果：

- 63 个 `.md` 文件。
- 63 个文件都有 YAML frontmatter。
- frontmatter 字段计数：`name` 63、`description` 63、`model` 63、`tools` 63、`color` 5。

代表性结构：

```yaml
name: code-reviewer
description: ...
tools: ["Read", "Grep", "Glob", "Bash"]
model: sonnet
```

来源示例：[code-reviewer.md](/Users/macmini/workspace/07-ECC-main/agents/code-reviewer.md)、[planner.md](/Users/macmini/workspace/07-ECC-main/agents/planner.md)

目录导入时不能把以下内容硬编码为 Graph 定义：

- `model: sonnet` / `opus`：这是来源平台模型名，不是 Graph 的模型等级或实际模型 ID。
- `tools: ["Read", "Write", ...]`：这是来源工具名，不等于 Graph 的 capability grant。
- 外部 MCP 名称，例如 `mcp__context7__query-docs`：必须先解析为已安装的 MCP capability 和任务 grant。
- 个人或项目专用路径、账号、品牌规则。

建议把 `agent.md` 导入为 `prompt` capability，并额外保存：

- `promptRole: agent | tool`
- `displayName`
- `description`
- `suggestedGrade`，由用户在 Graph 中确认，不从 `model` 自动映射
- `sourceToolNames`，仅作为参考，不作为授权
- `contentDigest`

## 5. 与 Graph 现有能力模型的关系

现有源码：

- `/Users/macmini/workspace/13-Graph/src/catalog/catalog.ts`
- `/Users/macmini/workspace/13-Graph/src/runtime/capabilities.ts`
- `/Users/macmini/workspace/13-Graph/src/core/task-runtime.ts`
- `/Users/macmini/workspace/13-Graph/presets/manifest.json`
- `/Users/macmini/workspace/13-Graph/src/web/App.tsx`

### 5.1 现有对象

`CapabilityRecord` 当前包含：

```ts
{
  id,
  kind: 'skill' | 'mcp' | 'extension' | 'pi-extension' | 'prompt',
  source,
  version,
  snapshot,
  status: 'installing' | 'installed' | 'failed'
}
```

`DefinitionSpec` 当前包含：

```ts
{
  recommendedGrade,
  capabilities?: CapabilityBinding[],
  prompts?: {
    agent?: CapabilityBinding,
    tool?: CapabilityBinding
  },
  review?,
  snapshot?
}
```

`CapabilityBinding` 只保存 `id` 和 `version`。这说明 Graph 已经有“定义版本绑定能力版本”的正确基础。

### 5.2 当前缺口

1. `source` 只是一个字符串，不足以保存 repo、subpath、commit、package、transport、license、archived 等目录事实。
2. `snapshot` 是 `Json`，可以临时承载扩展元数据，但当前没有类型化读取和 UI 投影；不宜长期把目录元数据藏在未定义结构里。
3. `install` 当前对本地 `source` 执行 `/bin/cp -R` 到 Graph 状态目录，没有 GitHub/npm 解析器、commit pin、许可证检查或子路径选择。
4. `loadCapabilities` 以 `kind` 分派加载；Skill 只检查 `SKILL.md`，Pi extension 只读 `capability.json`，MCP 只读 `capability.json` 的命令或 URL。目录条目必须在安装时规范化成这些运行快照。
5. UI 目前只显示已安装 capabilities 和 definitions；架构库是 `src/web/App.tsx` 中的硬编码数组，不能承载外部可发现目录。
6. ADR 0011 已明确当前还没有完整 `CapabilityBundleVersion`、`toolPolicy`、`runtimePolicy`；目录功能不能假装这些已经完成。

### 5.3 建议的映射

| 目录条目 | Graph 对象 | 说明 |
| --- | --- | --- |
| Skills 条目 | `CapabilityVersion(kind='skill')` | 安装后 snapshot 至少包含 `SKILL.md`；来源和许可证保存在目录元数据 |
| MCP 条目 | `CapabilityVersion(kind='mcp')` | `capability.json` 规范化 command/args/env refs 或 URL/headers refs/transport |
| Pi package | `CapabilityVersion(kind='pi-extension')` | 适配器从 `package.json.pi.extensions` 生成 Graph `capability.json`，并记录实际 entry |
| `agent.md` | `CapabilityVersion(kind='prompt')` | 作为 `DefinitionSpec.prompts.agent` 的候选，不直接成为运行模型配置 |
| Agent 组合 | `AgentDefinitionVersion` | 绑定精确 capability id/version；目录项不是定义本身 |
| Graph 架构 | 内置 architecture catalog | 现有 UI 可保留，建议纳入同一目录 API 但仍是只读参考 |

## 6. 安全边界

必须固定以下四层：

1. **发现**：目录条目显示来源、版本、许可证、风险、是否需要凭据。发现不等于安装。
2. **加入资源库**：解析并复制不可变快照，记录 digest、commit、许可证和安装状态。加入资源库不等于获得运行权限。
3. **绑定到 Agent**：`AgentDefinitionVersion` 精确引用 capability id/version。绑定不等于任务授权。
4. **任务授权**：MCP 工具按 `mcp:<capabilityId>:<toolName>` 授予；网络、文件和外部写操作继续经过 Graph 的调用门。

这与现有 ADR 一致：

- `/Users/macmini/workspace/13-Graph/docs/adr/0008-definition-bound-capability-loading.md`：安装能力不写入 `task_grants`，安装不扩大任务权限。
- `/Users/macmini/workspace/13-Graph/docs/adr/0011-isolated-pi-process-capability-bundles.md`：能力包、Pi 子进程、凭据留在宿主、digest fail closed。
- `/Users/macmini/workspace/13-Graph/docs/architecture.md`：远程 MCP 域名、工具名、描述和自报只读提示都不构成操作授权。

安装或启用时才解析的字段：

- MCP：命令路径、包版本、环境变量值、OAuth token、header 值、project ref、domain allowlist、read-only 模式、tool allowlist。
- Pi package：真实 entry、依赖树、Node/Python/系统依赖、执行代码的完整性、peer compatibility。
- Skills：脚本和 references 的路径、外部命令、网络调用、文件写入范围、账号要求。
- Agent prompt：来源工具名到 Graph 能力的映射、推荐等级、是否需要审查节点。

## 7. 建议的目录条目 schema

以下是一个建议，不是当前已实现 schema：

```yaml
schemaVersion: 1
id: github:owner/repo:skills/example
kind: skill | mcp | pi-extension | prompt | agent-definition | architecture
displayName: Example
summary: 一句话描述用途
source:
  type: github | npm | git | remote-mcp | local | builtin
  url: https://...
  repo: owner/repo
  path: skills/example
  requestedRef: main
  resolvedCommit: 40-char-sha
  package: "@scope/name"
  packageVersion: 1.2.3
  archived: false
license:
  expression: MIT | Apache-2.0 | custom | unknown
  path: LICENSE
  commercialUse: allowed | restricted | unknown
  redistribution: allowed | restricted | unknown
content:
  digest: sha256:...
  sizeBytes: 12345
  frontmatter: {}
install:
  strategy: copy-subpath | npm-package | mcp-template | manual
  requirements: []
runtime:
  transport: stdio | streamable-http | sse | none
  command: npx
  args: []
  envRefs: []
  url: null
  headerRefs: []
  oauth: false
  domains: []
  toolPolicy:
    default: deny
    allow: []
security:
  codeExecution: true | false
  network: none | declared-hosts | unrestricted
  filesystem: none | read | read-write
  externalWrites: true | false
  reviewStatus: unreviewed | reviewed | blocked
mapping:
  capabilityKind: skill | mcp | pi-extension | prompt
  suggestedAgentRoles: []
  suggestedGrade: null
```

关键约束：

- `resolvedCommit` 和 `contentDigest` 是目录条目可复现性的核心。
- `envRefs`、`headerRefs` 只保存引用名，不保存值。
- `toolPolicy.default` 应为 `deny`；目录不能把“工具存在”解释成“工具已授权”。
- `reviewStatus=blocked` 的条目可以展示，但不能绑定到正式任务。
- 目录来源页面发生变化时，旧 `resolvedCommit` 继续可追踪，新版本生成新的目录条目。

## 8. 首批内置目录建议

### 8.1 Skills

优先选择：

- `mattpocock/skills`：MIT、结构清晰、plugin manifest 可直接解析，适合作为首批精选。
- `anthropics/skills`：只收录逐条明确 Apache 2.0 的示例 skill；排除 `docx/pdf/pptx/xlsx` 等 source-available 条目，除非产品明确接受其条款。
- `K-Dense-AI/scientific-agent-skills`：先选少量无付费账号依赖、无外部写入的本地分析 skill，不能一次导入 166 条。
- `kepano/obsidian-skills`、`tscircuit/skill`、`KKKKhazix/khazix-skills`：作为领域精选。

默认不进入首批：

- `obra/superpowers-skills`：来源已归档。
- `mcncarl/yichen-skills`：非商业许可证限制。
- `affaan-m/ECC`、`Fission-AI/OpenSpec`：仓库太大或产品代码与技能混排，需要先做 curated subpath。
- `VoltAgent/awesome-agent-skills`：它是发现列表，不是技能安装源。

### 8.2 MCP

第一批建议只放低风险、可清楚说明权限边界的条目：

- `filesystem`：必须由用户显式选择允许目录。
- `sequential-thinking`：无凭据、无外部写入。
- `context7`：文档查询，API key 可选。
- `playwright`：本地浏览器自动化，默认视为外部副作用工具。
- `cloudflare-docs`：只读文档检索。
- GitHub 官方 MCP：优先远程 OAuth，明确工具范围和写入风险。

需要账号或高副作用、应放到后续分组：

- Supabase、ClickHouse：数据库读取/写入。
- Vercel、Railway、Cloudflare 账户级 server：部署和基础设施写入。
- Firecrawl、Exa、fal.ai、Browserbase、Browser Use：网络访问、云浏览器或付费模型。
- Atlassian、Confluence：企业数据和评论/工单写入。

### 8.3 Pi extensions

第一批优先：

- `@ff-labs/pi-fff`：本地、无凭据、无网络调用（已于 2026-11-07 卸载，见上表）。
- `pi-docparser`：本地文档解析，无 LLM/API key；但必须标注 LibreOffice/OCR 依赖。

需要网络或额外运行时，先作为可选条目：

- `pi-web-access`：默认可零配置，但会发网络请求并可能使用 provider 凭据。
- `pi-agent-browser-native`：依赖外部 `agent-browser` CLI 和 ffmpeg。
- `pi-mcp-extension`：在 peer dependency 兼容性复验前标记 `unverified`。

### 8.4 Agent 组合和架构

- 从 `/Users/macmini/workspace/07-ECC-main/agents/` 导入时只作为 `agent.md` 模板候选；`model` 和 `tools` 只作参考。
- Graph 现有的顺序、条件路由、扇出汇合、流水线、主管与工人、评估优化、对抗验证、多视角评委架构继续保留为只读架构目录。
- Agent 组合条目必须引用精确的 capability id/version，不能引用未固定的 `main`。

## 9. UI 信息层级建议

### 列表页

每个目录条目至少显示：

- 名称和一句话用途
- 类型：Skill / MCP / Pi extension / Agent.md / Agent 组合 / 架构
- 来源：官方、社区、内置
- 状态：未安装、已安装、更新可用、不兼容、已归档
- 风险摘要：是否需要凭据、是否会执行代码、是否可写外部系统
- 许可证标记：开放、受限、未知

筛选器建议：

- 官方/社区/内置
- 无需凭据
- 只读
- 本地运行
- 需要网络
- 与当前 Pi 版本兼容

### 详情页

建议分页或分区：

1. 概览：用途、来源、版本、许可证。
2. 权限：文件、网络、外部写入、凭据引用、工具类别。
3. 内容：Skill 指令、Agent prompt、Pi 工具、MCP 工具列表。
4. 安装：解析后的 commit、digest、依赖、安装策略。
5. 兼容性：Graph、Pi、Node/Python/Docker、平台。

### 操作层级

- `查看来源`：只读。
- `加入资源库`：创建不可变快照。
- `绑定到 Agent`：创建新的 AgentDefinitionVersion。
- `授权到任务`：针对当前任务生成具体 grants。

四个动作必须在 UI 和事件日志中分开，不能用一个“启用”按钮混合。

## 10. 未验证和待确认

- `laraplugins.io` 的 MCP 端点只核验到 HTTP 405/Allow: POST，未核验第一方授权文档和工具范围。
- Exa、Magic、Confluence、Jira 等社区 MCP 的包内容没有在本轮实际运行；本文只核对注册元数据、README 和官方文档。
- `pi-mcp-extension` 的旧 peer dependency 是否在实际当前 Pi 版本中仍能加载，未验证。
- Pi package 的 skill 自动发现、prompt 自动发现和 Graph 现有 `capability.json` 之间还没有适配器；本文没有声称已打通。
- 外部仓库的许可证可能随 commit 变化；实现时应保存 `licensePath` 和该 commit 下的许可证内容摘要。
- 没有安装任何外部 skill/MCP/Pi package，也没有调用任何付费 provider、MCP 服务或浏览器云服务。

## 一手来源索引

本地：

- `/Users/macmini/workspace/07-ECC-main/mcp-configs/mcp-servers.json`
- `/Users/macmini/workspace/07-ECC-main/agents/`
- `/Users/macmini/workspace/13-Graph/src/catalog/catalog.ts`
- `/Users/macmini/workspace/13-Graph/src/runtime/capabilities.ts`
- `/Users/macmini/workspace/13-Graph/src/core/task-runtime.ts`
- `/Users/macmini/workspace/13-Graph/src/web/App.tsx`
- `/Users/macmini/workspace/13-Graph/presets/manifest.json`
- `/Users/macmini/workspace/13-Graph/CONTEXT.md`
- `/Users/macmini/workspace/13-Graph/docs/adr/0008-definition-bound-capability-loading.md`
- `/Users/macmini/workspace/13-Graph/docs/adr/0011-isolated-pi-process-capability-bundles.md`

协议和规范：

- [MCP Transports, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Lifecycle, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Authorization, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)
- [Pi Packages](https://pi.dev/docs/latest/packages)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)

GitHub 仓库抽样：

- <https://github.com/obra/superpowers-skills>
- <https://github.com/garrytan/gstack>
- <https://github.com/mattpocock/skills>
- <https://github.com/mcncarl/yichen-skills>
- <https://github.com/American-Embedded/kistack>
- <https://github.com/luongnv89/skills>
- <https://github.com/tscircuit/skill>
- <https://github.com/KKKKhazix/khazix-skills>
- <https://github.com/affaan-m/ECC>
- <https://github.com/Fission-AI/OpenSpec>
- <https://github.com/anthropics/skills>
- <https://github.com/K-Dense-AI/scientific-agent-skills>
- <https://github.com/VoltAgent/awesome-agent-skills>
- <https://github.com/Imbad0202/academic-research-skills>
- <https://github.com/Fokkyp/SoftwareCopyright-Skill>
- <https://github.com/handsomestWei/patent-disclosure-skill>
- <https://github.com/kepano/obsidian-skills>
