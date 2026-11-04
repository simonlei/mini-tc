# 修复：`preloadOtherTabs` 预热的 `tabCache` 从不淘汰，内存无上限增长

> 来源：`TODO.md` 第 44 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 14 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`preloadOtherTabs` 预热的 `tabCache` 从不淘汰，内存无上限增长** —  ✅ 2026-10-19 复核：全量清点 tabCache —— 写入 2 处无界（`1096` 虚拟 tab / `1111`）、删除 4 处均定点非淘汰（`525` 切到该 tab / `617` closeTab / `1134` 加载失败 / `1246` refresh）、`preloaded` 闩在 `1117-1120` 全文只写 true 无复位路径，LRU/上限零命中。补：`1096` 让虚拟 tab 的 `search.hits` 数组也进了缓存，把快照生命周期延长到 tab 关闭。`FilePanel.vue:1076-1086` + `1045`。`preloaded` 一旦为 true 永不再跑，但已被预热的 tab 的完整 `entries` 数组会一直留在 `tabCache` 里，只有 `closeTab`（`578`）会删。10 个 tab × 每目录 5 万条 = 数十 MB 常驻，而且这些快照永不过期（切回去还会被 `1166/486` 主动丢弃重来）—— 占了内存又不完全可信。修法：加 LRU 上限（3 个 tab 或总条目数上限）。
