# JSON 格式文件预览与美化

> 来源：`TODO-done.md` 第 28 行 · 章节 已实现功能（想法暂存区） · 第 13 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **JSON 格式文件预览与美化** — 在文件预览（Ctrl+Q 对面面板）中支持 `.json` 文件：读取后用 `JSON.parse` 解析，再以 2 空格缩进 `JSON.stringify(obj, null, 2)` 美化输出。可在 `PREVIEWABLE_EXTENSIONS` 增加 `json`，并在 `read_file_preview` / 预览组件里按 JSON 处理：解析失败则提示「JSON 格式错误」并展示原始文本；与现有 text 预览复用同一面板与滚动。需处理：大文件上限（参考 `MAX_TEXT_SIZE`）、嵌套层级高亮可选、以及 `unsupported` 占位逻辑对 `.json` 的豁免（应走美化预览而非占位提示）。
  - 实现：后端 `read_file_preview` 的 `TEXT_EXTENSIONS` 加入 `JSON`，使 `.json` 像 txt/md 一样以原始文本读出（受 `MAX_TEXT_SIZE`=2MB 上限约束），解析/美化交给前端；前端 `App.vue` 的 `PREVIEWABLE_EXTENSIONS` 增加 `json`（豁免 `unsupported` 占位）；`FilePreview.vue` 拿到文本后若扩展名为 `json`，用 `JSON.parse` + `JSON.stringify(obj, null, 2)` 美化，解析失败则非阻塞提示「JSON 格式错误，以下为原始文本」并回退展示原始文本，类型徽标显示 `JSON`、图标 `🔧`。仅 `cargo check` 验证后端语法通过（前端改动未跑构建，待用户双击 `dev.bat` 实测）。
