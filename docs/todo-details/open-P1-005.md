# 修复：`extractTargets` 用 `name` 建索引 Map 和判成员，搜索结果页解压顺序错乱

> 来源：`TODO.md` 第 14 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 5 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`extractTargets` 用 `name` 建索引 Map 和判成员，搜索结果页解压顺序错乱** —  ✅ 2026-10-19 复核：`FilePanel.vue:1673-1681` 逐字未变，三项指控全成立（`1675` 成员判定、`1677` 每右键为 5000 条建一次 Map、`1680` 排序）；对比 `isEntryCut:1662-1667` 在虚拟目录下有 path 回落，可见是遗漏而非设计。`FilePanel.vue:1526-1534`。5000 条结果里 20 个 `report.zip` 塌成同一 key，`order` 只留最后一个的序号，「依次解压 N 个」顺序完全乱；`inSelection` 会把另一个目录的同名项算进选中集。且 `entries.value.map` 每次右键都为 5000 条建一次 Map。修法：改用 `e.path`。
