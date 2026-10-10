# 真实 graph 运行核验与体验修复

核验对象：会话「查看上传图片，编写graph来实现」`d12a19e7-a4ce-4760-8622-af43076ec746`，已确认提案 v3、graph `2484591f-ce7e-40e5-b983-9a63e3b15bd0`。只读默认应用 SQLite、main 的 Pi session 和产物对象，不修改原任务记录或业务仓库。

## 运行结论

该 graph 已完成，有 7 个定义修订、20 次投递、25 个队列项与 execution、17 次有效提交。25 个队列项均为 done，没有遗留输入。完成不代表执行期间没有缺陷。

| 核验 | 实际证据与结论 |
| --- | --- |
| 文档入口 | main session 多次读取 `/Users/macmini/workspace/13-Graph/docs` 的旧版本，再读取运行应用工作树的 v2 文档。旧业务代码和当前宿主是不同 checkout。此次交付的业务 commit 为 `5a18e84c40e2844ef77c447afcb490e1d8c9e59e`，不能把业务仓库的旧 graph 格式当作宿主 API。 |
| synth submit | 464 次调用中 457 次返回工具错误。实际送给模型的工具参数只有 `{type:"object"}`，没有声明 outputs。初始调用是 `{verdict:...}`，正确调用为 `{outputs:{verdict:{enable:true,value:...}}}`。旧宿主把缺失 outputs 当空对象：任务执行报缺项，聊天执行甚至接受空提交，占用唯一提交机会。RSI `a39468d` 增加回归，`dfdd278` 补齐实际工具 schema 并统一宿主解析，错误明确指出缺失 outputs，拒绝不写提交。本轮保留并验证这些修复。最终两个正确 verdict execution 各向 pass 与 plan-reviewer 投递，故有两次通过判定。pass 配置 each，重复执行再次判断符合该定义，不是 once 去重失效。 |
| 节点聊天 | planner→worker、planner→plan-reviewer、synth→reviewer-3、reviewer-3→synth 四条接收日志均绑定 done 队列。synth 另向外部 main 聊天。原始消息可追溯，未发现丢弃或伪造发送者。实际 Pi 回归另验证忙时排队、同会话历史、幂等重放与串行执行。 |
| 返工 | 本次 pass 只收到 passed:true；`pass.rework→worker.rework` 投递数为 0，因此本次不能证明自动业务返工。plan-reviewer 的不通过报告没有接线回 planner，主要由 main 协调修正。独立原生返工回归使用实际 Pi/HTTP，验证 false→原 worker→新产物版本→再次审查→true，以及重启后不重复已完成输入。 |
| 产物发布 | 7 个逻辑产物、15 个不可变版本：plan@1、plan-review@1–5、plan-review-verdict@1、review-1@1、review-2@1–2、review-3@1–2、synthesis@1–3。15 个内容对象均存在，逐一 SHA-256 与账本完全匹配。各版本保留发布节点。worker 走 workspace_commit，没有调用 artifact_publish；不能宣称每个节点都手工发布了产物。 |
| 产物读取与修改 | worker、三位 reviewer、plan-reviewer、synth 均有成功 artifact_read。synth 实际读取 review-1@1、review-2@1/@2、review-3@2；后两份新版本并未覆盖旧内容。plan-reviewer 与 synth 继续发布自身修订；自动 deliverable 发布也产生版本，并非所有版本都是手工修改。权限及 main 跨版本修改由真实 Pi 产物 owner 回归验证。 |
| 产物失败 | schema 格式、非法 tag、复用 requestId 且内容改变等拒绝可见，后续改正发布成功。另一次 artifact_read 因 counts.json.tmp rename ENOENT 失败，重读成功。这是工具结果计数器并发写入缺陷，已单独修复。 |
| 宿主检查 | 第一轮 worker.result 直接启动 check，检查的集成 commit 为 37ee912，尚无所需脚本，code=1。main 于修订 7 改成 pass.approved→check.job；后续真实检查 commit=5a18e84、code=0。submit 不隐含 Git 集成，该失败不是检查器丢失 worker 的文件。 |

## 本轮改动

- 运行提示直接给出 schemaVersion:2 API 和原生示例绝对路径，明确区分运行应用与业务 checkout。文档仅跟随当前操作需要的引用，避免强制递归读取历史报告。打包补齐示例与规格文件；旧 bundle 的核对确实发现这两份文件未被打包。
- 工具结果以 spill directory 串行完成 tracker 初始化、计数与读改写，避免同名临时文件竞争及丢失计数。并发回归在修复前失败，修复后保留两个 scope 的全部 24 次独立结果。
- 已确认的草稿窗口复用 GraphPanel，实时读取正式任务修订、边值、模块状态和聊天；确认事件自动切换。正式任务图和已完成任务也使用此组件。未确认提案继续保留可审阅的草稿预览。
- 节点历史在折叠工具造成的短页上主动补充，并在阅读顶部时继续分页；保留历史滚动锚点和已读取的全文。真实浏览器回归验证最早消息及最早工具结果自动出现。
- 原生设计范例补充接线检查：计划先审后做必须显式接线，多报告先汇合再启动 synth，返工重开保留旧状态，Git 集成后再投递宿主检查，合法 submit 不用于试探协议。

## 验证

针对性浏览器、计数器与可执行范例回归：25 项通过。节点通信、提交和产物 owner 的已有真实 Pi 回归通过。全量门禁最终通过：267 文件 / 1825 用例，190.10 秒，验收证据未变化；`/tmp/graph-real-run-full-check-173.log`。上一轮有一个既有决策快照用例在 15 秒内超时，单独复跑通过，未改条件或延长超时；最终在没有打包竞争的完整门禁中通过。

`app:build` / `app:verify` 通过，原生示例及规格文件已随包交付。包内 Node + 真实 Pi + 受控 HTTP provider 发出 2 次请求，第一条实际请求的 submit schema 要求 outputs，含 enable/value；正式提交、公开结果、稳定布局、重新布局及 Web 服务通过。证据：`/tmp/graph-real-run-packaged-schema-172.log`。

安装 `/Applications/Graph.app` 后，真实 Electron 默认用户状态核验通过：打开本会话已确认的 v3 草稿窗口，显示 graph 的 v7 修订和 9 个正式对象；切到完成任务图后位置完全一致；打开 synth，自动上滚分页加载到最早 GRAPH OVERVIEW，不点击“载入更早记录”。无浏览器 pageerror。证据：`/tmp/graph-real-run-desktop-172c.log`。

数据库安装前快照：`/tmp/graph-real-run-pre-install-172.sqlite`（0600）；上一版应用：`~/.graph/app-backup-172/Graph.app`。安装前后对该 graph 的修订、提交、投递、队列、execution、聊天条目和产物行逐一比较，完全一致。原 graph/会话/产物没有被重建，业务源码目录及交付 commit 未修改。
