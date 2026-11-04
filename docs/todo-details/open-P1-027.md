# 修复：`SearchDialog.onDone()` 在校验 searchId 之前就清掉了停止兜底定时器

> 来源：`TODO.md` 第 57 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 27 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`SearchDialog.onDone()` 在校验 searchId 之前就清掉了停止兜底定时器** — `SearchDialog.vue:325-337`。一次**过期**的 `search-done` 会清掉当前扫描的 1.5s 兜底；若当前扫描的 worker 随后真死了（panic / 事件丢失），对话框就**永久卡在「搜索中…」**，且「停止」按钮点了也没用 —— 恰好是这个定时器要防的场景。修法：`clearTimeout` 移到 id 判定之后。
