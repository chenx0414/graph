# 可复用 Matt 团队

**何时读取**：main 需要把已确认的功能任务交给 Matt skills 团队，或复用、调整已有团队时。先读运行应用的 [Graph API](graph-v2.md)；配方保存与编译使用 [配方入口](agent-recipes.md)，不创建另一套团队目录或执行内核。

## 选择流程与准备指令

1. main 从实际能力和配方清单核对已绑定 `/ask-matt`、`/writing-for-agents`，实际读取两份 SKILL.md。使用 ask-matt 选择当前阶段；已确认规格和任务不重新访谈。项目采用 Matt 文件流程时，首次实现前检查 tickets 阶段，实现产生提交后检查 implement，独立审查前检查 review。不要继承旧 matt-implement 身份中“首次开工先检查 implement”的陈旧要求。
2. 按 code-review 固定实际存在的比较基点、规格与规范来源。main 使用 writing-for-agents 给四个节点编写 instructions：明确步骤、输入的精确产物、应读取的技能、范围与完成条件。task 仅是摘要。保留 submission 和正式 acceptance；指令文本不代替约束，也不会绑定新能力。
3. 模板角色为 planner（codebase-design）、worker（tdd）、standards 与 spec（code-review，两个独立审查身份）。main 已在 graph 外安排 code-review 的两条并行审查车道；节点各执行所属轴，不调用不存在的 spawn 工具。选择 reviewer 模型时排除 planner、worker 的实际上游模型身份；两个轴可以使用同一个合格的独立模型。模型连接 ID 来自运行应用，不能照抄示例。

## 装配并保存真实模板

装配入口属于运行应用 Examples 路径中的 `assemble-matt-team.ts`；它和 `src/catalog/matt-team.ts` 随现有 App 源码打包，不依赖业务仓库的 scripts。下面命令中的路径替换成 system prompt 提供的运行应用 Examples 绝对路径，使用该应用的 Node 24：

```bash
node <Examples>/assemble-matt-team.ts --url http://127.0.0.1:<port> --config /absolute/task-options.json --out /absolute/matt-team.json
```

配置是一份 JSON。例如下列 check 运行项目自身的完整检查；没有该命令的项目必须改为实际验收命令，不能用 node --version 冒充功能通过：

```json
{
  "name": "功能任务的 Matt 团队",
  "task": "实现已确认的功能",
  "spec": "docs/specs/feature.md",
  "ticket": 123,
  "baseRef": "完整基线 commit SHA",
  "recipePrefix": "matt-team",
  "check": {"command": "node", "args": ["--run", "check"], "timeoutMs": 300000},
  "models": {"planner": "已配置规划连接", "worker": "已配置实现连接", "standards": "已配置独立审查连接", "spec": "已配置独立审查连接"},
  "instructions": {
    "planner": "main 按上述职责填写本任务的完整规划步骤与完成标准",
    "worker": "main 填写读取精确 plan、使用 tdd 实现、检查提交发布、依据两个精确报告在原节点返工的步骤",
    "standards": "main 填写 Standards 轴的规范来源、固定基点、精确成果引用与正式审查报告要求",
    "spec": "main 填写 Spec 轴的规格/任务来源、每项验收与正式审查报告要求"
  }
}
```

instructions 可省略以取得职责完整的默认指令；实际任务应审阅并补充项目条件。声明空白指令会被正式定义校验拒绝。相同 recipePrefix 复用相同角色配方；身份与绑定不变时编译保留当前版本，变化时发布新版本。需要并存不同角色组合时改用新前缀。

入口先读取实际 catalog，核对四角色全部所需技能均可用，再保存任何配方；缺失时列明角色和资源 ID，无配方写入。技能采用能力库实际选中版本，并把精确版本冻结到配方；不会生成技能、修改能力文件、添加权限、改 main 配方或自动启动图。保存/编译失败明确报错，已保存的配方仍可通过现有 catalog 查看和修复。

成功后 `--out` 真正写出普通 schemaVersion:2 JSON，所有 recipe 都是编译回执的精确 definitionVersion，没有假的 @1 引用。已有输出文件会被拒绝。保留这份文件即可复用：按新任务调整 name/task/instructions 和模型，再交给 graph_create；也可作为现有 templates 的 definition，通过 instances 固定模板版本复用。一次任务一张 graph，不因返工另建图；不同任务实例有独立会话与顶层产物范围。

## 运行、返工与最终验收

1. main 用完整输出定义创建草稿或 graph，并为代码任务明确 targetBranch。向公开 `job` 输入投递任务上下文；创建不会自动运行。
2. planner 发布不可变 plan，`result` 传递 plan 的 artifactId/version/digest。worker 必须 artifact_read 该版本，按 plan 实现，检查后 workspace_commit，并发布真实已提交代码产物或精确代码清单；result 携带原 plan 和新的 subject 引用。
3. standards、spec 读取同一精确 plan/subject，各自独立、只读检查实际集成工作副本，发布 `graph.review@1` 报告（commit/passed/reason 加上 plan/subject/axis/evidence），通过 result 提交精确报告引用。private source commit 仅是实现来源；正式报告 commit 必须是实际审查的 integration SHA。
4. decision 模块只有在两份报告的 plan、subject 的 ID/version/digest 与 commit 完全相同时才判断。任一轴失败沿普通 rework 边回原 worker，并携带两个报告；worker 读取精确报告后在原会话返工。两轴通过时公开 result 返回 main。旧版通过与新版报告混合时不会输出结果。
5. **result 通过后仍未完成正式验收。** main 等 graph 空闲，显式 `graph_send({graphId,input:"check",value:{}})`；等宿主 operation 结算，再调用 `graph_inspect({graphId,query:"acceptance"})` 核对 check 和两个 review 都验证当前干净 integration commit。检查没有传出公开业务 result；完整记录通过 operations/acceptance 查看。
6. 报告 SHA 陈旧或未实际验证当前集成时，向原 standards/spec 的 job 重新投递同一精确 plan/subject 与当前集成要求，等实际审查发布新报告，再核对正式验收。若曾提出 complete，则先 withdraw_complete 恢复输入。不能伪造通过产物、弱化 acceptance 或仅凭 decision.approved 请求最终交付。
7. 验收全部有效后由 main 请求 complete，已有工作排空后完成 Git 交付；需要人类验收时在确认草稿阶段另外声明 human 条件。真的出现 Git 冲突才派合流角色，之后重新检查和审查。graph 空闲、节点回复“完成”或普通 passed 投递均不是正式完成证明。
