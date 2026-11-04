# 修复：`list_drives` 一次 panic 永久毒化驱动器缓存 → 此后每次调用都失败且不可恢复

> 来源：`TODO.md` 第 27 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 10 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`list_drives` 一次 panic 永久毒化驱动器缓存 → 此后每次调用都失败且不可恢复** — `lib.rs:250-253`。
  - ✅ 2026-10-19 取证：`250-253` 是 `.lock().map_err(|_| "drive cache poisoned".to_string())?`，而**同文件另有 7 处锁全部**用了 `unwrap_or_else(|e| e.into_inner())`（`575`/`610`/`624` 的 `SEARCH_CANCEL`、`1268`/`1282`/`1408`/`1478` 的 `TRASH_UNDO`、`3880`/`4125`/`5913`）→ 唯独这里没有，是全文件唯一的例外。缓存是 `OnceLock<Mutex<Option<(Instant, Vec<DriveInfo>)>>>`（`243-245`），一旦有 panic 穿过临界区，Mutex 永久 poisoned，此后 `list_drives` **每次**都返回 `Err("drive cache poisoned")`，且进程内**无任何恢复路径**（不重试、不重建 `OnceLock`）。用户表现是「驱动器列表永久为空」而非偶发失败。
  - **本条已从原条目拆出**（原条目把「poison」与「持锁跨探测」捆在一起，但两者的必要性与修法完全不同 —— 见下条）。修法：对齐 `575/610/624` 的写法，`unwrap_or_else(|e| e.into_inner())`。**零风险、不改变任何并发语义**，可独立做。- [ ] **决策项（不是 bug，是权衡）：`list_drives` 在全局锁内跑完整个 A–Z 探测** — `lib.rs:241-271`，`probe_drives()` 在 `250` 获取的 guard 存活区间内执行（实现 `275-291`：26 次 `Path::exists()` + 每应答卷一次 `GetDiskFreeSpaceExW`）。`228-233` 注释自承「未就绪卷可阻塞几百 ms」。
  - 🚨 **原文把它当疏漏是误判 —— `lib.rs:235-240` 的注释明确论证了持锁跨探测是有意选择**：「两块面板在同一 tick 内发起挂载请求，若用 check-then-probe-then-store，两者都会 miss 缓存各跑一遍全量 A–Z 探测」。`INTERNALS.md`「启动」一节也把这条写成了设计约束（「锁要持跨越探测本身」）。
  - **所以原文的修法（锁只保护 cache 读写 + double-checked 回写）不能直接照做** —— 它正好推翻上述权衡，代价是引入两次探测窗口。**动手前需先确认能否接受该代价**，或另找方案（如把探测移到后台线程 + 缓存就绪前返回上一次结果、或用 `try_lock` 让第二个请求直接复用正在进行的探测）。
  - 拆条理由：poison（上一条，零风险该修）与本条（有意的权衡、需决策）捆在一起会导致「照着修」时把有意设计当成 bug 改掉。
