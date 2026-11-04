# 收敛：列宽拖拽的 window 监听器在组件卸载时不会移除（注释与实现相反）

> 来源：`TODO.md` 第 85 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 18 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：列宽拖拽的 window 监听器在组件卸载时不会移除（注释与实现相反）** — `FileList.vue:1396-1419` vs `1351-1357`。注释写着「no global listeners, no leak if the component unmounts mid-drag」，但 `pointermove/up/cancel` 是货真价实的 window 全局监听，`onBeforeUnmount` 没有调 `onResizeEnd()`。指针捕获确实随元素消亡，window 上的三个监听不会。
