# 修复：大列表热路径上的重复分配，每帧都在付

> 来源：`TODO.md` 第 59 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 29 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：大列表热路径上的重复分配，每帧都在付** —  ✅ 2026-10-19 复核：四项**全部成立**（现址）。① `getFileIcon:1065-1118` 的 `const icons = {...}` 在函数体内每次调用重建 —— 注：实为 **50 键**（原文写 40），模板 `:124` 每行每次渲染调一次；② `formatDate:1032-1038` 每次 `toLocale*` 内部构造 formatter 且 options 对象每次新建；`src/format.js` 全文 68 行、**唯一导出是 `formatBytes`**，与日期无关 → 原文「format.js 只收敛了 formatBytes」的提示成立；③ 排序比较器 `347-355` 每次比较新建 `localeCompare` 的 options 对象，精确说是 2 个字符串 + 1~2 个 options 对象（原文写「4 个字符串 + 一个」，方向对、计数有出入）；④ `scrollToRow:496-503` 仍是 `querySelectorAll(".file-row")` 取行，经 `moveSelection:521`/`extendSelection:578`/`movePage:607`/`extendPage:629` 各分支，5000 行时每次按键实例化 5000 节点。`FileList.vue` 四处。① `getFileIcon`（`1061-1122`）每行每次渲染新建一个 **40 键对象字面量** → 提到模块作用域 `Object.freeze`。② `formatDate`（`1028-1034`）每行每次渲染构造两次 `Intl.DateTimeFormat` → 模块级 `DATE_FMT`/`TIME_FMT`。③ 排序比较器（`306-312/345-353`）每次比较分配 4 个字符串 + 一个 localeCompare options 对象，5000 条约 24 万次正则替换 → 模块级 `Intl.Collator` + 排序前一次性 decorate。④ `moveSelection`/`extendSelection`/`movePage` 每次按键调 `querySelectorAll(".file-row")` 实例化 5000 个节点（`494-501`）→ 改用 `container.children[i]`。
