# 修复：永久删除里「是目录」判断在 `symlink_metadata` 下恒为 false → 指向目录的符号链接永远删不掉

> 来源：`TODO-done.md` 第 246 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 2 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：永久删除里「是目录」判断在 `symlink_metadata` 下恒为 false → 指向目录的符号链接永远删不掉** — 原 `lib.rs:1173-1182`。`symlink_metadata` 对任何符号链接返回 `S_IFLNK`，故 `file_type().is_dir()` **恒为 false**，那行是死代码。`C:\link → D:\somedir` 走 `remove_file`（`DeleteFileW`），而 Windows 要求目录链接用 `RemoveDirectory` → 失败被归类成 `other`，**连「提权重试」都不提示**。
  **已修（2026-10-13）**，实测比原描述多找到一个同源缺陷：
  - 🚨 **断链（目标已不存在）在更早一步就删不掉**：原代码用 `p.exists()` 判存在，而 `Path::exists()` **跟随**链接 → 目标没了的联接返回「路径不存在」，UI 里根本没法清理。陈旧联接恰恰是最需要清掉的那些。改用 `fs::symlink_metadata(p).is_err()` 判存在。
  - 🚨 **同一个文件里并存两套相反的链接语义**（原 TODO 已点名）：`remove_recursive` 用 `path.is_dir()`（**跟随**链接）→ 联接被当成目录交给 `remove_dir_all`。移动/复制路径上的删除（`copy_all` 清目标、`move_items` 删源，共 6 处调用）都走它。统一抽 `remove_link_or_tree(path)`，删「链接本身」还是删「树」由纯判据 `remove_call_for(is_link, link_points_at_dir, is_dir)` 决定，Windows 下 `link_points_at_dir` 用 `FileTypeExt::is_symlink_dir()`（reparse point 自身带目录标志，断链也还在）。`remove_recursive` 保留为薄委托，调用点一行没改。
  - **测试**（`remove_call_tests`，8 例）。**变异测试实测两个方向都能抓住**：① 把 `link_points_at_dir` 换成 `is_dir`（复现原 bug）→ `table_picks_the_right_removal_call` FAILED；② 把 `remove_recursive` 改回旧的 `path.is_dir()` 分支 → **修复前 61 个测试全绿、一个没红**（纯逻辑断言直调 `remove_call_for` 看不见调用点，唯一的端到端链接用例在本机 skip），因此补了两条**静态断言**（`include_str!("lib.rs")` 读源码正文）才把这条抓住 → `remove_recursive_delegates_instead_of_reimplementing` FAILED。
    - ⚠️ **静态断言自身踩过一次自引用坑**：判据用 `code.contains("file_type().is_dir()")`，而断言的**失败消息里就引着这句话** → 自己判自己失败。改成 `["file_type", "().is_", "dir()"].concat()` 在运行时拼 needle，源码里永远不含被禁的图案。**写「禁止某文本出现」的断言时，消息里的反例同样会被匹配到。**
    - ⚠️ 端到端链接用例在本机**实测是 skip 的**（输出 `skipping: this machine does not allow creating links`，与 `recursion_tests` 记录的一致），所以真正把关的是那张纯逻辑表 + 静态断言，**不是**端到端。**该用例要用户在能建 reparse point 的环境跑过才算数。**
  - `cargo check` / `cargo test --lib`（63 passed）/ `cargo fmt --check` 全绿。**待用户双击 `dev.bat` 实测**：Shift+Delete 删一个指向目录的联接（应删掉联接本身、目标内容完好）；删一个断链（应能删掉，而不是报「路径不存在」）。
