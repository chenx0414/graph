# Graph

为已有项目的功能开发编排 Agent：先与主管讨论并确认需求，再自主拆解、并行执行、交接上下文、审查返工和合并。

当前状态：M0 的 Pi 兼容性、调用控制与 macOS 受限执行验证，M1 的持久任务内核，以及 M2 的全部图模式、子图、返工与验证器已落地。可在无真实模型服务的情况下执行、恢复并调度完整任务图；生产 Pi 接入和 Web 应用继续按计划实施。Graph 为当前工作名称。

## 从这里开始

- [首版产品设计](docs/graph-mvp.md)：范围、执行规则与首个真实任务。
- [实现架构](docs/architecture.md)：模块 interface、持久化、Pi 接入与恢复方式。
- [实施计划](docs/implementation-plan.md)：M0–M7、18 个工作包和验收矩阵。下一里程碑为 M3。
- [M0 验证报告](docs/planning/m0-results.md)：准确依赖、可运行证据、适配方式与生产接入边界。
- [M1 验证报告](docs/planning/m1-results.md)：任务入口、所有权、调用恢复、名额额度和跨进程示例。
- [M2 验证报告](docs/planning/m2-results.md)：全部图模式、容器、回环、图修订、三类验证器与八种模板。
- [领域术语](CONTEXT.md)：Agent 定义、实例、节点、任务与额度的准确含义。
- [决策记录](docs/adr/)：已作选择的理由与权衡。

首版采用 Pi Agent、TypeScript、本机 Web 和独立后台，支持全部已确认图模式与验证器。完成标准包括执行机制测试，以及由 Graph 交付 MediaBookmarks 的 B站 Web 应用任务。

任务平台使用 GitHub Issues；目前仅有本地 Git，尚未指定 GitHub 仓库，工作包保存在实施计划中。

## 运行验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo:m1
```

pnpm 使用项目声明的 Node 24.20.0，不修改系统 Node。完整 M0 测试要求 macOS 的系统 sandbox-exec 和可用的 npm CLI；其他平台会明确失败。测试使用临时目录、本地响应服务与虚构凭据，不调用收费模型。
