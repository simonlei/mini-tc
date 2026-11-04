# 修复：预览关闭/恢复/视频翻页全部按 `name` 定位行，虚拟目录下会选错同名项

> 来源：`TODO.md` 第 13 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 4 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：预览关闭/恢复/视频翻页全部按 `name` 定位行，虚拟目录下会选错同名项** — `App.vue:1596/1680/1013` + `FilePanel.vue:2014/2016`。搜索结果页里同名是常态，而搜索结果恰恰是最容易触发预览的场合。`restoreByNames`/`selectName` 命中第一个同名行 → 关闭预览后焦点跳到另一个目录的同名文件。修法：preview 状态与 `pendingSelectName` 一律携带绝对 `path`，补 `restoreByPaths` / `selectPath`。
