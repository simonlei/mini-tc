# 收敛：`optimizeDeps.include` 漏了同样动态 `import()` 的 `@crabnebula/tauri-plugin-drag`

> 来源：`TODO.md` 第 80 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 13 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`optimizeDeps.include` 漏了同样动态 `import()` 的 `@crabnebula/tauri-plugin-drag`** — `vite.config.mjs:9-26` + `api.js:237`。配置注释把 `optimizeDeps.include` 的存在意义说得很清楚（不让 Vite 在用户第一次预览时才发现新依赖、从而强制整页刷新），而这个包走的正是同一种按需 `import()` 却没进 include → **第一次拖出文件时会在鼠标按住拖拽的中途触发整页重载**，恰好是最不能被打断的时刻。
