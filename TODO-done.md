# mini-tc TODO — 已完成归档

> 本文件只做归档清单：每条一行（标题 + 一句结论 + 有则附日期），实现明细在 `docs/todo-details/`，按需打开。
> 瘦身前原文备份（可恢复）：`C:/Users/simon/WorkBuddy/_mini-tc-archive-20261104/todo-before-slim-20261104.tar.gz`
> 未完成条目见 [`TODO.md`](TODO.md)。

## 已实现功能（想法暂存区）

- [x] **Backspace 退回上一级目录** — 在文件列表中按 Backspace 键导航到父目录（含空目录修复） · [明细](docs/todo-details/done-features-001.md)
- [x] **不支持预览格式时占位提示** — 若选中文件为不支持预览的格式（不在 `PREVIEWABLE_EXTENSIONS` 内），在另一侧面板直接展示「暂不支持预览该格式」，而不是静默无反应（涉及 `togglePreview` 及两处 … · [明细](docs/todo-details/done-features-002.md)
- [x] **路径栏支持 Windows 占位符与 ~ 家目录** — 在 PathBar 的可编辑路径输入中支持展开：`%LOCALAPPDATA%\Netease` 等 `%VAR%` 环境变量，以及 `~` 代表当前用户根目录（`C:\Users\<user>`） · [明细](docs/todo-details/done-features-003.md)
- [x] **支持鼠标返回键导航** — 部分鼠标侧键即「后退键」（`mousedown`/`mouseup` 中 `e.button === 3`，对应 XButton1） · [明细](docs/todo-details/done-features-004.md)
- [x] **文件名模糊搜索** — 在某一栏直接输入文字时，默认按该文字对当前目录下的文件/文件夹名做模糊匹配并实时过滤列表（而非触发其他快捷键） · [明细](docs/todo-details/done-features-005.md)
- [x] **支持 ctrl+c / ctrl+v / ctrl+x 剪贴板操作** — 在文件列表中选中条目后，可通过快捷键执行复制（ctrl+c）、粘贴（ctrl+v）、剪切（ctrl+x） · [明细](docs/todo-details/done-features-006.md)
- [x] **Ctrl/Shift 多选文件** — 在文件列表中支持 `Ctrl`+点击 进行不连续多选、`Shift`+点击 进行连续范围多选，从而可一次性选中多个文件/文件夹，配合上述 ctrl+c / ctrl+x / ctrl+v 进行批量拷贝… · [明细](docs/todo-details/done-features-007.md)
- [x] **与操作系统剪贴板打通** — 当前的 ctrl+c / ctrl+x / ctrl+v 已与系统剪贴板双向互通（原仅走内部内存剪贴板） · [明细](docs/todo-details/done-features-008.md)
- [x] **地址栏面包屑 + 点击进入编辑态** — 当前 `src/components/PathBar.vue` 的地址栏**一直是可编辑 `<input>`**（见 line 15-27），缺少面包屑形态 · [明细](docs/todo-details/done-features-009.md)
- [x] **支持 log 文件的查看** — 当前 `.log` 文件既不在前端 `PREVIEWABLE_EXTENSIONS`（`src/App.vue` line 344，含 txt/md/json/图片），也不在后端 `TEXT_EXTE… · [明细](docs/todo-details/done-features-010.md)
- [x] **预览文本文件时支持选中文本复制** — 当前 `FilePreview.vue` 的文本预览区（`<pre class="preview-text">`，约 line 35）是只读渲染，鼠标拖选文本后无法便捷复制：`App.vue` 全局 … · [明细](docs/todo-details/done-features-011.md)
- [x] **右键菜单调用 7-Zip 等外部压缩工具解压** — 在文件列表的右键上下文菜单中，针对压缩包（zip/rar/7z 等）增加「用 7-Zip 解压」「用其他压缩工具解压」入口：自动探测系统已安装的 7-Zip（`C:\Program Files\7-Z… · [明细](docs/todo-details/done-features-012.md)
- [x] **JSON 格式文件预览与美化** — 在文件预览（Ctrl+Q 对面面板）中支持 `.json` 文件：读取后用 `JSON.parse` 解析，再以 2 空格缩进 `JSON.stringify(obj, null, 2)` 美化输出 · [明细](docs/todo-details/done-features-013.md)
- [x] **统一配置保存到 `~/.minitc`（取代 localStorage）** — 当前散落在 `localStorage` 的配置应统一迁移到 `~/.minitc` 目录，与已有的 `video-config.json` 归并：① `FilePanel.vue` 的 `mini-… · [明细](docs/todo-details/done-features-014.md)
- [x] **视频播放完自动播放下一个** — 当前视频预览播放结束后不会自动续播 · [明细](docs/todo-details/done-features-015.md)
- [x] **地址栏路径过长时优化显示（消除横向滚动条）** — 当前 `PathBar.vue` 的面包屑区域（`.breadcrumb`）使用 `white-space: nowrap` + `overflow-x: auto`，当路径层级深或某段目录/文件名过… · [明细](docs/todo-details/done-features-016.md)
- [x] **修复：切换窗口后文件选中状态丢失** — 当应用窗口失去焦点（切换到其他程序）再切回来时，之前在文件列表中选中的文件变为未选中状态 · [明细](docs/todo-details/done-features-017.md)
- [x] **支持 PDF 预览** — 当前 `.pdf` 不在预览支持范围，选中会显示「暂不支持预览该格式」占位 · [明细](docs/todo-details/done-features-018.md)
- [x] **支持 doc / docx 文件预览** — 当前 `.doc`/`.docx` 不在预览支持范围，选中会显示「暂不支持预览该格式」占位 · [明细](docs/todo-details/done-features-019.md)
- [x] **删除失败（需管理员权限）时让用户选择是否提权重试** — 当前删除链路为 `FilePanel.vue:onDelete` → `deleteToTrash(fullPath)` → 后端 `delete_to_trash`（`src-tauri/src/l… · [明细](docs/todo-details/done-features-020.md)
- [x] **文件名排序支持「自然排序（数字优先按数值）」** — 当前按名称排序用 `FileList.vue:222` 的 `a.name.toLowerCase().localeCompare(b.name.toLowerCase())`，这是**纯字典序**（… · [明细](docs/todo-details/done-features-021.md)
- [x] **修复：视频播完自动续播时未真正自动播放（仅切换预览、停在暂停态）** — 这是 #33「视频播放完自动播放下一个」的**回归/未真正接上**项 · [明细](docs/todo-details/done-features-022.md)
- [x] **H.265/HEVC 视频「有声音没图像」自动引导系统播放器（方案①）** — 用户文件 `爱莉希雅 (2).MP4` 编码为 HVC1(=HEVC/H.265)+AAC · [明细](docs/todo-details/done-features-023.md)
- [x] **配置菜单：可配置文本预览后缀（预留更多配置项）** — 新增一个「设置 / 配置」菜单项（菜单入口可位于工具栏或右键/标题栏下拉） · [明细](docs/todo-details/done-features-024.md)
- [x] **修复：移动/拷贝 `root/a/a` 到 `root/` 时选「覆盖」导致 `root/a` 整目录丢失** — bug：源目录（如 `root/a/a`）移动/拷贝到 `root/` 时，目标路径 `root/a` 与已存在的父目录同名，前端/后端提示是否覆盖 · [明细](docs/todo-details/done-features-025.md)
- [x] **鼠标拖拽文件到目标文件夹（拖放移动）** — 在文件列表中用鼠标拖拽已选中的文件/文件夹（单个或 `Ctrl/Shift` 多选集合），落到目标文件夹上时视为「移动到该文件夹」（等同剪切+粘贴到目标） · [明细](docs/todo-details/done-features-026.md)
- [x] **启动性能优化（第二轮：收尾两项 + 一处回退）** — 第一轮已落地 splash MIN/FADE 250（运行时内联单一真源）+ `mammoth` 按需 `import()`（主 bundle 670→169.79 KB）+ `optimizeDep… · [明细](docs/todo-details/done-features-027.md)
- [x] **回退：启动期配置「9 次 `load_config` 合并为 1 次 `load_configs`」** — 曾实现（后端一次 `read_dir` 读回全部 `~/.minitc/*.json` + 前端 `primeConfigs()` 缓存 + `loadConfig` 内部 await 该 in-fl… · [明细](docs/todo-details/done-features-028.md)
- [x] **修：splash 在加载完成后仍白等约 160ms（MIN_SHOW 计时起点错了）** — 用户指出「splash 应该尽早展示、其余事情并行做，而不是加载完成后还硬撑一段时间」，方向完全正确，启动 log 随即证实确有 bug · [明细](docs/todo-details/done-features-029.md)
- [x] **导航前进 / 后退（Alt+← / Alt+→）** — 目前只能 Backspace 退回父目录，进入深层目录后无法原路返回，也没有「前进」 · [明细](docs/todo-details/done-features-030.md)
- [x] **视图状态持久化（显示隐藏文件 / 列宽 / 默认排序 / 预览开关）** — ~~现在只有 Tab 的 `path` + `sortColumn` + `sortDirection` 随 `tabs-left`/`tabs-right` 持久化（`FilePanel.vue:2… · [明细](docs/todo-details/done-features-031.md)
- [x] **修复：按空格统计的目录大小在窗口失焦再回来后丢失** — 用户实测：对目录按 `Space`（`list.dirSize` → `getDirSize`）统计出占用空间并显示在 Size 列后，**切到别的程序再切回 mini-tc，统计结果被清空变回空白*… · [明细](docs/todo-details/done-features-032.md)
- [x] **可执行文件右键菜单增加「以管理员身份运行」** — 当前右键菜单只对压缩包提供外部工具调用（见「右键菜单调用 7-Zip 等外部压缩工具解压」），对 `.exe` / `.bat` / `.cmd` / `.msi` / `.lnk`(指向可执行文件)… · [明细](docs/todo-details/done-features-033.md)
- [x] **批量重命名工具（Ctrl+M）** — 选中多个文件/文件夹后弹出重命名面板：左侧当前名、右侧实时预览新名（非法名 / 重名标红），支持模式：查找替换（区分大小写 / 正则）、序号占位（`[N]` 起始值 / 步长 / 位数）、前后缀插入、… · [明细](docs/todo-details/done-features-034.md)
- [x] **目录书签 / 常用目录（Ctrl+D）** — 快速在深层目录间跳转 · [明细](docs/todo-details/done-features-035.md)
- [x] **递归文件搜索（Ctrl+F，TC 习惯 Alt+F7）** — 当前 `/` 只对**当前目录**做文件名模糊过滤，没有递归搜索，这是最大的操作能力缺口 · [明细](docs/todo-details/done-features-036.md)
- [x] **Ctrl+Z 回滚「最近一次删除到回收站」（可撤销删除）** — 当前 `Delete`（`list.delete` → `FilePanel.onDelete` → 后端 `delete_to_trash`）把文件送进回收站后就彻底没了交互出口：minitc 没有… · [明细](docs/todo-details/done-features-037.md)

## P0 — 数据丢失 / 崩溃 / 安全

- [x] **修复：mammoth 预览的 `v-html` 净化器是黑名单且漏 `data:` URL，配合 `csp: null` 可在 Tauri 源上执行脚本** — `FilePreview.vue:386-409` + `tauri.conf.json:27` · 2026-10-14 · [明细](docs/todo-details/done-P0-001.md)
- [x] **修复：合并移动时用户选的「不覆盖」被忽略，且跳过的文件照样被删源** — `lib.rs:2052/2065/2078/2092` · 2026-10-11 · [明细](docs/todo-details/done-P0-002.md)
- [x] **修复：复制跟随目录联接（junction）无限嵌套** — ⚠️ **本条的原始描述三条全错，已按实测修正** · 2026-10-11 · [明细](docs/todo-details/done-P0-003.md)
- [x] **修复：覆盖不是原子的 —— 目标在「计划阶段」就被删，随后直接 `File::create` 原地写入** — `lib.rs:1868` / `1904` / `1772` · 2026-10-12 · [明细](docs/todo-details/done-P0-004.md)
- [x] **修复：预览加载无请求序号，旧结果覆盖新文件 + blob URL 泄漏** — `FilePreview.vue`（`loadPreview` / `loadHeicPreview` / `loadDocxPreview` 全程无 token，grep `loadToken|lo… · 2026-10-12 · [明细](docs/todo-details/done-P0-005.md)
- [x] **修复：选中态是下标，排序/过滤一变就指向别的文件 → 删错、改名错** — `FileList.vue:198-200` + `1444` · [明细](docs/todo-details/done-P0-006.md)
- [x] **修复：`pendingAutoplay` 在多条路径上泄漏，用户手动选的视频会自己开始播** — `VideoPreview.vue:341/655` · 2026-10-13 · [明细](docs/todo-details/done-P0-007.md)
- [x] **修复：批量重命名执行中规则表单仍可编辑，`applied` 回传的 pairs 与磁盘实际结果不一致** — `BatchRenameDialog.vue:186-202` · 2026-10-13 · [明细](docs/todo-details/done-P0-008.md)
- [x] **修复：`save_config` 是全部用户配置的落盘通道，却用裸 `fs::write`（非原子、无串行化）** — `lib.rs:2225` · 2026-10-13 · [明细](docs/todo-details/done-P0-009.md)
- [x] **修复：`extract_archive` / `add_to_archive` 直接执行前端传来的 `tool_exe`，等价于任意程序执行** — `lib.rs:2949` / `3152` · 2026-10-14 · [明细](docs/todo-details/done-P0-010.md)

## P1 — 真 bug / 竞态 / 泄漏 / 明显性能

- [x] **修复：`FileList.onKeydown` 缺 IME 守卫，中文输入会触发列表快捷键** — 原 `FileList.vue:862-866` · 2026-10-19 · [明细](docs/todo-details/done-P1-001.md)
- [x] **修复：永久删除里「是目录」判断在 `symlink_metadata` 下恒为 false → 指向目录的符号链接永远删不掉** — 原 `lib.rs:1173-1182` · 2026-10-13 · [明细](docs/todo-details/done-P1-002.md)
- [x] **修复：`loadDirectory` 无请求序号，先发后到的旧目录结果覆盖新目录并污染 tabCache** — `FilePanel.vue:1005-1072` · 2026-10-12 · [明细](docs/todo-details/done-P1-003.md)
- [x] **修复：行 `:key` 用 `entry.name`，虚拟目录必然撞键** — `FileList.vue:100-101` · [明细](docs/todo-details/done-P1-004.md)
- [x] **修复：`formatSize`/`formatBytes` 多份实现，其中两份缺上限 clamp → 超 1TB 显示 `"undefined"`** — 原 TODO 写「四份」，实测是 **8 份**（`App.vue`、`FileList.vue`、`FilePanel.vue`、`FilePreview.vue`、`PathBar.vue`、`S… · 2026-10-14 · [明细](docs/todo-details/done-P1-005.md)
- [x] **修复：预览状态的两个 watcher 在 `await` 后无条件写 preview，快速方向键会预览到旧文件** — 原 `App.vue` 的两个 `watch`、`showFilePreview`、`playNextVideo`、`togglePreview` · 2026-10-14 · [明细](docs/todo-details/done-P1-006.md)
- [x] **修复：`onDelete` 循环内每次 `await` 之后重新读 `activeTab.value.path` 与 `entries.value`** — 原 `FilePanel.vue:onDelete` · 2026-10-15 · [明细](docs/todo-details/done-P1-007.md)
- [x] **修复：`onCtxMenu` 三个 await 之间无守卫，慢的旧右键接管新右键的菜单** — `FilePanel.vue` 的 `onCtxMenu`（原 1765-1785） · 2026-10-19 · [明细](docs/todo-details/done-P1-008.md)
- [x] **修复：`VideoPreview.loadVideo()` 与 `detectSubtitles()` 无并发守卫 → 字幕串台** — 已修（2026-10-19） · 2026-10-19 · [明细](docs/todo-details/done-P1-009.md)
- [x] **审计项（不修）：`renamingIndex` 不随列表变化重置，内联改名可能改到别的文件** — `FileList.vue:242` / `255-291`（现址） · 2026-10-19 · [明细](docs/todo-details/done-P1-010.md)
- [x] **修复：`F2` 改名时输入字母变成「搜索」—— IME 合成开始时焦点被无条件抢到过滤框** — `FileList.vue` 的 `onCompositionStart`（原 700-704）判据用「焦点在不在搜索框」而非「合成从哪儿开始」 · 2026-11-04 · [明细](docs/todo-details/done-P1-011.md)

## P2 — 可维护性 / 重复实现 / 测试缺口

- [x] **修：`BatchRenameDialog` 序号输入框清空时 `v-model.number` 得 `""` 被当成 0 而非回落到默认** — `renameRules.js:141-148` · 2026-10-16 · [明细](docs/todo-details/done-P2-001.md)
- [x] **收敛：`expand_env_vars` 遇未闭合 `%` 会把路径剩余部分整段丢掉** — `lib.rs:322-349` · 2026-10-14 · [明细](docs/todo-details/done-P2-002.md)
- [x] **收敛：`edit.selectAll` 的输入框守卫只判 INPUT，漏 TEXTAREA / contenteditable** — `App.vue:2141-2147`（Ctrl+A）vs `2160-2164`（Ctrl+C/X/V）/ `2108`（Esc）/ `2350`/`2382`（bookmark.toggle / … · 2026-10-16 · [明细](docs/todo-details/done-P2-003.md)
- [x] **修复：全局 keydown 监听器注册在 `onMounted` 匿名函数里，`onUnmounted` 无法移除** — `App.vue:2078` ↔ `2433` · 2026-10-19 · [明细](docs/todo-details/done-P2-004.md)
- [x] **修：`dev.bat` / `dev.sh` 选 Node 取字典序第一个 → 永远用最旧的那个，而不是最新的** — `dev.bat:30-36` + `dev.sh:60-81` · 2026-10-16 · [明细](docs/todo-details/done-P2-005.md)
- [x] **文件夹内重复文件去重：扫描出内容相同的文件，确认后删除多余的** — 菜单栏「重复文件」打开对话框，对**当前目录**（可选递归子目录）做内容去重：找出内容完全相同的文件，分组列出让用户确认，**确认后**才把每组多余的副本移入回收站 · [明细](docs/todo-details/done-P2-006.md)

## 审计结论 — 2026-11-04 清单审查（已失效 / 判定不做）

> 从 `TODO.md` 移出，**不是已完成**：① 已修完或被代码证伪；② 复核后判定属于过度优化、
> 理论防御、大规模重构，不值得改。对应 `docs/todo-details/open-*.md` 原样保留作取证留档；
> 半条归档的只在主清单留前半，明细仍含全文。纪律见 `TODO.md` 头部。

### 已修完 / 已失效（漏迁残条）

- [x] **审计项（已失效）：docx 净化器漏 `data:` URL 与 SVG/MathML 命名空间**（原 P2-021）— 已由 P0-001 修复：`src/docxSanitize.js` 改用 DOMPurify 白名单，`ALLOWED_URI_REGEXP` 排除 `data:`，`FORBID_TAGS` 含 svg/math、`FORBID_ATTR` 含 `xlink:href`；`docx-sanitize-check.mjs` 已挂 `npm test` · 2026-11-04
- [x] **审计项（已失效）：前端测试套件没挂 npm script**（原 P2-023）— `npm test` 现挂 24 个脚本，`npm run check` 为 lint:imports → check:sfc → test 三道关；仅「无 prebuild」属可选偏好，不再作为待办 · 2026-11-04

### 已被明细自证推翻 / 有意设计

- [x] **审计项（不修）：「`list_drives` 在全局锁内跑完 A–Z 探测」是疏漏**（原 P1-010 明细内粘着的第二问）— `lib.rs:235-240` 注释与 INTERNALS.md 均论证为有意权衡（避免两块面板同 tick 重复全量探测），照原文「修」反而引入两次探测窗口 · 2026-11-04
- [x] **审计项（不成立）：`normDir("/")` 导致 marked 误判、sanitize 用空串去重**（原 P1-019）— `BookmarkMenu.vue:241-243` 有非空守卫、`bookmarks.js:64-65` 在算 key 前就丢空路径；仅盘根 `parentDirOf` 漏过滤成立，已降 P2 · 2026-11-04
- [x] **审计项（标题夸大）：帧检测「每次播放」做 4K `getImageData`**（原 P1-031）— 明细自证 canvas 回读只是 2 秒超时兜底，正常播放走 `requestVideoFrameCallback`；修法仍有效，已降 P2 · 2026-11-04
- [x] **审计项（已修）：「搜索」把整棵树一次性物化到 Vec**（原 P2-007 的三分之一）— 现为逐目录物化 + 边走边发 + 5 万上限；另两处仍成立，标题已改写 · 2026-11-04
- [x] **审计项（计数有误）：P1-029 的「40 键 / 4 个字符串 / 每帧都在付」** — 明细 2026-10-19 复核为 50 键、2 字符串 + 1~2 个 options；只保留 ④ `scrollToRow` · 2026-11-04

### 判定不做：过度优化（用户无感知，改动风险大于收益）

- [x] **审计项（不修）：复制路径上的死参数、重复分配、重复 stat**（原 P2-008）— 明细自写「单条都不致命」，理由仅为「与该文件性能取向自相矛盾」 · 2026-11-04
- [x] **审计项（不修）：`.vp-buttons` 在同一个 `<style scoped>` 写两遍**（原 P2-019）— 明细自写「目前靠 CSS 层叠侥幸正常」，当前零 bug；样式可直接合并，不占条目 · 2026-11-04
- [x] **审计项（不修）：`preloadOtherTabs` 的 `tabCache` 从不淘汰**（原 P1-014）— 明细自算 10 tab × 5 万条 ≈ 数十 MB 常驻，且切回时本就会丢弃重来；桌面应用可接受 · 2026-11-04
- [x] **审计项（不修）：`bindingsOf` 每次按键重建数组 / 加 memo**（原 P1-022 后半）— 一次按键约 20 次 map + normalize，纳秒级；前半「非数组静默解绑 + 无上限」已留 P1 · 2026-11-04
- [x] **审计项（不修）：`SearchDialog` 的 `hits` 深度响应式 / `iconOf` 每行 `Object.keys`**（原 P1-028 后半）— 渲染微优化；前半「hits 无上限」已留 P1 · 2026-11-04
- [x] **审计项（不修）：大列表热路径的 `getFileIcon` 对象、`Intl` formatter、排序比较器**（原 P1-029 ①②③）— 教科书式微优化，仅 5000 行极端目录才有意义 · 2026-11-04
- [x] **审计项（不修）：`emit_progress` 的 `let _ =` 丢弃 emit 错误**（原 P2-006）— 只在窗口正在关闭 / webview 崩了时复制没进度，边缘；抽 `emit_or_log` 统一三处收益不足 · 2026-11-04
- [x] **审计项（不修）：统一全文件四种 Mutex 中毒写法**（原 P2-003 后半）— 洁癖；仅 `window_state` 两处静默 return 补日志留 P2 · 2026-11-04
- [x] **审计项（不修）：`SearchDialog.onMounted` 的 `await listen()` 期间卸载导致监听器泄漏**（原 P1-026）— 需「打开后几毫秒内关闭」的极窄窗口 · 2026-11-04
- [x] **审计项（不修）：POSIX 根目录 / 硬编码反斜杠的全量跨平台收敛**（原 P1-019、P2-010/011 相关部分）— Windows 单机使用，收益低；盘符根过滤器失效等实际场景已留 P2 · 2026-11-04

### 判定不做：一次性大重构（已缩小为小修）

- [x] **审计项（不修）：抽 `configStore` 工厂统一 10 处 config**（原 P2-002 的工厂部分）— 只修两处真实漂移（空 catch / 缺防抖），已改写 · 2026-11-04
- [x] **审计项（不修）：15+ 个重复函数的全量收敛**（原 P2-001 的全量部分）— 只合并已出现行为差异的，已改写 · 2026-11-04
- [x] **审计项（不修）：数据丢失路径全量集成测试**（原 P2-022 的 ②③④）— 只补 `plan_overwrite` 表驱动 9 组合，已改写 · 2026-11-04
