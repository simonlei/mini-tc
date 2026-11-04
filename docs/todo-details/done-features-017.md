# 修复：切换窗口后文件选中状态丢失

> 来源：`TODO-done.md` 第 35 行 · 章节 已实现功能（想法暂存区） · 第 17 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：切换窗口后文件选中状态丢失** — 当应用窗口失去焦点（切换到其他程序）再切回来时，之前在文件列表中选中的文件变为未选中状态。这应该是个 bug。可能原因：① Tauri 窗口 `focus`/`blur` 事件触发了某些重置逻辑，导致 `selectedIndices`/`activeIndex` 被清空；② 窗口失焦时 Vue 响应式状态未持久化或被 watch 误重置；③ `FileList.vue` 的选中状态可能依赖于 `isFocused`/`activePanel` 等焦点相关 ref，窗口级 blur 导致这些 ref 被清除从而连带清除了选中态。需排查 `App.vue` 中窗口焦点监听、`FilePanel.vue` 的 `activePanel` 逻辑、`FileList.vue` 的 `selectedIndices`/`activeIndex`/`anchorIndex` 在窗口 blur/focus 时的变化链路，确保选中状态在窗口切换后保持不变。
