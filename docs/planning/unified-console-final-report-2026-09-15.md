# Unified Console 八项要求：最终交付报告（U00–U11）

日期：2026-09-15。分支 `feat/unified-console`，最终交付提交见文末固定。基线 `787fcf2`，本轮不合并 `main`、不发布、不触碰两个旧 feature 分支与其他工作区。独立验收结论以验收方为准；本文件只汇总实现、提交与证据。

## 提交与工作包

| 工作包 | 提交 | 内容 |
| --- | --- | --- |
| U00 | `8cd1523` | 基线核对（Node 24.20.0 / Pi 0.85.1 / 286 项通过）；ADR 0010 五组契约；`graph-mvp` 默认额度改为不限 |
| U01 | `2d9a331` | 新实例默认不限累计 token（schema v14 `instances.unlimited`）；有限额度仍阻断；显式 `setBudget`；界面显示“不限” |
| U02 | `6c0b4b8` | 项目 Git 准入（schema v15 `project_preparation`）；宿主初始化/基线/脏仓库阻断；验收/绑定前预检；负缓存修复；子目录范围 |
| U03 | `afe9242` | 配置/凭据/调度器热生效（LiveConfig、`/api/app/secret` 令牌桥、`--dynamic`）；发送时重解析；不在途/排队串 key；无 relaunch |
| U04 | `30e8b83` | Anthropic Messages 原生传输；价格币种/来源/快照；六类供应商模板 |
| U05 | `1d1309e` | 模板驱动的一键向导；保存即应用；追加平台不覆盖；字段错误/连接测试 |
| U06 | `c67c49b` | 预设 4 Skills + 本地只读 MCP + 4 人才定义；schema v16 `presets`；幂等/可升级/可重试 |
| U07 | `790af5e` | 节点会话与运行投影（schema v17 `node_entries`/`node_sessions`/operation 计时）；凭据等待与运行分离 |
| U08 | `5975a23` | 统一节点详情面板与直接路由；程序命令、工具、运行记录、证据；只读 |
| U09 | `5882fbc` | 人才详情与按指标的经历统计（样本/未知/未结束/失败；对话工作单列） |
| U10 | `dc3b5c5` | 对话任务节点直达详情；组合流程验证（向导→对话→确认→节点→人才） |
| U11 | 本文件提交 | 最终全量、探针、真实 Electron APP 冒烟与交接 |

## 迁移

`store.ts` 依次新增：v14 `instances.unlimited`；v15 `project_preparation`；v16 `presets`；v17 `node_entries`/`node_sessions` 与 operation 计时列。所有迁移只增列/增表，不改写历史行；旧实例、旧价格记录与历史验收结论保持原样。数据库版本上限 17。

## 最终验证（准确 SHA 见文末）

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build`：rc=0。
- `vitest run`：**69 文件 / 329 项**，连续两轮全部通过。
- 真实 Electron APP 冒烟：`GRAPH_APP_SMOKE=1 npx electron@44.3.0 .`（临时 userData）输出 `APP_SMOKE_OK http://127.0.0.1:…`，rc=0；验证 Electron main + 子进程 daemon + 窗口加载真实链路。
- 验收方主 Agent 入口探针：`history-global-seq`、`history-cache-consistency`、`message-state-millisecond`、`decision-empty-snapshot`、`conversation-ui-boundaries` 全部 rc=0 且语义断言通过。
- 8 个历史沙箱/监听探针全部 rc=0。
- app-console 端到端探针 `app-a3-flow`、`app-ui-restyle` rc=0（截图副作用已恢复提交字节）。
- 原始输出：`acceptance-evidence/unified-console/u00..u11/` 与本目录 `verification.output.txt`、`probes.output.txt`、`app-smoke.output.txt`。

## 八项要求对应结论

1. 预设 Skills/MCP/人才库：U06，真实安装、绑定、可运行、幂等、有版本与溯源。
2. 图/看板进入真实节点详情：U07+U08，条目来自真实 Pi 会话，程序节点显示命令，只读。
3. 业务项目必须 Git 化：U02，宿主初始化/基线/脏仓库阻断，正式派发无无 Git 回落。
4. 选供应商填 API key 一键配置：U04+U05，模板对应已验证 transport。
5. APP 配置热生效：U03，保存/密钥推送即时更新后续发送绑定，无重启冒充。
6. 人才详情与经历统计：U09，完整后端记录、指标独立分母、对话工作单列。
7. 默认不限累计 token 与时长：U01，保留用量/未知/暂停/权限/并发/恢复；旧实例不静默扩额。
8. 低门槛完整桌面流程：U05+U10 与组合测试；真实 Electron 冒烟通过。

## 未测与保留边界（不宣称完成）

- 真实付费供应商冒烟未执行（无指定测试凭据）：OpenAI/Anthropic/Gemini/DeepSeek/OpenRouter 的线上行为以本地契约测试为准，不标“官方已验证”。
- 长会话自动摘要/压缩未实现；不限累计 token 不等于无限上下文。
- 真实模型的理解、追问、解释与决策维护质量未评估。
- OAuth/订阅登录、多云企业身份、RPM/TPM/429 冷却不在本轮。
- “一键禁用连接”仍通过改凭据引用/删除入口完成；容器节点独立详情路由、窄窗口与键盘专项审计留待后续。
- 结论由独立验收决定；本提交不合并 main、不发布。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/vitest run
GRAPH_APP_SMOKE=1 npx --yes electron@44.3.0 .
```
