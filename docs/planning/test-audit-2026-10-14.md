# 测试审计

## 当前交付范围

最新活动目标为“删除20%无用的单元测试和集成测试，保留 e2e 测试”。按此范围收尾；保留仍有独立契约的单元、集成测试，不把此前的全量 E2E 迁移或覆盖率不超过2%作为本次交付条件。

为降低维护成本，撤去早期2%覆盖率门禁、分组配置及新增依赖；保留2项廉价而独立的thinking兼容单测，撤去仅为全量迁移准备的100文件历史CLI归档及新兼容E2E。原有真实E2E继续保留。后续43/44/45迁移草案未应用。

最终证据以 [交付报告](test-audit-2026-10-14/final-report.md) 为准。下文记录早期探索的当时状态；其中旧口径、“尚需完成”与覆盖率数字不是当前交付条件或最终结论。

E2E 以实际执行边界判断：完整浏览器/HTTP/CLI/公开运行程序流程，真实业务组件、磁盘状态和必要的进程、Git、传输；模型、远端服务可以用受控外部服务代替。直接调用内部 helper、写入私有数据库记录或 mock 自有协作者，不因文件名含 `e2e` 就成为 E2E。不同进程生命周期、协议和持久化契约需要各自保留证明。

## 基线与工作区

- 固定源码基线：`463fa2ca61157d10e4617c208a4684b1cd9744c9`。
- 全量基线：271 个文件、1,852 个执行用例，全部通过，189.57 秒。
- 原始报告：`/tmp/graph-test-audit-baseline.json`；日志：`/tmp/graph-test-audit-baseline.log`。
- 使用者原有的技能、ADR、研究和规格文档改动保留；本次未提交、推送或修改外部任务状态。

## 分组证据

逐声明账本、生产调用方、历史依据、保留契约与 keeper 在以下文件中。账本中“待迁移”不等于已获准删除；必须以实际通过的 keeper 和保留复核为准。

| 生产职责 | 账本 | 执行边界 |
| --- | --- | --- |
| 测试数量门禁 | [baseline-guard](test-audit-2026-10-14/baseline-guard.md) | 实际 CLI、报告/基线文件、退出码与显式降低选项 |
| 运行源码身份 | [source-identity](test-audit-2026-10-14/source-identity.md) | 实际 CLI、Git 检出、公开启动状态、重启 |
| 部署与开发线差异 | [deploy-drift](test-audit-2026-10-14/deploy-drift.md) | 实际 CLI、桌面 HTTP 状态入口、真实独立 Git 索引 |
| 桌面抽屉与进程生命周期 | [desktop-shell](test-audit-2026-10-14/desktop-shell.md) | 实际 Electron、renderer bridge、OS 信号、真实 daemon |
| Graph 定义与确认 | [graph-definitions](test-audit-2026-10-14/graph-definitions.md) | 公开建图/确认、真实 Pi、Git 检查与交付 |
| 模块状态、规则与投递 | [graph-modules](test-audit-2026-10-14/graph-modules.md) | 公开输入、模块解释、持久 outbox、真实下游 Pi |
| Provider、价格与 thinking | [providers](test-audit-2026-10-14/providers.md) | HTTP、真实 Pi、TCP 请求、持久费用、实际浏览器 |
| 输入、历史、复制与附件 | [composer](test-audit-2026-10-14/composer.md) | 实际浏览器、剪贴板权限、输入事件、HTTP 请求载荷 |

## 已验证与待验证

第一批迁移验证：28 个新场景，14 个通过、14 个失败；主要是夹具的授权、环境隔离、验收准备和错误判断。没有把这些失败当作删除原测试的依据。

第二批验证（包括相关原有 E2E 与进程兄弟测试）：58 个用例，53 个通过、5 个失败，72.37 秒。通过的边界包括 CLI 门禁、源码身份、部署差异、graph 定义/确认、模块主要状态流程、provider 传输、历史价格、桌面抽屉、输入撤销及主要附件流程。

第二批的未通过场景还需要验证修正后的结果：桌面地址文件路径、模块错误消息的正确语法 guard、流式复制的外部模型夹具、输入历史的实际分页、thinking 请求与异步建议请求的正确归属。类型检查另指出模块夹具传入可选 `undefined` 与严格类型不兼容，必须修正。

真实会话 E2E 暴露了 thinking options 跨 worker IPC 丢失的问题；候选修复只转发允许的生成选项。第二批已经证明首个真实主会话请求收到 `xhigh`，后续矩阵仍需避开独立的异步建议请求并完成因果控制。详情见 [thinking 缺口](test-audit-2026-10-14/thinking-defect.md)。不要据此宣称 graph 节点支持未声明的 thinking 配置。

输入历史 helper 的 100 条上限没有真实父组件调用方，也没有产品规格要求；真实界面暴露已载入历史。审计不新增用户可见的历史截断。真实撤销栈的 100 步上限则有生产调用与浏览器证明，继续保留。

## 尚需完成

2026-10-14 后续验证：模块 keeper 的两类语法拒绝分别核对到各自实际 guard，新增单等号控制后 4 个场景全部通过（4.83 秒）。Provider header keeper 改为按实际主会话的工具声明及用户输入识别请求，避免异步建议请求污染序号；同时补回 OpenAI、Anthropic 验证 POST 的真实授权头断言，3 个场景全部通过（3.10 秒）。独立 provider 复核中的错误正文形态、默认配置、字段错误归属及不可达传输等其余缺口尚未补齐。

1. 完成当前 keeper 的失败修正与验证；只在对应证据通过后删除旧层与无生产调用的 seam。
2. 按生产 owner 审计和迁移剩余测试，包括错误命名为 E2E 的私有状态/helper 测试；不能只改文件名或排除覆盖率。
3. 对每项被删契约独立复核剩余 keeper，修复保留缺口，并用必要的生产 mutation 验证恢复的契约。
4. 对比最终与固定基线的实际文件、用例和生产/测试 LOC；记录运行成本及覆盖率口径。不能靠改基线掩盖测试失败或未迁移的低层测试。
5. 全量验证、明确更新有意缩减的 suite baseline，运行 `node --run check`，再完成 autoreview。现阶段尚未做完整交付检查。

## 后续 owner 验证

2026-10-14 第四批：`graph-modules`、`composer-lifecycle`、`project-branches` 合计 8 个场景，5 通过、3 失败（34.97 秒）。模块 4 个场景包含新增的公开暂停行为：再次受理相反输入后没有重复判断、原输入保持、没有下游执行或模型调用。真实 Git 命名流程通过。聊天生命周期 2 个场景、浏览器默认目标分支 1 个场景失败，相关旧层继续保留，按实际错误修正后再迁移删除。日志 `/tmp/graph-test-audit-owner-batch4.log`。

独立桌面诊断仍在启动/窗口阶段超时（90 秒）；没有得出是产品还是执行环境故障的结论，不通过延长超时或删除场景隐藏。日志 `/tmp/graph-test-audit-desktop-diagnostic.log`。全量覆盖率与20%缩减仍未达到完成证据。

第五批（2026-10-14）：聊天生命周期和分支场景共 4 个，3 通过、1 失败（7.91 秒）。两个聊天生命周期完整浏览器流程均通过；真实 Git 命名流程通过。默认分支在实际确认界面显示 main 而非当前 feature/current；源码核对发现公开项目 DTO 未提供当前 branch，旧 helper 的理想 DTO 测试未保护真实 wiring。下一步在公开只读项目投影补齐真实 Git 分支事实，保留准备快照 fallback，再用同一 browser red/green 验证。日志 `/tmp/graph-test-audit-owner-batch5.log`。

本批新增测试的严格类型检查发现 usage helper 返回类型包含不可能的 undefined、raw graph fixture 缺少 inputs/outputs；待修正后重跑，不把运行通过当作类型门禁通过。

第六批：实际项目当前分支只读投影修复后，分支 2 个 E2E 全部通过，同一浏览器 red/green 证明默认当前 branch 以及用户修改 targetBranch。聊天生命周期原 2 个仍通过，新增真实浏览器存储额度耗尽场景在模型答复 guard 超时，相关旧存储契约继续保留。合计 5 个场景 4 通过、1 失败（39.46 秒），日志 `/tmp/graph-test-audit-owner-batch6.log`。删 interaction 声明时误移除仍使用的 queuedUserMessages import，已恢复；严格类型检查与 git diff --check 均通过，日志 `/tmp/graph-test-audit-typecheck6b.log`。不因局部通过宣布最终迁移完成。

第七批并行复验：project-branches4 + composer-lifecycle3 全部通过（7 场景，10.97 秒），日志 `/tmp/graph-test-audit-owner-batch7.log`。当前/准备快照/未知 branch 回退与用户修改均通过真实浏览器+Git，允许退休对应3个helper声明。quota storage 保留复核只删除真实额度耗尽已经证明的非空草稿写入控制，读取/缺失storage/删除失败仍留。

第八批：composer-lifecycle4、provider-metadata3 及仍保留的 provider-form/catalog 契约共 63 个用例全部通过（13.25 秒），日志 `/tmp/graph-test-audit-owner-batch8b.log`。第一轮同批失败仅因删除已迁移声明后留下空 describe，已删除空组并以完整相同命令验证；没有降低业务断言。有限预算下真实缺失 usage 的保留证明现在通过；worker 角色和跨实例范围仍需补证，旧 telemetry4继续保留。`node --run typecheck` 同批通过，日志 `/tmp/graph-test-audit-typecheck8.log`。

第九批：provider-metadata4/node-queue3 共7场景，5通过、2失败（27.87秒），类型检查通过，日志 `/tmp/graph-test-audit-owner-batch9.log` 和 `/tmp/graph-test-audit-typecheck9.log`。真实队列失败恢复与补交场景通过，持有a供应商响应时b独立执行的场景未达到 execution guard，必须核对drive受理时序，原queue7不删。新account严格配置断言补入生产规范化的 defaultBudgetTokens:null 后到达下一真实UIguard：编辑credentialId未触发既有账户名称加载。该区别需改用真实账户选择操作验证，不放宽名称/凭据/并发断言。独立control日志 `/tmp/graph-test-audit-account-control.log`，旧form契约保留直到proof完整。

第十三批：14 场景12通过，provider accounts4全部通过；恢复夹具可见会话scope、普通provider错误与SDK context恢复区分后继续验证。第十四批20场景18通过，composer9与queue4全绿；其余失败是恢复输入违反instance唯一约束以及真实Git初次设置tracking额外stdout。恢复输入用真实两实例currentbinding事务交换，未禁用约束/捏造invocation。

第十五批（47.21s）：21场景20通过。真实Electron2、Gitpush1、skillsCLI5、subgraph1、configHTTP/vendor1、composer生命周期6和metadata账户/目录4均通过。新provider validation1在实际平台入口locator失败，旧负向校验保留。严格类型检查（新增恢复交换前版本）通过，最新版本待重跑。主列表之前provider缺口状态是历史记录：已补齐缺口并完成授权头mutation红/恢复候选绿，具体providers账本为准。全量迁移、2%覆盖率和完整check仍未完成，不能将上述局部结果当最终交付。

第十六批（18.66s）：31场景30通过，metadata6（真实缺凭据/非法自定义配置与多平台Setup生成身份）、旧config13/setup2/真实insightsUI2均通过。newsubmit唯一失败是native schema输出Validation failed与夹具宽泛regex不匹配，原bridge8保留。新增Setup/browser契约据此退休对应builder1和validation5，配置语义旧helper3也在configHTTP完整5拒绝表通过后退休。

第十七批（20.02s）：35场景34通过。secret生命周期1+旧4、metadata6、submit native1+旧bridge8、worktrees3、native-repairfreeze1、生命周期前7及remaininginsights2/compactevent1通过。新longhistory1在用户读上方时offscreeninnerText取空；需要核对content-visibility，再证明实际新消息DOM与无滚动跳转。类型检查17b和git diff --check通过。新loopbackproxy只延迟真实pauseHTTP回复，未提供owner状态，真实pending禁用流程通过。

删除deadproduction: setup108行、insights221行及App unused imports，均以全repo当前caller证据确认无生产调用；当前provider Setup builder/bridge/global、tokenformat/nodepalette/inboxcount保留。移除对应不可到达helper证明，独立正在使用契约保留待迁移。

中途全量（214.13秒，/tmp/graph-test-audit-interim-full.json）：266文件中265文件通过，1606执行用例全部通过；唯一suite失败为provider-form删空one-platform组。已清理空组，原28用例focused通过。基线1852到1606暂减246（13.28%），并非最终20%/2%达标证明，未更新基线或路由隐藏未迁移契约。

独立第二轮保留性review（composer/graph）完成，报告已保存临时。Composer指出streamingcopy空集合不能覆盖真实streamguard；恢复原sole声明，跨多历史instance新恢复输入仅交换currentbinding而历史属于同instance，恢复旧sole兼容顺序声明等待可信真实producer迁移。Rangepaste加caret最终11，requestAnimationFrame需eventualpoll才判断；未误认poll前瞬时17为产品缺陷。Emptyclipboard设置真非空选区并保留[6,11]；当前UI早退不调用helper空字符串collapse，因此记录真实selection保持而不虚称旧helperreturncaret即UI契约。新增真实空history多行ArrowDown11/ArrowUp0且文本无变化已通过。

Graph reviewer唯一gap G1已补：公开发布worker@2真实不同identity，合法template7->8和nestedleaf3->4新实例分别native运行，旧实例始终@1。错误重用publish requestId先被真实幂等守卫拒绝，改独立requestId后keeper通过6.27秒。故意subgraph-expansion把@2 recipe降回@1，newkeeper在exactworker@2 guard失败（2.78秒），mutation已恢复源码逐字节SHA256608c1b9e45f1b9a815da7784ea54c71ae4e985db3c13cd7e473f606c3d35d1e9；恢复候选复验进行中。

第22批：15文件72场景全部通过28.03秒，沉淀真实reader/配置、浏览器candidate与actualdisabled-storage、打包真实volume和existing图CLI/nativeartifact兄弟完整。verification新增definition缺inputs/outputs的type错误已补空接口并保持原placement拒绝。第23a批49场景47通过，discovery7+old10/secretdefault/sediment/package/actualartifact兄弟全部green；newartifact101并行publish每execution仅1version，因为需要按真实toolround串行，改101独立native rounds后head101达到，但defaultlist100分页assert仍待修；plainnative拒绝文本不能强JSONparse，按actualprotocol修，其他metadata/CAS场景已pass。

第23b批39场景38通过，Firefox原生dom.storage.enabled=false实际返回absent而非SecurityError。未把expected放宽冒称异常路径，撤新增重复Firefoxrow保留真实Chromeabsence，原blockedstoragesole留待actual独立证明。普通preferences10已真实SettingsUI/default/invalidexternalstoredstrings/roundtrip/re-enable/newMarkdown/candidatepayload验证，原11→blockedsole1；source onlytest exports按当前真实caller去export不去logic。实际sending网络responsehold新keeper随后第24owner通过。

第24owner27场景26通过，唯一101versionslist需要明确page100+nextpage1；lifecycle12含sending真实delay和preferences/interaction剩余守卫全green。types24b通过。初始runner完整partition：45e2e+221lower=266、无重叠无遗漏；另3fullyreadgraph保留加入后48+218=266。默认test仍allinclude，mixed/unread旧file不提前排除。

第24覆盖率实测151.77秒：unit配置排除当时48真实E2E文件后218文件1412用例全部通过。V8纳所有src ts/tsx与desktop ts/mjs/cjs（仅type declarations排除）：lines67.99%(13592/19989)，statements63.34%(15878/25067)，functions60.82%(3185/5236)，branches57.83%(13625/23558)。明确远高2%，是保守未迁移口径的中途实测，不是完成证据。reports coverage/unit默认ignored；日志/tmp/graph-test-audit-unit-coverage24.log，routing当时/tmp/graph-e2e-files24cov.json与unitfiles24cov.json。

新增正式runner test:unit/test:e2e/test:coverage及匹配Vitest5的@vitest/coverage-v8依赖；check:coverage读取report验证每metric<=2且必须有productionlines分母，当前实际report正确exit1。CLI2%正向边界和2.01%branch拒绝/未计量报告拒绝均实测，defaultcheck尚未更新baseline或隐藏失败。随后11fullyreadruntimehash全unchanged+3fullyreadgraphpending统一纳正式routing，下一测量会记录新准确分组；不将上次67.99冒充新口径。

第25批：105场景100通过，5失败+1unhandled由新keeper触发，原合同未删。sandbox PATH在restricted进程只含nodebin/usr/bin/bin，而旧helper checkEnvironment只拥有unsandboxed工具路径；携带homebrew断言移到真实unsandboxed分支，其余双方保留secret/ELECTRON/checkout/HOME。真实credential轮换暴露SDKheaders先capture、slot后仍旧Bearer；ADR0010实际send解析承诺未兑现，原mockqueuedscheduler不能证明真实发送。

第26批132场景131通过：actualsend刷新修复后keyqueue/OpenAI/Anthropic兄弟、Pi20以及真实graph/artifacts全部green，唯一FIFO夹具错误期待409，currentappRuntimeErrorHTTP400，旧sole只保护idempotencycode不承诺409；改400+原code。主提示词3literal/steer正向全部green，types新增proposal缺requiredinterfaces需空inputsoutputs。

第27批34场景33通过，newgraph-lifecycle2/typesgreen，queue轮换sameharness去新fetchImpl control红exact旧Bearer，源码逐字节restoreSHA7323c9f06e06c6a4a2b9ed0d7c9d2efa1bbbd00b49b1572289a46493f2a927e6（随后explicitAuth检查补入，更终SHA待结案）。候选保留手动显式auth权威。FIFO中间publicmessages按delivery/turn分组，不应对queued与delivered混合断言creationsequence；改identity状态+单独queued顺序+实际provider当前user严格FIFO，未对业务排序做盲sort。

第28批108场景107通过，typesgreen。keykeeper矩阵OpenAIBearer动态/Anthropic x-api-key动态/显式Authorization恰同原key值仍保持权威3全通过；会话15含FIFO/newprompt/steer、原样完整搬出3真实旧E2E全部green。newgraph wildcardcase在Submitted guard前遇Expectedunchangedcanonicalgrantpath，源证据hostconfig filename encodeURIComponent保留'*'而grant严格拒glob；实际合法nodeID应filename编码，不扩大安全授权。最小fix编成%2A待同harness候选与control验证，旧12graph-runtime独立守卫保持。

第29批：7文件41场景全通过14.67秒，typesgreen，RSI真实修正/提交、rawstream正向copyguard和star filenamefix全部进入真实目标guard。FIFO准确源证据修正：conversation.deliverMessages222-236将受理queued消息seq更新为MAX(seq)+1，使其在前assistant后；listMessages430-442 ORDERBYseq。中间first/thirdqueued/seconddelivered为正式writer排序，故identity状态+queued-only FIFO+actualvendor当前user保消费contract，未盲sort或伪造序号。

独立复核缺口与产品修复定点controls29（全部sourcebyte恢复）：
- chat-copy.streamingguard删→newactualdelta正向row出现copybutton1，在composer494失败；SHA8690c245df4d1143120e958e538fcef9fad0c56f4edb6e94a38cae29d02ae0d0。
- ChatComposer仅选区range插入caret+1→composer194exactcaret11失败，非普通插入误报；SHA7153c37fb0f23988876bfd4a6818223a65bb0e9646e8d2e87cb11090a88f6df2。
- kernelgraphlane去star%2A→star*真实配置授权错误精确重现，newgraph141要求真实missingfile的intendedguard失败；SHA6c1ca7ba4c3134cb5a798bfbb95c120e15bb1cb32d3493ebd629dc3c351de95b。
- controlledactualsend去explicitAuthorization保护→显式原token被错误换成rotated，keyqueue87严格拒绝；SHA cc0039a2ac240fea35efb0ea7a5ca13acac2532000ccd09c767394737925bfc7。
- workerModelOptions去reasoning透传→thinking56实际Grok wire缺reasoning_effort:xhigh，telemetry选择仍不能代替线报；SHA bb514d3480f5b0919c0ec45f5a535ad97d2234bfc93a6e20e34de12389f37c54。
完整输出/tmp/graph-test-audit-controls29.log，逐控制/tmp/graph-test-audit-control29-*.log。恢复后同候选5文件20场景全green15.54秒，/tmp/graph-test-audit-controls29-candidate.log。没有mutation残留。原rawstreamsole至此可退休；原多历史instance兼容sole仍未真实producer闭合，保留不隐瞒。

第32批及独立保留性复核：资源库10→2真实CLI/Chromium流程，制品workspace5+projectlist1退休、技能library3+ownedlink1退休、conversation初始pending/projectless/archive恢复/admission4退休，共删除24旧声明。删除前携带独立复核指出的精确 API 元数据、URI、get scope/name、原生skill location/name，12文件95用例全绿33.81秒；删除后11文件80用例全绿34.80秒，严格types32c与diffcheck通过。资源库 only-test exports取消，逻辑保留。新增真实CLI启动默认null正向与0/-1失败流程已通过，旧unlimited最后constructor声明将在恢复候选复验后退休，前五native整文件再登记；不提前把mixed整文件排除。

新实际native skills流程发现并修复 skillFolder 吞掉 host skillPaths，撤fix真实主请求缺Pi全局description红，恢复同harness3文件7项全绿3.35秒。四个本批保留缺口mutation均caught且逐字节还原：资源分类、project URI、get project scope、archive timestamp，具体SHA/日志各owner账本。额外CLI budget null猜测mutation也被实际成功启动的错误行为捕获，源码config逐字节恢复SHA811a0c63ea87b4e61a55b2cbce831676c99e6302a67cefedca9533f437756332，候选复验进行中。未完成全量转换/20%最终计数/<=2%最终覆盖率，不更新suite baseline，不提交推送。

第33/34批：草稿4真实native/browser/Git流程最终全部通过，独立逐16旧声明保留复核补恢复原摘要即时guard，内容破坏mutation明确caught并逐字节恢复。恢复候选4文件61项全绿28.91秒后退休16旧声明；context原parser2声明共7拒绝row移公开graphCreate atomic keeper并caught允许context mutation，其余12真实native原样保留登记e2e。33b另有3历史浏览器whole17项和kernelGit4/nativefreeze1完整通过并登记。完整分类审计继续：console34十文件56声明没有whole候选，不把名字含E2E/OS子进程当业务真实；runtime34十文件39声明仅8whole28case合格（准备fresh候选验证），pi-native-tools/node-turn-driver混合仍lower。覆盖率未重新测量，不用旧67.99%冒充新口径；最终suite baseline/check/20%仍待全量。

第34退休后验证首次71项70绿，唯一失败是删除旧draft组时连带删去formalaccept仍调用的共享draftFixture，types也精确报missingname；已从原HEAD逐字恢复该夹具，保留正式accept独立契约。复验4文件43项全绿29.41秒，types34c绿，未降低断言。

第35 scope真实keeper已实际CLI/main graph_create+graph_send→nativeworker的workspace.path=work流程，7种技能名字/description/location从SDK原生available_skills块独立读出，另缺失6目录实际ENOENT下只有own技能。首轮准备fixture被真实config拒同provider不同URL、配方无systemprompt、廉价suggestion共享worker流干扰，修fixture后精确before-f红：Graphmetadata漏project根2skill、原生SDKblock漏Pi-global+project2skill。最小修复kernel-node-host把boundprojectroot传contextassembly，kernel-graph-lane合并host native dirs到worker skillPaths供SDK与resident readgrant。候选6文件14项全绿10.82秒、types35绿。分别撤metadata/SDK修复同harness各红且逐字节恢复SHA06677f6d8ff2abf3f1d71e9f893f3115a3443ea21975fc0c0ec0cd1c5cbaa180和6623029e3d53674d8657be0b1b6fb77af137626d9a54c0006c3feb4501bcd6d2；恢复候选复验进行中。独立scope保留性审查等待，旧scope sole尚未退休。

第35覆盖率重新实测：分组93e2e+172lower=265文件，无重叠/遗漏/额外路径（/tmp/graph-{unit,e2e}-files35.json）。unit v8仅运行172文件1175用例，全部通过94.59秒；实际lines65.76%(13147/19992)、statements61.12%(15324/25071)、functions58.88%(3084/5237)、branches55.10%(12986/23568)。日志/tmp/graph-test-audit-unit-coverage35.log，coverage/unit真实report。所有metric仍明显>2%，check-test-coverage按预期拒绝。该结果仅证明当前保守分类口径及lower通过，不证明全量默认suite/最终20%或全迁移完成。旧scope最后sole已在独立review+恢复candidate4项全绿后退休；退休后新技能3流程全绿7.83秒，types35b绿。仍须迁移剩余172 mixed/lower文件，保留真正E2E，不更新baseline或宣称已达标。

第36预算层：独立逐6声明保留复核完成，真实heldsend/三个累积turn/独立不限额节点/第四超额拒绝keeper + 真实reconcile replay不重扣费承接。恢复候选4文件27全绿12.66秒后，退休kernel-node-budget前6 SQL/helper声明，保留后3native整文件登记E2E；退休后3文件9全绿5.53秒，types36d绿。3故意回归分别在reservation释放、实际第四请求、reconcile重复扣费处红且源码逐字节恢复，完整证据node-budget.md/budget-preservation36.md。未改生产业务逻辑。下一批thinking和settings staged新增单强度/空强度真实模型请求与nav/secondaccount DOM carries，4文件24通过20.15秒，旧测试仍待独立复核退休，types36e绿。

第36思考/设置层：独立逐17声明保留复核完成，补deepseek无requested default→high/real单档high/real空档API[]与nativeoff无effort、真实archive/general导航与第二account3字段。finalcarry4files24全绿18.46秒后退休thinking10+settings7；删除没有生产caller的高级设置registry/helper约32源码行，保留真实nav和clamp/default逻辑。退休后newkeepers+settingsUI/m8thinking兄弟4files24全绿21.26秒，types36f绿，diffcheck绿。3controls实际caught选项off/导航逆序/第二账户group错标，并逐字节恢复，证据thinking-settings-preservation36.md。only-none真实catalog空档最终off与“每模型thinking-on”的注释冲突，仅记录产品差异，不把现有守卫错误删除或扩项修改规则。默认全量复验准备，最终baseline/20%/2%尚未证明。

第36结束默认全量复验：264文件1497用例全部通过223.34秒，/tmp/graph-test-audit-full36.{log,json}，无失败/未处理错误，lint36通过。相对固定baseline1852减少355（19.1685%），尚未达到20%（至少需净减少371），不更新suite-baseline，不将中途结果写为完成。随后37批新main预算3实际workflow及tabs carries已应用候选验证，旧main-budget3/tabs17继续保留直到proof与独立复核。全量36结论不外推为37新candidate也绿。

第37/38批独立复核发现旧多member共享预算兼容contract仍缺真实keeper，保留旧sole，不把新单member流程当作证明；另补exact2052256额度等号正向。main预算3个controls与tabs5个controls均在目标断言红并逐字节恢复，记录controls37.md。tabs独立17项保留复核通过，待恢复candidate后退休。rework原13声明按原body精确拆8真实e2e+5lower，不把手动scheduler占位当公开业务刺激；重跑联合candidate38与types38。最终全量/20%/<=2%尚未完成。

第38退休闭环：budget旧2项退休后4文件11case全绿8.24秒，types38c绿；tabs17退休，activeTab only-test4LOC删除，rework13精确8e2e+5lower保留。最新分组99e2e+166lower=265，无重叠/遗漏/额外。覆盖率38仅lower166文件1118case全部通过94.56秒，lines65.34%(13059/19985)、stmt60.62%(15193/25060)、func58.37%(3054/5232)、branch54.61%(12870/23563)；真实coverage/unit更新，check:coverage按预期拒绝>2。覆盖率目标未完成。39批thinking同一真实13catalog/nativekeeper扩Vite/Chromium控件与用户切换，candidate运行中；旧7项还保留，不能提前退休。

第39批：同一真实13model API/nativekeeper扩Chromium控件、实际UI选择和hotconfig saved fallback，独立review缺口全部carry后4files14cases全绿11.72秒。9controls均目标断言失败且源码逐字节还原；恢复4files14cases全绿12.35秒/types39f绿。退休thinking5声明，保留2历史兼容；usage4→2完整真实CLI/TLS/browser流程，退休旧4，并删only-test fetch/pricingPath/cacheTTLoptions。退休后含settings兄弟4files15cases全绿21.87秒/types39g绿。具体controls39.md/两独立review。defaultfull39正在跑；尚不以推算case数宣称20%，最新实测lowercoverage仍65.34%>2，继续全迁移。

第39默认全量实证：265文件1479用例全部通过245.14秒，/tmp/graph-test-audit-full39.{log,json}，success true/failed0；lint39绿。相对固定1852 baseline净减373=20.1403888%，已达到>=20%数量目标。不要把这个局部完成误写全目标完成：剩余lower真实coverage最新65.34%>2，仍须全转换，原suite-baseline271/1852保持未更新直到最终campaign结案。该全量只覆盖39最终源码，不外推为后续40/41/42候选也通过。

40/41闭环：历史CLI/currentUI两兼容row真实Vitest+2独立webmutationcaught；node-submit同一个case携成功receipt/disabled-refusal/unknown-call+真实记录，3mutationcaught。恢复5files8cases全绿14.02秒/types40b绿，退休thinking残余2+toolchannel3，保留其他resident夹具。实际归档885092bytes/100unique历史files/30673历史execLOC，单独记support成本；README+生成器实测重建archive identities逐字节一致，无测试时git/联网。42先携heldSSE实际invocation authoritative128/256，8files24cases全绿9.53秒；新guard控制第一轮有跳过/清理缺陷，尚不以这些失败冒充有效proof，完整纠正见42账本。

42闭环：补真实heldSSE权威128/256入库；错误filter全skip不算proof，修filter后estimated source mutation目标红；semanticend最终在连接释放deadline目标guard红且无unhandled，早两次清理问题明确排除。源码全部逐字节恢复后6files21cases绿8.59秒/types42b绿，退休usage-source2和deadhook36prodLOC（保留account_delta全部历史reader/merge/enum）。退休后含Pi/Anthropic/history预算9files39cases全绿9.95秒/types42c/diffcheck绿。详controls42.md。43/44/45原生迁移只读准备中；全量转换/<=2%仍未达标，目标保持active。

最终按最新活动目标“删除20%无用的单元/集成测试，保留e2e”收尾。撤掉早期覆盖率2%门禁/分组配置/新增coverage依赖，离线frozen-lockfile恢复依赖；为控制维护成本，撤掉40历史CLI归档与新2case，恢复低成本独立兼容2单测，保持总case数。43/44/45草案未应用。最终GRAPH_UPDATE_BASELINE=1 node --run check完整退出0，263files1474cases全部绿229.67秒，baseline271/1852显式降低263/1474，验收证据未变化。净减378=20.4104%，原有真实e2e保留。最终只读自动审查无可操作发现，diffcheck通过；无提交/推送/PR。详细final-report.md、final-verification.json、final-loc.json。
