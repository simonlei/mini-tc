# MiniTC — Windows 原生版

WPF + .NET 8 重写的双栏文件管理器，取代原 Tauri 2 + Vue 实现。macOS 端仍由仓库根目录的 Tauri 工程提供。

## 为什么重写

| | Tauri + WebView2 | 本工程 |
|---|---|---|
| 冷启动到窗口可见 | WebView2 初始化 + Vue 挂载 + 1.2s 人为 splash | **约 340 ms**（温态，实测） |
| 文件复制 / 移动 | 约 700 行自研 Rust 引擎（跨卷、合并、冲突、提权全部手写） | Shell `IFileOperation`，行为与资源管理器逐字节一致 |
| 剪贴板 / 拖放 | 手写 `DROPFILES` 封送 + vendored `drag-rs` 补丁 | `DataObject` / `DoDragDrop` 原生支持 |
| 图标 | emoji 占位 | `SHGetFileInfo` 真实 Shell 图标 |
| 视频 | WebView 解码，mkv/HEVC 靠启发式判定黑屏后回退 | Media Foundation，mkv/avi 直接播，失败有明确事件 |
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

- **排序**：目录优先；忽略连字符（`-1a.txt` 按 `1a.txt` 比）；字符类 数字 < 拉丁 < 中文（`0.txt` < `a.txt` < `推特.txt`）；数字段按数值（`1a` < `2c` < `10b`，经 `StrCmpLogicalW`，与资源管理器同源）
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
| 文本 | `txt/md/json/log` + 用户自定义后缀；2 MB 上限，`.log` 超限只读末尾 512 KB；BOM → 严格 UTF-8 → GBK 逐级嗅探（原版一律 lossy UTF-8） |
| 图片 | WIC 解码，`OnLoad` 缓存以免锁定文件（预览时仍可重命名/删除） |
| 视频 | Media Foundation；常驻进度条、按钮行 3 秒自动隐藏、±5/±30 秒、倍速、音量滚轮、字幕（同目录探测 / 手动加载 / ±0.5 秒偏移）、播完自动续播下一个、全屏 |

PDF 与 doc/docx 未做内联渲染（需引入 native PDFium 或 OOXML 解析，体积与启动成本不划算），选中时提供「用系统程序打开」。

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
