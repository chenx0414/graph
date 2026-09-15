# U06 预设 Skills/MCP/人才包：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `1d1309e`（U05）。

## 交付内容

- **内置预设包** `presets/`：4 个 Skill（项目调查、实现与验证、独立审查、测试与交付）、1 个本地只读 MCP（`project-index`，工具 `project_search`/`project_read`，离线零账号）、4 个人才定义（master / coder / reviewer / tester）绑定准确 Skill/MCP 版本与推荐等级；manifest 带版本、来源、许可证、描述。
- **幂等、可升级的安装**（`src/catalog/presets.ts` + schema v16 `presets` 表）：按目录内容 hash 记录；未变化时第二次启动零发布、零安装；升级时产生新的 capability/definition 版本，旧版本保留给运行中实例；单个预设失败可重试（行不写入，下次启动重试）。
- **走既有版本化能力通道**：capability 复制经现有受限安装器；definition 通过 catalog 命令发布并以 `snapshot.preset` 记录 id/version/hash/license/source 便于溯源；用户复制/编辑内置定义会因 `publishDefinition` 递增版本而生成用户版本，预设不会覆盖它。
- **MCP 可移植命令**：能力 manifest 支持 `"command": "node"`（宿主解析为当前 Node 可执行文件），相对参数按快照目录解析；服务器以工作副本为 cwd，沙箱只给 scratch 写权（讨论态）或工作副本 + scratch（执行态），工具内再拒绝越出工作副本的路径。
- **启动接线**：daemon 启动即安装预设（不依赖模型配置）；预设包不可用时回退最小 master/coder/reviewer 定义；安装失败按单个预设记录并在下次启动重试。

## 验证

- `tsc` 主/Web、`vite build`、全量 `vitest run`：**65 → 66 文件 / 319 项通过**。
- `tests/console/presets.test.ts`（4 项）：
  1. 全新 stateDir 离线安装：9 个预设就绪、定义绑定准确版本、第二次安装全部 skip、定义与能力集合不变；升级后出现 `master@2` 且 `master@1` 仍可寻址；
  2. 真实 Pi 会话加载预设 Skill 并执行 `mcp_project_index_project_search`，检索结果回填会话，MCP 调用计入 invocation；
  3. `project_read` 拒绝 `../` 越界路径且外部文件未被改动；
  4. 缺失源的安装失败可重试，修复后成功。
- 原始输出：`acceptance-evidence/unified-console/u06/verification.output.txt`。

## 边界与后续

- 远程 MCP 模板未包含在预设包内（讨论期本就不可用，执行期需任务 grant），未冒充已安装。
- 预设升级不自动重绑运行实例；新实例使用最新定义版本。
- 人才定义详情/经历统计由 U09 展示。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/presets.test.ts
```
