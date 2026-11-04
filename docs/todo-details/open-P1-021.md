# 修复：`addBookmark` 不校验上限，`sanitize` 在加载时截断 → 重启后书签静默蒸发

> 来源：`TODO.md` 第 51 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 21 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`addBookmark` 不校验上限，`sanitize` 在加载时截断 → 重启后书签静默蒸发** —  ✅ 2026-10-19 复核：行号全对（`MAX_BOOKMARKS=200` 在 `bookmarks.js:18-21`、`sanitize` 截断 `break` 在 `76`、`addBookmark` 在 `120-134`）。`addBookmark` 只返回 `empty`/`exists` 两个 reason、**无 `full`**、`bookmarks.value` 无条件追加；「静默蒸发且变永久」确认 —— `sanitize` 的截断结果成为内存态（`86`），此后任意 mutation 的 `scheduleSave()`（`97-105`）都会把截断结果写回磁盘。`bookmarks.js:120` vs `76`。`MAX_BOOKMARKS = 200` 只在**读盘路径**生效（`76` 处 `break`），写入路径无门禁。用户加到第 201 个，内存和磁盘都是 201 条、UI 正常显示，下次启动 `sanitize` 在第 201 条处 break → **最后 50 条无声蒸发**，且截断结果会被下次任意 mutation 写回磁盘变成永久的。修法：`addBookmark` 返回 `{ok:false, reason:"full"}` 并弹提示。
