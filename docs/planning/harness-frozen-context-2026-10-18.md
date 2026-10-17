# 评测配置和本地资源快照（2026-10-18）

状态：已实现并完成受控完整交付验证；未调用新的真实模型，未修改生产配置。修复 [配方资源保真缺口](harness-eval-fidelity-2026-10-18.md) 的本地冻结和装配部分，外部运行依赖仍未全部证明，不能宣称总体降本或完整生产基线已可比较。

## 创建和使用

`node scripts/harness-eval-context.mjs /source/graph-home /new/snapshot-directory`

使用原 CapabilityLibrary 读取完整配方和能力目录，编译核对每一个配方的必需绑定。复制全部 agent-combinations.json、capabilities 和 prompts，保留所有配方和资源，不只复制 main/coder/reviewer。手工放置/全局原生 skills 若未纳入此快照就明确拒绝，不静默省略。已有非空输出不会覆盖。

复制优先使用文件系统 COW；按相对路径、文件内容、可执行位和链接目标计算 SHA-256，比较复制前源、复制后源和副本。内部链接重定位至副本；已有外部链接拒绝，外部悬空链接保留悬空事实。重新扫描副本，要求配方绑定和目录事实与源相同。快照根目录 0700、manifest 0600；不向 stdout 输出 Prompt、环境变量值或认证头。

`GRAPH_EVAL_CONTEXT_SNAPSHOT=/snapshot node scripts/harness-real-eval.mjs /frozen/config.json [case]`

runner 在模型调用前核验摘要/目录元数据，安装至本次私有 graphHome，核对真实运行时加载的配方资源。请求快照却失败就退出，不回退裸配方；禁止与临时额外 browser capability 混用。workflow 模式编译已有 coder/reviewer，保留其身份、skills 和全部资源，不再以 resources=[] 的受控配方覆盖。所有模式保留源预算、权限等顶层设置，仅替换项目为本次私有目录；快照模式还保留完整 models（含 preferences），main 仍用首连接；这不是批准新模型或新分工，真实模型的后续使用仍遵守已有授权边界。默认未提供快照的旧评测行为保留，报告须继续标明其简化配置范围。

## 本机实际快照

源 /Users/macmini/.graph 的 11 个配方、377 个目录条目全部保留；main/coder/reviewer 为 14/6/5 项绑定。普通文件 123,904 个，内容摘要 `e4cf3d890fede950f14494c8acbebe0061a13f67b7aba16f3fee4e7501173fd5`。目录 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-production-context-vQkAlq/snapshot`；只含摘要和数量的核对文件 /tmp/graph-production-context-snapshot-2026-10-18.json。

创建前后源与副本摘要相同，副本重新扫描仍是 11 配方、377 条目，必需引用有效；整个过程模型调用数为 0。没有复制或重建真实用户数据库、会话或凭据存储，原生产目录未写入。完整目录中的无关资源也没有为了过门禁删去。

## E2E

真实 CLI→snapshot→runner→daemon→Pi→受控供应商：先冻结含必需 skill 的 main 配方，再修改原 skill，实际模型请求中的技能路径读回冻结正文，并修复项目，通过独立 parser 行为检查。缺失指定版本在快照创建前拒绝；篡改快照在 daemon/model 前拒绝，供应商收到 0 请求。修复前 /tmp/graph-context-fidelity-red.log 因读到修改后的源 skill、忽略篡改而失败。初步修复后 /tmp/graph-context-fidelity-green.log 3/3 通过。后续补充配置保真回归：标准访问模式 + 1 token 在旧简化模式原先被遗漏，/tmp/graph-context-standard-budget-red.log 复现实际模型仍被调用；快照模式保留配置后已阻止调用。最终实现两种模式都保留源 limits/access；不改变 ADR 0024 中 full 模式绕过预算的产品规则。初始用例未声明 standard，不能拿它当预算门禁缺陷，已纠正。

扩展已有完整交付 E2E 的同一 owner 为原简化配置/冻结绑定两行：worker 和独立 reviewer 真正读取冻结 skill，源修改没有混入随后请求；真实 commit/artifact/host check/review/目标交付后才成功，全部供应商调用进入账本。局部 /tmp/graph-context-workflow.log：2 文件、7 测试通过；补充模型 preferences 的自动 worker 选择与标准预算约束后由最终完整门禁再次验证，未 mock 自有资源装配、状态或验收回执。测试夹具一度用了 main 不暴露的 write_file，改为真实 Pi write 工具；没有为夹具添加生产别名。

## 尚未证明

目录校验不是扩展/MCP 运行成功。当前生产 FFF package source 为 `npm:@ff-labs/pi-fff@>=0.10.6 <0.12.0`，browser 为 `npm:pi-agent-browser-native@^0.6.0`，都是范围；版本字段和本地目录快照不等于锁定 SDK 实际解析的包。命令、远程服务和外部 package source 原样保留，manifest/runtime 报告明确 allRuntimeDependenciesProven=false。下一步须在不改变用户授权范围的前提下核对实际包解析、权限、MCP 初始化和必要绑定加载，不能先做付费性能对照再补这项证据。

本轮系统 prompt 没有新的精简 diff；复制源 Prompt/skills 是恢复基线，不是要求模型少做工作。没有启用已有实验 flag，没有补跑 Step 5、切换既有 main 或修改成功定义。原简化环境样本保留原范围，与新快照不能直接合并计算节省；总体目标仍未达成。

最终配置回归中，冻结图的 worker 不显式指定模型，由源 high preference 选中实际 worker 供应商；没有把首目录 main 当 worker。检查项目仍须真实交付。标准访问的有限预算分别覆盖裸/快照路径，拒绝必须发生在模型供应商收到请求之前。

最终 /tmp/graph-harness-check-frozen-context-final.log：272 文件、1,510 测试全部通过，真实浏览器与 FFF 依赖执行，验收证据未变化。9 项直接相关 E2E 包含冻结/篡改/缺失、两种模式的标准预算，以及冻结资源和 preferences 下的完整正式交付。初步 1,508 门禁不能代替这次包含配置修复的最终门禁。
