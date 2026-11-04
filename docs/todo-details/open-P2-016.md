# 收敛：`ContextMenu.menuStyle` 在 computed 里读非响应式的 `window.inner*`，高度估算忽略分隔条

> 来源：`TODO.md` 第 83 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 16 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`ContextMenu.menuStyle` 在 computed 里读非响应式的 `window.inner*`，高度估算忽略分隔条** — `ContextMenu.vue:46-60`。① `window.*` 不是响应式源，菜单打开后调整窗口宽度右边界钳制不生效、菜单可能被截断在视口外；② 估算把所有项一律按 28px 计，而 `.ctx-sep` 实际只有 9px，15+ 项含多条分隔条的菜单误差可达 100px 以上。
