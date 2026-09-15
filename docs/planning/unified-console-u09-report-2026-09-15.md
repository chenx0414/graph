# U09 人才详情与工作经历统计：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `5975a23`（U08）。

## 交付内容

- **共享聚合内核** `src/core/talent.ts`（服务端计算，不在 React 对截断数据求均值）：
  - `talentDetail(store, id, {version?})`：定义版本列表、职责/描述、推荐等级、是否独立审查、绑定能力及其真实安装状态与来源、`snapshot.preset` 溯源（内置预设 vs 用户版本）。
  - `talentExperience(store, id, {version?})`：按组织原则 `taskId + instanceId` 聚合，返工/重试/模型切换不虚增经历；每条样本含 token、runMs、费用（币种）、尝试次数与返工轮次、失败/未结束标记。
  - **按指标独立判断完整性**：token 均值只用已知且已结束样本；时间均值只用完整时间样本；费用缺失/未知/多币种保持未知，不与 token 分母绑定。显示各自样本数、未知数、未结束数、失败数。
  - **主管聊天单列** `chat` 序列，与功能任务 `task` 序列分别统计；跨版本用“总和/总样本数”的原始池，不平均版本均值。
- **API**：`GET /api/catalog/definitions/:id?version=` 返回 `{detail, experience}`；Runtime `talent(id, options)`。
- **界面**：Agent 库中定义可点击，详情面板展示职责、版本、绑定能力状态、预设/用户溯源、任务/对话样本数与三项均值（含样本/未知）、经历列表；经历可跳到 U08 节点详情。

## 验证

- `tsc` 主/Web、全量 `vitest run`：**69 文件 / 329 项通过**；新增 `tests/console/talent.test.ts`（5 项）。
- 覆盖：100/300/unknown → token 均值 200、样本 2、未知 1，时间 10s/30s/unknown → 20s、样本 2；交叉缺失 token=100/时间=10s 与 token 未知/时间=30s → token 均值 100（n=1）、时间均值 20s（n=2）、费用保持不完整；两版本原始池合计；同实例 3 次尝试算 1 条经历、返工 2 轮且用量累计；未结束样本不计入均值；对话与任务序列分开；无记录为“暂无”；详情的能力安装状态与来源、内置/用户溯源。
- 原始输出：`acceptance-evidence/unified-console/u09/verification.output.txt`。

## 边界

- 统计不做历史回填；旧数据缺时间段显示未知，不补造精确时长。
- 失败原因细分仍以问题记录为准。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/talent.test.ts
```
