# 修复：`PathBar.onEnter` 的两次 IPC 全无 catch，失败时静默无反应 + unhandled rejection

> 来源：`TODO.md` 第 55 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 25 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`PathBar.onEnter` 的两次 IPC 全无 catch，失败时静默无反应 + unhandled rejection** —  ✅ 2026-10-19 复核：行号漂移至 `376-399`（原 394-409）。`onEnter` 两个 `.then()` 均无 `.catch()` → reject 变 unhandled rejection、`invalid` 不置位、输入框停在编辑态、无任何提示。`copyPath:408-419` 的 catch 依赖 `inputRef.value`，而该 input 只在编辑态渲染（`107-119` 的 `v-else` 与面包屑 `v-if` 互斥）→ 非编辑态下恒 null → **catch 是空操作**。补：`PathBar.vue` 内 `showToast` 零出现；虽声明了 `notify` emit（`167`）且 `FilePanel.vue:29` 已接上，但**从未 emit 它**。`PathBar.vue:394-409`。IPC 失败时输入框停在编辑态、不显示 invalid 红框、无任何提示，产生 unhandled rejection。`copyPath`（`419-430`）的兜底 `if (inputRef.value)` 在非编辑态下恒为 null → **catch 分支实际是空操作**。对比同项目 `FilePanel.vue:1480` 的 `catch (e) => showToast(...)`，处理明显不一致。
