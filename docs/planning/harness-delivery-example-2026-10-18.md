# 以经过 E2E 执行的代码交付示例减少 API 查找歧义

上一轮完整资源 parser A 中 main 反复阅读 Graph API、acceptance、Git integration 与源码，180 秒内没有发布 proposal。现有 pipeline 示例只展示节点与宿主命令连接，其 check 是 node --version；文档明确它不证明项目验收。正式代码交付规则存在于 graph-v2 与 artifacts-and-git，但此前缺少一份把 worktree、代码 artifact、host check、独立 reviewer 与精确 integration commit 放在一起的完整定义。

本轮补齐按需材料，不改系统 prompt、工具 schema、模型、effort、默认配方或 flag，不新增真实模型会话，不补跑已停止小集。该示例解决 API 装配的文档缺口；尚未证明真实 planner 少读文件、减少轮次、降低成本或提高成功率。

## 交付材料与边界

- `examples/graphs/parser-delivery.json` 是完整原生 JSON definition：work 节点在真实 worktree 修复 config.js、提交并发布代码 artifact；check 是真实导入 parser 的行为检查；review 使用独立审查配方并发布 graph.review@1；定义声明 check/review 两项正式验收。节点都有非空 instructions，原始配方能力仍需匹配工具。
- `docs/agent/code-delivery.md` 说明稳定 recipe ID / definitionVersion / 当前模型连接的装配，外层草稿 acceptance 与定义验收的对应关系，以及 main 按工作完成 → 当前 integration commit → 宿主检查 → 独立审查 → 最终完成与 Git 交付的调用次序。不是自动确认接口，不授予新权限，不替代真实证据或用户已声明的人工验收。
- 当前 `graph-v2.md` 和 `artifacts-and-git.md` 提供有明确触发条件的链接；正文仍按需读取，不把完整例子塞进缓存前缀或 main system prompt。原正式规则未删减。已有结构示例保留，本文不把 node --version 当业务验证。

示例 recipe/model 字段是连接占位符；实际使用前必须读取当前目录并采用用户指定模型及真实配方版本。没有把某个 DeepSeek/LongCat/Step 5 组合写成新默认。示例只实现 parser 任务；用于其他业务时要替换具体检查、产物和节点指令，不能把 parser 检查当成任意项目的通过证明。

## 可执行证明

现有 `tests/e2e/harness-workflow.test.ts` 的三行完整交付流程直接读取新 JSON，只替换当前受控模型/已编译配方连接，自动偏好行按原契约省略 worker 的显式模型。退休该 owner 内复制的 graph 定义，避免文档与测试定义分别演进。

仍然通过真实 CLI/HTTP、Pi、持久化、Git worktree/commit、宿主集成、immutable artifact、host check、独立 reviewer、正式完成与目标项目外部行为验收；辅助请求和全部角色仍进同一成本报告。外部模型使用本地受控 HTTP 服务，不伪造宿主完成回执、不 mock 自有组件。自动确认仅限原隔离测试夹具的授权，不作为生产授权说明。

`/tmp/graph-delivery-example-red.log` 在补充文件前因实际示例不存在而失败；这是缺少交付 artifact 的证据，不能冒称旧运行时功能缺陷被复现。补齐后 `/tmp/graph-delivery-example-green.log`：1 文件、5 测试通过，49.59 秒。保留原 bare/frozen-auto/frozen-explicit、查询错误恢复、原始资源冻结、自动模型偏好、独立审查和完整逐模型用量断言；没有新增或改写低层测试。

## 效率假设与限制

新指南 4,653 bytes，JSON 2,630 bytes，共 7,283 bytes；这是材料体积，不是实际阅读量、token 或费用下降。真实轨迹中首次 bash 阅读旧 Graph 文档正文 25,899 bytes；不同材料覆盖范围不同，不能直接相减当可实现节省。

受控模型不会自行选择文档，因此测试没有证明新入口的发现率或 planner 质量。跨模型、MCP、浏览器、运行时间与生产 task mix 仍需真实证据。不能用这次 E2E 把原失败样本改为通过，也不能因此扩大模型评测授权。

回滚撤销新增指南/示例/链接，并恢复 owner 原内联定义；无运行时行为、状态迁移或生产重启。当前保留全部默认设置，整体“完整任务价格加权成本下降且质量不降”仍未达成。

最终全量 `/tmp/graph-delivery-example-check.log`：272 文件、1,514 测试通过，348.49 秒；baseline 匹配，验收证据不变。
