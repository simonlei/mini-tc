# 统一配置保存到 `~/.minitc`（取代 localStorage）

> 来源：`TODO-done.md` 第 30 行 · 章节 已实现功能（想法暂存区） · 第 14 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **统一配置保存到 `~/.minitc`（取代 localStorage）** — 当前散落在 `localStorage` 的配置应统一迁移到 `~/.minitc` 目录，与已有的 `video-config.json` 归并：① `FilePanel.vue` 的 `mini-tc-tabs-left` / `mini-tc-tabs-right`（打开的 tab 列表 + 激活 tab id）；② `App.vue` 的 `mini-tc-theme`（主题）。后端 `load_video_config`/`save_video_config` 已用 `home_dir().join(".minitc")` 落地，可新增通用命令（如 `load_app_config` / `save_app_config` 整份读写，或按子项 `load_config(name)` / `save_config(name, json)`）；前端把各 `localStorage.getItem/setItem` 改为对应 `invoke`。需处理：异步加载（`FilePanel.onMounted` 原同步读 localStorage 后 fallback 建首页 tab，须改为 await 配置后再决定 fallback）、首次启动无配置时的默认值、`video` 配置并入同一体系且保持兼容、以及 localStorage 旧数据的迁移/清理。
  - 实现：后端新增通用命令 `load_config(name)` / `save_config(name, config)`，统一落到 `~/.minitc/<name>.json`（带 `..`/分隔符路径穿越防护）；原专用 `load_video_config`/`save_video_config` 删除，`VideoPreview.vue` 改用通用命令读写 `video-config`（文件仍是 `~/.minitc/video-config.json`，兼容旧数据）。前端 `FilePanel.vue`（tabs-left/tabs-right）与 `App.vue`（theme）全部从 `localStorage` 迁移到通用命令；`onMounted` 改为 `await loadConfig` 后再决定 fallback 建首页 tab；旧 `localStorage` 数据在首次启动时迁移写入新存储并清理。仅 `cargo check` 验证后端语法通过（前端改动未跑构建，待用户双击 `dev.bat` 实测）。
