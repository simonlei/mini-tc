# 文件名排序支持「自然排序（数字优先按数值）」

> 来源：`TODO-done.md` 第 47 行 · 章节 已实现功能（想法暂存区） · 第 21 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **文件名排序支持「自然排序（数字优先按数值）」** — 当前按名称排序用 `FileList.vue:222` 的 `a.name.toLowerCase().localeCompare(b.name.toLowerCase())`，这是**纯字典序**（逐字符比较），导致 `1a.jpg / 10b.jpg / 2c.jpg` 排成 `1a, 10b, 2c`（因为字符 `'1'` `'1' '0'` < `'2'`，即 "10" 排在 "2" 前面）。目标：数字片段按**数值大小**排，上述三文件应排成 `1a, 2c, 10b`。用户意图是「优先识别文件名中排在前面的数字、并以数字大小排序」。需处理：① 最简方案——`localeCompare(a, b, undefined, { numeric: true, sensitivity: 'base' })`，浏览器原生即做数字感知比较（`1` < `2` < `10`），且需确认中文/大小写灵敏度；② 更可控方案——写「自然排序」比较器：把名称拆成 `[数字, 文本]` 交替片段，数字段 `parseInt` 后按数值比、文本段按字典序比（参考 Explorer / 多数文件管理器的行为），注意多段数字（`a1b2` vs `a10b3`）、前导零、以及无数字文件名退化为纯文本序；③ 与现有「目录优先于文件」逻辑（`col==="name"` 时 `a.is_dir` 优先）共存，不受自然排序影响；④ 仅作用于 `name` 列排序，`size`/`modified` 排序保持原样；⑤ 可选：排序函数提到 `FileList.vue` 顶部或抽成 `utils/sort.js` 便于复用与单测；⑥ `cargo check` 无影响（纯前端改动），改完前端未跑构建，待用户双击 `dev.bat` 实测。
  - 实现：`FileList.vue` 的 name 排序由纯字典序 `a.name.toLowerCase().localeCompare(...)` 改为 `a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })`：浏览器原生数字感知比较，数字串按数值排（`1a < 2c < 10b`），`base` 灵敏度替代原 `toLowerCase()` 做大小写/重音不敏感；与现有「目录优先」逻辑共存（仅作用于同类型间），`size`/`modified` 列不变。纯前端改动，`cargo check` 无影响，待用户双击 `dev.bat` 实测。
