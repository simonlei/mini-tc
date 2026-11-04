# 修复：移动/拷贝 `root/a/a` 到 `root/` 时选「覆盖」导致 `root/a` 整目录丢失

> 来源：`TODO-done.md` 第 55 行 · 章节 已实现功能（想法暂存区） · 第 25 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：移动/拷贝 `root/a/a` 到 `root/` 时选「覆盖」导致 `root/a` 整目录丢失** — bug：源目录（如 `root/a/a`）移动/拷贝到 `root/` 时，目标路径 `root/a` 与已存在的父目录同名，前端/后端提示是否覆盖；用户选「是」后 **`root/a` 整个目录丢失**。根因：覆盖逻辑先删除目标 `root/a` 再执行 move/copy，但目标 `root/a` 同时是**源 `root/a/a` 的父目录**（源在目标内部），删目标即连源一起删掉，随后 move/copy 找不到源，数据永久丢失。用户澄清期望行为：覆盖但要**保留目录内容**，相当于把 `root/a/a` 的内容**合并进** `root/a`（目录 merge），而不是整体替换删除。
  - 实现（纯后端 `src-tauri/src/lib.rs`，commit cf33985 后二次修订）：保留 `path_key()` / `is_ancestor_or_same()`（盘符前缀防 `C:\x\a`/`D:\x\a` 误判同源）。改用**目录合并**语义——新增 `plan_overwrite(src,dest,overwrite)` 返回 `Leave`/`Replace`/`Skip`：
    - 目标不存在 → `Leave`（正常拷贝/移动）。
    - **同名目录 vs 同名目录** → 若 overwrite 则 `Leave`（合并：保留双方，递归把源内容并入目标；移动时源目录随后清空移除），否则 `Skip`。这是修复核心：不再 `remove_recursive(dest)`，彻底消除「删目标连源一起删」的丢数据路径。
    - 叶子冲突（文件 vs 文件 / 类型不符）→ overwrite 则 `Replace`（删目标后替换），否则 `Skip`。
    - `check_no_nested_target(src,dest)` 仅拒绝「目标位于源内部」（`root/a` → `root/a/b`），源在目标内部（用户场景）放行交给合并。
  - 接入点：`copy_all` 顶层循环与任务循环（按 `plan_overwrite` 动作处理）、`move_items` 主循环。`move_items` 新增 `merge_move` 队列：当目标为已存在目录时无法 `rename` 到非空目录，改为 `copy_all(..., overwrite=true)` 合并再把空源目录删掉；`cross_volume` 跨卷回退、以及合并移动均保留「复制阶段有 error 则保留源、不删除」的防丢数据原则。前端不动（错误经 `res.errors` → toast）。`cargo check` + `cargo fmt --check` 均 exit 0，待用户双击 `dev.bat` 实测（重点：把 `root/a/a` 拷/移到 `root/` 选覆盖 → `root/a/a` 内容并入 `root/a`、`root/a/a` 被移除、`root/a` 其余内容完好；把 `root/a` 移到 `root/a/b` 仍被拒绝）。
