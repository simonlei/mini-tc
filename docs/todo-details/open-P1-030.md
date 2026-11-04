# 修复：`subtitle` 探测每次切换视频都重扫整个目录 + 逐文件 IPC，且加载了所有匹配项而非只加载命中的那条

> 来源：`TODO.md` 第 60 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 30 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`subtitle` 探测每次切换视频都重扫整个目录 + 逐文件 IPC，且加载了所有匹配项而非只加载命中的那条** —  ⚠️ 2026-10-19 复核：**部分成立**。仍成立：每次切视频重扫整个目录（`519-548`，无任何缓存 —— `VideoPreview.vue` 与 `subtitleGate.js` 中 `cache`/`Map(`/`memo` 零命中）、**加载了所有匹配项而非只加载命中的那条**（`526-529` 循环不按 `matched` 过滤，`matched` 只在 `542` 的提交阶段用于决定默认选中哪条）。已修：`528` 已是「有 path 就直接用、缺了才 joinPath」的写法，且 `subtitleGate.js:89-90` 把 `path` 透传下来、后端 `lib.rs:169` 也总是带绝对路径 → **`joinPath` 往返这一半已消失**。`VideoPreview.vue:525-545/655-670`。一个 5000 条目目录翻 10 个视频 = 10 次全量 `listDirectory` + N 次 `joinPath` 往返。修法：按目录缓存 `listDirectory` 结果；只对 `matched === true` 的文件 `loadSubtitleByPath`；`joinPath` 只在缺 `path` 时调。
