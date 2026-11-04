# 收敛：`PathBar`/`FilePanel` 绕过 `paths.js` 直接拼绝对路径，其中两处硬编码 `\`

> 来源：`TODO.md` 第 77 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 10 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`PathBar`/`FilePanel` 绕过 `paths.js` 直接拼绝对路径，其中两处硬编码 `\`** — `App.vue:1249`、`FilePanel.vue:1463/1741/1122/1854`。`parentDirOf` 的契约是返回**斜杠归一化**的父目录（`paths.js:36` 里做了 `replace(/\\/g,"/")`），再拼 `"\\"` 得到 `"C:/a\\c.txt"` —— 斜杠混用的路径被写进 `entry.path`，随后参与 `entryPath`/`parentDirOf`/`normDir`/`isSearchPath` 的一整套比较。`1463`/`1741` 还是逐字复制粘贴。修法：`paths.js` 导出 `joinName(dir, name)`，两处改调。
