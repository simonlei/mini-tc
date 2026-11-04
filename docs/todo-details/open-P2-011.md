# 收敛：`HandleNativeDrop` 手写 `destDir.replace(/\\/g,"/")` 绕过 `normDir`，盘符根目录下过滤器失效

> 来源：`TODO.md` 第 78 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 11 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`HandleNativeDrop` 手写 `destDir.replace(/\\/g,"/")` 绕过 `normDir`，盘符根目录下过滤器失效** — `App.vue:1434-1435`。`normDir` 已在同文件 `269` 导入并在 `1212` 正确使用（多一步去尾斜杠）。当目标栏是盘根 `C:\` 时内联版本得 `"C:/"`，而 `parentDirOf("C:/a.txt")` 返回 `"C:"` → 永远不相等，「源已在目标目录中」的过滤对盘根完全失效。同一个语义两份实现、已分叉。修法：直接 `const normDest = normDir(destDir)`。
