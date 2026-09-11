# Pi 能力核查

核查日期：2026-09-10。以下是官方文档与源码的事实摘要，具体依赖版本仍需在实现前锁定。

- [官方 SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) 提供 createAgentSession、逐会话工作目录、模型与工具配置、事件流和资源加载，可用作每个 Agent 的内核。工作目录设置不等同于操作系统级隔离。
- [会话格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) 支持持久化消息树与会话恢复；外部命令崩溃后的结果核查仍需 Graph 实现。
- [官方设计取舍](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#philosophy) 不内置 MCP 或子 Agent 编排；Graph 需通过扩展或自建工具接入，并自行管理任务图、并发、额度及代码集成。
- [扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) 提供工具调用拦截；扩展本身具有宿主进程权限，不能将工具白名单当成扩展代码沙箱。
- [Usage 类型](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) 包含 input、output、cacheRead、cacheWrite 和 totalTokens。reasoning 属于 output，cacheWrite1h 属于 cacheWrite，不重复相加。
- [Anthropic 适配](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/anthropic-messages.ts) 将 input、output、cacheRead、cacheWrite 相加。用户已确认每次请求的缓存使用仍计量，同一次请求不重复相加。
- 会话可能包含工具内部模型调用、压缩与分支摘要的用量。Graph 需按原始调用归属记账，避免子 Agent 消耗被主管汇总结果重复累计。

已确认产品规则：暂停阻止下一次模型或工具调用，已发出的调用结束后停稳；用量缺失时暂停该 Agent 待核对；尽量预留额度，实际超出完整记账；允许自主搜索与安装 Skills/MCP/扩展。安装版本、复用与生效方式仍待明确。
