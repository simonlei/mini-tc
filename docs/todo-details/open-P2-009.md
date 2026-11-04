# 收敛：复制路径上 5 个 `setTimeout` 未在卸载时清理

> 来源：`TODO.md` 第 76 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 9 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：复制路径上 5 个 `setTimeout` 未在卸载时清理** — `App.vue:715/720/747/825/1485` + `FilePanel.vue:288/1443`。`onUnmounted` 里三个定时器一个都没清；`FilePanel` 的 `onBeforeUnmount`（`1261-1266`）只解了 search 监听，`toastTimer` 和 **2 秒延迟删除定时器**都留着 —— 卸载后仍会执行 `refresh()` 并 `emit`。修法：统一在卸载钩子里 `clearTimeout`。
