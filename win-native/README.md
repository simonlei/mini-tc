# MiniTC — Windows 原生版

WPF + .NET 8 重写的双栏文件管理器，取代原 Tauri 2 + Vue 实现。macOS 端仍由仓库根目录的 Tauri 工程提供。

## 为什么重写

| | Tauri + WebView2 | 本工程 |
|---|---|---|
| 冷启动到窗口可见 | WebView2 初始化 + Vue 挂载 + 1.2s 人为 splash | **约 340 ms**（温态，实测） |
| 文件复制 / 移动 | 约 700 行自研 Rust 引擎（跨卷、合并、冲突、提权全部手写） | Shell `IFileOperation`，行为与资源管理器逐字节一致 |
| 剪贴板 / 拖放 | 手写 `DROPFILES` 封送 + vendored `drag-rs` 补丁 | `DataObject` / `DoDragDrop` 原生支持 |
| 图标 | emoji 占位 | `SHGetFileInfo` 真实 Shell 图标 |
| 视频 | WebView 解码，mkv/HEVC 靠启发式判定黑屏后回退 | LibVLC 内嵌解码，自带 HEVC / RMVB / FLV 等解码器，不依赖系统媒体功能包 |
| 界面 | 4 套自制主题 | Fluent 配色，跟随系统深浅色与强调色 |

## 环境要求

- Windows 10 1809（build 17763）或更高 / Windows 11
- .NET 8 SDK（构建）；运行需 .NET 8 Desktop Runtime（安装包会自动引导安装）

## 开发

```powershell
cd win-native

dotnet build                                  # 编译
dotnet run --project src/MiniTC                # 运行
dotnet test tests/MiniTC.Tests                 # 48 个契约测试
```

## 目录结构

```
win-native/
├── src/MiniTC/
│   ├── App.xaml(.cs)              入口：Velopack 钩子、配置预载、异常兜底
│   ├── MainWindow.xaml(.cs)       命令栏、双栏布局、全局快捷键分发、全屏、更新
│   ├── Interop/                   Win32 / Shell COM
│   │   ├── ShellInterop.cs        IFileOperation / IShellItem 定义
│   │   ├── ShellFileOperations.cs 复制/移动/删除/重命名/新建（专用 STA 线程）
│   │   ├── NativeMethods.cs       图标、StrCmpLogicalW、DWM、变更通知
│   │   └── WindowTheming.cs       深色标题栏、Win11 圆角、系统主题/强调色
│   ├── Services/                  无 UI 依赖的业务逻辑
│   │   ├── ConfigStore.cs         ~/.minitc 读写（原子替换）
│   │   ├── DirectoryService.cs    目录枚举、递归大小
│   │   ├── FileEntryComparer.cs   排序规则（见下）
│   │   ├── ShortcutService.cs     38 条命令、组合键解析、冲突检测
│   │   ├── PreviewService.cs      预览分类、文本读取
│   │   ├── SubtitleService.cs     SRT / VTT / ASS 解析与探测
│   │   ├── ArchiveService.cs      7-Zip / WinRAR 探测与调用
│   │   ├── ClipboardService.cs    CF_HDROP + Preferred DropEffect
│   │   ├── IconService.cs         Shell 图标（按扩展名缓存）
│   │   └── UpdateService.cs       Velopack 检查 / 下载 / 重启
│   ├── ViewModels/                MainViewModel / PanelViewModel / TabViewModel
│   ├── Views/                     面板、预览、播放器、快捷键与设置窗口
│   └── Themes/                    Fluent 明暗配色 + 控件样式
├── tests/MiniTC.Tests/            行为一致性测试
└── scripts/build-release.ps1      Velopack 打包
```

## 配置兼容

直接复用原版的 `%USERPROFILE%\.minitc\`，升级无需迁移：

| 文件 | 说明 |
|---|---|
| `tabs-left.json` / `tabs-right.json` | 标签页与各自排序状态，结构不变 |
| `shortcuts.json` | 仅存与默认值的差异；未知命令 id 自动丢弃 |
| `text-preview-extensions.json` | `{ "ext": bool }`，兼容早期的纯数组格式 |
| `video-config.json` | 音量 / 倍速 / 静音记忆 |
| `theme.json` | 旧值自动映射：`latte`→浅色，`neon`/`graphite`/`forest`→深色 |
| `view-state.json` | 新增：隐藏文件开关、分栏比例 |

## 保留的行为约定

- **排序**：目录优先；文件名直接复用 `StrCmpLogicalW`（= 资源管理器真值，顺序逐字节一致）。不再做字符类预分组，连字符 / 符号 / 全角括号（`【` 等）按系统真实权重参与比较，排序结果与 Windows 资源管理器完全相同（与跨平台 Tauri 版的 `nameClass` 近似规则有意分叉）
- **同名冲突**：目录走**合并**而非「删除后替换」，杜绝原版曾出现的「把 `root/a/a` 移到 `root/` 导致 `root/a` 整体丢失」
- **跨卷移动**：复制全部成功后才删除源
- **剪切语义**：靠 `Preferred DropEffect`，粘贴后清空剪贴板
- **删除**：`Delete` 进回收站，`Shift+Delete` 永久删除；权限不足时由 Shell 直接弹 UAC 并提权继续（不再需要单独的提权 PowerShell 子进程）
- **删除后光标**：落到被删块下方第一个幸存项，末尾则回退到上方最近一项
- **解压**：三级探测（固定路径 → `where.exe` → 常见便携目录）；多选压缩包**顺序**解压，GUI 工具等上一个结束
- **窗口切回**：从外部工具（如 7-Zip）返回时自动重列目录、恢复选中、交还键盘焦点；正在输入时不抢焦点

## 快捷键

38 条命令全部可在「配置 → 快捷键设置」内重绑定（支持一命令多组合键、同作用域冲突红色高亮）。作用域优先级 视频 > 文件列表 > 全局，由 WPF 的隧道/冒泡事件顺序天然保证。

列表的方向键 / PageUp / Home / End 及其 `Shift` 扩展选择**默认交给 ListView 原生处理**（锚点范围选择、虚拟化滚动都由框架实现）；仅当用户把这些命令改绑到其他键时才由应用接管。

## 预览

| 类型 | 实现 |
|---|---|
| 文本 | `txt/md/json/log` + 用户自定义后缀；2 MB 上限，`.log` 超限只读末尾 512 KB；BOM → 严格 UTF-8 → GBK 逐级嗅探（原版一律 lossy UTF-8）；`.json` 自动 2 空格缩进美化（解析失败回退原文并提示「JSON 格式错误」） |
| 图片 | WIC 解码，`OnLoad` 缓存以免锁定文件（预览时仍可重命名/删除）；**GIF 走逐帧动画**——WPF 不会自己播放 GIF（`Image` 无论 Freeze 与否都只显示首帧），故解码全部帧后用 `ObjectAnimationUsingKeyFrames` 驱动 `Image.Source` 循环播放，每帧延迟读自 `/grctlext/Delay`；**每帧需先合成到完整画布**——GIF 帧通常只含与上一帧的差异、尺寸小于画布且有偏移和透明色，直接播放会让未覆盖区域透明（深色预览背景下即大片黑块），故按 `/imgdesc/Left`/`Top` 定位绘制，并依 `/grctlext/Disposal` 还原上一帧；**合成走一块像素缓冲区 + premultiplied alpha 混合，每帧只读写自己的区域**——原先每帧新建一张 `RenderTargetBitmap` 重画整块画布，实测 640×360 / 77 帧 GIF 要 **1431 ms**（17.5 ms/帧），改用共享缓冲区后约 **107 ms**；4 MB / 640×1144 / 39 帧的大 GIF 则从 **1056 ms 降到 ~187 ms**（先前的 `WritePixels` 回写 + 再克隆快照等于每帧两次全画布拷贝，是大头）；已是完整帧、无透明且无需还原的 GIF 免合成，超 500 帧或总像素超 32M 降级为首帧。源文件始终不锁。**加载性能**：选中一个文件会连续触发多个属性变更，故加载统一走 60 ms 防抖（快速浏览时只为停下的那张图解码一次，命中缓存则立即显示、不等防抖）；静态图按预览列实际宽度解码（量化到 512/768/1024/1280/1600 档，含 DPI 与 1.25 倍余量），缓存为 LRU 8 张——早先是「满 4 张就整体清空」，浏览几张后回头看等于重新解码；**GIF 分两步加载**：先用 `DelayCreation` 只解首帧（4 MB GIF 实测 **3 ms**）立刻显示画面，再在后台合成完整动画（~187 ms）接管播放，避免为合成耗时干等空白 |
| 视频 | LibVLC（`LibVLCSharp.WPF` 的 `VideoView`）；常驻进度条、按钮行 3 秒自动隐藏、±5/±30 秒、倍速、音量滚轮、播完自动续播下一个、全屏。外挂字幕（同目录探测 / 手动加载 / ±0.5 秒偏移）已随引擎替换暂时移除 |
| PDF | PdfiumViewer 原生渲染（不引 WebView2），翻页、适应宽度 / 实际大小，显示「第 X / Y 页」（对齐 WebView 版 `convertFileSrc`+`<iframe>` 的内联预览） |
| DOCX | `DocumentFormat.OpenXml` 解析 OOXML 包，在进程内渲染 WPF `FlowDocument`：标题分级、粗体/斜体/下划线/删除线、超链接、项目符号与编号列表（解析 numbering.xml）、基础表格；图片不内联（对齐 WebView 版 mammoth 默认行为），页脚标注「图片未内联渲染」 |

DOCX 现可内联预览（C1）。`.doc`（旧版二进制格式）仍不支持，选中时提供「用系统程序打开」。PDF 走 PdfiumViewer 原生渲染，不引 WebView2。

**视频预览不依赖 Windows Media Player。** 原先的 `MediaElement` 走 Media Foundation，而 WPF 的 `MediaElement` 要求系统装上「Windows Media Player / 媒体功能包」这个可选功能——没装的机器上连普通 H.264(avc1) 的 mp4 都放不出来。现在改用 LibVLC，解码器随包自带（HEVC、RMVB、FLV 等均可播），无需任何系统可选功能。两个已知取舍：

- `VideoView` 内部是 `WindowsFormsHost`，存在 WPF airspace 限制——WPF 子元素画不到视频上面。按 LibVLCSharp 官方解法，**叠加内容放在 `VideoView` 内部**（会被渲染到视频之上的独立透明窗口）。覆盖层背景的 alpha 必须大于 0（`#00000000` 不行），否则视频区域永远收不到鼠标事件。播放失败的兜底面板仍是**隐藏视频面**而不是盖在上面。
- 引擎实例全应用共享（`Services/VlcEngine.cs`）：加载原生插件实测约 **780 ms**，而 `Play()` 到出首帧只要 10–60 ms——慢的几乎全是这一次性初始化，且它是按 LibVLC 实例计的，左右两栏不能各建一个。窗口加载完成后会在后台线程 `Prewarm()` 预热，首次预览基本无感。
- 外挂字幕渲染暂未接入（`SubtitleService` 保留，将来可用 `AddSlave(MediaSlaveType.Subtitle, …)` 接回）。

## 发布

```powershell
cd win-native
./scripts/build-release.ps1 -Version 0.2.0            # 约 6 MB 安装包，自动引导装运行时
./scripts/build-release.ps1 -Version 0.2.0 -SelfContained   # 约 90 MB，无任何前置依赖
```

产物在 `artifacts/releases/`：`MiniTC-win-Setup.exe` 安装包、`MiniTC-<版本>-full.nupkg` 更新包，以及更新清单 `releases.win.json` / `assets.win.json` / `RELEASES`。整个目录上传到 `<CDN>/win-native/` 即完成发布。

> 不出便携包（`--noPortable`）：解压版无法自更新（`UpdateService.IsInstalled` 为 false），只会被当成「便携版，更新不可用」。

CI 走 `.github/workflows/win-native-release.yml`，推送 `win-v*` tag 触发（与 mac 端的 `v*` tag 互不干扰），复用现有 `COS_*` secrets。

更新地址可用环境变量 `MINITC_UPDATE_FEED` 覆盖，便于测试预发布通道。

> Velopack 装到 `%LocalAppData%`，无需管理员权限，增量更新只下载差异包。
