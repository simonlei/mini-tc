# 修复：覆盖不是原子的 —— 目标在「计划阶段」就被删，随后直接 `File::create` 原地写入

> 来源：`TODO-done.md` 第 169 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 4 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：覆盖不是原子的 —— 目标在「计划阶段」就被删，随后直接 `File::create` 原地写入** — `lib.rs:1868` / `1904` / `1772`。`plan_overwrite` 返回 `Replace` 时立刻 `remove_recursive(&dest_item)`，而此时 `collect_copy_tasks`（`1878`）刚跑完、**一个字节都还没复制**；随后 `copy_file_with_progress` 用 `File::create(dest)` 直接截断目标写入。任何一个后续步骤失败（磁盘满、目标被占用、源只读）用户就同时失去源和目标，且中途失败留下半截文件。同仓库 `window_state.rs:122-133` 已经正确实现了 tmp+rename，模式是现成的，只是复制路径没复用。顺带 `plan_overwrite` 在 `1855` 和 `1892` 被调两次，每次内部 3 次 stat → 每项多 3 次无用 syscall。修法：复制到 `dest.tmp-xxx`，成功后 `rename` 原子替换，删掉两处 `remove_recursive`。
  - ✅ **已实现（2026-10-12）**。共三处提前删除，全部改掉（第三处是本轮新发现的，原描述只提到两处）。
    - **`copy_file_with_progress` 改为 tmp + rename 原子替换**。tmp 建在**目标的同级目录**（不能放 `%TEMP%` —— 跨卷会把最后一步变成非原子的 copy+delete）。`create_new` 独占认领，撞名就换后缀，绝不复用已有文件（可能是上次崩溃的残留）。失败路径三处都清理 tmp；写入后 `sync_all()` 再 rename（否则断电留下「已改名但为空」的文件）。**rename 覆盖已存在的文件在 Windows 上是原子的**（std 内部 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`，**本机实测**，顺带推翻了 `window_state.rs:128` 那句「Windows 上 rename 不能覆盖已存在的目标」的注释 —— 那个 `remove_file` 是多余的，留着无害但可以删）。
    - **两处 `remove_recursive` 改为条件触发**。新增 `dest_is_nonempty_dir()`：**只有目标是「非空目录」时才需要预先清除**（`rename` 无法替换非空目录，`create_dir_all` 也无法覆盖文件）；**普通文件目标绝不预删** —— 正是「提前删文件」这个动作本身造成了失败后两边皆空。空目录也不需要（实测 rename 可覆盖空目录）。
    - 🚨 **第三处新发现**：`move_items`（`lib.rs:2853`）的 Replace 分支同样「先删目标再 rename 源」，rename 失败（跨卷/权限/目标被占用）则两边都没了，而这里删除是**必需**的（`fs::rename` 不覆盖已存在文件）。改用 **park-and-commit**：先把源 rename 成同级临时名（`park_source`），目标空出来后再 rename 回去；任何一步失败都**把源改名回原位**并报错。提交失败时**如实报出文件仍在哪个临时名**下，绝不删除。
    - 🚨 **`park_source` 的第一版是错的，被测试当场抓住**：我假设「rename 到已存在名字会报 `AlreadyExists`」，于是靠报错来避让。实测本机 `fs::rename` 在 Windows 上**无条件覆盖已存在目标**（连目录 rename 到已存在文件都成功）→ 循环第一轮就把上次崩溃残留的临时文件**静默吃掉**了。改为**先用 `symlink_metadata` 主动查存在性**，不依赖 rename 报错。**又一次印证：Windows 文件系统 API 语义不能靠推理。**
    - **测试**：新增 `mod atomic_replace_tests` 共 9 例（`cargo test --lib` 全库 45 passed / 0 failed）。覆盖 tmp 与目标同级、撞名不复用、**「决定 Replace 本身不得删除任何东西」**、非空目录仍需清除、普通文件目标不得预删、完整往返不留残留、park 可逆、park 不吃占用名、失败后源原样恢复。**变异测试**：把 `dest_is_nonempty_dir` 改成「存在即返回 true」（=退回提前删除）→ 2 例失败；把 `park_source` 退回依赖 rename 报错 → 1 例失败。
    - `cargo check` / `cargo fmt --check` 均 exit 0。**待用户双击 `dev.bat` 实测**（复制覆盖同名文件，确认目标内容正确替换且无残留 `.minitc-*.tmp`；跨目录移动覆盖同名文件，确认源与目标都正确；用一个大文件覆盖，途中观察进度条与最终一致性）。
