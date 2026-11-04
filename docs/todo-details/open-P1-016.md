# 修复：`switchTab` 不校验 id，`pendingSelectName` 跨 tab 残留

> 来源：`TODO.md` 第 46 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 16 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`switchTab` 不校验 id，`pendingSelectName` 跨 tab 残留** —  ✅ 2026-10-19 复核：现址 `643-645` 整个函数体一行，无 `tabs.value.find` 校验、无 `pendingSelectName` 清空；同文件 `toggleTabLock:671-672`、`relockTabAtCurrentPath:687-688` 都先 find 再 return，`switchTab` 是唯一例外。两个后果的控制流逐段确认（路径 watcher `494-496` 的 `if (!newPath) return`、PathBar 的 `:path` 空串、状态栏仍显示旧条目数）。`FilePanel.vue:604`。传入已关闭/不存在的 id 时 `activeTab` 变 undefined → 路径 watcher 的 `if (!newPath) return` 直接返回 → **面板继续显示上一个 tab 的列表而 PathBar 与状态栏全空**，看起来像卡死。切 tab 时 `pendingSelectName` 也不清空，A tab 的待选名会落到 B tab 的同名行上。
