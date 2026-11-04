# 修复：`rerunSearch` 的 searchId 用 `Date.now() % 1000000`，且重跑时不取消旧扫描

> 来源：`TODO.md` 第 45 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 15 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`rerunSearch` 的 searchId 用 `Date.now() % 1000000`，且重跑时不取消旧扫描** —  ✅ 2026-10-19 复核：现址 `1276-1302`，`1281` 的 `Date.now() % 1000000` 逐字未变（注释宣称的意图并未实现）；`1288-1296` 确认无 `cancelSearch()`。补：`cancelSearch` 缺失被后端 `start_search` 的抢占（`lib.rs:572-581`）部分兜住，但只在 `startSearch` 成功返回后才发生，`await` 之前旧扫描仍在推 batch，id 撞上时 `1323` 的过滤失效。`FilePanel.vue:1195/1203`。取模约 16.7 分钟循环一次，同一毫秒内的两次重跑会拿到相同 id，旧扫描的尾随 `search-batch` 直接落进新一轮 hits；旧扫描也没取消，白烧 IO。修法：用模块级自增计数器（和 `nextTabId` 同样策略），重跑前 `cancelSearch()`。
