# 修复：`ContextMenu` 没有 Esc 处理，书签行右键菜单的 Esc 路径可证明不可达

> 来源：`TODO.md` 第 54 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 24 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`ContextMenu` 没有 Esc 处理，书签行右键菜单的 Esc 路径可证明不可达** —  ✅ 2026-10-19 复核：`ContextMenu.vue` 全文 116 行，**`keydown`/`Escape`/`esc` 零出现**。控制流确认：`BookmarkMenu.vue:278-283` 的 `onRowMenu` 先 `close()` 把 `open` 置 false（`close():184-185` 只重置 `editingId`、**不碰 `rowMenu`**）再置 `rowMenu.visible = true`；此后按 Esc 时 `onDocPointer` 在 `201` 的 `if (!open.value) return` 直接挡在门外 → **Esc 完全无反应、右键菜单滞留**。`ContextMenu.vue:5-29` + `BookmarkMenu.vue:278-297/200-217`。`onRowMenu` 先 `close()` 把 `open` 置 false，右键菜单打开后按 Esc **完全无反应**（`onDocPointer` 的 `if (!open.value) return` 直接挡在门外）。capture 做了，但少了「谁拥有 Esc」的仲裁。修法：early-return 改成 `if (!open.value && !rowMenu.value.visible) return;`，Esc 分支里先关 rowMenu。
