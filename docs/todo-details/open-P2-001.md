# 收敛：`formatDate` 四份、`isArchiveName`/`getExt`/`leafName` 三份、`copyTextToClipboard` 三份、`isTypingTarget` 五份

> 来源：`TODO.md` 第 65 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 1 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`formatDate` 四份、`isArchiveName`/`getExt`/`leafName` 三份、`copyTextToClipboard` 三份、`isTypingTarget` 五份** — 分散在 `FileList.vue:1020/1028/1036/1062`、`FilePreview.vue:347`、`SearchDialog.vue:449/501`、`FilePanel.vue:125-155/286-293/911-914/1938-1961`、`App.vue:1126-1132/1249/1484-1493/1884/1936/2099/2128`、`bookmarks.js:43`、`TabBar.vue:49`、`renameRules.js:229-235`、`BookmarkMenu.vue:236`。✅ `formatBytes`（8 份）已收敛到 `src/format.js`，见 `TODO-done.md`；本条只剩 `formatDate`。已产生实际漂移：`formatDate` 在 SearchDialog 产 `2026-10-11 09:30`、在 FileList 产 `2026/10/11 09:30`；`VideoPreview` 的 `ext` computed 与 `getExt()` 对无扩展名文件行为**相反**（`"README".split(".").pop()` 得 `"readme"`，于是渲染一个 `<video>` 等一个永远不会来的 `error` 事件）。修法：抽 `src/ext.js`（`formatDate` 的第二处收敛走 `src/format.js`，测试见 `format-size-check.mjs`），`leafName`/`parentDirOf`/`normDir` 统一收敛到 `paths.js`。
