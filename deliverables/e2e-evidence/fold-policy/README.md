# 折叠策略：轮块展开、轮内工具组折叠（主对话 / 主管对话 / 节点对话一致）

本目录是这一个改动的可重复证据。`red.txt` 是改动前（733d1b48）的真实浏览器测量，
`green.txt` 是改动后的同一份测量，两张报告（`red-report.json` / `green-report.json`）
逐窗口记录首屏与点击后的读数，`*.png` 是三处窗口的首屏与点开后的截图。

## 方向与取舍

定死的方向：**轮块默认展开，轮内工具组默认折叠（含进行中的一轮）**，三处窗口完全一致。

733d1b48 的方向相反（live 工作默认展开），这里改回并统一。取舍理由写进
`src/web/transcript-model.ts` 的 `transcriptFoldPolicy`：轮次是读者扫读的单位，所以轮块
展开——一个轮次几步、用了什么工具、花了多久，不点就看得见；轮内工具细节折叠，因为
一个正在跑的轮次若把工具行全部铺开，回答会被挤到屏幕外。这也是「三处一致」的代价：
节点对话里那段实时工具行以前是最显眼的，现在和主对话一样收成一行摘要。

## 一处策略，两条渲染路径的调用点

`transcriptFoldPolicy` 只在 `src/web/transcript-model.ts` 声明一次：

- `src/web/transcript-model.ts`：`emitActivity()` 用它给轮块定 `collapsed`；
  `activityRows()` / `pushToolGroup()` 不再携带任何 `open` 标志——工具行自己没有
  「我要开着」的决定权。
- `src/web/TranscriptRows.tsx`：`ToolActivityGroup` 的
  `open = manualOpen ?? transcriptFoldPolicy.toolGroupExpanded`；
  `CollapsedTurn` 的 `open = manualOpen ?? (transcriptFoldPolicy.turnExpanded || !row.collapsed)`；
  两者都由 `TranscriptRowView` 渲染，且 `TranscriptRowView` 的 `defaultOpen` 透传已删除
  （那是「打开轮块顺带打开轮内工具组」的那条老路）。

两条渲染路径最后落到同一组组件：

1. 主对话 / 主管对话：`src/web/conversation-view.tsx` → `conversation-state.tsx` 的
   `supervisorTranscript()` → `buildTranscriptRows()` → `TranscriptRowView`。
2. 节点对话：`src/web/AgentNodeChat.tsx` → `nodeMessages()`（`node-transcript.ts`）→
   `buildTranscriptRows()` → `TranscriptRowView`。

`node-transcript.ts` 里的那条 `busy` 闸门属于「哪条 assistant 记录是最终回答」，不是折叠
默认值，因此保留（733d1b48 的这个修正是对的：结束的节点跑不该把最后一轮继续当成进行中）。
取舍：保留它意味着节点对话结束时最后一轮是一条回答 + 一个可展开的轮块，而不是把回答当成
轮内的一个步骤。

## 「节点对话完全没变化」的根因

不是没重新构建：主检出 `dist/web/assets/index-BTGxgBFp.js`（941210 字节，17:00 构建）与用
733d1b48 重新构建出来的文件逐字节相同（sha256 都是
`347437efbcde56437492fb4ae2612ce8d2c2c703511ccd3b0fa7b8f61609f366`），也就是说那套代码
确实已经在跑的 bundle 里。
真正的原因是 733d1b48 的实现只到了一条分支：

- 它把 `open: true` 只给了**未回答**的那条分支（`activityRows(key, ordered, true)`）；
- 已经结束的轮次走另一条分支，工具组由 `CollapsedTurn` 的 `defaultOpen` 打开——733d1b48
  没碰它，所以已结束的节点对话和以前一模一样；
- 而人在节点对话里看到的多半是已结束的那一轮，于是「完全没变化」。

修法不是再补一个标志位，而是删掉 `open` 这个逐行决定：轮块与工具组各自的默认值来自
同一处 `transcriptFoldPolicy`，两条分支、两个组件都读它。截图为证：`green-node.png`
里节点对话的已结束轮与进行中轮的工具组都是收起的一行，轮块是展开的。

## 所测 bundle 与两个会话各引用哪个

- 本节点（line1 工作树）测的是 `dist/web/assets/index-BA0r_4o9.js`，`node --run build:web`
  产出，构建时间 2026-11-04T09:36:37Z（本地 17:36），941123 字节。
- 改动前的基线测的是 `index-BTGxgBFp.js`，941210 字节，2026-11-04T09:12:12Z（本地 17:12）。
  它由 `git archive HEAD`（733d1b48）单独构建到 `/tmp/head-web` 后测量，与本工作树的
  构建互不覆盖。
- 主会话与节点会话引用的是**同一个 bundle**：控制台没有按窗口分包，守护进程用
  `--web-dir` 提供 `index.html`，`index.html` 指向唯一那个 `index-*.js`。差别只在各自的
  守护进程指向哪个 `dist/web`——主会话跑的是主检出 `/Users/macmini/workspace/13-Graph/dist/web`
  （`index-BTGxgBFp.js`，即 733d1b48），本节点跑的是本工作树的 `dist/web`
  （`index-BA0r_4o9.js`）。已经打开的标签页会继续跑它加载时的那份 bundle，所以核对
  bundle 文件名和构建时间是判断「改动有没有生效」的第一步。

## 浏览器

本机沙箱里起不来浏览器（chromium `Received signal 11 SEGV_ACCERR`，firefox
`sandbox_extension_issue_file_to_process failed`），所以浏览器由宿主的桌面工具启动一次并暴露
DevTools 端点，脚本通过 CDP 驱动它——真实 Chromium（`152.0.7977.78`），真实守护进程，
真实 `dist/web`：

```sh
# 1) 启动浏览器（宿主侧，一次即可）
desktop launch Electron --arg=<an Electron app dir> --cdp 9333
# 2) 测量三处窗口
GRAPH_FOLD_CDP=http://127.0.0.1:9333 node scripts/measure-fold-policy.mjs --label green
```

在能自己起浏览器的机器上，一条命令即可（显式 executablePath，不接受默认那份会 SEGV 的）：

```sh
node scripts/measure-fold-policy.mjs --executable /path/to/chromium --label green
```

脚本实测并断言：首屏每个 `[data-testid="tool-activity-group"]` 的 `data-open` 为 `false`
且 `.tool-group-content` 高度为 0；每个 `.collapsed-turn` 的 `data-open` 为 `true`；点一次
第一个工具组后 `data-open` 为 `true` 且高度 > 0，再点一次回到 `false` / 0px；不满足时
非零退出（`red.txt` 里是 `exit=1`，`green.txt` 里是 `exit=0`）。

## 测量脚本自己踩过的三个坑（已处理）

1. 转录里的历史行带 `content-visibility: auto`，屏幕外的行不会被布局，直接读高度会拿到 0px
   ——那是假绿。脚本先用 `scrollIntoViewIfNeeded()` 把每一行滚进视口，并断言该行自身
   高度 > 0，再读内容高度。
2. 每个标签页都是 `Activity mode="hidden"` 保留 DOM，同一个 `data-testid` 会在隐藏的
   标签页里出现第二份。脚本只用 `:visible` 的那份。
3. 折叠是 CSS 过渡，属性先翻、高度后到。脚本按「读到达标值」轮询，而不是读完就断言。

## 需要别人接手的两处旧断言（不属本节点文件清单）

方向反了以后，两条既有用例断言的是旧方向，合并前必须退休或按新方向重写，否则门禁会因它们变红：

- `tests/e2e/chat-open-policy.test.ts:77`（733d1b48 新增）断言每个
  `[data-testid="tool-activity-group"]` 的 `data-open` 为 `true`、`.tool-group-content`
  高度 > 0；`:70` 断言轮块打开（这条仍然成立）。
- `tests/m8/app-shell-ux.part-02.test.ts:101`（2a507e9a 新增）断言打开着的轮块里那个工具组
  `data-open` 为 `true` 且高度 > 0；`:96` 的轮块断言仍然成立。

本目录的测量覆盖了它们想守的同一件事（首屏收起、点开有高度、轮块展开），断言级别更高：
三处窗口 + 进行中的一轮。
