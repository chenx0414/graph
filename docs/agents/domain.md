# Domain docs

工程技能探索代码前，该按什么顺序读本仓库的领域文档。

## 探索之前读这些

- 仓库根目录的 **`CONTEXT.md`**（术语表）；如果存在 **`CONTEXT-MAP.md`**，它指向每个上下文各自的 `CONTEXT.md`，只读与本次主题相关的那些。
- **`docs/adr/`**：读与你要动的区域相关的 ADR。多上下文仓库还要看 `src/<context>/docs/adr/`。

这些文件**不存在就直接继续**：不要报“缺少”，也不要一上来就建议创建。它们由 `/domain-modeling`
（经 `/grill-with-docs`、`/improve-codebase-architecture` 到达）在术语或决策真正定下来时**按需**建立。

## 本仓库布局：single-context

```
/
├── CONTEXT.md              ← 领域术语表（按需建立）
├── docs/adr/               ← 架构决策记录
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

（若哪天出现根级 `CONTEXT-MAP.md`，即为 multi-context：每个上下文一份 `CONTEXT.md`，
根 `docs/adr/` 放跨上下文决策，`src/<context>/docs/adr/` 放该上下文自己的决策。）

## 用术语表里的词

输出里出现领域概念时（issue 标题、重构提案、假设、测试名），用 `CONTEXT.md` 定义的词，
不要漂到你自造的近义词。需要的概念还不在表里，说明要么你在发明项目不用的语言（回头想），
要么真的缺一条（记下来交给 `/domain-modeling`）。

## ADR 冲突要挑明

输出与既有 ADR 冲突时，明说，不要偷偷覆盖：

> _与 ADR-0007 冲突，但值得重新讨论，因为……_
