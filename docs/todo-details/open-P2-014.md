# 收敛：`SearchDialog.onListKeydown` 整块硬编码 key 且从不 `markHandled`

> 来源：`TODO.md` 第 81 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 14 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`SearchDialog.onListKeydown` 整块硬编码 key 且从不 `markHandled`** — `SearchDialog.vue:266-292`。7 个键全部硬编码、全部不认领，违反项目硬约束。目前靠 App 全局处理器的 `if (searchVisible.value) return` 兜底不炸，但这是隐式依赖：任何绕过该守卫的新命令都会和这里打架。修法：`shortcuts.js` 补一组 `searchDialog.*` 命令。
