# U10 低门槛 APP 流程贯通：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `5882fbc`（U09）。

## 交付内容（贯通 U01–U09）

- **首次使用**：`#/setup` 向导只需平台 + API key + 推荐模型；高级设置收起；保存即热应用（U03/U05）。项目可选，普通目录由宿主在绑定时初始化 Git（U02）。
- **对话优先**：首页即会话列表与新建对话；主 Agent 讨论、草稿卡、确认、执行中追问沿用既有会话入口；确认后功能任务出现在对话页。
- **节点可见**：对话页每个功能任务的每个节点现在直接链接到 U08 只读节点详情（`#/tasks/:id/nodes/:nodeId`）；图页节点点击同样进入详情；程序节点显示确认命令与证据。
- **人才可见**：Agent 库定义可点击查看职责、能力安装状态、来源与经历统计（U09），经历可回到节点详情。
- **生效边界可见**：设置/向导显示“已保存并应用”；失败给出原因与可执行下一步；待生效不会伪装成功。
- **只读边界**：节点详情不含派发/插话控件；继续沟通仍走主 Agent。

## 已独立验证的组合流程

| 步骤 | 验证 |
| --- | --- |
| 干净启动 → 选平台填 key → 保存并应用 | `tests/console/setup-wizard.test.ts`（真实 Chromium，无终端、无手写 JSON；追加第二平台不覆盖；字段错误定位；保存不产生模型请求） |
| 聊天 → 绑项目 → 草稿 → 确认 → 功能任务 | `tests/m8/conversation-ui.test.ts`（真实 Chromium + 受控供应商） |
| 确认后 → 点节点 → 看真实对话/工具/运行记录/证据 | `tests/console/node-detail-ui.test.ts` + `tests/console/node-run.test.ts` |
| 看人才详情/经历并跳回节点 | `tests/console/talent.test.ts` + Agent 库面板 |
| Git 准备与脏仓库处理 | `tests/console/git-admission.test.ts` + 设置页“项目 Git 准备”卡片 |
| 配置热生效/轮换/禁用/并发 | `tests/console/hot-config.test.ts` |

## 验证

- `tsc` 主/Web、全量 `vitest run`：**69 文件 / 329 项通过**（对话节点链接改动后 conversation-ui 复跑通过）。
- 原始输出：`acceptance-evidence/unified-console/u10/verification.output.txt`。

## 边界

- 内部 UUID/revision/grant 仍出现在高级区（节点详情、设置），普通首屏不展示。
- “禁用连接”目前通过把凭据引用改为未配置的名字并保存（UI 已有入口），或在设置中删除连接；显式一键禁用按钮留待后续。
- 窄窗口/键盘可达性沿用现有组件，未做专项审计。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/setup-wizard.test.ts tests/m8/conversation-ui.test.ts tests/console/node-detail-ui.test.ts tests/console/talent.test.ts
```
