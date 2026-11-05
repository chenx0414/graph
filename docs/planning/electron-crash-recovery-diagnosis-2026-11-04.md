# Electron 崩溃根因取证与实现方案（2026-11-04）

基线 `rsi/rsi-c924ce66` @ `733d1b48`。本文只记录取证结论与实现方案，不含代码改动。
每条结论后面是文件路径与行号，或可直接重跑的命令。

graph:allow-large-file: 这是一份取证记录：.ips 字段摘录、逐条推论与实现方案要能被一次复核对齐到同一个出处，拆成多份会让「哪条结论对应哪份证据」重新变成口头约定。

> **修订 v2（2026-11-04 晚）**：§0 / §3.3 / §5 / §6 更正了根因归属。原文把死因归到「macOS 27.2 的
> IOKit 缺陷」，实际是**本仓库受限运行时的 `(deny default)` seatbelt profile 拒绝浏览器启动所需的三件事**
> （L3 实测：`tests/e2e/playwright-launch-environment.md` §3，commit `e710b928`）——死法没错，归属错了。
> 原文成立并保留的两条：**不是内存压力**、**与 Chromium 启动崩溃同源**。
> 新增：§10（那几次系统崩溃弹窗到底是谁的）、§11（`tests/helpers/host-browser.ts` 的静默/必须报错边界）、
> §12（`tests/m8` 与 `tests/console` 整层不可用的判定入口）、§13（实现后记）。

## 0. 结论摘要

| 问题 | 结论 | 关键证据 |
| --- | --- | --- |
| 是内存压力导致的吗？ | **不是**。立即死因是「受限沙箱里拿到 NULL 的 IOKit 通知端口，被 `IONotificationPortGetRunLoopSource` 解引用」——不是 macOS 的 IOKit 缺陷，也不是内存压力 | `x0 == 0`（56/56 份报告）、`ldr x0,[x0,#0x10]`；本 boot `Swapouts=0 / Swapins=0 / Pages throttled=0`（§4）；沙箱链见 §3.3 |
| 与 L3 那份 Chromium 启动崩溃同源吗？ | **同源**：同一个失败面（受限沙箱拒绝浏览器启动必需的三件事）、同一条 IOKit 指令、同一个空句柄、同一启动时段；不是同一个调用方 | 56 份报告 `atPC` 逐字节相同、`IOKit+45340`；`tests/e2e/playwright-launch-environment.md` §3；commit `e710b928` |
| 会打到打包版 Graph.app 吗？ | **不会中这一枪**（原文「会」是错的）。用户窗口由 launchd 在宿主会话启动，不在受限沙箱里；崩掉的是沙箱内由 node 拉起的**开发版** Electron | 四份同批报告的 `bundleInfo.CFBundleIdentifier = com.github.Electron`、`procPath = …/Electron.app/Contents/MacOS/Electron`、`parentProc` 三份 `node` 一份 `Exited process`；§6 |
| 为什么没有 Graph.app 自己的崩溃报告？ | 崩溃进程的身份是开发版 Electron（`com.github.Electron`），由工作节点沙箱内的测试/探测拉起；Graph.app 只是进程树的 `responsibleProc`，它自己没有崩 | `.ips` 无 `dev.graph.console`；`responsibleProc=Graph / responsiblePid=3329`、`coalitionName=dev.graph.console`；§5.1 |
| 用户看到的系统崩溃弹窗是谁的？ | **我们沙箱内测试/探测拉起的开发版 Electron**，不是用户的 Graph.app | 17:14:27 / 17:48:18 / 17:48:20 / 17:48:24 / 17:49:27 五份报告的字段；§10 |
| 父进程为什么已退出？ | 它是上游启动器（`node`；17:48 那批是同一个父 pid `6263`，即看护进程），子进程先崩、父进程随后退出；不是被信号杀 | 同一父 pid 在相邻报告里既记为 `node` 又记为 `Exited process`；§5.2 |

---

## 1. 证据来源（可重跑）

```bash
# 全部崩溃报告的字段汇总
cd ~/Library/Logs/DiagnosticReports && python3 - <<'PY'
import json,glob
def load(p):
    t=open(p,encoding='utf-8',errors='replace').read(); i=t.find('\n{')
    return json.loads(t[:i]), json.loads(t[i+1:])
for p in sorted(glob.glob("*.ips")):
    if not any(k in p.lower() for k in ('chrome','electron')): continue
    hdr,body=load(p)
    th=body['threads'][body['faultingThread']]; f0=th['frames'][0]
    print(p, body.get('exception'), body.get('procLaunch'), body.get('captureTime'),
          body['usedImages'][f0['imageIndex']]['name'], f0['imageOffset'],
          th['threadState']['x'][0]['value'], body['instructionByteStream']['atPC'])
PY

# 机器内存水位（累计计数器，只能单调增）
vm_stat; memory_pressure | tail -5
```

时间线口径：本机 2026-11-04 13:22 起为本次 boot（`uptime` 显示 `up 4:02`，17:24 采样）。
两份 `bootSessionUUID`（`706DC4C6…` / `308C8756…`）证明跨了两次 boot，见 §3。

---

## 2. 那份 Electron `.ips`：字段与顶部 5 帧

文件：`~/Library/Logs/DiagnosticReports/Electron-2026-11-04-171427.ips`（`incident_id 1CCBFCD6-…`）

| 字段 | 值 |
| --- | --- |
| `app_version` / `bundleID` | `44.3.0` / `com.github.Electron`（= `package.json:92` 的 `electron@44.3.0`） |
| `procLaunch` → `captureTime` | `17:14:25.1444` → `17:14:26.7193`（**启动后 1.575 s**） |
| `exception.type` | `EXC_BAD_ACCESS` |
| `exception.signal` | `SIGSEGV` |
| `exception.subtype` | `KERN_INVALID_ADDRESS at 0x0000000000000010` |
| `exception.codes` | `0x1, 0x10`（KERN_INVALID_ADDRESS, 故障地址 0x10） |
| `termination` | `{code: 11, namespace: SIGNAL, indicator: "Segmentation fault: 11", byProc: "exc handler"}` |
| `faultingThread` | `0`，`queue = com.apple.main-thread`，`triggered = true` |
| `vmregioninfo` | `0x10 is not in any region` |
| `parentProc` / `parentPid` | `Exited process` / `64516` |
| `responsibleProc` / `responsiblePid` | `Graph` / `3329`（= 正在运行的 `/Applications/Graph.app`） |
| `coalitionName` | `dev.graph.console`（= `scripts/package-app.mjs` 的 `appId`） |
| `pid` / `procRole` | `64569` / `Background` |

顶部 5 帧（`threads[0].frames`）：

| # | image | offset | symbol |
| --- | --- | --- | --- |
| 0 | `IOKit` | `+45340` | `IONotificationPortGetRunLoopSource` +48 |
| 1 | `Electron Framework` | `+94101944` | （无符号；见下面的说明） |
| 2 | `Electron Framework` | `+93824336` | （无符号） |
| 3 | `Electron Framework` | `+74962424` | （无符号） |
| 4 | `Electron Framework` | `+50281372` | （无符号） |

**第 1 帧往后给的 symbol 名字不可信**：`ares_dns_rr_get_ttl +3373188`、`_v8_internal_Node_Print +3893088`
这种「符号 + 离谱偏移」是 dyld 在 stripped 二进制里就近套用导出符号的产物。只有第 0 帧是真符号
（IOKit 是系统 dylib，带符号表），所以**只有第 0 帧可以作为调用点证据**。

### 2.1 把故障指令解出来

`instructionByteStream.atPC` = `AAhA+YABALSog134SZot8CmRRPkpAUD5PwEI6+EGAFT9e1ap9E9VqQ==`，base64 解码：

```
000840f9 800100b4 a8835df8 499a2df0 299144f9 290140f9 3f0108eb e1060054
```

首字 `0xf9400800` 按 AArch64 `LDR (immediate, unsigned offset)` 解码：
`size=3 opc=1 imm12=2 Rn=0 Rt=0` → **`ldr x0, [x0, #0x10]`**。
次字 `0xb4000180` → `cbz x0, #+48`。

同时 `threadState.x[0].value == 0`。也就是说：

> 调用方把 `IONotificationPortRef = NULL` 传进了 `IONotificationPortGetRunLoopSource()`，
> macOS 27.2 的 IOKit 在函数 +48 处先执行 `ldr x0,[x0,#0x10]`（读 `port->cfSource` 字段），
> **`cbz` 判空在解引用之后**，所以读到 0x10 就崩。'0x10 is not in any region' 与之吻合。

这条链排除了「随机内存踩踏」：随机踩踏不会每次都踩在 `x0 == 0` 上并落到同一条指令。

---

## 3. 与 Chromium 家族同类字段对比：同源判定

`~/Library/Logs/DiagnosticReports` 里共有 **56 份** `SIGSEGV` 报告来自三个不同二进制：

| 二进制 | 份数 | 版本 | 调用方（LR 所在模块） |
| --- | --- | --- | --- |
| `Electron` (`com.github.Electron`) | 12 | 44.3.0 | `Electron Framework+94101944`（12/12 完全相同） |
| `chrome-headless-shell` (`headless_shell`) | 25 | — | `chrome-headless-shell+42324356`（24 份）、`+41233264`（1 份） |
| `Google Chrome for Testing` | 19 | 153.0.8010.36 | `GCFT Framework+50148716 / +50084712 / +48589532`（三个调用点） |

56 份报告**全部**满足：

- `exception.type = EXC_BAD_ACCESS`，`subtype = KERN_INVALID_ADDRESS at 0x0000000000000010`（`codes` `0x1,0x10`）
- 故障线程 = `threads[0]`，`queue = com.apple.main-thread`
- 帧 0 = `IOKit +45340`（`IONotificationPortGetRunLoopSource +48`）
- `threadState.x[0] == 0`
- `instructionByteStream.atPC` **逐字节相同**：`AAhA+YABALSog134SZot8CmRRPkpAUD5PwEI6+EGAFT9e1ap9E9VqQ==`
- `captureTime - procLaunch` 全部落在 0.1–1.6 s（见下表），即启动期、窗口出现之前

启动延迟（`Electron-*.ips`，`procLaunch` → `captureTime`）：

| 文件 | launch | capture | 线程数 | writable | resident |
| --- | --- | --- | --- | --- | --- |
| `Electron-2026-11-04-001846.ips` | 00:18:43.4126 | 00:18:43.6539 | 8 | 131.6M | 593K |
| `Electron-2026-11-04-001847.000.ips` | 00:18:46.3499 | 00:18:46.4813 | 8 | 131.5M | 609K |
| `Electron-2026-11-04-003852.ips` | 00:38:51.3529 | 00:38:51.4825 | 10 | 132.5M | 609K |
| `Electron-2026-11-04-003908.ips` | 00:39:07.2317 | 00:39:07.4636 | 8 | 139.6M | 593K |
| `Electron-2026-11-04-171427.ips` | 17:14:25.1444 | 17:14:26.7193 | 8 | 131.6M | 561K |

### 3.1 PC 跨 boot 变化不是「另一处代码」

本 boot 的报告 PC = `0x19db5511c`，上一 boot 的 = `0x18aea111c`。两者是**同一条指令**：

```
Electron-2026-11-04-001846.ips  bootSessionUUID 706DC4C6-…  sharedCache {base: 6543278080, uuid: b39b8e81-…}
Electron-2026-11-04-171427.ips  bootSessionUUID 308C8756-…  sharedCache {base: 6858588160, uuid: b39b8e81-…}
```

`sharedCache.uuid` 相同、`base` 不同 ⇒ 同一份 dyld 共享缓存被滑到了不同基址；`PC - IOKit.base`
两次都是 `45340`。所以同源判定靠的不是地址，而是**同一份操作系统构建里的同一条指令**。

### 3.2 同源到什么程度（必须说准）

- **相同**：崩溃点（`IONotificationPortGetRunLoopSource` +48：先 `ldr x0,[x0,#0x10]` 再 `cbz`，
  所以谁把 NULL 传进来谁就在这里死——这是**系统函数的实现特性**，不是本机独有的缺陷）、
  故障形态（NULL+0x10）、触发时机（启动后 1 秒内、主线程）、故障线程。
  谁把 NULL 传进来，见 §3.3。
- **不同**：调用方。Electron 从 `Electron Framework+94101944` 调，headless_shell 与 GCFT 各从自己的
  framework 调（三个不同偏移）。所以「同源」指**共享同一个失效面**，不是「同一段应用源码」。

### 3.3 根因更正（2026-11-04 晚）：不是 macOS 的 IOKit 缺陷，是受限沙箱

§2 把死法写对了（`x0 == 0`、`ldr x0,[x0,#0x10]`、`IOKit+45340`），错的是归属：原文把「谁把 NULL 交进来」
说成了 macOS 27.2 的系统缺陷。真实链路已被 L3 实测（`tests/e2e/playwright-launch-environment.md` §3，
commit `e710b928`；同 commit 的 `tests/helpers/host-browser.ts` 头注释）：

1. 本仓库的受限运行时把每条命令放进 `(deny default)` 的 seatbelt profile：
   `backend/internal/graph/runtime_restricted_policy.go:30` `func sandboxBaseProfile`，
   `:32` `(version 1)`、`:33` `(deny default)`。
2. 这条 profile 拒绝浏览器启动必需的三件事，三条都有实测输出：

   | 被拒的事 | 沙箱内实测 | 宿主会话 |
   | --- | --- | --- |
   | 嵌套自己的沙箱 | `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` → `sandbox_apply: Operation not permitted` | 通过 |
   | 注册自己的 Mach 服务 | `bootstrap_check_in(bootstrap_port, "com.example.Probe.MachPortRendezvousServer")` → `unknown error code (1100)`（系统 Chrome 自己打印 `FATAL:base/apple/mach_port_rendezvous_mac.cc:159] … Permission denied (1100)`） | `(os/kern) successful (0)` |
   | 申请动态沙箱扩展 | `sandbox_extension_issue_file_to_process failed for …/Electron.app: 1 (Operation not permitted)`（本轮 E2E 的 app stderr 里逐字出现这一行） | 通过 |

3. 任一步失败都发生在平台初始化里：拿不到 Mach 端口 rendezvous 句柄的那条路径把 NULL 传给
   `IONotificationPortGetRunLoopSource`，于是同一帧、同一地址 `0x10` 的 SIGSEGV。

对照（L3 的测量表：同一二进制、同一 argv、同一 user-data-dir 形态）：沙箱内 SEGV，宿主会话里正常渲染并截图。
也就是说差别只在**进程上下文**，不在版本、不在参数、不在 user-data-dir。

诚实标注（沿用 L3 的写法，也是本节唯一的缺口）：单独写的 IOKit 探针（`IONotificationPortCreate`、
`IOServiceGetMatchingService("IOPMPowerSource")`）在同一个沙箱内是**成功**的，所以「某个具体 iokit 权限被拒」
不足以单独解释整条链；能确定的是上表三件事被明确拒绝，且进程上下文一变结果就从 SEGV 变成正常。

因此 **Graph 无法在应用内修掉**它（既不能补 IOKit 判空，也不能改 Electron 二进制），产品侧能做的仍是
「崩了自动回来 + 说明上次为何崩」，实现与状态见 §13。

---

## 4. 内存证据：崩溃时刻的水位与并发实例数

### 4.1 系统级水位（本 boot，累计计数器）

```
$ sw_vers            → macOS 27.2 / 26B118 / Mac16,10 / ARM-64
$ uptime             → 17:24  up 4:02      # 本 boot 起于 13:22
$ vm_stat            → page size 16384
Pages free:                23396      # ≈ 366 MB（17:24 采样）
Pages wired down:         145707      # ≈ 2.28 GB
Pages stored in compressor: 669772
Pages occupied by compressor: 338276 # ≈ 5.16 GB
Pageouts:                 166211
Swapins:                       0
Swapouts:                      0
Pages throttled:               0
$ memory_pressure    → System-wide memory free percentage: 52%
```

`Swapins` / `Swapouts` / `Pages throttled` 是**自 boot 起单调递增的累计量**，只会变大不会变小。
在 17:25 读到 `=0`，等价于「13:22 以来任何时刻（含 17:14:26 那次崩溃）都 =0」。
macOS 的内存压力先触发 throttling 与压缩/换出；这三项为 0 说明本 boot 内从未进入压力状态。
现场「vm_stat 空闲约 10000 页」是 17:0x 的采样，与这里同一 conclusion：空闲偏低但无换出、无 throttling。

### 4.2 崩溃进程自身的内存

见 §3 表：11 份 Electron 报告的 `vmSummary` 全部是
`Writable regions: Total=131.x–139.x M, resident=561K–625K`，线程数 7–10。
`vmSummary` 里 `Guard 385.0G` / `App-Specific Tag 1 48.0G` 是**虚拟保留地址**，不是占用。

### 4.3 并发浏览器实例数

崩溃报告本身给出了并发数的下界（同一 10 秒窗口内不同 pid 的 Chromium 进程都崩了）：

```
2026-11-04 00:18:43 → 00:18:49   7 崩溃 / 7 个不同 pid / 7 秒
    5 × Electron（pid 77098 77133 77218 77289 77486）
    2 × chrome-headless-shell（pid 77683 77780）
2026-11-04 00:38:49 → 00:38:55   6 崩溃 / 6 个不同 pid / 7 秒
    4 × Electron + 2 × chrome-headless-shell
2026-11-04 16:57:51 → 16:57:52   4 崩溃 / 4 个不同 pid / 2 秒（4 × GCFT）
2026-11-04 17:13:36 → 17:13:38   4 崩溃 / 4 个不同 pid / 3 秒（2 × GCFT + 2 × Google Chrome）
```

即：**至少 7 个 Chromium 进程同时存活过**（每个 ≈130 MB 可写 + 3.1 GB 只读共享库映射，
共享库部分是全机共享的同一份页），总私有占用不到 1 GB。24 GB 级机器上这不构成压力。

### 4.4 结论与推理链

1. 若死因是内存压力，唯一能把压力变成 **`SIGSEGV at 0x10`** 的路径是：
   压力 → `IONotificationPortCreate()` / `mach_port_allocate()` 返回失败 → 得到 NULL → 调用方未判空。
   压力本身只会给出 `SIGBUS`、compressor/jetsam 的 `SIGKILL`，或数据区随机地址，不会是 `x0 == 0`。
2. 该路径的前提（系统进入压力）不成立：本 boot `Swapouts=0`、`Swapins=0`、`Pages throttled=0`（§4.1），
   崩溃进程自身足迹 ≈130 MB（§4.2），且 `~/Library/Logs/DiagnosticReports` 里**没有任何 JetsamEvent/panic 报告**
   （`ls | grep -i -E "jetsam|panic|watchdog"` 无输出）。
3. 形态也不支持「资源耗尽」：资源耗尽是随机条件，不可能 56/56 次都停在同一条指令、同一个
   `x0 == 0`、同一个 `IOKit+45340`，而同一批二进制在别的时刻又能正常起来（当前仍有 4 个 Electron 存活）。
4. 因此：**不是内存压力导致**。真正能确定的因果是「NULL 端口句柄 + 系统侧缺判空」；
   「为什么那一刻创建端口会返回 NULL」见 §8，属于未证实项，不写进结论。

---

## 5. 没有 Graph.app 崩溃报告 / 父进程为何已退出

### 5.1 报告目录里到底有谁

```
$ python3 -c '
import glob,json
for f in glob.glob("/Users/macmini/Library/Logs/DiagnosticReports/*.ips"):
    print(json.load(open(f)).get("bundleID"))' | sort | uniq -c
  29 (none)                              # chrome-headless-shell 等无 bundle 的二进制
  19 com.google.chrome.for.testing
  12 com.github.Electron
  10 com.google.Chrome
   3 com.apple.textkit.nsattributedstringagent
   2 dev.graph.foldbrowser                # /tmp 下的另一个中间产物，SIGTRAP，与本案无关
   1 com.apple.dock.external.extra.arm64
```

`grep -l '"bundleID":"dev.graph.console"' ~/Library/Logs/DiagnosticReports/*.ips` → **无命中**。

原因不是「打包版不会崩」，而是三件事（2026-11-04 晚按 `.ips` 字段更正）：

1. `.ips` 的文件名与 `bundleID` 取自**崩溃进程自己的 bundle 身份**。这 56 次崩溃的进程身份是
   `com.github.Electron`（dev 版 `electron desktop/main.mjs`）、`headless_shell`、
   `com.google.chrome.for.testing`。
2. 这些进程是**工作节点沙箱内的测试/探测**拉起的。同批四份报告
   （`Electron-2026-11-04-174818/174820/174824/174927.ips`）的
   `bundleInfo.CFBundleIdentifier` 都是 `com.github.Electron`，`procPath` 都是
   `…/Electron.app/Contents/MacOS/Electron`（开发版二进制）；`parentProc` 三份为 `node`
   （同一个父 pid `6263`，即当时的看护/启动进程），一份（17:48:23.99）因取样时父进程已被回收记为
   `Exited process`。
3. Graph.app 在这几次崩溃里只是 `responsibleProc`（`responsiblePid = 3329`，
   `coalitionName = dev.graph.console`），不是崩溃者；它自己的进程树没有崩——pid 3329/3331 全程存活，
   graphd（pid 93660，`127.0.0.1:65146`）的 `console.json` 从头到尾没变。它为什么不中这一枪见 §6。

### 5.2 父进程（17:14 那批是 64516，17:48 那批是 6263）

- 这 12 份 Electron 报告的 `parentProc` 是 `node`：即上游启动器（`electron` CLI、Playwright 的
  `_electron.launch`（`tests/helpers/desktop-shell.ts:37-41`），或本任务的 keeper）。17:48 那批四份报告的
  父 pid 全是 `6263`：三份记 `node`，一份（17:48:23.99）记 `Exited process`——同一个父进程，只是取样时刻不同。
- 「Exited process」不是第二种死因，只是**取样时父进程已被回收**的标签。反证在相邻报告里：

```
Electron-2026-11-04-001846.ips     parentProc=node(76967)           pid=77098
Electron-2026-11-04-001847.000.ips parentProc=node(76967)           pid=77218
Electron-2026-11-04-001847.ips     parentProc=Exited process(76967) pid=77289
```

同一个父 pid `76967`，在相隔 1 秒的报告里一次记 `node`、一次记 `Exited process`。所以该字段
只反映「写报告那一刻父进程还在不在」。

- 因果方向：子进程先于父进程死亡（报告是子进程的），父进程随后因为子进程消失而退出/返回。
  判定为**不是被信号杀**的依据：子进程死于自己主线程里 `x0 == 0` 的解引用，与父进程状态无关；
  且兄弟子进程崩溃的瞬间父进程仍在（上表）。`termination` 里 `byProc: "exc handler"`、
  `byPid` 等于自身 pid，也说明终止由内核异常处理交给进程自己完成，没有第三方 kill。
- 顺带一条对本方案重要的推论：父进程消失后 **graphd 会成为孤儿**（它由 `desktop/main.mjs:126`
  spawn），这正是 §7.6 必须处理 adopt-or-start 的原因。

---

## 6. 这份崩溃会不会打到打包版 Graph.app（2026-11-04 晚更正：不会中这一枪）

**不会。** 原文写「会」，并把条件写成「只要那段时间系统侧 `IONotificationPortCreate` 也返回 NULL」——
那句话把「沙箱拒绝」误当成了「系统随机/间歇地给 NULL」。更正后的因果（§3.3）是：
NULL 来自**受限 seatbelt profile**，而用户的打包版窗口由 launchd（Finder 双击 / `open`）在**宿主会话**启动，
根本不在那条 profile 里。

原文里仍然成立、并继续支持「同一份二进制」的那一半（它证明的是同一份 Electron，不是同一份死因）：

| 仍然成立的事实 | 依据 |
| --- | --- |
| 打包用的 Electron 与崩溃现场完全相同 | `package.json:92` `"electron": "44.3.0"`；`scripts/package-app.mjs` 的 `electronVersion: repo.devDependencies.electron` |
| 打包不重新编译 Chromium，只重组 bundle | `scripts/package-app.mjs`：`asar: false`、`npmRebuild: false`、`target: ['dir','dmg']`、`identity: null` |
| 崩溃调用点在 Electron Framework 内部，与桌面层无关 | 帧 0 = `IOKit`；LR = `Electron Framework+94101944`；`desktop/*` 里没有任何 IOKit 调用 |
| dev 与 packaged 的差异只有路径解析 | `desktop/runtime-files.mjs:42-60` 只按 `app.isPackaged` 选 `appPath` |

判定「不会」的三条证据：

1. 崩溃进程的 `bundleInfo.CFBundleIdentifier` 是 `com.github.Electron`（Electron 的**开发版**二进制），
   `procPath` 是 `…/Electron.app/Contents/MacOS/Electron`；打包版的 bundle id 是 `dev.graph.console`
   （`scripts/package-app.mjs` 的 `appId`），报告目录里 `grep '"bundleID":"dev.graph.console"'` 至今 0 命中。
2. 每一个崩溃进程的父进程都是 `node`（或取样时已被回收的同一个父进程），而打包版窗口的父进程是 launchd；
   父进程身份就是「它在不在沙箱里」的直接旁证（§5.2）。
3. 那几次崩溃发生的整段时间里，用户的 Graph.app（pid 3329/3331）与它的 graphd（pid 93660，`127.0.0.1:65146`）
   全程存活、`console.json` 一字未变。

**仍然存在的风险（不是本条结论的部分）**：同一份 Electron 只要被放进受限 profile 启动，就会以同样方式
死在同一帧——例如把打包版当作一次「受限命令」拉起来（图检查默认走受限运行时）。这是配置问题，不是
Finder 路径。真要关掉它，正确做法是给这条命令 `sandbox: false` 的检查声明（ADR 0029），而不是在应用里补判空。

**未做（需要授权的实验）**：更强的对照是「在宿主会话里反复启动打包版/开发版，观察是否不崩」。这需要起
Electron，本轮禁止；L3 已在宿主会话里用 Chromium 做过同形对照（正常渲染 + 截图），见
`tests/e2e/playwright-launch-environment.md` §2 的表。

---

## 7. 实现方案

### 7.1 先复核交付说明里的三条现成事实

| 事实 | 复核结果 |
| --- | --- |
| 隔离开关已存在：`GRAPH_APP_USER_DATA` | **成立**。`desktop/main.mjs:21` `if (process.env.GRAPH_APP_USER_DATA) app.setPath('userData', resolve(...))`；`desktop/runtime-files.mjs:42` `currentAppPaths()` 用它取 `app.getPath('userData')`（`runtime-files.mjs:48`/`59`），`desktop/lib.ts:39` `stateDir = join(userData,'state')`。隔离粒度见下面的「隔离了什么」。 |
| 路由恢复已有机制：`last-conversation-route.json` | **成立**。`desktop/main.mjs:41` 计算路径、`:42` 启动时读、`:43` 经 `consoleUrl` 应用到 URL、`:60-64` 页面每次导航经 `onRoute` 回写；校验在 `desktop/lib.ts:334 consoleRoute` 与 `:340 restoreConsoleRoute`。 |
| 没有 `--conversation` 参数 | **成立**（`rg -n "conversation" desktop/` 只有 route 与 IPC 相关，无该参数）。本方案**选择不新增它**，理由见 §7.5。 |

`GRAPH_APP_USER_DATA` 隔离了什么、没隔离什么（E2E 必须知道边界）：

- 隔离：`stateDir`（`lib.ts:39`，守护进程的 sqlite/instances/screenshots/rsi 全在这下面）、
  `graph.config.json`（`lib.ts:41`）、`secrets.json`（`lib.ts:42`）、`app.requestSingleInstanceLock()`
  的单实例锁（`main.mjs:31`，锁按 userData 分域）、以及本方案要新增的两个标记文件。
- 未隔离：`graphHome`（`lib.ts:40`，默认 `~/.graph`）：`capabilities/`、`prompts/`、`app-root` 文件共享。
  这是资源库，不是运行态，可以共享；E2E 里已有做法是把 `HOME` 也指到临时目录
  （`tests/helpers/desktop-shell.ts:38` 的 `HOME: root`）。

### 7.2 三份文件的语义必须分开

| 文件（都在 `app.getPath('userData')` 下，与 `main.mjs:41` 的 route 文件同级） | 谁写 | 语义 |
| --- | --- | --- |
| `last-conversation-route.json`（已存在，**不改语义**） | 渲染进程导航 → `main.mjs:60-64` | 「用户最后停在哪一页」（`#/conversations/<id>` / `#/tasks/<id>`） |
| `last-run.json`（新） | 应用启动时写、**正常退出时删** | 「我现在这一次运行还活着吗」：`{version, pid, startedAt, electron, appVersion}` |
| `last-crash.json`（新） | 看护进程或下一次启动时写 | 「上一次异常退出」：`{version, at, pid, startedAt, exitCode, signal, reason, source, ips?}` |

`reason` 必须是**可判定的类别**，不能出现「未知原因」：

- `signal` 非空 → `"被信号 SIGSEGV(11) 终止"`；SIGKILL(9) → `"被信号 SIGKILL(9) 强制结束"`。
- `exitCode != 0` 且无信号 → `"退出码 N"`。
- 有 `.ips` 命中（按 pid + 启动时间窗匹配）→ 追加 `"EXC_BAD_ACCESS / KERN_INVALID_ADDRESS at 0x10，IOKit+45340 IONotificationPortGetRunLoopSource+48，17:14:26.719"`。
- 三者全无（例如长时间断电后）→ 也要给类别：`"上一次运行未正常退出，且系统未留崩溃报告（SIGKILL / 断电 / 系统回收）"`，
  并附上 `last-run.json` 里的 `startedAt` 作为时间。
- 正常退出（`exitCode === 0` 且无信号）→ **不写** `last-crash.json`，并删掉旧的，避免误报。

`.ips` 匹配规则（纯函数，便于 E2E 断言）：读 `~/Library/Logs/DiagnosticReports` 下 mtime 在
`[startedAt-60s, at+60s]` 的 `*.ips`，取首行 JSON 的 `pid` 等于 `last-run.json` 的 pid 者。
本次取证已经证明这条路可用：`Electron-2026-11-04-171427.ips` 的 `pid = 64569`、
`procLaunch = 17:14:25.1444` 都在 `last-run.json` 能记下的范围内。

### 7.3 看护进程怎么拿 exit code / signal

一个进程被 SIGSEGV 打死之后**不能自己重启自己**，所以看护者必须在它外面。两种部署形态分别有确定的机制：

**形态 A：有人启动它（开发、E2E、CI）——父进程 spawn，最准**

新增 `desktop/keeper.mjs`：`spawn(electronBin, ['desktop/main.mjs', ...])`，
在 `child.on('exit', (code, signal) => …)` 里直接拿到 `(exitCode, signal)`。
Node 的 `exit` 事件对信号致死的子进程给出 `code === null`、`signal === 'SIGSEGV'`，这就是 a3 要的
「看护进程的退出码/信号」，不需要解析任何系统文件。这条路径是本任务 E2E 取证路径。

**形态 B：Finder 双击打包版——没有父进程，用 launchd**

打包版的父进程是 launchd，应用自己无法做父进程。可用的确定机制是 LaunchAgent + `KeepAlive`，
其上次退出状态可由 `launchctl print` 读到（本机已验证该命令存在并输出该字段）：

```
$ launchctl print gui/501/com.apple.Finder | grep 'last exit'
	last exit code = (never exited)
```

即 `launchctl print gui/$UID/dev.graph.console` 的 `last exit code` / 终止信号就是形态 B 的
`(exitCode, signal)` 来源。形态 B 属于「可选增强」，不进本节点验收；但它与形态 A 共用同一个
`last-crash.json` 与同一个 `reason` 分类函数，所以以后接上不需要改判定逻辑。
形态 B 在没有 LaunchAgent 的普通双击场景下，靠 §7.2 的 `last-run.json` + `.ips` 给出原因（能给出，
只是不能自动重启）。

### 7.4 自动重启策略与并发防护

重启必须有界，否则「启动即崩」会变成无限循环。本机已经出现过这种形态：
`00:18:43→00:18:49` 6 秒内 5 个 Electron 进程相继崩在同一处（§3）。因此：

```
keeperDecision({exitCode, signal, uptimeMs, attempts}) →
  'stop-clean'         exitCode === 0 && !signal                     // 正常退出：不重启
  'restart'            uptimeMs >= 30_000（稳定运行过）              // 重置 attempts 后立刻重启
  'restart-backoff'    uptimeMs < 30_000 且 attempts < 3             // 退避 min(1s·2^n, 30s)
  'stop-crash-loop'    uptimeMs < 30_000 且 attempts >= 3            // 停，写 last-crash.json 并报「反复启动即崩溃」
```

并发防护三层：

1. **应用层**：`main.mjs:31 app.requestSingleInstanceLock()` 已存在；锁按 userData 分域，
   所以隔离实例与主实例互不干扰（主实例 pid 3331 / 端口 65146 不会被抢）。
2. **看护层**：`<userData>/keeper.lock` 用 `open(path,'wx')` 原子创建，内容 `{pid, startedAt, userData}`。
   已存在时：pid 活着且 `/proc` 等价物（`process.kill(pid,0)`）成功 → 退出（已有看护者）；
   pid 不活 → 视为陈旧锁，覆盖。这防止两个 keeper 互相重启对方的子进程。
3. **标记层**：`last-run.json` 带 pid；下一次启动时若发现 `last-run.json` 的 pid **仍然活着**
   （`process.kill(pid,0)` 成功）→ 说明是第三个实例误读，不报崩溃、直接覆盖。

### 7.5 恢复同一 conversationId：选择「复用 last-conversation-route.json」

**决定：不新增 `--conversation`，keeper 依靠 `last-conversation-route.json` 恢复。**

理由：

1. **单一事实源**。route 文件已经由渲染进程在每次导航时回写（`main.mjs:60-64`），
   并在每次启动（`main.mjs:43`）与每次守护进程重载（`main.mjs:178 showConsole` → `consoleUrl`）时被应用。
   再加一个参数，就出现「参数说会话 A、文件说会话 B」的二义性，必须再写一条优先级规则去解决它。
2. **不违反「标记不要合并语义」**。route 记路由、`last-crash.json` 记异常，两者物理分离；
   若把会话 id 放进 `--conversation` 交给 keeper 转交，等于把路由塞进了崩溃通道。
3. **走的是真实用户路径**。双击启动本来就是「读 route 文件 → 恢复上次页面」；让 E2E 走同一条路径，
   证明的才是用户会遇到的行为，不是一条只存在于测试里的旁路。
4. **崩溃点决定它能覆盖本任务**。崩溃发生在 1.6 秒内、窗口尚未出现（§3 的 8 线程 + 无渲染进程），
   此时 route 文件里保留的正是**上一个成功运行的最后一页**，即用户真正想回到的那一页。
5. **就被验证的粒度**：a2 要求「恢复同一 conversationId」，而 E2E 断言的就是「重启后 URL 的
   `#/conversations/<id>` 与 kill 之前相同」，route 文件是这条断言的直接来源。

已知局限（写清不掩盖）：`consoleRoute()`（`desktop/lib.ts:334`）只接受
`#/conversations/<id>` 与 `#/tasks/<id>`。若崩溃时用户停在任务页，恢复的是任务页而不是会话页。
这不影响 a2（E2E 停在会话页），若要覆盖任务页 → 会话页的映射，属于另一条改动，不在本节点范围。

### 7.6 守护进程与三条 lane 不断：adopt-or-start

`a4` 要求「kill 期间守护进程与 50fa0860 的三条 lane 不断」。当前代码做不到，原因有两处：

1. `main.mjs:111 startDaemon()` **无条件** spawn 新守护进程（`main.mjs:126`），没有「接管已有的」分支。
   应用被强杀后 graphd 会成为孤儿；重启的应用再起一个 → 同一 `stateDir` 上两个守护进程、两套 sqlite 写者。
2. `main.mjs:130` `stdio: ['ignore','pipe','pipe']`。应用死后这两根管道的读端消失，graphd 下一次往
   stdout/stderr 写就吃 SIGPIPE（Go 对 fd 1/2 的 SIGPIPE 是默认致命）。落点是 `server_cli.go:401`
   的 banner 以外的 `fmt.Printf` / `stopGraphDaemon` 等。

改法（两处，都在 desktop/）：

- **stdio 落盘**：`stdio: ['ignore', logFd, logFd]`，`logFd = openSync(join(paths.stateDir,'daemon.log'),'a')`。
  守护进程从此没有「会被打断的管道」，父进程被 SIGKILL 也不牵连它。banner 的读取改由
  `state/console.json` 提供（见下条），日志用 `tailText(readFileSync(daemon.log))` 替代原
  `tailText(stderr||stdout,12)`（`main.mjs:169`、`main.mjs:173`）。
- **adopt-or-start**：`startDaemon()` 先读 `state/console.json`
  （`backend/internal/graph/server_console_address.go:19` `ConsoleAddressPath`、
  `:27` `WriteConsoleAddress`，字段 `{url,pid,mode,startedAt}`，文件权限 0600），
  若 `pid` 活着且 `GET <url>/` 返回 200 → **接管**：设 `readyUrl = url`、不 spawn。
  否则才走现有的 spawn。这既修好了强杀重启，也让「应用重启」对正在跑的三条 lane 完全无感。
  接管路径还需要一个 watcher（轮询 `GET /api/health` 或 `process.kill(pid,0)`）替代现在的
  `child.on('exit')`（`main.mjs:158`），否则接管的守护进程死了应用不知道。
- 好处叠加：守护进程本来就会**优先复用上次端口**（`backend/internal/graph/server_console_port.go:21`
  `PreferredConsolePort`，在 `server_host.go:148` 用 `--port 0` 时生效，等待 5 s 让旧 socket 释放），
  所以即便走到「重启守护进程」，URL 也常常不变；配合 `desktop/lib.ts:350 consoleReloadAction`
  的 `reload` 判定，页面原地刷新而不是跳新地址。E2E 里已经有用例证明这个复用行为
  （`tests/e2e/console-discovery.test.ts:24-44`）。

### 7.7 展示位置

三处，按「一定要能看到」排序，都不需要改 `src/web`：

1. `last-crash.json`（§7.2）：机器可读、E2E 直接断言，也是人排查时的第一现场。
2. **状态栏菜单一项**（`desktop/lib.ts:86 trayMenuItems`）：`上次异常退出：SIGSEGV(11) · 11-04 17:14`，
   点击用 `shell.openPath` 打开对应 `.ips`。`refreshTray()`（`main.mjs:401`）已有重建菜单的入口。
3. 非 background 模式弹一条 macOS 通知 + `reportDaemonError`（`desktop/console-window.mjs:74`，
   已封装「background 时写日志 / 否则弹框」）；这是现成的「告诉用户出事了」通道，直接复用不新造。

`preload.cjs` 的 `window.graph` 桥可以顺带暴露 `lastCrash`，供后续在页面里做 banner；
但那需要 `src/web` 配合，不属于 desktop/ 范围，列为后续项，不阻塞验收。

### 7.8 文件清单与改动点

| 文件 | 改动 | 为什么必须是它 |
| --- | --- | --- |
| `desktop/lib.ts` | 新增纯函数：`runStatePath/crashMarkerPath/keeperLockPath`、`describeExit`、`keeperDecision`、`findCrashReport`、`adoptableConsole(record, isAlive, probe)`。风格对齐现有 `rsiRestartDecision`（`lib.ts:254`）——纯函数、供 main 与 keeper 共用 | 现有「纯助手」层，`main.mjs` 与 `keeper.mjs` 都要用同一份判定 |
| `desktop/main.mjs` | ① `whenReady`（`:457`）读 `last-run.json` → 解析原因 → 写 `last-crash.json` → 写本次 `last-run.json`；② `before-quit`（`:447`）删 `last-run.json`，并补 `process.on('SIGTERM'/'SIGINT')` 走同一收尾；③ `startDaemon`（`:111`）加 adopt-or-start，`:130` stdio 改落盘；④ `showConsole`/`openWindow` 展示上次崩溃 | 生命周期钩子与守护进程都在这一处 |
| `desktop/runtime-files.mjs` | 若把 `.ips` 目录与 `daemon.log` 路径也纳入路径推导，在此新增（`currentAppPaths` 已在 `:42`） | 已经是「从 userData 推导路径」的唯一位置 |
| `desktop/keeper.mjs`（新） | 父进程看护：spawn、`exit(code,signal)`、`keeperDecision`、写 `last-crash.json`、`keeper.lock`、信号转发（Ctrl-C 时先让子进程优雅退出） | 形态 A 的唯一落点；`desktop/` 之外放会让打包 `files` 列表漏掉它（`scripts/package-app.mjs` 的 `files` 含 `desktop/**/*`） |
| `desktop/package.json` 脚本 | `app:dev` 从 `electron desktop/main.mjs` 改为 `node desktop/keeper.mjs`（另留 `app:dev:bare` 走无看护） | **注意：`package.json` 在 `desktop/` 之外**，若本节点文件清单不含它，则这一步留给 implement 或改由 `keeper.mjs` 自行说明运行方式 |
| `tests/e2e/desktop-crash-recovery.test.ts`（新） | 见 §7.9。图里的 check 模块已经点名了这个路径（`graph` 定义 `i2c` 的 `vitest run tests/e2e/desktop-crash-recovery.test.ts`） | 验收要求的 E2E |

明确**不改**的文件：`src/web/**`（展示留后续）、`backend/**`（`console.json` 与端口复用已经够用）、
`desktop/console-window.mjs`（只调用 `reportDaemonError`）、`desktop/daemon-process.ts`
（`stopDaemonProcess` 在 `:10` 已能停子进程，接管路径不需要它改）。

### 7.9 E2E 验收（a2/a3/a4/a5）

新增 `tests/e2e/desktop-crash-recovery.test.ts`，以 `tests/helpers/desktop-shell.ts` 为底
（它已经做到：临时 `HOME` + `GRAPH_APP_USER_DATA` 隔离、`_electron.launch`、轮询
`state/console.json` 等就绪，见该文件 `:38`、`:37-41`、`:55`）。流程：

1. 记录**外部实例基线**：`state/console.json` 读到主实例 `pid 3331`/`port 65146`，以及
   `lsof -nP -i :65146` 的 LISTEN pid `93660`（本次已实测）。
2. 起隔离实例（`GRAPH_APP_USER_DATA=<tmp>/user-domain`，keeper 作为父进程），
   等 `state/console.json` 出现、拿到自己的 url 与 pid。
3. 在页面里导航到某个会话，断言 `last-conversation-route.json` 变成 `#/conversations/<id>`，
   记下 `conversationId`。
4. **强杀**：对 Electron 主进程 `process.kill(pid,'SIGKILL')`（只杀自己起的那个 pid，不按名字杀）。
5. 断言 keeper 自动重启：出现新的 `console.json`（新 pid、`startedAt` 变大），窗口 URL 的
   `#/conversations/<id>` 与第 3 步一致。
6. 断言 `last-crash.json`：`signal === 'SIGKILL'`、`exitCode === null`、`at` 落在 kill 与重启之间。
   —— 时间与原因都是真的（不是「未知原因」），满足 a3。
7. 断言守护进程与 lane 不断（a4）：kill 前后 `console.json` 的 `pid`/`url` **不变**（走 adopt 路径），
   并对比 `tasks.sqlite` 里 `50fa0860/operations` 的 `dispatched_at` 未出现回退、
   该任务的 `nodes`/`records` 计数不减。注意：主机上本进程读 `tasks.sqlite` 受 WAL 限制可能读到旧快照，
   E2E 里应通过**被隔离实例自己的 daemon HTTP 接口**取这三条 lane，而不是直接读主库。
8. 断言正常退出不重启：`app.close()`（Playwright）→ 等 2 s → 没有新 `console.json`、没有新 `last-crash.json`。
9. 全程断言 `pid 3331` 与端口 `65146` 未被触碰：第 1 步的基线值在结束时逐一比对。
10. 产物：`tests/.artifacts/desktop-crash-recovery/` 下留
    `before.png` / `after.png`（`page.screenshot()`）、两份 `console.json`、`last-crash.json`、
    keeper 日志；命令固定为
    `node node_modules/vitest/vitest.mjs run tests/e2e/desktop-crash-recovery.test.ts`
    （与图里 check 模块一致）。

---

## 8. 未证实项（不写进结论，留给实现期做判别实验）

1. ~~那一刻为什么 `IONotificationPortCreate` 会返回 NULL~~ → **已在 §3.3 解释**：不是系统随机给 NULL，
   是受限 seatbelt profile 拒绝浏览器启动所需的三件事。仍未确定的只剩「三件事里哪一件先失败导致端口为
   空」——单独写的 IOKit 探针（`IONotificationPortCreate` / `IOServiceGetMatchingService("IOPMPowerSource")`）
   在同一个沙箱内**成功**，所以不能把原因缩成「某条 iokit 权限被拒」。已知排除项保留：内存压力（§4.4）、
   「唤醒后窗口期」（`sleepWakeUUID` 只随 boot 变化，与崩溃无关）。
2. **打包版是否已实际命中**。现在判为**不会**（§6，三条证据）。仍未做的是「宿主会话里反复启动打包版
   不崩」的正向对照——需要一次被授权的 Electron 启动，本轮禁止。
3. ~~12 次 Electron 崩溃的启动方~~ → **现在有更直接的证据**：`bundleInfo.CFBundleIdentifier =
   com.github.Electron`、`procPath` 是开发版 `Electron.app/Contents/MacOS/Electron`、`parentProc = node`
   （17:48 那批同一个父 pid `6263`），即工作节点沙箱内的测试/探测。`/bin/ps` 仍被沙箱挡，无法再细分到
   具体是哪个 agent 的哪次启动，这一点保持「只按父进程身份陈述」。

---

## 9. 给 implement 的最小落地顺序

1. `desktop/lib.ts` 的纯函数 + `desktop/keeper.mjs`（先能让「强杀→自动重启→原因可见」成立）。
2. `desktop/main.mjs` 的 `last-run.json` / `last-crash.json` / 展示三处。
3. `desktop/main.mjs` 的 adopt-or-start 与 stdio 落盘（a4 的守护进程不断）。
4. `tests/e2e/desktop-crash-recovery.test.ts`（先写、先看它在缺 keeper 时失败，再补实现）。
5. 崩溃循环的实际停手证据：把「反复启动即崩溃」也用 E2E 覆盖（构造一个必然立刻退出的子进程），
   断言 3 次后停手并写出 `last-crash.json`——否则 00:18 那种 6 秒 5 崩会变成无限重启。

**风险**：`last-crash.json` 是纯写入，最坏情况是多一个陈旧文件；`keeper.lock` 用原子创建 + pid 存活判断，
最坏情况是需要人工删锁；adopt-or-start 若判断错（把别人的守护进程当自己的），会在同一个 `stateDir`
上多一个写者——所以 `console.json` 的 `mode`/`startedAt` 与 `GET /` 的 200 必须**同时**满足才接管，
任何一项不满足都退回 spawn。

---

## 10. 那些系统崩溃弹窗到底是谁的（2026-11-04 晚新增）

用户在这一天看到 4 份 Electron + 1 份 chrome-headless-shell 的「意外退出」弹窗。逐份查字段（`~/Library/Logs/DiagnosticReports`）：

| 弹窗时刻 | 报告文件 | 崩溃进程 pid | `bundleInfo.CFBundleIdentifier` | `procPath` | `parentProc(parentPid)` | `responsibleProc(pid)` |
| --- | --- | --- | --- | --- | --- | --- |
| 17:14:27 | `Electron-2026-11-04-171427.ips` | 64569 | `com.github.Electron` | `…/Electron.app/Contents/MacOS/Electron` | `Exited process(64516)` | `Graph(3329)` |
| 17:48:18 | `Electron-2026-11-04-174818.ips` | 6267 | `com.github.Electron` | 同上（开发版） | `node(6263)` | `Graph(3329)` |
| 17:48:20 | `Electron-2026-11-04-174820.ips` | 6280 | `com.github.Electron` | 同上（开发版） | `node(6263)` | `Graph(3329)` |
| 17:48:24 | `Electron-2026-11-04-174824.ips` | 6391 | `com.github.Electron` | 同上（开发版） | `Exited process(6263)` | `Graph(3329)` |
| 17:49:27 | `Electron-2026-11-04-174927.ips` | 7804 | `com.github.Electron` | 同上（开发版） | `node(7794)` | `Graph(3329)` |

（同一时段还有 `chrome-headless-shell-2026-11-04-175009.ips` 一类无 bundle 的报告，来自 L3/测试的浏览器启动。）

结论：**用户看到的 Electron 意外退出弹窗来自我们沙箱内的测试/探测进程，不是他的 Graph.app。**
- 崩溃者身份是**开发版 Electron**（`com.github.Electron`，`package.json:92` 的 44.3.0），不是 `dev.graph.console`；
- 父进程是 `node`（看护/启动器）或取样时已被回收的同一个父进程，而用户的 app 父进程是 launchd；
- `responsibleProc = Graph` 只表示**进程树从 Graph 长出来**（工作节点的命令在 Graph 的作业里跑），
  不代表 Graph 自己崩了——它的 pid 3329/3331 与 graphd 在整个过程中一直活着。

**弹窗本身压不掉**（附和注，来自 implement 节点的实测/查证，弹窗复现需要授权）：`--noerrdialogs` 与
`--disable-breakpad` 在 Electron 44.3.0 的 `Electron Framework` 二进制里存在（`strings` 各 1 次），
只管 Chromium 自己的错误框与 crashpad 上传；`--disable-crash-reporter` 与 `CRASHREPORTER_DISABLE`
在二进制里根本不存在（0 次）。`LSUIElement`/`LSBackgroundOnly`/`app.setActivationPolicy('accessory')`
只改 Dock 与激活态——上一轮 E2E 就是在 accessory 模式下跑的，弹窗照旧。唯一真能关的是用户级
`defaults write com.apple.CrashReporter DialogType none`（本机当前没有这个键），那会把全机真实崩溃一起静音，
不由测试做。**所以减少弹窗的唯一手段是减少实例数**，见 §13 的 E2E 限流。

---

## 11. `tests/helpers/host-browser.ts` 的边界：何时静默、何时必须报错（2026-11-04 晚新增）

它在 `isSandboxed()`（`sandbox-exec` 嵌套探针）为真时，造一个临时 `.app`（唯一 `CFBundleIdentifier`、
`LSUIElement`）用 `open -g -n` 交给 LaunchServices，读 `DevToolsActivePort` 拿端口，再用
`chromium.connectOverCDP()` 接上——返回的仍是 Playwright 的 `Browser`。断言与页面行为不变，只是浏览器进程的
父上下文换了。

**会静默（不报错，但都可观察）的情形：**

1. `DevToolsActivePort` 读不到 —— 轮询循环里被吞掉，因为这就是「还在启动」的正常状态（每 100ms 一次）。
2. `resolveBrowserExecutable()` 找不到同 revision 的 headless-shell —— 静默回退到 Playwright 捆绑的
   Chrome for Testing 加 `--headless=new`；差异能从返回值的 `version` / `mode` / `logPath` 看出来。
3. `close()` 里 CDP 的 `Browser.close` 发送失败 —— `.catch()` 吞掉（此时连接可能已经断了，进程已退出）。
4. 临时目录删不干净 —— `process.emitWarning(...)`，不是测试失败，但也不静默。

**必须报错的情形：**

1. 宿主会话里的浏览器在 `timeoutMs`（默认 60 s）内没有写出 `DevToolsActivePort` —— 抛错并附
   `browser.log` 末 2 KB。这是「宿主也起不来」的唯一判定点，也是「`open` 成功但浏览器自退」的落点。
2. 非沙箱环境走原生 `chromium.launch` —— Playwright 自己的 `Process failed to launch!` 直接向上抛
   （本任务的 E2E 在这台机器上撞到的就是这条）。

**关键边界**：`open` 返回 0 **不能**当作成功。本机实测过 `open -n …/Electron.app` 返回 0 而进程从未启动
（LaunchServices 在沙箱里静默拒绝），所以唯一可靠的成功信号是 `DevToolsActivePort` 里出现 > 0 的端口；
「open 成功但浏览器自退」必然落到上面第 1 条，以明确错误收尾。现有行为已经符合「必须报错」那一半，本轮不改它。

---

## 12. `tests/m8` 与 `tests/console` 被整层判为不可用：判定入口与依据（2026-11-04 晚新增）

- **层定义**：`tests/env-layers.json` 的 `window-services` 层（`tests/m8/**`、`tests/console/setup-wizard.test.ts`
  以及若干 `tests/e2e/*`）。
- **判定入口（最终报告可直接引用这一处）**：`scripts/check-tests.mjs:25` 的 `browserLaunches()`，
  它用**原生** `chromium.launch({ headless: true })` 真起一次浏览器；在 `:50` 注册为
  `const probes = { chromium: browserLaunches }`。探针给出原因时，`check-tests` 把这些文件全部
  `--exclude`，打印 `check:tests: layer "window-services" skipped (N entries) - <reason>`，并把
  「跳过了哪层、为什么、哪些文件」写进台账 `tests/.suite-layers.json`。
- **为什么本机整层不可用**：`browserLaunches()` 用的是原生启动，没有走 `host-browser.ts` 的宿主会话规避，
  所以在受限沙箱里必然失败（§3.3）。这是**沙箱能力缺失，不是回归**：同一台机器上同一个探针的结果只取决于
  进程上下文，与任何一次代码改动无关。
- **台账的两个作用**：① 被跳过的层不会读成「测试变少了」（`check:baseline` 读同一份台账）；② 跳过一定带
  原因，不静默。
- **让整层真跑起来的两条路**（L3 文档 §6）：在 Graph 之外的 shell 里跑；或按 ADR 0029 用 `sandbox: false`
  的检查声明跑（宿主以普通进程启动命令，`sandboxed: false` 记在 `checks/<nodeId>.json`）。
  `host-browser.ts` 只让**指定文件**在本机真跑，不改变整层判定。

---

## 13. 实现后记（2026-11-04 晚新增）

实现已落地，commit `3522625d`（产品代码）+ `9b21bddd` / `151194e2`（E2E）：

| 文件 | 作用 |
| --- | --- |
| `desktop/crash.ts` | 纯规则：run marker 身份（pid + bootedAt）、`.ips` 解析与按 pid/时间窗匹配、原因句子、`keeperDecision`（干净退出即停；其余重启并退避，连续 3 次立即死亡则停手）、可接管的 daemon 地址判定 |
| `desktop/run-marker.ts` | app ready 前以 `O_EXCL` 认领 `<userData>/crash/last-run.json`，导航时更新 conversationId，正常退出删除；上次运行留下的标记 → 写 `<userData>/crash/last-crash.json`（keeper 已记录同一 run 时保留 keeper 的版本，并在后来出现 `.ips` 时补全） |
| `desktop/crash-record.ts` | 找 `[bootedAt, at]` 窗口内该 pid 的最新 `.ips`，原子写崩溃记录 |
| `desktop/keeper.mjs` | 父进程看护：spawn + waitpid、记崩溃、`--conversation=<id>` 重启、干净退出即停；`keeper.lock` 一 userData 一把；SIGTERM/SIGINT 转发后再退；SIGSEGV 类信号最多等 3s 让 `.ips` 落盘再写记录 |
| `desktop/daemon-runtime.mjs` | adopt-or-start：`console.json` 的 pid 活着**且** `GET <url>/` 200 才接管，否则 spawn；守护进程 stdio 落 `state/daemon.log`（应用被强杀不会让 graphd 吃 SIGPIPE）；接管后用 3s 存活轮询替代 `child.on('exit')` |
| `desktop/main.mjs` | 三份标记与看护的接线；状态栏一行「上次异常退出：SIGKILL(9) · 11-04 17:41」；非 background 时通知；SIGTERM 当作正常退出 |

与 §7 方案的三处偏差（实现时定的，记在这里避免文档与代码打架）：

1. 标记文件在 `<userData>/crash/` 下（原方案写的是 `<userData>/` 根），与 `keeper.lock`、`keeper.log` 同目录。
2. keeper 重启时**显式**传 `--conversation=<id>`（原 §7.5 选择只靠 route 文件）；正常双击启动仍只读 route 文件。
3. E2E 加了机器约束：一次只跑一个 Electron（`O_EXCL` slot）、启动尝试封顶 3 次（2s→4s 退避，超限以
   「环境阻塞：Electron 启动 SEGV」失败）、keeper 以 `--max-restarts=0` 启动（一次尝试=一次拉起），
   并在每次启动前后断言用户实例未被触碰（pid 3329/3331 存活、pid 93660 仍在 65146 应答）。

**状态**：完整 a2–a5 E2E 尚未跑过——本机从 agent harness 启动的任何 Electron 都会在 ~100ms 内死在 §3.3
那条链上，跑一次就是 3 个崩溃弹窗。等被授权后跑一次
`node node_modules/vitest/vitest.mjs run tests/e2e/desktop-crash-recovery.test.ts`。
