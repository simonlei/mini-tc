# win-native 版 vs Tauri 跨平台版：功能差异对比

> 基线：当前工作区 HEAD（2026-09-25 复核）。结论均为源码实证，未执行任何构建或测试。
> 本文档初版于 2026-09-18（commit `26d17bf`），本次根据后续提交与代码重组做了全面复核与修正。
>
> **项目结构变更（重要）**：初版之后 `win-native` 代码整体重组进 `win-native/src/MiniTC/`，
> 分为 `Views/`、`ViewModels/`、`Services/`、`Models/`、`Interop/`、`Themes/` 子目录。
> 下文所有 `win-native` 路径均相对 `win-native/src/MiniTC/`，省略该前缀。

## 评审结论

**总判：`win-native` 不是「功能等价移植」。它在 Shell 集成与 Windows 原生体验上有明显增强，但仍有若干「Tauri 有、native 无」的预览/交互缺口。初版列出的 B1（PDF）、B3（.ogg）、B5（JSON 美化）已于后续提交修复；初版遗漏的「字幕」两侧均已实现（对等）。**

### 覆盖与限制

- **已读（本次复核）**
  - Tauri 侧：`src/App.vue`、`src/components/FilePreview.vue`、`src/components/VideoPreview.vue`、`src/components/FileList.vue`、`src/components/TabBar.vue`、`src/shortcuts.js`。
  - win-native 侧：`Services/PreviewService.cs`、`Services/SubtitleService.cs`、`Services/ShortcutService.cs`、`Services/ArchiveService.cs`、`Services/TextDecoder.cs`、`Views/VideoPreviewView.xaml.cs`、`Views/FilePanelView.xaml(.cs)`、`Views/MainWindow.xaml.cs`、`ViewModels/MainViewModel.cs`、`ViewModels/PanelViewModel.cs`、`ViewModels/TabViewModel.cs`、`Models/FileEntry.cs`。
- **未执行**：本机 `dotnet` 可用，但 win-native 契约测试（48 条）与 Tauri 前端构建均未在本文档生成过程中运行。
- 文中「未找到」表示在对应侧源码中确实检索不到该能力，非推测。

---

## A. win-native 独有（Tauri 版没有）

| # | 差异 | win-native 证据 | Tauri 现状 |
|---|---|---|---|
| A1 | **完整命令栏菜单**：文件 / 编辑 / 查看 / 配置 / 帮助 五组，含「打开、新建文件夹、删除到回收站、永久删除、退出、全选、重命名、显示隐藏文件、刷新、打开配置目录」 | `Views/MainWindow.xaml.cs`（菜单构建） | 仅「配置」「帮助」两个菜单，无删除/重命名/退出等入口（`src/App.vue`） |
| A2 | **隐藏文件开关**（默认开，写盘） | `ViewModels/MainViewModel.cs`；配置 `view-state.json` | 只有 `.is-hidden` 样式，无开关（旧 `TODO.md` 项，Tauri 侧仍无） |
| A3 | **分栏比例持久化** | `Views/MainWindow.xaml.cs`（分隔条比例写盘） | 不持久化 |
| A4 | **F5 刷新 / F7 新建文件夹** 快捷键 | `Services/ShortcutService.cs` | 未注册（`src/shortcuts.js`） |
| A5 | **解压可选「解压到当前文件夹」** | `Services/ArchiveService.cs`；`Views/FilePanelView.xaml.cs` | 后端支持 `mode="here"`，但前端只发 `to_folder` |
| A6 | **「在资源管理器中显示」/「在资源管理器中打开当前目录」** | `Views/FilePanelView.xaml.cs` | 未找到 |
| A7 | **视频原生解码范围大幅扩展**：MKV / AVI / WMV / ASF / VOB / TS / M2TS / MPG / MPEG / MTS / OGG / WEBM 由 Media Foundation 直解 | `Services/PreviewService.cs`（`NativeVideoExtensions`） | 这些多数落「用系统播放器打开」（`src/components/VideoPreview.vue`） |
| A8 | **真实 Shell 图标**（`SHGetFileInfo`，按扩展名缓存） | `Services/IconService.cs` | emoji 占位 |
| A9 | **文本编码逐级嗅探**：BOM → UTF-16LE/BE → 严格 UTF-8 → GBK → lossy | `Services/TextDecoder.cs` | 一律 `from_utf8_lossy`，GBK 文件变乱码 |
| A10 | **主题跟随系统 + 跟随强调色 + 深色标题栏 + Win11 圆角** | `Services/ThemeService.cs`；`Interop/WindowTheming.cs` | 4 套固定主题，无 `prefers-color-scheme` |
| A11 | **文件操作走 Shell `IFileOperation`**：冲突用 Explorer 原生对话框（跳过 / 替换 / 重命名 / 应用于全部），UAC 由 Shell 弹 | `Interop/ShellFileOperations.cs` | 自研 Rust 引擎 + 自定义「跳过/覆盖」二选 + `runas` PowerShell 提权 |
| A12 | **`SHChangeNotify` 主动通知 Explorer 刷新** | `ViewModels/MainViewModel.cs` | 未找到 |
| A13 | 新增配置 `view-state.json`、`crash.log`、视频配置 `video-config` | `Models/ConfigModels.cs`；`App.xaml.cs` | 无对应 |
| A14 | 更新机制换 Velopack（增量包、免管理员） | `Services/UpdateService.cs` | `tauri-plugin-updater` |
| A15 | **字幕叠加**：自动探测同目录 `.srt/.vtt/.ass/.ssa` 字幕、可手动载入字幕文件、±0.5s 偏移、C 键开关 | `Services/SubtitleService.cs` + `Views/VideoPreviewView.xaml.cs` | 同样具备（`src/components/VideoPreview.vue`），两侧对等 |
| A16 | **「类型」列**（显示后缀并支持按类型排序） | `Views/FilePanelView.xaml`（`TypeColumn` → `FileEntry.TypeText`） | 同样具备（`src/components/FileList.vue` `col-type`），两侧对等 |

---

## B. 已修复（初版回退项，本轮已关闭）

| # | 原严重度 | 差异 | 修复证据 |
|---|---|---|---|
| B1 | 高 | **PDF 内联预览**——初版 win-native 落到 `Unsupported`，只给「按文本预览 / 用系统程序打开」 | `fc7730b`：`Services/PreviewService.cs` 新增 `PreviewKind.Pdf` + `RenderPdfPage`（PdfiumViewer 渲染到 WPF `BitmapSource`），`Views/PreviewView.xaml.cs` 接入翻页。**已与 Tauri 对等。** |
| B3 | 中 | **`.ogg` 完全不被识别为视频** | `Services/PreviewService.cs` 的 `NativeVideoExtensions` 已含 `OGG`（第 55 行）。**已修复。** |
| B5 | 低 | **JSON 预览不再美化** | `69d4aff`：`PreviewService.LoadText` 对 `.json` 做 2 空格缩进美化 + 解析失败告警回退原文（第 151-166 行）。**已与 Tauri 对等。** |

---

## C. 仍待修复 / 缺失（Tauri 有、native 无）—— 实现候选项

> **进度**：C1（docx 内联预览）已于 **2026-09-25 实现**并落地（见下方标注 + commit `23bda72`），剩余 C2–C5 待排期。

| # | 严重度 | 差异 | Tauri 证据 | win-native 现状 |
|---|---|---|---|---|
| C1（原 B2） | ✅ 已实现 | **docx 内联预览**（2026-09-25 补齐）：`DocumentFormat.OpenXml` v3 读 OOXML → 渲染 WPF `FlowDocument`（标题分级 / 粗斜体下划线删除线 / 超链接 / 项目符号与编号列表 / 基础表格；图片不内联，对齐 mammoth 默认）。超链接点击用默认浏览器打开。 | `src/components/FilePreview.vue`（`docx` 分支：mammoth 读字节 → HTML 注入） | `PreviewService` 新增 `PreviewKind.Docx` + `IsDocx`；新增 `Services/DocxPreviewService.cs`；`Views/PreviewView.xaml.cs` 接入 `FlowDocumentScrollViewer`。`.docx` 现可内联预览；`.doc` 仍 `Unsupported`。 |
| C2（原 B4） | 中 | **SVG 图片预览丢失** | `src/App.vue` 图片集合含 `svg` | `PreviewService.ImageExtensions`（`JPG…AVIF`）不含 `SVG`。注意：WPF 不原生渲染 SVG，实现需引入 `SharpVectors` 之类库或 WebView 宿主。 |
| C3（原 B6） | 低 | **Tab 列表无内存缓存 / 预加载**，切 Tab 会重新列目录并显示 Loading | `src/components/FilePanel.vue`（面板状态缓存） | `ViewModels/TabViewModel.cs` 仅存 `Path` + 排序状态，无条目缓存；切 Tab 由 `PanelViewModel` 重新列目录。 |
| C4（原 B7） | 低 | **中键行为全无**：中键关 Tab、中键（XButton1）返回上一级 | `src/components/TabBar.vue`、`src/components/FileList.vue` | 全仓无中键 / XButton 处理（`Views/MainWindow.xaml.cs`、`FilePanelView` 均无）。 |
| C5（原 B9） | 低 | **「预览中源目录被删空 → 自动退出预览」未移植** | `src/App.vue`（监听预览目标消失） | `MainViewModel` 仅在切换/关闭时 `ClosePreview`，无「源目录被清空则自动退出」逻辑。 |

---

## D. 同名功能、行为不同

1. **排序实现**：Tauri `localeCompare(numeric:true)` + 字符类（`src/components/FileList.vue`）；win-native `StrCmpLogicalW` + 数字 < 拉丁 < CJK（`Services/FileEntryComparer.cs`）。语义一致，win-native 与资源管理器同源。
2. **复制 / 移动的进度呈现**：Tauri 应用内自绘进度条；win-native 用 Shell 原生进度 / 冲突对话框（`Interop/ShellFileOperations.cs`）。win-native 的冲突处理更强（多「重命名」「应用于全部」）。
3. **视频跳转按钮**：Tauri ±10s 与 ±30s 两对按钮（`src/components/VideoPreview.vue`）；win-native 只有 ±10s 按钮，±5 / ±30 仅在快捷键（`Views/VideoPreviewView.xaml` 按钮行 + `HandleShortcut` 的 `back5/forward5/back30/forward30`）。
4. **压缩包识别集合**：Tauri 含 `exe`（自解压）、`zst`、`lz4`、`ace`、`deb`、`rpm`；win-native 无这些，但多 `EPUB`（`Services/ArchiveService.cs`）。
5. **压缩默认名**：Tauri 一律取当前文件夹名；win-native 单选取「原文件名.zip」、多选取「当前目录名.zip」。
6. **状态栏**：Tauri `N items`；win-native 「共 M 个目录, K 个文件」+ 选中字节（`ViewModels/PanelViewModel.cs`）。两侧都不在状态栏显示磁盘余量（都在盘符下拉里）。
7. **更新清单位置**：`latest.json`（COS 根） vs `releases.win.json`（`win-native/` 子目录，可用 `MINITC_UPDATE_FEED` 覆盖）。两侧都是**仅手动检查**，无启动自动检查。
8. **视频全屏**：Tauri `requestFullscreen`；win-native 隐藏窗口 chrome 并最大化预览列（避免 `MediaElement` 重父级导致播放重启，`Views/MainWindow.xaml.cs`）。
9. **字幕体验**：两侧均支持同目录自动探测 + 手动载入 + 偏移 + 快捷键开关，基本对等。差异仅在于 UI 形态（Tauri 是 `<video>` + 叠加层；native 是 `MediaElement` + `TextBlock` 叠加）。

---

## E. 低优先级观察项

`Services/ShortcutService.cs` 原样保留了 Tauri 为 macOS 设计的默认绑定 `Meta+Backspace`（删除）与 `Shift+Meta+Backspace`（永久删除）。在 Windows 上 `Meta` 显示为 `Win`，即 `Win+Backspace` / `Shift+Win+Backspace` 会触发**不可恢复的永久删除**。这两个组合在 Windows 上没有系统占用，但从 macOS 语义平移过来的默认值在 Windows 上语义陌生且无确认弹窗——建议要么在 Windows 侧剔除这两个默认值，要么在加载旧配置时做一次迁移清理。

> **决策（2026-09-24）**：Backspace-删除是 macOS 约定，Windows 端不兼容。已在 `ShortcutService.cs` 的 `list.delete` / `list.deletePermanent` 默认值中**移除** `Meta+Backspace` 与 `Shift+Meta+Backspace`（保留 `Delete` / `Ctrl+Backspace` 与 `Shift+Delete` / `Ctrl+Shift+Backspace`）。`NormalizeCombo` 解析器仍保留 Meta 别名以便用户手动绑定，仅删默认值。契约测试 `DefaultBindingsMatchTheWebBuild` 同步更新。旧版 `shortcuts.json` 若曾显式把这两个组合存为 override 才会残留，属用户主动自定义，不在本次清理范围。

---

## 建议优先级（更新于 2026-09-25）

1. **C2 SVG 预览（中，需引入 SVG 渲染库）**、**C3 Tab 缓存（低）**、**C4 中键交互（低）**、**C5 预览源清空自动退出（低）** 为当前仅存的「Tauri 有、native 无」缺口，可按价值与工作量排期实现。**C1 docx 内联预览已于 2026-09-25 实现**（见 C 节标注）。
2. 初版 B1 / B3 / B5 已修复，从缺口清单移除；新增 A15（字幕）、A16（类型列）为两侧对等能力，初版文档遗漏，已补入 A 节。
3. ~~决定 E 项的 `Win+Backspace` 永久删除默认值是否保留。~~ **已决策（2026-09-24）：直接移除这两个 Mac 起源默认值，不保留。**
