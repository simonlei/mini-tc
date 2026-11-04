# 收敛：`emit_progress` 仍 `let _ =` 丢弃 emit 错误 —— 正是 `emit_batch` 注释里点名修掉过的那个 bug

> 来源：`TODO.md` 第 70 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 6 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`emit_progress` 仍 `let _ =` 丢弃 emit 错误 —— 正是 `emit_batch` 注释里点名修掉过的那个 bug** — `lib.rs:1743` vs `710-717`。同一个「向 webview 发事件」的 API 在两处用了两种错误处理，搜索那条修了、复制这条没修。IPC 断了（窗口正在关闭 / webview 崩了）时复制仍在跑，用户看不到进度也没有日志，最后只看到「复制没反应」。修法：抽 `emit_or_log(app, event, payload)`，三处（`710`/`729`/`1743`）统一走它。
