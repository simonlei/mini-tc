# 修复：`closeTab` 的 `cancelSearch()` 是全局取消，会误杀另一面板正在跑的扫描

> 来源：`TODO.md` 第 15 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 6 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`closeTab` 的 `cancelSearch()` 是全局取消，会误杀另一面板正在跑的扫描** — `FilePanel.vue:588-593`（现址 `610-641`，cancel 在 `631`）+ `api.js:165-167` + `lib.rs:620-628`。
  - 🚨 2026-10-19 取证：成立，**且比原文严重一层** —— 原文说「取消的是后端唯一那条扫描」，实测后端**根本不支持并发扫描**：`SEARCH_CANCEL`（`lib.rs:543-547`）是 `Mutex<Option<Arc<AtomicBool>>>` 的**单一槽位**，`cancel_search`（`620-628`）不接受任何 id 参数。
  - 🚨 **更关键的是 `start_search` 本身就抢占式 cancel**（`lib.rs:572-581`）：每次新搜索先 `guard.take()` 出上一次未完成的 flag 并 `store(true)` 置取消。所以**右栏发起新搜索会直接顶掉左栏正在跑的扫描**，根本等不到 `closeTab`；`FilePanel.vue:1323` 的 `tabs.value.find(...)` 只能过滤前端归属，**过滤不了后端抢占** → 左栏 `searchLabel` 的 `live` 分支（`:202`）会永远停在「搜索中…」。`closeTab:631` 的 `cancelSearch()` 零参数、`stillShown` 只在 `tabs.value`（本面板）内查找，完全看不到另一侧面板。
  - 修法比原文大：不止前端，`cancel_search(id)` + 后端 `SEARCH_CANCEL` 改为 `HashMap<u64, Arc<AtomicBool>>`，**且要一并决定 `start_search` 是否还允许抢占别人的扫描**（不抢占则需在无空槽时拒绝或排队）。
