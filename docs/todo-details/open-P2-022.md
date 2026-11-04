# 测试缺口：数据丢失路径零覆盖，风险最低的纯函数却覆盖最好

> 来源：`TODO.md` 第 89 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 22 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **测试缺口：数据丢失路径零覆盖，风险最低的纯函数却覆盖最好** — `lib.rs:3306-3495` / `window_state.rs:365-463`。已有：`glob_match`（7 例）、`has_pe_header`/`script_has_command`/`executable_kind`（`lib.rs`）、`resolve` 多显示器布局（9 例，`window_state`）。**完全没有**：`same_path`、`path_key`、`is_ancestor_or_same`、`plan_overwrite`、`collect_copy_tasks`、`move_items` 整条流程、`dir_size`、`expand_env_vars`、`is_valid_config_name`（安全闸门）。上面几条 P0 全落在 `plan_overwrite` + `move_items` 的**组合逻辑**里——单看每处都正确，只有组合起来才丢数据，恰是断言式测试最擅长的。修法（按性价比排序）：① `plan_overwrite` 表驱动测试（src 目录/文件 × dest 不存在/目录/文件 × overwrite 真/假 = 9 种组合）；② `move_items` 三个决策的集成测试（临时目录 + 断言源文件还在：skip 不删源、merge 尊重不覆盖、跨卷失败保留源）；③ `path_key` 的 `C:\x\a` vs `D:\x\a`、大小写、UNC；④ `is_valid_config_name`。
