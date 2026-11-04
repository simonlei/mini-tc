# 与操作系统剪贴板打通

> 来源：`TODO-done.md` 第 18 行 · 章节 已实现功能（想法暂存区） · 第 8 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **与操作系统剪贴板打通** — 当前的 ctrl+c / ctrl+x / ctrl+v 已与系统剪贴板双向互通（原仅走内部内存剪贴板）。拷贝/剪切时写入操作系统剪贴板（Windows 的 CF_HDROP，使资源管理器及其他程序可识别这些文件；或从外部复制文件进来时也能识别）；粘贴时既能消费内部记录，也能消费来自系统剪贴板的文件列表。处理了跨平台差异、权限，以及外部→内部、内部→外部两种方向的读写。
  - 实现：后端新增 `set_clipboard_files` / `get_clipboard_files` 命令。Windows 用原生 Win32 API（user32/kernel32/shell32）写/读 `CF_HDROP`：复制/剪切写入文件列表 + Unicode 文本副本，剪切额外写 `Preferred DropEffect=DROPEFFECT_MOVE`；粘贴读 `CF_HDROP`，由 DropEffect 决定移动/复制（无标记则复制），无 CF_HDROP 时回退解析 Unicode 文本中的真实路径。非 Windows 后端降级为 no-op，前端用 `navigator.clipboard` 文本回退（仅把含路径分隔符的行当文件）。前端 `App.vue`：复制/剪切时同步 `set_clipboard_files`；`pasteFromClipboard` 抽成共享 `doPaste(operation, sources)`，内部记录优先、为空则回退系统剪贴板。仅 `cargo check` 验证后端语法通过（前端改动未跑构建，待用户双击 `dev.bat` 实测）。
