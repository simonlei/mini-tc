# 收敛：10 处 config 的 load/save/sanitize 各自手写，应抽 store 工厂

> 来源：`TODO.md` 第 66 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 2 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：10 处 config 的 load/save/sanitize 各自手写，应抽 store 工厂** — `viewState.js:86/102/164`、`bookmarks.js:28/58/97`、`shortcuts.js:300`、`FilePanel.vue:299-368`、`VideoPreview.vue:146-169`、`App.vue:397/656/848/903`。同一套「load-once 去重 + trailing 防抖 + JSON.parse + sanitize + catch 回落 + fire-and-forget 写入」在 10 处独立实现，**已经产生实际漂移**：`FilePanel.saveState` 忘了加防抖（见 P0）、`VideoPreview.savePlayerConfig` 的 catch 是**完全空的**（用户改过的播放速度静默丢失）、`App.vue` 5 个配置的健壮性从「逐字段校验」到「零校验」不等。修法：抽 `src/configStore.js` 导出 `createConfigStore({key, sanitize, defaults, debounceMs})`。
