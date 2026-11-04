# 支持 log 文件的查看

> 来源：`TODO-done.md` 第 22 行 · 章节 已实现功能（想法暂存区） · 第 10 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **支持 log 文件的查看** — 当前 `.log` 文件既不在前端 `PREVIEWABLE_EXTENSIONS`（`src/App.vue` line 344，含 txt/md/json/图片），也不在后端 `TEXT_EXTENSIONS`（`src-tauri/src/lib.rs` line 299，仅 `["TXT","MD","JSON"]`），所以选中 `.log` 会显示"暂不支持预览该格式"占位。目标：让 `.log` 像文本一样可预览。需改动：① 前端 `PREVIEWABLE_EXTENSIONS` 增加 `"log"`；② 后端 `TEXT_EXTENSIONS` 增加 `"LOG"`，使其经 `read_file_preview` 走 `text` 分支（受 `MAX_TEXT_SIZE`=2MB 上限约束）；③ 可选：`FilePreview.vue` 给 log 一个独立类型徽标/图标（现为通用 "TEXT"）；④ 注意常见 log 文件往往很大（>2MB），当前超限会报 "File too large to preview"，可考虑对 log 放宽上限或改为只读尾部 N 行（tail）而非全量，避免大日志卡顿/报错。实现参考第 16 条 JSON 预览（同样的 `PREVIEWABLE_EXTENSIONS` + `TEXT_EXTENSIONS` 双端放行模式）。
  - 实现：后端 `TEXT_EXTENSIONS` 加 `"LOG"`；超大 log（>2MB）改为 tail 末尾 512KB（`LOG_TAIL_LIMIT`，`seek`+`read_to_end`+丢弃首行残缺+顶部 banner 提示），txt/md/json 仍保持 2MB 上限报错；需 `use std::io::Seek`。前端 `App.vue` `PREVIEWABLE_EXTENSIONS` 加 `"log"`（`togglePreview`+两处 `watch` 自动豁免占位）。`FilePreview.vue`：log 走文本区、`ext==="log"` 时 `previewType="log"`、独立徽标 `LOG`(图标 📜)、footer 行数统计覆盖 log。`cargo check` 通过（exit 0），前端未跑构建，待用户双击 `dev.bat` 实测。
