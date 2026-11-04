# 审计项（不修）：`renamingIndex` 不随列表变化重置，内联改名可能改到别的文件

> 来源：`TODO-done.md` 第 342 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 10 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **审计项（不修）：`renamingIndex` 不随列表变化重置，内联改名可能改到别的文件** — `FileList.vue:242` / `255-291`（现址）。
  - ⚠️⚠️ **2026-10-19 实测：TODO 原文的因果已过期，且原文给的修法照做会引入新 bug。本条应改写为「审计项」或直接归档。** 上一次取证（2026-10-16）留下的「两个 watcher 的 flush 顺序与谁覆盖谁尚未实测」现已实测完毕 —— 用 `@vue/compiler-sfc` 编译**未经修改的** `FileList.vue`、stub 掉 `api.js`、jsdom 挂载真实组件，走真实 DOM 点击 + F2：
    - **watcher 次序实测为 `["W-remap(pre)", "W-props-entries(post)", "W-snapshot(post)"]`** —— pre 的身份重映射**先**跑，post 的 `props.entries` watcher 后跑，且后者**根本不写 `renamingIndex`** → **不会覆盖**前者。原文猜测的顺序问题不存在。
    - **端到端场景正确**：`a.txt` 改名中 → 改按 Modified 降序（行序变 `["b.txt","c.txt","a.txt"]`），输入框仍在 `a.txt` 那一行；整体替换（`entries.value = res.entries`）与 `.filter()` 换新数组时新对象身份不在旧列表 → `renamingIndex` 归 `-1`，改不到别的文件。
    - 🚨 **原文的修法「watcher 里加 `renamingIndex.value = -1`」是有害的**：它会与现有身份重映射打架，把排序变更场景下**正在进行的合法改名误杀**。
    - **残留的真实缺口**（实测复现，但当前调用方不可达）：`sortedEntries:327-329` 对 `found` 排序**直接返回 `props.entries` 本身**（`displayedEntries:387-391` 无搜索词时再透传一层）→ computed 不失效；若该数组被**就地** `splice` 移位，pre watcher **完全不触发**，`renamingIndex` 停在旧下标，`commitRename` 会改到隔壁行。核查 `FilePanel.vue` 对显示行的全部变更（`:500/:1093/:1113/:1137/:1286/:1507/:1528` 整体替换、`:1326/:831/:893` push 追加不移位、`:993` splice 作用于 nav.entries 非显示行）—— **当前均未触发**，属潜在加固项非现行缺陷。
    - **建议改写为**：`commitRename`（`789-801`）按 entry 身份取行而非下标（它现在仍是 `displayedEntries.value[idx]`）+ `sortedEntries` 的 `found` 分支返回副本以断掉同引用。
