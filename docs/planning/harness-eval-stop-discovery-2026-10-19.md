# 隔离评测的停止地址发现修复（2026-10-19）

尚未证明完整任务降本且质量不降。本轮修复评测的可控性，不改变模型、提示词、任务验收或生产默认；付费模型调用为0。

## 发现与修复

系统临时目录中的旧提案、资源归档、脚本和上次shell A/B运行目录已不存在；仓库历史报告保留，原始账本当前无法重审。原因未确定，不归因某次清理。新资源快照改存Codex附件目录，完整安装复验后逻辑摘要与历史相同（143901普通文件、377能力、11配方；main/coder/reviewer 14/6/5），归档字节摘要另记，不冒称旧tar逐字恢复。

首个停止探针直接把长附件路径用作TMPDIR，实际operation因Unix socket路径过长而进入unknown：`listen EINVAL`。其供应商请求为0，不能把它当用量停止保护的有效失败。私有运行入口改用`/Users/macmini/.graph-eval/`下的短持久目录，保留账本和会话，避免依赖系统临时目录保留。

短路径后，真实CLI/Pi流程产生1条estimated usage，但watcher仍没有停止回执：它等待的`state/console.json`未由评测CLI发布。正式server CLI本来使用`writeConsoleAddress`公布动态端口；harness-real-eval直接调用startGraphDaemon，遗漏了这一调用。

修复只在评测daemon绑定后复用同一writeConsoleAddress，记录真实url/pid/mode/startedAt，沿用0600文件权限。外部停止watcher能在对应私有state下发现服务，不需要扫描任意进程或猜端口。没有修改正式运行时HTTP或授权边界。

## 验证

原完整交付E2E owner新增地址发现契约，保留实际worker修改、worktree提交、host check、独立review、精确commit和目标交付全部断言。修复前frozen-explicit在完整业务成功后明确失败于缺少console.json（7.776秒）；修复后原5项全部通过（49.40秒）。没有新增单元/集成测试。

另一个本地失败路径探针通过真实HTTP→Pi→SQLite→独立watcher→公开pause/interrupt接口，外部模型fixture返回缺失usage。修复后2个本地供应商请求、0付费；watcher的guard-stop记录只指向该项运行，pause回执200，最终task paused=1、worker_active操作为0、非权威usage保持非权威，taskSuccess=false。它验证失败停止与数据保留，不验证完整14/6/5装配、节点故障、所有停止异常、模型质量或成本收益。

持久证据目录：`/Users/macmini/.codex/attachments/81739269-9f1f-4891-b9b7-4dd7f46a3ff7/harness-recovery-2026-10-19`，含red/green日志、安装证明、冻结材料与guard-probe-latest.json。失败探针DoOmzu、OpVZad及成功kZ3qzO分别保留；不覆盖失败。

首次全量门禁失败：266文件通过、6文件失败，1486测试通过、28失败，351.29秒。command-module与spike直接报Docker daemon不可达；loops/scheduling/templates/verification有派发和结果缺失的关联失败，未在首次结果中逐条证明同因。启动本地Docker后确认daemon 29.4.0响应；未改源码或测试绕过依赖，第二次完整门禁通过：272文件、1514测试，359.86秒，baseline匹配、验收证据未变。两轮之间只有Docker依赖状态改变，原28项失败全部消失；保留首次失败日志。

## 边界与后续

旧watcher的exit0或“没有guard-stop”不能再作为实时停止已验证的证据；旧结果的终态、失败取消和默认关闭结论不因此改写。此次发现不证明旧运行一定曾继续产生应停止的调用，也不追补缺失账本。

此前待批范围材料已失效。私有模型候选按既有历史提案重建，非free Step移除免费零费率，A/B配置只改首选planner，生产配置不变。使用者提供的凭据按0600私有环境文件保存，不回显、不写仓库；提供凭据不等于批准新模型范围。重新冻结与预检后仍需明确批准，不能复用旧授权或将自动继续目标当批准。

整体目标仍未完成：没有可比整树成本下降与质量等效证据，历史原始材料缺失还限制重新审计。停止保护和资源恢复是评测前提，不能替代降本结果。
