# 评测快照归档与完整 main 装配（2026-10-18）

本轮修复评测快照载荷的完整性问题，并完成一次完整 main 的真实装配探针。未调用付费模型，未改变生产模型、配方、路由或实验默认值；仍未证明每完成任务成本降低。

## 发现与保留的证据

此前含 SDK 缓存的 v1 快照在本轮完整 main 启动前被严格摘要检查拒绝，受控模型收到 0 请求。原摘要为 `de57b345f76ce241c037d3eb2c3ca873372a1ee026d573c32e194fdde5034b39`，源 `/Users/macmini/.graph` 本轮仍匹配该摘要；旧副本实际为 `d002a3b56c8f8d332ecee613ba63fd71504b90ce0e58c8b91948eb9ebb937c98`。

逐条核对：源 161,904 条、副本 161,560 条，缺失 344 条全部为零字节普通文件，无新增、无其他内容或执行位变化。没有证据确定删除过程，不能归因某个工具或临时目录策略。旧 v1 未修补，也未忽略空文件；完整性差异记录 `/tmp/graph-context-integrity-diff-2026-10-18.json`，失败探针保留为 `/tmp/graph-full-main-runtime-probe-invalid-v1-2026-10-18.json`。此前报告的创建时校验通过和本轮发现的后来失效是不同观察。

## 修复

新写入 v2：`context.tar.gz` 为唯一载荷，`context.json` 同时记录归档字节 SHA-256 和完整目录清单摘要。创建后删除散文件暂存树；安装先验证归档摘要与路径清单，再解包到私有 graphHome，重算全部文件（包括零字节文件）、目录、符号链接和执行位的摘要，核对真实 CapabilityLibrary 配方及能力事实，然后才允许 daemon/model 启动。完整 v1 仍按原目录摘要严格读取，损坏 v1 继续拒绝。

本机依赖系统 bsdtar（3.5.3/libarchive 3.7.4）；不使用放开绝对路径、父目录或中间符号链接保护的 `-P`/`-U`。排除 xattrs，保留普通文件执行位；快照目录 0700，载荷及清单 0600。当前仅验证本机工具链，不承诺跨平台 tar 参数兼容或封装所有宿主依赖。

原真实 CLI E2E owner 增加空模块导入，冻结后移除散文件中的空模块，模型仍须从安装后的缓存执行完整代码并完成 parser 修复；另一行改写归档字节，必须在模型调用前拒绝。修复前 `/tmp/graph-context-archive-red.log` 两行失败；修复后 `/tmp/graph-context-archive-green.log` 五行通过。没有新增低层测试或测试专用生产接口。

新完整快照 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-context-archive-nMFW13/snapshot`：143,901 普通文件、377 能力、11 配方，逻辑摘要与源相同。归档摘要 `f0ad9d275534347aeb86441a400d1f687a53ab8ce3574a9201ef09d90f74a8ad`，约 686 MiB。核对文件 `/tmp/graph-context-archive-2026-10-18.json`。它是新产物，不替换旧失效证据。

## 完整 main 的实际运行证据

使用原 main 的全部 14 项绑定和新归档，私有 runner → daemon → Pi → 本地受控外部模型，收到 1 次请求、0 付费调用。实际 wire 包含 54 个工具，包括 fffind/ffgrep、agent_browser、focus_browser_window、Context7 resolve/query。pi-worker 配置包含 11 个 skill 路径、4 个扩展路径、1 个 MCP server；这是运行配置及实际发送工具证据，不把配置本身当成服务执行回执。

从实际扩展路径读取到 browser 0.6.17、FFF 0.11.0、MCP adapter 2.38.0，与此前私有解析结果一致。原始私有核对 `/tmp/graph-full-main-archive-runtime-probe-2026-10-18.json`。main 正常结束，parser 故意没有修复，taskSuccess=false；不能计为成功业务样本、模型分层成功或成本收益。Context7 实际查询、所有宿主工具操作、完整 coder/reviewer 工作负载仍未由此探针证明，allRuntimeDependenciesProven=false。

## 门禁与下一步

首次全量 `/tmp/graph-harness-check-context-archive.log`：270 文件通过、2 文件失败；3 个失败均涉及已经不存在的旧私有 FFF/browser 路径（浏览器 ENOENT、搜索工具未装配）。保留失败记录，不改测试或降低门禁。重新从当前已安装缓存复制私有 npm 树，核对包版本后，仅修正测试环境路径再运行完整检查。

最终 `/tmp/graph-harness-check-context-archive-final.log`：`node --run check` 全部通过，272 文件、1,510 测试；真实 FFF/browser 依赖执行，suite baseline 匹配，验收证据未变。耗时 351.14 秒，VITEST_MAX_WORKERS=4；私有依赖元数据 `/tmp/graph-archive-check-packages.json`。

后续应在完整绑定环境验证外部服务和真实交付，再做整棵任务的价格加权成本与质量对照。已停止的候选实验不因本轮基础设施修复自动获得重跑授权；所有优化 flag 继续关闭。
