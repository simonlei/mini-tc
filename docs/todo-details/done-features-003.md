# 路径栏支持 Windows 占位符与 ~ 家目录

> 来源：`TODO-done.md` 第 12 行 · 章节 已实现功能（想法暂存区） · 第 3 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **路径栏支持 Windows 占位符与 ~ 家目录** — 在 PathBar 的可编辑路径输入中支持展开：`%LOCALAPPDATA%\Netease` 等 `%VAR%` 环境变量，以及 `~` 代表当前用户根目录（`C:\Users\<user>`）。需在 `onEnter` 提交 `navigate` 前先做展开（建议后端或前端统一解析），否则 `pathExists` 会判定为不存在而报红
