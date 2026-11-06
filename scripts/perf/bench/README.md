# 浏览器性能与回归门禁

依赖项目现有 Node、Playwright、Chromium，不需要 Python 或新增 npm 包。

> **2026-10-23：测量脚本 `measure.ts` 随 TypeScript 后端退休。** 它原来用 `openGraphServer()` 在本进程里开一整套 TypeScript 运行时，再从内部 API 建会话与图；TypeScript 后端删掉之后，这条内部 API 没有了，而 daemon 的公开面没有「程序化建图」的口子（建图是主 Agent 的 `propose_graph` 工具），所以脚本无法照搬。**基线比较（前后两个 web 构建的 A/B）与 `check.ts` 的像素门限都还在，上面的命令要等测量脚本按 Go daemon 重写之后才能再跑**。这一步记在退役计划里。

```sh
node --run build:web
# 参数必须是分别保留的前后构建；不是在两个不同时间各测一次。
node scripts/perf/bench/measure.ts /tmp/graph-flash-baseline-web dist/web scripts/perf/bench/final-fast4g.json
node scripts/perf/bench/check.ts scripts/perf/bench/final-fast4g.json
PERF_PROFILE=local node scripts/perf/bench/measure.ts /tmp/graph-flash-baseline-web dist/web scripts/perf/bench/final-local.json
node scripts/perf/bench/check.ts scripts/perf/bench/final-local.json
```

每组各 10 次，使用独立上下文冷缓存、A/B 交替、nearest-rank p50/p75/p95。全部 HTTP 请求受网络限速影响。持久会话和两个真实模块及边经正式运行时创建，不直接写数据库或伪造 graph 响应；测量期间不启动模型调用。

会话终点等待历史消息并实际填入文字；Graph 终点等待第二个节点、第一条边并点击节点。Graph 从会话经公开 hash 路由导航，含浏览器操作开销，不是纯 React 渲染时间。页面导航开始前不包含守护进程冷启动；不能据此报告完整 APP 冷启动速度。

输出带原始每次测量与 Resource Timing。对全部 JS/CSS/JSON 通过真实 HTTP 验证原始字节及 5 种 Accept-Encoding；比较首页与 Graph 的可见文本。两种宽度 PNG 留在系统临时目录，背景图片解码在截图前等待，排除在编辑器可用终点之外。`check.ts` 解码真实 PNG，像素差门限 0.5%（RGB 任一通道差 >16），并执行 `limits.json` 的 p75 上限。上限含少量本机噪声余量，不代表零毫秒波动；后续改动只收紧、不能为通过实验放宽。

这些命令需要有效的基线构建和稳定的专用时段，因此作为显式性能门禁，不自动加入全仓库并行测试。baseline/lazy-local 等文件是过程记录，最终前后结论只使用 final-*。

截图在临时目录被清理后无法重检，需重新跑完整配对；普通运行不修改 `acceptance-evidence/`。
