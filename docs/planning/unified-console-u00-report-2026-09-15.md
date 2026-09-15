# U00 统一基线与公共契约报告

日期：2026-09-15。工作分支 `feat/unified-console`，工作树 `/Users/macmini/workspace/graph-unified-dev`。本报告记录基线事实、契约冻结与八项要求的映射；不代表功能已实现。

## 基线核对

| 项 | 值 |
| --- | --- |
| HEAD（规划基线） | `787fcf2`（`docs: record the unified branch merge...`） |
| 合并提交 | `695bbc5`（`feat/master-agent-entry` c917fc5 × `feat/app-console` 7f94c6c） |
| 分支 | `feat/unified-console`（未切回旧分支，未改 main） |
| 项目 Node | `v24.20.0`（`./node_modules/.bin/node`） |
| Pi SDK | `@earendil-works/pi-coding-agent` / `pi-agent-core` / `pi-ai` 0.85.1 |
| 构建结果 | `tsc --noEmit` rc=0；`tsc -p tsconfig.web.json --noEmit` rc=0；`vite build` 通过 |
| 测试结果 | `vitest run` 58 文件 / 286 项通过，rc=0 |
| 原始输出 | `acceptance-evidence/unified-console/u00/baseline.output.txt` |

工作树在本轮开始时的未跟踪文件只有 `unified-console-roadmap-2026-09-15.md` 与 `unified-console-agent-handoff-2026-09-15.md`；本轮把两份计划文档随 U00 一并提交，不覆盖其他工作区文件。

## 八项要求到工作包的映射

| 用户要求 | 工作包 | 优先级 |
| --- | --- | --- |
| 预设 Skills/MCP/Agent 人才库 | U06（+U04 目录、U09 详情） | P1（本轮必交付） |
| 图/看板进入真实节点详情 | U07（数据）、U08（界面） | P1（本轮必交付） |
| 业务项目必须 Git 化 | U02（+U05/U10 入口） | P0 |
| 选择供应商填 API key 一键配置 | U04（协议）、U05（向导） | P0 |
| APP 配置热生效 | U03（+U04/U05 接口） | P0 |
| 人才详情与工作经历统计 | U09（+U07 记录） | P1（本轮必交付） |
| 默认不限累计 token 与总时长 | U01 | P0 |
| 低门槛完整桌面流程 | U10（贯通 U01–U09） | P0 |

整体回归、真实桌面流程与交接包由 U11 完成。长会话自动摘要与真实模型对话质量评估保留为已知未闭合项（见文末）。

## 契约冻结（ADR 0010）

[ADR 0010](../adr/0010-unified-console-contracts.md) 固定五组契约，工作包不得另行定义：

1. **额度**：新实例默认 `tokenLimit = null`（不限）、`runTimeLimitMs = null`；有限与无限是可空判别而非魔法数字；旧实例原样保留；暂停/未知用量/权限/名额/凭据并发/实例身份/恢复规则不变。
2. **Git 准入**：正式派发只在准备好 Git 的项目内；宿主初始化非仓库并生成受控基线；脏仓库默认阻断并给出显式处理入口；不自动 reset/提交/改 remote/push。
3. **热生效**：由宿主 ConfigManager 维护不可变快照、凭据版本与已应用 revision；保存失败保持旧配置；key 轮换只影响未发送请求；排队发送前重解析；不以 relaunch/重建会话冒充。
4. **会话投影**：定义/实例/activation/operation/invocation/session 严格区分；工人与审查实例接入真实 Pi 事件；详情只读；程序节点展示命令与输出，容器展示子节点；分页用稳定游标。
5. **统计**：按指标独立判断完整性；unknown 不折零；每项显示样本数/未知数/未结束数；跨版本用总和/总样本数；主管对话单列。

同步更新：`docs/graph-mvp.md` 的累计额度默认值改为“默认不限，可显式设置有限额度”，并指向 ADR 0010。历史验收报告的结论不改写。

## 公共状态与迁移排号（集成负责人）

- 数据库迁移从 `store.ts` 当前版本 +1 起连续分配（当前为 v13，U01 使用 v14）；每个工作包提交前登记自己的编号，不允许并行分支各自定义同一版本。
- 配置 schema 版本、`task-runtime.ts` 公共 DTO 与 REST 路由由集成负责人在工作包评审时合并；新增字段必须能表达 `unlimited`、`unknown`、历史版本与“待生效”状态。
- 价格目录与快照版本编号沿用 `catalogRevision` 语义，不新开第二套目录。

## 已知未闭合项（保留，不宣称完成）

- 长会话自动摘要/压缩：未实现；不限累计 token 不等于无限上下文。
- 真实模型对话质量评估：未执行；脚本化供应商与受控 fixture 不能替代。
- OAuth 订阅登录、多云企业身份、RPM/TPM/429 冷却：不在本轮范围。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/node --version
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/vitest run
```
