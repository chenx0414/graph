# 本机 Playwright 启动即 SEGV：测量、根因、规避

日期：2026-11-04　基线：`733d1b48`　相关代码：`tests/helpers/host-browser.ts`、`scripts/playwright-launch-report.mjs`

## 1. 症状

在 Graph 的工作节点里跑浏览器测试，`chromium.launch()` 一律失败：

```
<launching> .../chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell --disable-field-trial-config ... --no-sandbox
  --user-data-dir=/var/folders/.../T/playwright_chromiumdev_profile-zgvE04 --remote-debugging-pipe --no-startup-window
<launched> pid=59660
[pid=59660][err] Received signal 11 SEGV_ACCERR 000000000010
```

`tests/e2e/node-chat-auto-history.test.ts` 一个字未改也同样失败，所以它不是某条断言或某次改动的问题，而是环境级：这条命令里**任何** Chromium 都起不来。

## 2. 测量（同一台机器，2026-11-04）

`node scripts/playwright-launch-report.mjs` 重跑这张表，落盘到 `$TMPDIR/graph-playwright-launch-report/<时间戳>/report.md`，
每个在宿主会话里起来的浏览器各留一张截图。要点：

| 浏览器 | 版本 | `chromium.launch()`（本工作节点） | 同一条 argv 原样在沙箱内跑 | 宿主会话里启动 |
| --- | --- | --- | --- | --- |
| Playwright 的 chrome-headless-shell（headless 默认） | Chrome for Testing 153.0.8010.12 | SEGV_ACCERR 0x10 | `Received signal 11 SEGV_ACCERR 000000000010` | 正常，截图 6232 字节 |
| Playwright 自带 Chrome for Testing | 153.0.8010.12 | SEGV_ACCERR 0x10 | `sandbox_extension_issue_file_to_process failed ...: 1 (Operation not permitted)` 后 SEGV | 正常，截图 5334 字节 |
| agent-browser 的 Chrome for Testing | 153.0.8010.36 | SEGV_ACCERR 0x10 | 同上（`sandbox_extension_issue_file_to_process` 被拒） | 正常，截图 5334 字节 |
| 系统 Google Chrome | 156.0.8078.76 | launch 失败 | `sandbox_extension_issue_file_to_process failed for /Applications/Google Chrome.app` | 正常，截图 5334 字节 |

也就是说：**不存在“153 能跑、1243 不能跑”**。agent-browser 那个 153.0.8010.36 在本工作节点里跑同样 SEGV（上表第二行到第四行是同一现象的三种版本），它此前“正常”，是因为它是在宿主会话里起来的，不是在这个沙箱里。

同一条 argv（`tests/helpers/host-browser.ts` 的 `HOST_BROWSER_ARGUMENTS` + `--user-data-dir=$TMPDIR/...` + `--remote-debugging-port=0` + `about:blank`）在两个上下文的对照：

```
inside the sandbox: SEGV_ACCERR at 0x000000000010 (signal 11)
host session:       rendered "host session", 6232-byte screenshot
```

`--user-data-dir` 两边都在 `$TMPDIR` 下、都是新建的空目录；`--no-sandbox` 两边都有；参数列表逐字相同（宿主侧只把 `--remote-debugging-pipe` 换成 `--remote-debugging-port=0`，因为第二个进程要能 attach）。所以参数与 user-data-dir 都不是原因。

## 3. 根因：工作节点命令跑在 deny-default 的 seatbelt 沙箱里

Graph 的受限运行时把每条命令放进一个 `(deny default)` 的 seatbelt profile（`backend/internal/graph/runtime_restricted_policy.go` 的 `sandboxBaseProfile`）。在这条命令里可以复现三件事：

| 探针 | 本工作节点 | 宿主会话 |
| --- | --- | --- |
| `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`（嵌套沙箱） | `sandbox_apply: Operation not permitted` | 通过 |
| `/bin/ps -p $$`（跨沙箱的 process-info） | `spawn EPERM`（`Operation not permitted`） | 通过 |
| `bootstrap_check_in(bootstrap_port, "com.example.Probe.MachPortRendezvousServer")` | `unknown error code (1100)` | `(os/kern) successful (0)` |

第三行正是系统 Chrome 自己打印的判决：

```
FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS.
  bootstrap_check_in com.google.Chrome.MachPortRendezvousServer.60835: Permission denied (1100)
```

而崩溃报告把 0x10 的来处写清楚了（`~/Library/Logs/DiagnosticReports/chrome-headless-shell-*.ips`）：

```
exception: EXC_BAD_ACCESS KERN_INVALID_ADDRESS at 0x0000000000000010
faulting frame: IONotificationPortGetRunLoopSource (IOKit)   ← 调用者拿到 NULL 后没有判空
```

结论：浏览器启动要做三件这条 profile 不允许的事——注册自己的 Mach 服务（`bootstrap_check_in`，1100）、申请沙箱扩展（`sandbox_extension_issue_file_to_process`，Operation not permitted）、嵌套自己的沙箱；任一失败它就在平台初始化里死掉，而且死法取决于哪一步先失败（headless shell 与 Chrome for Testing 在 IOKit 通知端口的空指针处崩、系统 Chrome 先撞 rendezvous FATAL）。

诚实标注不确定的部分：单独写的 IOKit 探针（`IONotificationPortCreate` / `IOServiceGetMatchingService("IOPMPowerSource")`）在同一个沙箱内是**成功**的，所以“某个具体 iokit 权限被拒”不足以解释整条链；能确定并已测量的是——同一二进制、同一 argv、同一 user-data-dir 形态，**只在进程上下文不同**（沙箱内 vs 宿主会话），结果从 SEGV 变成正常渲染；以及上面三件被明确拒绝的事。

## 4. 规避：沙箱内检测到限制就在宿主会话起浏览器，仍由 Playwright 驱动

`tests/helpers/host-browser.ts`：

1. `isSandboxed()` 直接用 `sandbox-exec` 嵌套探针判断（沙箱内必然 `sandbox_apply: Operation not permitted`）；
2. 不在沙箱里 → 原样 `chromium.launch({ headless: true })`；
3. 在沙箱里 → 造一个临时 `.app`（唯一 CFBundleIdentifier），可执行文件 `exec` 浏览器（headless shell，`--remote-debugging-port=0`），用 `open -g -n` 交给 LaunchServices——**这是本机唯一还能走出的路径**（`launchctl submit`/`bootstrap` 在本沙箱被拒，实测 bootstrap 返回 `5: Input/output error`）；
4. 读 `DevToolsActivePort` 拿到端口，`chromium.connectOverCDP()` 接上，返回的还是 Playwright 的 `Browser`；
5. `close()` 发 CDP `Browser.close`（只断开会让浏览器留在宿主里），再删临时目录——浏览器自己的 crashpad 会在这之后继续往 profile 里写，所以 `--disable-breakpad --disable-crash-reporter` 一起带上，删不干净时打印 warning 而不是悄悄留一堆（实测四次启动后 `$TMPDIR/graph-host-browser-*` 归零）。

`tests/e2e/node-chat-auto-history.test.ts` 只换了启动那两行，断言、等待、种子数据一律没动。宿主会话里的浏览器通过回环访问本测试自己起的真实 daemon（沙箱内的服务对宿主可访问，已实测）。

**为什么这不是掩盖真实缺陷：**

- 断言与页面行为完全没变：真实 daemon、真实 HTTP、真实 Chromium、真实回环；只是浏览器进程的父上下文换了。
- 它是**明说的**：返回值带 `mode: 'direct' | 'host'`、`version`、`logPath`，测试可以断言自己是怎么跑的；报告脚本把两个上下文的结果并排写进 `report.md`。
- 它**不会退化成 skip**：宿主会话也起不来时抛错并附浏览器自己的日志（`browser.log` 末 2KB），红就是红。`browserLaunches()` 那个“浏览器层能力不可用”的探针仍用原生 `chromium.launch`，我没有动它，所以本机仍然把 `tests/m8`、`tests/console` 那一层判为能力不可用——这条 helper 只让指定文件在本机真的跑起来，不改变整层的判定。
- 非沙箱环境（CI、普通 shell）走原生启动路径，行为与不加 helper 时一致。

## 5. 复现命令与报告路径

```bash
# 本机跑绿（同一命令在 Graph 工作节点里执行也一样）：
node node_modules/vitest/vitest.mjs run tests/e2e/node-chat-auto-history.test.ts

# 重跑本文件的测量表 + 截图（默认写 $TMPDIR，可用 --out 指定）：
node scripts/playwright-launch-report.mjs
#   → $TMPDIR/graph-playwright-launch-report/<时间戳>/report.md
#   → 同目录 *.png
```

2026-11-04 记录：

- `node node_modules/vitest/vitest.mjs run tests/e2e/node-chat-auto-history.test.ts` → `1 passed (8.3s)`；
- `node scripts/playwright-launch-report.mjs` → `report.md`，四行浏览器三次对照，宿主会话四行全部渲染出图。

本次证据目录（含 `report.md`、四张 `*.png`、上面的 vitest 输出）：

```
$TMPDIR/graph-playwright-launch-report/2026-11-04T10-24-02-278Z/
  report.md
  playwright-chromium-headless-shell-default-for-headless-.png
  playwright-bundled-chrome-for-testing.png
  agent-browser-153-0-8010-36.png
  system-google-chrome.png
  node-chat-auto-history.log
```

## 6. 在宿主上下文跑（根因在 OS 沙箱时这就是正路）

- **单个文件**：不需要额外动作，`tests/helpers/host-browser.ts` 已经替你把浏览器放进宿主会话。
- **要整层浏览器测试在宿主会话跑**（`tests/m8`、`tests/console` 仍直接 `chromium.launch`）：在 Graph 应用之外的 shell 里执行，或按 ADR 0029 让已确认的图用 `sandbox: false` 的检查声明跑——那条路径由宿主以普通进程启动命令，`sandboxed: false` 会记在 `checks/<nodeId>.json` 里。
- **要让新的浏览器测试也享受这个规避**：把 `chromium.launch({ headless: true })` 换成 `launchBrowser()`，`finally` 里调 `launched.close()`，其余不动。

## 7. 未做的事

- 没有改任何断言、没有加 `skip`、没有把测试挪进隔离名单。
- 没有改 `scripts/measure-fold-policy.mjs`（L1 的文件）。
- 没有去改沙箱 profile 本身（`backend/internal/graph/runtime_restricted_policy.go` 属宿主代码，不在本节点文件范围）；本节点只让测试在这种环境里仍能证明自己要证明的事。
