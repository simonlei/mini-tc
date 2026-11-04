# 收敛：`ensureVisible()` 直接写 `scrollTop` 与 scrollTop ref 之间差一帧

> 来源：`TODO.md` 第 84 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 17 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`ensureVisible()` 直接写 `scrollTop` 与 scrollTop ref 之间差一帧** — `SearchDialog.vue:247-264`。程序化赋值触发的 `scroll` 事件是异步的，而 `start/visible/offsetY` 全依赖 `scrollTop.value` → 长按 ↓ 连续移动时新激活行可能有一帧不在渲染窗口里，表现为高亮「追不上」。修法：赋值后同步 `scrollTop.value = vp.scrollTop`。
