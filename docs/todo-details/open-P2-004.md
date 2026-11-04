# 收敛：`home_dir()` 有两套实现、两种失败模式；`save_config` 与 `save_state` 是同一段系统 API 却一份原子一份不原子

> 来源：`TODO.md` 第 68 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 4 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`home_dir()` 有两套实现、两种失败模式；`save_config` 与 `save_state` 是同一段系统 API 却一份原子一份不原子** — `lib.rs:192-207` vs `search_log.rs:19-25`。`search_log` 在 `USERPROFILE` 缺失时退化成 `"."` → 日志被写进**进程 CWD**（dev 模式下是 `src-tauri/`，正是 Tauri 监听的源码树，文件写入会触发 dev 重编译 —— 而 `open_file` 的注释费了很大劲避免这类事）。两处都直接读 `USERPROFILE` 而绕过 `SHGetKnownFolderPath`，域配置文件变更后会写到错误位置。修法：抽 `config_dir()` 统一。
