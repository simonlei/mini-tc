# 修复：`search-batch` 用 `push(...hits)` 展开入参 + 上限判断在 push 之前

> 来源：`TODO.md` 第 19 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 7 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`search-batch` 用 `push(...hits)` 展开入参 + 上限判断在 push 之前** —  ✅ 2026-10-19 复核：现址 `1320-1328`，检查（`1325`）在展开 push（`1326`）之前的顺序逐字未变；`MAX_SEARCH_RESULTS=5000` 在 `1274`，提示文案「结果已达上限（5000）」在 `1339`。`FilePanel.vue:1239-1241`。① 上限检查在前，单个大批次能把 hits 顶到远超 5000，而 `truncated` 分支还提示「已达上限(5000)」—— 提示与实际不符；② `push(...arr)` 在 arr 十万级时抛 `RangeError: Maximum call stack size exceeded`，`pattern="*"` 的全盘搜索容易触发。修法：`slice(0, room)` 后逐个 push。
