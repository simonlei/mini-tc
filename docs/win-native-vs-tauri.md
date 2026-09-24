# win-native 版 vs Tauri 跨平台版：功能差异对比

> 生成方式：双侧源码静态比对（`ce-code-review`）。基线：当前工作区 HEAD，无 diff 范围。
> 结论均为源码实证，未执行任何构建或测试。

## 评审结论

**总判：`win-native` 不是「功能等价移植」。它在 Shell 集成与 Windows 原生体验上有明显增强，但在文档类预览上存在真实功能回退，另有一处扩展名遗漏（`.ogg`）。**

### 覆盖与限制

- **已读**
  - Tauri 侧：`src-tauri/src/lib.rs`（全文 2357 行）、`src/shortcuts.js`、`src/App.vue`、`src/components/*`（全量清点）。
  - win-native 侧：`MainWindow.xaml.cs`、`MainViewModel.cs`、`PanelViewModel.cs`、`ShortcutService.cs`、`ArchiveService.cs`、`PreviewService.cs`、`Views/PreviewView.xaml`、`Views/SettingsWindow.xaml`（全量清点）。
- **未执行**：本机 `dotnet` 不在 PATH，`win-native/tests`（48 条契约测试）未运行；Tauri 前端未跑 `npm run build`。
- 文中「未找到」表示在对应侧源码中确实检索不到该能力，非推测。

---

## A. win-native 独有（Tauri 版没有）

| # | 差异 | win-native 证据 | Tauri 现状 |
|---|---|---|---|
| A1 | **完整命令栏菜单**：文件 / 编辑 / 查看 / 配置 / 帮助 五组，含「打开、新建文件夹、删除到回收站、永久删除、退出、全选、重命名、显示隐藏文件、刷新、打开配置目录」 | `MainWindow.xaml.cs:253-378` | 仅「配置」「帮助」两个菜单，无删除/重命名/退出等入口（`App.vue:4-53`） |
| A2 | **隐藏文件开关**（默认开，写盘） | `MainViewModel.cs:92,154-165` | 只有 `.is-hidden` 样式，无开关（`TODO.md:79` 仍是未完成项） |
| A3 | **分栏比例持久化** | `MainWindow.xaml.cs:424-434` | 不持久化（`TODO.md:79`） |
| A4 | **F5 刷新 / F7 新建文件夹** 快捷键（命令数 36 → 38） | `ShortcutService.cs:71-72` | 未注册（`src/shortcuts.js:38-82`） |
| A5 | **解压可选「解压到当前文件夹」** | `ArchiveService.cs:19-26`；`FilePanelView.xaml.cs:800` | 后端支持 `mode="here"`（`lib.rs:2027`）但前端只发 `to_folder`（`FilePanel.vue:706`） |
| A6 | **「在资源管理器中显示」/「在资源管理器中打开当前目录」** | `FilePanelView.xaml.cs:737,764` | 未找到 |
| A7 | **视频原生解码范围大幅扩展**：MKV / AVI / WMV / ASF / VOB / TS / M2TS / MPG / MPEG / MTS 由 Media Foundation 直解 | `PreviewService.cs:42-46` | 这些多数落「用系统播放器打开」（`VideoPreview.vue:173-175`） |
| A8 | **真实 Shell 图标**（`SHGetFileInfo`，按扩展名缓存） | `IconService.cs:29-55` | emoji 占位 |
| A9 | **文本编码逐级嗅探**：BOM → UTF-16LE/BE → 严格 UTF-8 → GBK → lossy | `TextDecoder.cs:19-53` | 一律 `from_utf8_lossy`，GBK 文件变乱码（`lib.rs:454-466`） |
| A10 | **主题跟随系统 + 跟随强调色 + 深色标题栏 + Win11 圆角** | `ThemeService.cs:84-95`；`WindowTheming.cs:20-69` | 4 套固定主题，无 `prefers-color-scheme`（`src/style.css`） |
| A11 | **文件操作走 Shell `IFileOperation`**：冲突用 Explorer 原生对话框（跳过 / 替换 / 重命名 / 应用于全部），UAC 由 Shell 弹 | `ShellFileOperations.cs:33-42` | 自研 ~700 行 Rust 引擎 + 自定义「跳过/覆盖」二选 + `runas` PowerShell 提权（`lib.rs:603-662`） |
| A12 | **`SHChangeNotify` 主动通知 Explorer 刷新** | `MainViewModel.cs:632-647` | 未找到 |
| A13 | 新增配置 `view-state.json`、`crash.log` | `ConfigModels.cs:35-47`；`App.xaml.cs:50-68` | 无 |
| A14 | 更新机制换 Velopack（增量包、免管理员） | `UpdateService.cs` | `tauri-plugin-updater`（`tauri.conf.json:44-53`） |

---

## B. win-native 相对 Tauri 的功能回退 / 缺失

| # | 严重度 | 差异 | 证据 |
|---|---|---|---|
| B1 | **高** | **PDF 内联预览丢失**。Tauri 走 `convertFileSrc` + `<iframe>`（WebView2 内置 PDF 查看器）；win-native 落到 `Unsupported`，只给「按文本预览 / 用系统程序打开」 | Tauri `App.vue:450` + `FilePreview.vue:33-51`；win-native `PreviewService.cs:73-86`、`PreviewView.xaml:69-85`、`win-native/README.md:99` |
| B2 | **中** | **docx 内联预览丢失**（mammoth 转 HTML + 消毒），`.doc` 的友好提示也没有 | Tauri `FilePreview.vue:255-282,325-331`；win-native 无对应分支 |
| B3 | **中** | **`.ogg` 完全不被识别为视频**。Tauri 把 `ogg` 列入原生解码组；win-native 的 `NativeVideoExtensions` 与 `ExternalOnlyVideoExtensions` 都不含 `OGG`，`.ogg` 会直接落到「暂不支持预览」 | Tauri `App.vue:451` + `VideoPreview.vue:173`；win-native `PreviewService.cs:42-52` |
| B4 | **中** | **SVG 图片预览丢失** | Tauri `App.vue:450` 含 `svg`；win-native `PreviewService.cs:32-35` 无 `SVG`（但补了 TIF/TIFF/ICO/JFIF/HEIC） |
| B5 | **低** | **JSON 预览不再美化**（2 空格缩进 + 解析失败告警回退原文） | Tauri `FilePreview.vue:342-352`；win-native `PreviewService.LoadText` 纯文本 |
| B6 | **低** | **Tab 列表无内存缓存 / 预加载**，切 Tab 会重新列目录并显示 Loading | win-native `PanelViewModel.cs:166-170`；Tauri `FilePanel.vue:275-310` |
| B7 | **低** | **中键行为全无**：中键关 Tab、中键（XButton1）返回上一级 | Tauri `TabBar.vue:50-56`、`FileList.vue:630-635`；win-native 全仓无中键处理 |
| B8 | **低** | **启动 splash 移除**（1.2s 满屏 + 0.6s 淡出） | Tauri `src/main.js:8-33`；win-native `App.xaml.cs:30-32`，有意去掉 |
| B9 | **低** | 「预览中源目录被删空 → 自动退出预览」未移植 | Tauri `App.vue:1092-1101`；win-native 未找到 |
| B10 | 信息 | 跨平台能力收窄为 Windows-only（`net8.0-windows` + P/Invoke + Shell COM）；Tauri 仍覆盖 macOS / Linux | `MiniTC.csproj:5,8` |

---

## C. 同名功能、行为不同

1. **排序实现**：Tauri `localeCompare(numeric:true)` + 字符类（`FileList.vue:255-298`）；win-native `StrCmpLogicalW` + 数字 < 拉丁 < CJK（`FileEntryComparer.cs:17-76`）。语义一致，win-native 与资源管理器同源。
2. **复制 / 移动的进度呈现**：Tauri 应用内自绘进度条（`App.vue:177-193`）；win-native 用 Shell 原生进度 / 冲突对话框（`ShellFileOperations.cs:99-156`）。win-native 的冲突处理更强（多「重命名」「应用于全部」）。
3. **视频跳转按钮**：Tauri ±10s 与 ±30s 两对按钮（`VideoPreview.vue:77-80`）；win-native 只有 ±10s 按钮，±5 / ±30 仅在快捷键（`VideoPreviewView.xaml:115-118`）。
4. **压缩包识别集合**：Tauri 含 `exe`（自解压）、`zst`、`lz4`、`ace`、`deb`、`rpm`（`FilePanel.vue:80-110`）；win-native 无这些，但多 `EPUB`（`ArchiveService.cs:41-45`）。
5. **压缩默认名**：Tauri 一律取当前文件夹名（`FilePanel.vue:855`）；win-native 单选取「原文件名.zip」、多选取「当前目录名.zip」（`FilePanelView.xaml.cs:826-828`）。
6. **状态栏**：Tauri `N items`；win-native 「共 M 个目录, K 个文件」+ 选中字节（`PanelViewModel.cs:384-405`）。两侧都不在状态栏显示磁盘余量（都在盘符下拉里）。
7. **更新清单位置**：`latest.json`（COS 根） vs `releases.win.json`（`win-native/` 子目录，可用 `MINITC_UPDATE_FEED` 覆盖）。两侧都是**仅手动检查**，无启动自动检查。
8. **视频全屏**：Tauri `requestFullscreen`；win-native 隐藏窗口 chrome 并最大化预览列（避免 `MediaElement` 重父级导致播放重启，`MainWindow.xaml.cs:438-486`）。

---

## D. 低优先级观察项

`ShortcutService.cs:66-69` 原样保留了 Tauri 为 macOS 设计的默认绑定 `Meta+Backspace`（删除）与 `Shift+Meta+Backspace`（永久删除）。在 Windows 上 `Meta` 显示为 `Win`（`ShortcutService.cs:428`），即 `Win+Backspace` / `Shift+Win+Backspace` 会触发**不可恢复的永久删除**。这两个组合在 Windows 上没有系统占用，但从 macOS 语义平移过来的默认值在 Windows 上语义陌生且无确认弹窗——建议要么在 Windows 侧剔除这两个默认值，要么在加载旧配置时做一次迁移清理。

---

## 建议优先级

1. 补 `.ogg` 到 `NativeVideoExtensions`（B3，一行改动，纯遗漏）。
2. 明确 B1 / B2 的产品决策：若 PDF / docx 预览是必需能力，需引入 PDFium 或保留 WebView2 宿主；若接受现状，应在根目录 `README.md` 的功能列表里同步标注 Windows 端不支持，避免与「本工程仅服务 macOS」的说明冲突。
3. 决定 D 项的 `Win+Backspace` 永久删除默认值是否保留。
4. 剩余 B5–B9 可按体验优化排期。
