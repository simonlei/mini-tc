# 修复：选中态是下标，排序/过滤一变就指向别的文件 → 删错、改名错

> 来源：`TODO-done.md` 第 187 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 6 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：选中态是下标，排序/过滤一变就指向别的文件 → 删错、改名错** — `FileList.vue:198-200` + `1444`。`selectedIndices/activeIndex/anchorIndex` 是 `displayedEntries` 的下标，但让下标失效的变更有三种：`props.sortColumn/sortDirection`、`searchQuery`、`props.entries`，**只有 `showHidden` 那一条补了按条目身份的重映射**。点一下 Modified 表头再按 Delete，删掉的是排序后同一下标的另一批文件；F2 改名的也是另一个文件；过滤框打字后 `activeIndex` 越界时 `onSearchKeydown` 的 Enter 打开错误文件。修法：把现有重映射逻辑提成 `remapSelection(prevList)`，同时挂到 `() => [props.sortColumn, props.sortDirection]` 与 `searchQuery`。
