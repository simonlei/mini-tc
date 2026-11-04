# 修复：`SearchDialog` 的 `hits` 无上限、深度响应式、`iconOf` 每行每帧做 5 次数组扫描

> 来源：`TODO.md` 第 58 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 28 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`SearchDialog` 的 `hits` 无上限、深度响应式、`iconOf` 每行每帧做 5 次数组扫描** —  ✅ 2026-10-19 复核：三项全成立（现址 `186` `ref([])`、`319-324` 无长度判断、`510-518` 的 `EXT_ICON` 是对象字面量 + `520-527` 的 `iconOf` 每帧 `Object.keys()` + 线性 `includes`）。`322` 行只有 id 过滤、无任何上限，与 FilePanel 的 `1325` 不对称属实；「已达上限」提示只在 `doneInfo?.truncated`（`71`）下出现，而后端不超发时前端已无界增长。全文 `shallowRef`/`triggerRef` 零命中。修正：原文说「5 次 includes」略有偏差 —— 实测最坏 6 组、平均命中约 3 次，但「每帧每行一次 `Object.keys` 分配 + 数组扫描」的定性成立。`SearchDialog.vue:318-323/527-534`。① 与 `FilePanel` 的同名监听器不一致（后者有 `MAX_SEARCH_RESULTS`），后端多发时无界增长而「已达上限」提示只在 `doneInfo.truncated` 时出现；② `hits` 是深度 ref，5000 个 Proxy，每行每帧穿 7 层 + `iconOf` 做 5 次 `includes`（约 50 次字符串比较）+ 一次 `Object.keys` 分配，快速滚动掉帧。修法：`shallowRef` + `triggerRef`；`EXT_ICON` 拍平成 `Map`。
