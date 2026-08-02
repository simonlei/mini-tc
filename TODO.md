# mini-tc TODO

> 想法暂存区，先记录，暂不实现。

- [x] **Backspace 退回上一级目录** — 在文件列表中按 Backspace 键导航到父目录（含空目录修复）
- [x] **不支持预览格式时占位提示** — 若选中文件为不支持预览的格式（不在 `PREVIEWABLE_EXTENSIONS` 内），在另一侧面板直接展示「暂不支持预览该格式」，而不是静默无反应（涉及 `togglePreview` 及两处 `watch`）
- [x] **路径栏支持 Windows 占位符与 ~ 家目录** — 在 PathBar 的可编辑路径输入中支持展开：`%LOCALAPPDATA%\Netease` 等 `%VAR%` 环境变量，以及 `~` 代表当前用户根目录（`C:\Users\<user>`）。需在 `onEnter` 提交 `navigate` 前先做展开（建议后端或前端统一解析），否则 `pathExists` 会判定为不存在而报红
- [x] **支持鼠标返回键导航** — 部分鼠标侧键即「后退键」（`mousedown`/`mouseup` 中 `e.button === 3`，对应 XButton1）。在文件列表区域监听该键，触发与 Backspace 相同的「退回上一级目录」逻辑（注意区分左右面板，仅对当前活动面板生效）
- [x] **文件名模糊搜索** — 在某一栏直接输入文字时，默认按该文字对当前目录下的文件/文件夹名做模糊匹配并实时过滤列表（而非触发其他快捷键）。需处理：输入态与导航快捷键的冲突（例如仅在未聚焦输入框时启用，或提供独立搜索框）、区分大小写/子目录递归与否、清空即恢复全部列表
- [x] **支持 ctrl+c / ctrl+v / ctrl+x 剪贴板操作** — 在文件列表中选中条目后，可通过快捷键执行复制（ctrl+c）、粘贴（ctrl+v）、剪切（ctrl+x）。复制/剪切将当前选中项写入内存剪贴板（记录源路径+操作类型），粘贴时在**当前活动面板（用户当前选中的目录）**目录执行拷贝/移动。已在 App.vue 全局 keydown 拦截并 preventDefault（输入框焦点时放行，文本编辑正常）；粘贴后目标面板+活动面板都 refresh；复制保留剪贴板可重复粘贴，剪切粘贴后清空；后端 `copy_items`/`move_items` 递归处理目录，跨卷 move 用 copy+delete 兜底；目标已存在/源不存在则跳过并聚合错误，前端用 toast 反馈成功/失败
- [x] **Ctrl/Shift 多选文件** — 在文件列表中支持 `Ctrl`+点击 进行不连续多选、`Shift`+点击 进行连续范围多选，从而可一次性选中多个文件/文件夹，配合上述 ctrl+c / ctrl+x / ctrl+v 进行批量拷贝/剪切与粘贴。需处理：选中态的视觉高亮、活动面板 vs 另一侧面板的选中隔离、与模糊搜索过滤态共存、剪切态（移动）对多项的标记、全选/取消等便捷操作
  - 实现：`FileList.vue` 选中模型改为 `selectedIndices`(Set)+`activeIndex`+`anchorIndex`；`Ctrl+点击`切换、`Shift+点击`连续范围、`Ctrl+A`全选、`Esc`/点空白取消；每面板独立实例天然隔离左右选中；与 `/` 过滤态共存（索引基于 displayedEntries）；`App.vue` 的 ctrl+c/x/v 改为读取整个 `selectedEntries` 集合（后端 `copy_items`/`move_items` 本就支持多路径）；`Ctrl+X` 时通过 `cutNames` 把源面板中的待移动项以 `is-cut` 半透明斜体标记，粘贴后清除；`Delete` 支持批量删除。
- [ ] **与操作系统剪贴板打通** — 当前的 ctrl+c / ctrl+x / ctrl+v 仅走内部内存剪贴板（记录源路径+操作类型），与外部系统剪贴板不互通。目标：拷贝/剪切时写入操作系统剪贴板（如 Windows 的 CF_HDROP / 文件描述符，使资源管理器及其他程序可识别这些文件；或从外部复制文件进来时也能识别）；粘贴时既能消费内部记录，也能消费来自系统剪贴板的文件列表。需评估 Tauri 的 `tauri-plugin-clipboard` / 原生剪贴板 API，处理跨平台差异、权限，以及外部→内部、内部→外部两种方向的读写
- [ ] **右键菜单调用 7-Zip 等外部压缩工具解压** — 在文件列表的右键上下文菜单中，针对压缩包（zip/rar/7z 等）增加「用 7-Zip 解压」「用其他压缩工具解压」入口：自动探测系统已安装的 7-Zip（`C:\Program Files\7-Zip\7z.exe` 或 PATH 中的 `7z`）或其他压缩软件，将选中压缩包路径作为命令行参数（如 `7z x "<path>" -o"<target>"` 解压到当前面板目录）调用外部程序完成解压。需处理：工具未安装时的提示、解压目标目录选择（当前面板目录 vs 新建同名文件夹）、跨平台探测差异（macOS/linux 用 `unzip`/`7z`），以及该右键菜单本身依赖的上下文菜单基础设施（见后续右键菜单条目）

- [ ] **JSON 格式文件预览与美化** — 在文件预览（Ctrl+Q 对面面板）中支持 `.json` 文件：读取后用 `JSON.parse` 解析，再以 2 空格缩进 `JSON.stringify(obj, null, 2)` 美化输出。可在 `PREVIEWABLE_EXTENSIONS` 增加 `json`，并在 `read_file_preview` / 预览组件里按 JSON 处理：解析失败则提示「JSON 格式错误」并展示原始文本；与现有 text 预览复用同一面板与滚动。需处理：大文件上限（参考 `MAX_TEXT_SIZE`）、嵌套层级高亮可选、以及 `unsupported` 占位逻辑对 `.json` 的豁免（应走美化预览而非占位提示）。

- [x] **统一配置保存到 `~/.minitc`（取代 localStorage）** — 当前散落在 `localStorage` 的配置应统一迁移到 `~/.minitc` 目录，与已有的 `video-config.json` 归并：① `FilePanel.vue` 的 `mini-tc-tabs-left` / `mini-tc-tabs-right`（打开的 tab 列表 + 激活 tab id）；② `App.vue` 的 `mini-tc-theme`（主题）。后端 `load_video_config`/`save_video_config` 已用 `home_dir().join(".minitc")` 落地，可新增通用命令（如 `load_app_config` / `save_app_config` 整份读写，或按子项 `load_config(name)` / `save_config(name, json)`）；前端把各 `localStorage.getItem/setItem` 改为对应 `invoke`。需处理：异步加载（`FilePanel.onMounted` 原同步读 localStorage 后 fallback 建首页 tab，须改为 await 配置后再决定 fallback）、首次启动无配置时的默认值、`video` 配置并入同一体系且保持兼容、以及 localStorage 旧数据的迁移/清理。
  - 实现：后端新增通用命令 `load_config(name)` / `save_config(name, config)`，统一落到 `~/.minitc/<name>.json`（带 `..`/分隔符路径穿越防护）；原专用 `load_video_config`/`save_video_config` 删除，`VideoPreview.vue` 改用通用命令读写 `video-config`（文件仍是 `~/.minitc/video-config.json`，兼容旧数据）。前端 `FilePanel.vue`（tabs-left/tabs-right）与 `App.vue`（theme）全部从 `localStorage` 迁移到通用命令；`onMounted` 改为 `await loadConfig` 后再决定 fallback 建首页 tab；旧 `localStorage` 数据在首次启动时迁移写入新存储并清理。仅 `cargo check` 验证后端语法通过（前端改动未跑构建，待用户双击 `dev.bat` 实测）。

