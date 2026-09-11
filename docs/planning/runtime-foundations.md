# 本机执行基础核查

核查日期：2026-09-10。这里区分官方能力、本机事实与规划选择，未安装依赖或运行真实模型请求。

## 本机事实

当前环境为 macOS arm64，Node.js 26.3.0、npm 11.16.0、pnpm 11.19.0、Git 2.50.1。Graph 目录已初始化 Git，无远程仓库，尚无应用代码与依赖清单。本轮未读取环境密钥。

## 运行时与存储

- Node 官方将 24 列为 LTS、26 列为 Current；生产应用推荐 LTS。规划采用 Node 24 LTS，具体补丁版本在首个兼容性验证中固定，不修改其他项目运行时。[发布表](https://nodejs.org/en/about/previous-releases)
- Node 24 的 `node:sqlite` 为 release candidate，提供同步 DatabaseSync。规划将其封装在持久化模块内，固定 Node 版本并做真实数据库测试；不将驱动成熟度表述为已经稳定。[Node 24 SQLite 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- SQLite WAL 允许读写并行，但同一时刻只有一个 writer；FULL 同步模式在每次提交同步 WAL。规划使用本机磁盘、单写者、短事务，事务内不执行外部调用；采用 WAL + synchronous=FULL，备份使用数据库备份接口，不单独复制活跃主文件。[WAL 文档](https://www.sqlite.org/wal.html)
- SQLite 的事务原子性只覆盖数据库状态，不能把 Git 或模型调用并入同一事务。Graph 另记操作意图与结果，并在恢复时核查外部事实。[事务文档](https://www.sqlite.org/atomiccommit.html)

## Web 与任务图

- Fastify 可运行本地 Node HTTP 服务并提供请求注入测试接口，规划承载命令、查询与事件流；任务生命周期不绑定 HTTP 请求。[Fastify](https://fastify.dev/docs/latest/Reference/Server/)
- Vite 支持 React 项目模板；规划用 React + Vite 构建本机界面，依赖兼容性与 Node 版本一起锁定。[Vite](https://vite.dev/guide/)
- React Flow 支持父子节点和禁用拖动，可呈现子图；它是显示层，不负责执行。自动布局采用 elkjs 候选，验证回边、折叠和跨容器连线后固定版本。[React Flow 子图](https://reactflow.dev/learn/layouting/sub-flows)、[elkjs](https://github.com/kieler/elkjs)

## Git 与工具执行

- Git worktree 支持一个仓库的多个工作树，各自检出分支。规划由受控 Git 模块管理实例副本、任务集成分支和最终合入，普通 Agent 不直接管理目标分支。[git-worktree](https://git-scm.com/docs/git-worktree)
- `git merge --ff-only` 在不能快进时拒绝合并。规划先在集成分支生成并验证包含目标分支最新状态的提交，最终只合入已核验结果；脏目标工作区与竞争变化须核查，不能自动覆盖用户修改。[git-merge](https://git-scm.com/docs/git-merge)
- MCP 官方 TypeScript SDK 支持客户端与本地/远程连接。Graph 管理连接、凭据引用和逐工具授权，不将 MCP 工具注解当成权限事实。[官方 SDK](https://modelcontextprotocol.io/docs/2026-07-28/sdk)

## 自主安装扩展的执行约束

Pi 扩展具有宿主权限，见 [Pi 核查](../pi-capabilities.md)。任意扩展不能与持有正式数据库和所有凭据的后台同进程加载；进程隔离也不自动等于权限隔离。

`@anthropic-ai/sandbox-runtime` 的官方实现支持 macOS 文件路径与网络限制；域名过滤并不能区分检索和修改外部服务，且官方注明自定义代理仍存在配置限制。它是本机受限执行的候选，必须先验证与受控工具/模型代理的组合，不宣称仅靠域名白名单已满足 Policy。[官方实现与限制](https://github.com/anthropics/sandbox-runtime)

首个里程碑需要证明：扩展、子进程、压缩/摘要和重试都不能绕过模型准入与额度记录；工具执行不能写正式状态库或越出授权范围。若当前 SDK 或执行环境无法满足，调整适配实现并复验，不能用“已设置 cwd”代替验收，也不能静默退化为提示词约束。
