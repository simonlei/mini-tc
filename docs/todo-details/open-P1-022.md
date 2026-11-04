# 修复：`loadShortcuts` 对非数组覆盖值静默解绑命令，且无长度上限、`bindingsOf` 每次按键重建数组

> 来源：`TODO.md` 第 52 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 22 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`loadShortcuts` 对非数组覆盖值静默解绑命令，且无长度上限、`bindingsOf` 每次按键重建数组** —  ✅ 2026-10-19 复核：行号漂移至 `305-320`/`285-291`/`348-354`。三项全成立：(a) `314` 的三元 else 分支就是 `[]`，而 `bindingsOf:288-289` 只在 `Array.isArray(ov)` 时返回 override、空数组是 truthy → 返回 `[]` → `matches:353` 恒 false，**不回落默认值**；(b) `loadShortcuts:314` 与 `setBindings:295-303` 都只有 `dedupe` 无 `slice`，全文件无 `MAX_BINDINGS`；(c) `bindingsOf` 无 memo。补：App.vue 中 `matches(` 有 **24 处**调用点全在同一全局 keydown 内串行，「一次按键约 20 次」确认。`shortcuts.js:307-311/280-286/343-349`。① `"edit.copy": "Ctrl+C"`（手改成字符串而非数组）→ `next[id] = []` → `matches` 恒 false → **Ctrl+C 被静默解绑**，用户看不出任何异常。② 无 `MAX` 上限（对比 bookmarks 有）。③ `matches()` 在全局 keydown 里一次按键被调约 20 次，`bindingsOf` 每次都 `map + normalizeCombo + dedupe`。修法：非数组改为跳过该 key 回落默认值；加 `MAX_BINDINGS_PER_COMMAND = 8`；`bindingsOf` 加按命令 id 的缓存。
