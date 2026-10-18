# 已批准：完整资源与正式交付下重新评估免费 worker

状态：2026-10-18 使用者明确回复“批准这 4 个隔离会话”。授权仅限下述顺序和停止条件；批准时尚未发起本提案的真实模型会话。目标仍为整棵任务价格加权成本下降、质量不降。原有 LongCat worker 和 Step 5 planner 的批准范围均已按各自停止条件结束；不延伸旧批准，也不修改旧失败记录。

## 为什么提议重评而非宣布旧候选通过

旧 LongCat worker 仅 1/3 完整成功，DeepSeek 对照 3/3，旧候选确实不通过。后来核实当时的私有配方 resources 为空，而当前生产 main/coder/reviewer 为 14/6/5 项绑定；不能据此将候选泛化为生产默认模型的成功或失败。[保真报告](harness-eval-fidelity-2026-10-18.md)保留此限制。

现在 v2 归档已经严格恢复完整配方、能力、Prompt 与 SDK 缓存；三个本地受控外部模型已通过真实 worktree、提交、artifact、host check、独立 review 与目标交付的整条链路，24 请求全部入账。资源补齐只构成新条件下重评的理由，不保证候选质量改善。当前输出与提示词实验均无可归因的已验证降本收益，仍关闭。

2026-10-18 再次核对 [OpenCode Go 官方页](https://dev.opencode.ai/v2/docs/console/go/)：LongCat 2.5 Preview Free 仍为限时免费，不保证长期价格。Step 5 Preview 不是本地旧的 step-5-preview-free 别名，不静默替换。通过同一现有 Go 凭据测试；不可用或不接受参数就记录失败并停止，不新增凭据或换模型。

## 精确范围

最多 4 个新的私有完整 workflow 会话：parser A、parser B、CLI B、CLI A。每会话模型运行 180 秒；冻结任务原话、初始文件、独立行为验收，保留完整原配方与资源；不做提示词或输出 flag 组合，所有实验 flag 关闭。每个角色开始自己的 fresh context，不在已有会话中切换模型。

| 角色 | A | B |
| --- | --- | --- |
| main/planner | 当前 DeepSeek V4.1 Flash high | 相同 |
| coding worker | 当前 DeepSeek V4.1 Flash high | 当前 LongCat 2.5 Preview Free medium |
| 独立 reviewer | Step 5 Preview medium，upstream step-5-preview | 相同 |

表内 high/medium 是当前配置的 model grade；不把 grade 冒称 reasoning effort。本轮沿用既有 runtime 的思考强度规则，不增加 effort 覆盖。Step 5 仅复制现有 medium profile 的请求参数并换成已批准的 upstream ID，移除旧免费别名的零费率。

只在临时配置显式指定角色模型，生产模型、路由、effort、配方、分工与用户会话不改。B 是模型与当前 profile 的整体候选，不把结果归因纯模型。reviewer 与实现模型不同，必须读取不可变 artifact 并审查当前 integration commit，保留产品的独立性和精确提交门禁。

任务原话作为首段保留；另以用户角色的“已批准的隔离评测执行约束”明确正式 graph、冻结 worker/reviewer 模型、worktree、host check、不可变 artifact、精确 integration commit 与独立审查要求。公开 conversation create API 仅提供 text，故使用同一 user message 的独立段落，不修改 system prompt 或原配方；A/B 除 worker ID 外约束一致。发送前保存该 setup。

main 发布合法 proposal 后，runner 沿公开确认接口自动接受冻结评测内的 draft；worker 必须在真实隔离 worktree 实施/提交并发布代码 artifact，真实 host check 和独立审查通过后，main 才能完成 graph 并交付目标项目。外部独立 verifier 再核对实际项目行为；只修了文件、只发布 draft 或仅 worker 完成都不计完整成功。该自动确认仅覆盖这些冻结测试项目。

## 停止条件与成本

- parser A 未在期限内完成完整流程，则不运行其余会话，先报告基础对照不能成立。
- parser B 失败、质量退化或出现证据/权限/独立性问题，立即停止余下两项；不补跑失败，不换候选或悄悄调整 effort。
- 有错误、超时或未知 usage 的成本都保留；不从分子删除规划、辅助模型、重试、压缩、RSI、审查或返工。精确冻结价格缺失时严格指标为 null，公开 modelWeights 情景单独报告，null 价格或 usage 不填零。
- 若四项全部通过，也只证明小样本可行性；跨类别重复对照与生产启用仍需新决定，不因免费 worker 或单点有利即扩大。

180 秒是每会话的模型运行时限，不是供应商金额上限；准备归档和依赖不调用付费模型。当前磁盘剩余空间有限，应先把已结束评测的可恢复依赖副本归档、保留账本/会话/项目，再核对新会话空间；准备失败不发起付费调用。供应商失败不在后台反复尝试。

该提案改变评测所用模型及角色用途，原目标的 “Propose only: changes to which models run, routing, reasoning-effort defaults, or how work is split across agents” 要求先获得使用者批准。此前对其他已停止小集的批准不当作本轮授权。

## 执行前验证

补齐用户角色执行约束的 owner 是现有 `tests/e2e/harness-workflow.test.ts`。新增 frozen-explicit 行保留原 frozen-auto 的自动偏好契约；真实 HTTP、Pi、worktree、提交、artifact、host check、独立 reviewer、完成 graph 与目标 parser 验收均通过。红灯 `/tmp/graph-model-role-setup-red.log` 实际缺少约束，补齐后的 `/tmp/graph-model-role-setup-green.log` 1 文件/5 测试通过。全部由受控本地外部模型服务完成，没有付费调用。

已结束 compact-shell A/B 的私有 `graph/` 依赖副本分别归档为各 run 根下的 `graph-runtime.tar.gz`（约 720MB），验证 gzip/tar 可读取及配方字节一致后才移除可恢复的展开副本；state、项目、账本、case 与结果保留。各根 `runtime-archive.json` 保存 SHA-256 与恢复命令，不覆盖初始 v2 归档。新执行计划冻结在 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-bound-model-tiering-EjgLzd/plan.json`，包含源文件、模型配置与 context hash。尚未因准备步骤发起真实调用。

最终全量门禁 `/tmp/graph-model-role-setup-check.log`：272 文件、1,514 测试通过，354.43 秒；baseline 正常增长，验收证据不变。通过后才启动首个批准会话。
