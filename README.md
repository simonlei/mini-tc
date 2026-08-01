# mini-tc

> 基于 Tauri 2 + Vue 3 的跨平台双栏文件管理器，致敬 Total Commander。

## 功能

- 左右双栏布局，可拖拽调整面板宽度
- 每栏独立多 Tab 管理，Tab 状态自动持久化
- 可编辑路径栏 + 盘符下拉切换
- 文件列表按名称 / 大小 / 修改时间排序
- **文件预览**（Ctrl+Q）：文本（txt/md）和图片（jpg/png/gif/webp/bmp/svg/avif），图片通过 asset protocol 直接加载，无大小限制
- 4 套内置主题（石墨工业 / 霓虹暗夜 / 暖茶拿铁 / 墨竹青翠）
- Ctrl+Tab 快速切换左右面板
- **自动更新**（帮助 → 检查更新）
- Windows / macOS / Linux 跨平台支持

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | [Tauri 2](https://v2.tauri.app/) |
| 前端 | Vue 3 + Vite 5 |
| 后端 | Rust (7 条 Tauri 命令) |
| 编译 | MSVC (Windows) / Clang (macOS) / GCC (Linux) |

## 前置条件

- [Rust](https://rustup.rs/) (stable-msvc on Windows)
- [Node.js](https://nodejs.org/) >= 18
- Windows：Visual Studio 2022 Build Tools（含 C++ 桌面开发工作负载）
- macOS：Xcode Command Line Tools
- Linux：`build-essential` + `libwebkit2gtk-4.1-dev` 等

## 快速开始

```bash
# 克隆仓库
git clone https://cnb.cool/simon-lei/mini-tc.git
cd mini-tc

# 安装前端依赖
npm install

# 启动开发模式
npx tauri dev
```

## 构建生产版本

```bash
# 生成签名密钥（仅首次）
npx tauri signer generate -p mini-tc-updater -w src-tauri/keys/mini-tc.key

# 构建并准备发布产物
bash scripts/release/build-release.sh
```

产物在 `scripts/release/out/` 下，包含 `.msi` 安装包和 `latest.json` 更新清单。

## 发布新版本

1. 修改 `package.json` 和 `src-tauri/tauri.conf.json` 中的版本号
2. 运行 `bash scripts/release/build-release.sh`
3. 在 [CNB Releases](https://cnb.cool/simon-lei/mini-tc/-/releases) 创建新 Release
4. 上传 `scripts/release/out/` 中的 `.msi` 和 `latest.json`
5. 已安装用户下次启动时点击 **帮助 → 检查更新** 即可自动升级

## 项目结构

```
mini-tc/
├── src/                      # Vue 前端
│   ├── App.vue               # 主双面板布局 + 菜单栏
│   ├── main.js               # 应用入口
│   ├── api.js                # Tauri invoke 封装
│   ├── style.css             # 全局样式（4 套主题变量）
│   └── components/
│       ├── FilePanel.vue     # 面板容器（Tab + 路径 + 文件列表）
│       ├── TabBar.vue        # 多 Tab 管理
│       ├── PathBar.vue       # 可编辑路径栏 + 盘符切换
│       ├── FileList.vue      # 文件列表（排序）
│       └── FilePreview.vue   # 文件预览（文本/图片）
├── src-tauri/                # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs            # list_directory / read_file_preview / list_drives 等
│   ├── tauri.conf.json
│   └── icons/
├── .cnb.yml                  # CNB CI 流水线配置
├── package.json
└── vite.config.js
```

## License

MIT
