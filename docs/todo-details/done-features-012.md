# 右键菜单调用 7-Zip 等外部压缩工具解压

> 来源：`TODO-done.md` 第 26 行 · 章节 已实现功能（想法暂存区） · 第 12 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **右键菜单调用 7-Zip 等外部压缩工具解压** — 在文件列表的右键上下文菜单中，针对压缩包（zip/rar/7z 等）增加「用 7-Zip 解压」「用其他压缩工具解压」入口：自动探测系统已安装的 7-Zip（`C:\Program Files\7-Zip\7z.exe` 或 PATH 中的 `7z`）或其他压缩软件，将选中压缩包路径作为命令行参数（如 `7z x "<path>" -o"<target>"` 解压到当前面板目录）调用外部程序完成解压。需处理：工具未安装时的提示、解压目标目录选择（当前面板目录 vs 新建同名文件夹）、跨平台探测差异（macOS/linux 用 `unzip`/`7z`），以及该右键菜单本身依赖的上下文菜单基础设施（见后续右键菜单条目）
  - 实现：新增通用 `ContextMenu.vue`（浮层 + 外部点击关闭 + 视口越界翻转）。`FileList.vue` 在行/空白处 `@contextmenu.prevent` 时 `emit('ctx-menu')`（带 entry + clientX/Y，并选中该行）。`FilePanel.vue` 挂载时 `get_archive_tools()` 探测已安装工具（Windows：7-Zip 标准路径 + PATH `7z`/`7za`、WinRAR；非 Windows：`7z`/`7za`/`unzip`），按 entry 类型构建菜单：目录/文件「打开」「复制路径」、压缩包按各工具生成「解压到当前文件夹」「解压到"<stem>"」（无工具时显示禁用项「未检测到 7-Zip 等压缩工具」）、空白处「刷新」。后端新增 `get_archive_tools` / `extract_archive`：`extract_archive(archive, target_dir, tool_exe, syntax, mode)` 按 `syntax`（`7z`/`unzip`/`winrar`）构建命令，`mode="to_folder"` 解压到以压缩包名为基准的新子目录；`7z` 用 `x "<archive>" -o"<target>" -y`（路径含空格靠单参数拼接规避）。解压成功后 toast + 刷新面板。前端改动未跑构建，待用户双击 `dev.bat` 实测：`cargo check` 已通过。
