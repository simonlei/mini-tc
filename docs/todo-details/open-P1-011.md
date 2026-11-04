# 修复：`window_state::flush` 持有 `state: Mutex` 跨越整段阻塞文件 IO → 拖动窗口掉帧

> 来源：`TODO.md` 第 33 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 11 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`window_state::flush` 持有 `state: Mutex` 跨越整段阻塞文件 IO → 拖动窗口掉帧** — 现址 `window_state.rs:223-231` + `107-134` + `observe:205-218`。
  - ✅ 2026-10-19 取证：锁跨越 `save_state` **成立且比原文更严重**。`227` 取 guard → `230` `save_state(&guard)`；`save_state` 内含 `create_dir_all`（`114`）+ `serde_json::to_string` + `atomic_file::write_atomic`（`129`），而后者内部还有 `create_dir_all` + `create_new_file` + `write_all` + `flush` + **`sync_all`**（同步刷盘）+ `rename` → **实际 FS 操作 ≥6 次而非原文的 3 次**，且 `sync_all` 是其中最慢的一个。竞争路径核实：`observe` 由 `WindowEvent::Moved/Resized`（`310-312`，模块注释自承「每秒几十次」）驱动、等的是同一把锁（`205`）；`flush` 的后台 flusher 每 400ms 持锁一次（`233-238`）。**跨线程竞争只发生在后台 flusher 与事件循环线程之间**（`flush` 另一调用点 `315` 在事件线程上跑关闭路径，是同线程重入不自锁）。
  - 🚨 **但 `226/224` check-then-act 竞态的后果不是原文暗示的「丢几何」**：逐一枚举交错后发现**不会丢更新**（若 observe 在 swap 后完整跑完，flush 随后读到新值，且 dirty 仍为 true 只是冗余写一次；`AtomicBool::store(true)` 不可能覆盖另一个 `true`）。**真实缺陷是「失败不重试」** —— `save_state` 的所有错误都被吞掉（`115`/`130` 处 `debug_log` 后 return），而 `dirty` 已在 `224` 被清成 false；若这次落盘因 IO 失败失败，磁盘上停留在旧值直到下一次 Moved/Resized，窗口若此后静止则状态永久是旧的。
  - ⚠️ **原文的修法只解决锁跨越，不能解决 dirty 时序**：需额外让 `save_state` 返回 `Result` 并据此恢复 dirty 标志。两件事应一起做，否则改了一半反而更容易误判已修完。
