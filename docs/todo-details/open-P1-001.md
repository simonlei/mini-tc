# 修复：`loadVideo()` 不 pause 旧视频，切文件时旧音频继续响到新资源起播；`videoSrc = ""` 是死代码

> 来源：`TODO.md` 第 10 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 1 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`loadVideo()` 不 pause 旧视频，切文件时旧音频继续响到新资源起播；`videoSrc = ""` 是死代码** — ⚠️ **2026-10-19 取证：三项代码缺陷确证仍在，但「旧音频继续响」这一症状本身不成立。** 现址 `VideoPreview.vue:699`（`videoSrc.value = ""`）与 `709` 在同一同步块（区间内无 `await`），Vue 渲染批处理合并 → `""` **确从未落到 DOM**；`<video>` 无 `:key`、无 `videoSrc` watcher，切文件是同一 DOM 元素换 src；全文件唯一 `pause()` 在 `onBeforeUnmount:754`，切文件路径上无。`resW/resH`（`198-199`）在 `loadVideo:705-707` 与 videoTime/duration/playing 一起重置的情况下**唯独漏了分辨率**，只在 `onLoadedMetadata:312-313` 被写。🚨 **但「旧音频继续响」无法从代码判定** —— 改 `src` 会触发浏览器 media element load algorithm 中止旧资源，那是浏览器行为不是本仓库代码的缺陷。把浏览器已代劳的事算作 bug 不准确。修法：清理搬进 DOM（`pause()` + `removeAttribute("src")` + `load()`）+ 重置 `resW/resH`。
