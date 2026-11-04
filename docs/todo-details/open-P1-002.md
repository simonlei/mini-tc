# 修复：五个对话框既不拦全局快捷键，也不还焦点

> 来源：`TODO.md` 第 11 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 2 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：五个对话框既不拦全局快捷键，也不还焦点** — `App.vue:2095-2113`（三道闸门）+ `318/357/443/652/…`（入口）。全局 keydown 开头只有 `if (searchVisible) return`、`if (batchRenameVisible) return` 与 `if (confirmDialog.value.visible) return` 三道闸门，`settingsVisible` / `generalSettingsVisible` / `shortcutsVisible` / `aboutVisible` / `updateDialog.visible` **全都没有**。设置对话框打开时按 F5 会复制选区到对面栏、Ctrl+T 新建标签、Ctrl+H 切隐藏文件、Alt+← 导航目录 —— 全部在遮罩后面执行。四个入口也都没记 `document.activeElement`，Esc 关闭后焦点停在 `<body>`，方向键/Enter 全失灵。更糟的是 `confirmDialog` 弹出时按 Ctrl+V 会再进一次 `doPaste` → 第二次 `showConfirm` 覆写 `confirmResolve` → **第一次的 Promise 永不 resolve，那次粘贴静默丢失**（`confirmDialog` 这道闸门已加，但 `showConfirm` 侧仍无「已有未决 confirm」保护）。修法：① 在三道闸门前加统一模态闸门（把这几个 ref 收进 `modalOpen` computed）；② 按 `searchReturnFocus` 的现成模式给四个入口补 `activeElement` 记录 + `nextTick` 还原；③ `showConfirm` 加「已有未决 confirm 时先 reject/排队」保护。⚠️ 修法**不是**加通用模态拦截：`SettingsDialog`/`GeneralSettingsDialog` 无自己的 Esc 处理，会破坏关闭。📌 行号已随 2026-10-19 的 `onGlobalKeydown` 抽取漂移，动手前重新定位。
