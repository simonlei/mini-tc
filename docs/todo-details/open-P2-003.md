# 收敛：Mutex 中毒处理有四种写法，其中 window_state 的一种会静默永久关闭持久化

> 来源：`TODO.md` 第 67 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 3 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：Mutex 中毒处理有四种写法，其中 window_state 的一种会静默永久关闭持久化** — `window_state.rs:207/229` vs `lib.rs:545/594/249`。`window_state` 的两处 `else { return }` 没有任何日志：一旦某次回调在持锁期间 panic，`observe` 和 `flush` 会**永久静默失效** —— 窗口照常响应用户，但 `window-state.json` 再也不更新，且无从诊断（对比 `resolve` 路径上 94/101/115/126/131 处都有日志）。修法：抽 `lock_or_recover(m)` 统一走 `into_inner()` + `debug_log`。
