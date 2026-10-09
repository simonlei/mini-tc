# mini-tc

<p align="center">
  <img src="mini-tc-poster_assets/8193b8d0-miora_text_to_image-1789187746977-0-407594159234.jpg" alt="mini-tc — A cross-platform dual-pane file manager" width="900" />
</p>

<p align="center"><em>基于 Tauri 2 + Vue 3 的跨平台双栏文件管理器，致敬 Total Commander。</em></p>

---

## 功能

- 左右双栏布局，可拖拽调整面板宽度（比例会被记住，下次启动保持，双击分隔条复位）
- 每栏独立多 Tab 管理，Tab 状态自动持久化
- 可编辑路径栏 + 盘符下拉切换
- 文件列表按名称 / 大小 / 修改时间排序（名称排序时：忽略连字符 `-`，如 `-1a.txt` 按 `1a.txt` 比较；中文字符排在数字与英文字母之后，如 `0.txt` < `a.txt` < `推特.txt`；数字段按数值自然排序，`1a.jpg` < `2c.jpg` < `10b.jpg`）
- **启动屏（splash）**：冷启动时全屏 logo + 三点循环加载。展示**至少 250ms**，并等左右两栏首次列目录都完成才淡出（250ms），另有 2500ms 硬兜底防止慢目录/网络盘把用户堵在加载页；常量 `SPLASH_MIN_SHOW_MS` / `SPLASH_FADE_MS` / `SPLASH_MAX_SHOW_MS` 在 `src/main.js` 顶部，其中淡出时长由 JS 在运行时内联写入 `transitionDuration`，是单一真源（`index.html` 里的 CSS 只是兜底，别再两处各写一份）
- **启动耗时埋点**：`src/bootLog.js` + 后端 `boot_mark` / `boot_timings` 命令，开发模式下 devtools 控制台会打印两张 `console.table`（JS 阶段 / Rust 阶段，共用同一时钟可直接对齐），Rust 侧另有 `[boot] ... ms` 逐行输出到控制台窗口。用 `localStorage.setItem("minitc-boot-log", "off")` 可关闭
- **启动路径上的三处瘦身**（实测大头是 Tauri 固有的 WebView2 `setup`，JS 侧能砍的主要是重复 IPC 与无谓排序）：
  - **配置批量预载**：启动要读 theme / text-preview / app-config / shortcuts / bookmarks / panel-split / view-state + 每栏 tabs-\* 共 9 份 `~/.minitc/*.json`，原本是 9 次独立 `load_config` 往返，而首屏列目录就卡在其中一次上。改为后端 `load_configs()` 一次 `read_dir` 全部读回，前端 `api.js` 用 `primeConfigs()` 在 `mount()` 之前启动（**不 await**）并缓存；`loadConfig` 内部会等这个 in-flight promise，所以子组件先于父组件 `onMounted` 跑也没问题，调用点无需改动。`saveConfig` 会回写缓存；读取失败时缓存置 `null` 退回逐文件 IPC，**不会把一次瞬时失败缓存成「配置全丢」**
  - **驱动器列表缓存**：后端 `list_drives` 要遍历 A–Z 逐个 `Path::exists` + 对应答的卷调 `GetDiskFreeSpaceExW`（空光驱、断连网络盘可阻塞数百 ms），而左右两栏在 mount 和**每次窗口重新获得焦点**时都会各调一次 —— 一次切窗就是 4 次走盘。现由后端 `OnceLock<Mutex<..>>` 缓存、TTL 2 秒。**锁要持跨越探测本身**：两栏的请求在同一 tick 发出，只包缓存检查的话它俩会双双 miss 各跑一遍全盘扫描
  - **`list_directory` 不再排序**：前端 `sortedEntries` 对除 `found`（搜索顺序，仅搜索结果伪目录有意义）外的所有列都会重排，后端排的序必被丢弃，而那个比较器每次比较要 `to_lowercase()` 两次 = O(n log n) 次堆分配，故直接删掉
  - 前两条已合并进本轮改动；第三条（`list_directory` 每条目 stat 两次 → 改 `entry.metadata()`）在实现递归搜索时已顺带修掉
- **文件预览**（Ctrl+Q）：文本（txt/md/json/log）、图片（jpg/png/gif/webp/bmp/svg/avif）、HEIC 系列（heic/heif/hif/avci）和 PDF/doc/docx；图片经 asset protocol 直接加载，无大小限制；文本预览区内可拖选文字按 Ctrl+C 复制，或点 footer「复制全部」复制整篇
  - **HEIC/HEIF 预览**：WebView2 无原生 HEIC 解码器，走 `src/heicDecoder.js` + `src/heicDecode.worker.js` —— Worker 里用 **libheif 的 WebAssembly 版**解码成 RGBA，主线程再 canvas 编成 JPEG 交给 `<img>`，图上标注「已转换为 JPEG」。wasm 约 2 MB，按需加载（`?worker` 导入 + `optimizeDeps.include` 登记），启动不受影响。设了两道防爆上限：单文件 60 MB、解码后 5000 万像素（12MP 手机照片约需 48.8 MB RGBA 缓冲）
  - **⚠️ 像素上限必须在 Worker 里 `display()` 之前判**（曾踩坑）：原本上限是在 `decodeHeic()` 返回之后才检查的，可那时 `display()` 早已跑完 —— 实测一张 12240×16320 的文件**先烧掉 4.4 s / 762 MB RGBA / 2.1 GB RSS，然后才弹「已跳过预览」**，上限等于没设。现在上限由 `heicDecoder.js` 的 `MAX_HEIC_PIXELS` 经 postMessage 传进 Worker，在分配像素缓冲前拦截
  - **超大图回退到容器内嵌的缩小版**：超限时先在容器里找同图的内嵌预览，找不到才拒绝。HEIC 的 **grid 派生图**会把这事变成刚需：主图是 N×M 个 tile 拼成的马赛克（每个 tile 是独立的隐藏 item），所以能出现「3 MB 文件装 200 MP」。实测用户那份 `P (3).HEIC` 有 **768 个 512×512 tile 拼成 16320×12240**（`irot` 转 90° 后显示 12240×16320），全量解码要 762 MB；改用 item 770 内嵌的 384×512 缩小版后 **4.4 s / 762 MB → 56 ms / 0.8 MB**。筛选条件：跳过 top-level id、跳过 hidden item（否则会取到拼图碎片）、跳过 `Exif/mime/uri`、像素数 ≥64K 且 ≤上限、**长宽比与主图差 ≤2%**（挡掉深度图 / alpha 平面），多候选取像素最多者，扫描上限 2048 个 item 防病态文件。命中降级时图上标注「原图 WxH 过大，已显示内嵌预览图」
  - **多帧 HEIC 播放（canvas）**：容器里有多个 top-level 图元时（连拍 / 序列 / Live Photo）走动画播放，`<canvas>` + `putImageData` 逐帧绘制（不用 `<img>`：换 src 会闪且每帧泄漏一个 objectURL）。首帧随初始解码一起返回，UI 立即有画面；其余帧**按需向 Worker 索取**（`decodeHeicFrame(index)`），Worker 缓存已解析的容器避免每次重解析（实测 19 ms/次）。**帧率不靠猜**：读每帧的 `heif_image_get_duration()`，真有时序就按真实速度播，只有文件完全没有时序数据时才回落 100 ms/帧。底部有播放/暂停按钮和 `当前/总帧数` 计数；换文件与组件卸载都会停掉循环
    - 🚨 **循环令牌（`animToken`）必做**：`clearTimeout` 只能杀当前那个定时器，若某帧正在 `await` 解码，换文件时它回来后还会继续调 `decodeHeicFrame()`，对着 Worker 里已被替换的容器反复取帧 —— 表现为方向键快速切文件后 canvas 自己乱跳。每次启停递增令牌，旧循环回来一比对即退出。帧解码失败时**结束循环而非空转**，否则卡在同一帧反复报错
  - **为什么不用 heic2any**（已移除）：它内嵌的是 emscripten **asm.js** 版 libheif，YUV→RGBA 转换跑在 JS 解释器上。实测 12MP 手机照片中位数：**asm.js 1047 ms vs wasm 422 ms（2.5x）**。⚠️ `libheif-js` 的 package.json `main` 指向的正是 asm.js 版（`libheif/libheif.js`），必须显式引 `libheif-wasm/libheif-bundle.mjs` 才拿到 wasm
  - **HEIC 耗时诊断**：每次预览在 devtools 控制台打一张折叠表（`[heic] <文件名> <总耗时> ms`），分 `start / file-read / worker-decode / encoded / ready / painted` 六步，**每文件一张**可左右对比。`worker-decode` 的 note 里进一步拆出 `hevc=Xms`（比特流解码）和 `rgba=Yms`（颜色转换）。失败、翻页中断、超限中止三种情况也会补打（末行标 `failed` / `interrupted` / `aborted`）；多帧文件在 `ready` 步显示 `frame 1/N`
  - **⚠️ libheif-js 的 embind 调用约定（实测，别猜）**：高层 `HeifDecoder.decode()` 拿到的 `HeifImage` 有 `.handle`（原生 handle）和 decoder 的 `.decoder`（`heif_context`），可直接调 `heif_item_get_item_type` / `heif_item_is_item_hidden` / `heif_js_context_get_image_handle(ctx,id)` / `heif_image_handle_release`。但**返回 struct 的函数分两类**：`heif_context_read_from_memory(ctx, buf)`、`heif_context_has_sequence(ctx)` 这类已被 embind 封装，正常传参、返回 `{code, subcode, message}`；而 `heif_image_handle_get_image_tiling` / `decode_image_tile` 等裸导出**必须自己 `_malloc` 传隐藏 sret 指针**再从 `HEAP32` 读，少传会静默返回垃圾值而不报错 —— 极易误判成「API 不可用」（grid 分块解码就走不通这条路，只能靠内嵌缩小版绕过）
  - **⚠️ 剩余慢点**：换成 wasm 后 12MP 仍需约 420 ms，**瓶颈依然是全尺寸 YUV420→RGBA 转换**（HEVC 比特流解码只占 2–10 ms）。根治要靠降采样，但 libheif-js 的高层 API 不暴露尺寸参数（C API 有 `heif_image_scale_image`，但如上所述在 embind 下调不通）。后端 Rust `libheif-rs` 有干净的 `HeifDecodingOptions::max_width`，是后续方向
- **视频预览**：`mp4/webm/ogv/mov/m4v` 等由 WebView 直接解码（含字幕自动探测同目录 `srt/vtt/ass`、外挂字幕、±0.5s 偏移微调、倍速、音量记忆）；`mkv/avi/flv/wmv/rmvb` 等无法解码的格式自动回退「用系统播放器打开」，HEVC/H.265 这类「有声音没画面」的情况也会自动识别并回退。控制栏中**进度条常驻**（随时可见当前位置、可拖动 seek），仅下方按钮行在播放 3 秒后自动收起，鼠标移回底部或暂停时立即恢复
  - **预览时窗口置顶**（配置 → 通用设置，**默认关闭**）：开启后播放视频预览时 MiniTC 窗口保持在所有窗口之上，关闭预览（Esc / 切换到别的文件 / 关掉面板）后自动还原层级。⚠️ 置顶是**操作系统窗口级**属性，所以浮起来的是**整个 MiniTC 窗口**（含文件列表），不是只有视频画面那一块——浏览器没有任何 API 能把单个 DOM 元素抬到其他程序窗口之上，想做到「只有视频浮在最上层」必须把播放器拆成独立的置顶窗口。置顶联动由一个 `watch` 驱动 `src/alwaysOnTop.js`（对 ↑/↓ 切片、面板切换、自动连播、Esc 全部自动生效，且做了状态去重与失败回滚），退出时强制还原以免留下置顶窗口。
- **通用设置**（配置 → 通用设置）：应用级配置项的独立页面，与「文件预览设置」（只管单个文件怎么渲染）和「快捷键设置」并列。配置项以声明式 schema（`GeneralSettingsDialog.vue` 顶部的 `GROUPS` 数组，分组 + 行，行类型 `toggle` / `select`）声明，新增一项只需加一个对象，UI 渲染 / 持久化 / 缺省回退自动获得。按 key 前缀分流存储：`view.*` 开头的行归 `viewState.js`（`~/.minitc/view-state.json`），其余归 `~/.minitc/app-config.json`，所以对话框不必知道某行属于哪个 store
- **视图状态持久化**（`~/.minitc/view-state.json`，模块级单例 `src/viewState.js`，150ms 防抖写盘）：记住「文件列表长什么样、怎么排」这类偏好，重启后自动恢复
  - **显示隐藏文件**（`Ctrl+H`，或通用设置 → 视图里左/右栏各自一个开关）：默认**不显示**点开头的名称与隐藏/系统属性文件。后端始终全量返回，过滤纯在前端做，所以切换是**瞬时**的（上万项的目录也不会重新列目录）。**左右栏独立**——双栏本来用于对比，「左边看点文件、右边看干净的」是正当诉求。显示出来的隐藏文件仍保持半透明（不然看着像 bug）。⚠️ 过滤会整体平移行号，故选中集合按**条目对象身份**（不是下标）迁移到新列表——否则切换时第 3 行的选中会静默变成另一个文件，而它正是预览/重命名/删除的操作目标
  - **列宽可拖拽**：Name / Size / Type / Modified 四列表头右侧都有手柄，拖动实时改变宽度，**双击手柄恢复该列默认宽度**；写盘防抖，所以拖动过程不会每帧写一次。列宽**左右栏共用**（300px 的 Size 列在两栏是同一件事，分开只会像 bug）。四列宽度都是**字面宽度**，面板多出来的空间留成右侧空白（与资源管理器一致），所以拖出来的宽度在任何面板宽度下都保持原样——Name 列也是可调的，长文件名被截断时可以直接拉宽
  - **窗口缩小时的降级优先级**：**Size / Type / Modified 优先保证完整显示，文件名栏承担全部让步**（缩窄→ 省略号 → 归零），因为文件名在地址栏还能看到，而被截掉的时间列丢的是用户明确设过的信息。面板宽到连三栏都放不下时，三栏才按同一比例等比缩小（各自有可读下限：Size 60 / Type 48 / Modified 96），并且 Name 先归零。**这些都是渲染时的临时调整，存储的设定值一个字节都不动**——窗口拉回去立刻恢复原样。拖拽起始宽度取的是**存储值**而非实测宽度，否则窗口缩小后 Name 会被永久卡在挤扁后的尺寸、再也拖不宽
  - **新标签页默认排序**：新建 tab 时按此处的列 + 方向打开。**故意不追溯重排已有 tab**——每个 tab 的排序存在自己的 `tabs-<id>.json` 里，用户已经摆好的 tab 被静默重排是惊吓
  - **预览开关**：退出时开着预览（图片/文本/视频）则**重启后自动恢复**，并把源列表设为活动栏、重新选中该文件，于是 Esc / Ctrl+Q 的行为与「从未关闭过预览」完全一致。文件在关闭期间被删则跳过恢复。「格式不支持」占位页不恢复（没有内容可显示）。恢复会等两栏都完成首次列目录，避免预览盖住空面板
  - 配置被改坏也不会出问题：列宽按上下限夹取、非有限值落回默认，排序列必须是已知键，损坏的 JSON 只丢该项、其余照常生效
- 4 套内置主题（石墨工业 / 霓虹暗夜 / 暖茶拿铁 / 墨竹青翠）
- **Tab 切换左右面板**（与 Total Commander 一致）：焦点在文件列表时按光标 `Tab` 即在左/右栏之间跳转，切换后键盘焦点交给新面板，方向键直接接着操作。焦点不在文件列表上（地址栏 / 文件名过滤 / 内联改名 / 对话框 / 右键菜单）时 `Tab` 保持浏览器的原生焦点切换行为不被抢走
- **多标签页快捷键**（与 Total Commander 一致）：`Ctrl+T` 在**当前活动面板**按当前目录新开一个标签页，`Ctrl+W` 关闭该面板的当前标签页（仅剩一个时无操作，不会把最后一栏关掉），`Ctrl+Tab` / `Ctrl+Shift+Tab` 在该面板的标签页之间**轮换**（到底后回到第一个，环绕不卡住）。四者都在地址栏 / 文件名过滤框获得焦点时同样生效，且执行后键盘焦点自动交回文件列表，方向键可直接操作新标签页。轮换成功时会弹一条 toast 报出落点路径；只有一个标签页时静默忽略。左右栏各轮各的，互不影响
- **标签页锁定 / 一键回到锁定位置**（对应 TC 的「锁定，但允许更改文件夹」）：`Ctrl+Shift+L` 把当前标签页的所在目录记为**锁定锚点**（已锁定时再按一次解除），`Ctrl+Y` 把该标签页跳回锚点。⚠️ 锁定**不阻止目录切换**——标签页仍可自由进出任何目录，锁定的只是「回家的路」，这点与 TC 一致（TC 另有 `Ctrl+Num*` 的严格锁定，即禁止换目录，本应用未实现）。标签栏上已锁定的标签显示 🔒 并染上淡色底，悬停提示里同时给出当前路径与锁定路径；**在标签页上右键**弹出菜单：锁定当前位置 / 回到锁定位置 / 以当前目录重新锁定 / 关闭此标签页。锁定锚点随标签页一起持久化到 `~/.minitc/tabs-<panelId>.json`，重启后依然有效（旧存档无该字段即视为未锁定）
- **导航前进 / 后退**（`Alt+←` / `Alt+→`，浏览器式）：每个标签页维护**自己独立**的目录历史栈，左右栏、各标签页互不干扰（与 TC 的每面板历史一致）。历史栈随标签页一起持久化到 `~/.minitc/tabs-<panelId>.json`，**重启后仍能往回走**；每档上限 100 条，超出丢弃最旧的。地址栏上有 `←` / `→` 两个按钮可点，无历史可走时置灰但不隐藏（避免工具栏跳动），tooltip 说明原因。
- 标准 history 语义：新导航会**截断前进分支**（往回走两步后走进新目录，原来的「前进」就没了）；后退 / 前进回到某个目录时会**顺带选中刚离开的那个文件夹**，与浏览器一致。已删除的目录（或已拔掉的盘）在回退途中会被**自动从栈里剔除**并继续往更早的方向找，不会把面板卡在报错页——剔除了几个会弹 toast 说明。
- **鼠标侧键同义**：XButton1（后退）/ XButton2（前进）走的是同一套历史栈，**不再是「返回上一级」**——上一级仍由 `Backspace` / 双击 `..` 负责，两者语义不再混淆。仅活动面板响应。
- **目录书签 / 常用目录**（`Ctrl+D`）：把当前目录收进一份**全局共用**的常用目录列表，一键跳回深层路径，不用每次逐层点进去或临时开标签页。地址栏上的星标按钮打开下拉，点击书签即跳到**当前活动面板**；`Ctrl+D` 是开关式——加了再按一次就移除，并弹 toast 报出结果。星标用 `☆`（空心、暗色）/ `★`（实心、主题色 + 同色边框）区分是否已收藏，**刻意不用 `⭐` emoji**：emoji 由彩色字体渲染成固定图形，`color` 对它无效，未收藏时也会一直显示成黄色。
  - 书签**有名字**，可在下拉里**行内改名**（回车提交 / Esc 取消），**右键**书签行弹出菜单重命名 / 上移 / 下移 / 删除；底部另有「添加当前目录」按钮，不记快捷键也能操作。**左右栏共用同一份列表**（模块级单例 + `~/.minitc/bookmarks.json`），任一栏加的书签另一栏立刻可见，且不占用任何标签页。
  - 与「标签页锁定」（`Ctrl+Shift+L`）是**两件不同的事**：锁定是「这个标签页记住一个回家的锚点」，锁完照样能自由浏览；书签是「全局一份带名字的常用目录」，不绑任何标签页。搜索结果标签页是虚拟目录，既隐藏 `⭐` 也不响应 `Ctrl+D`（快捷键直接落空，不被吃掉）。
  - **失效书签自动置灰**：目录被删或盘符被拔时，行内加删除线并在悬停提示里标明「目录已不存在」；点击时还会再验一次，宁可弹 toast 报错也不会把面板带进报错页。
  - **「最近访问」分区**列出本标签页最近走过的目录（倒序，最多 10 条，不含当前目录）。它**不额外落盘**，而是从该标签页自己的历史栈现算——历史栈已经持久化并且本来就在驱动 `Alt+←`，另存一份只会跟它不一致。
  - 两个面板各有一个下拉，共享一个「当前展开者」令牌，保证同时只会展开一个，不会出现两个下拉各带一层遮罩。菜单的 mousedown / Esc 监听走 **capture** 阶段（否则面板根节点的 `@click` 会抢先激活面板），Esc 还会 `stopPropagation` 以免连带触发「关闭预览」。
- **搜索结果标签页没有历史**：`minitc://search/{id}` 哨兵不是真实目录，按钮直接隐藏；从结果集跳进真实目录时**重新起一段历史**（不会把哨兵记成可回退的一站）。
- **右键上下文菜单**：在空白处右键可「新建目录」（在当前目录创建空文件夹，创建后可直接改名）；在文件/文件夹上右键可「打开」「复制路径」；对压缩包（zip/rar/7z/tar/gz/iso…）自动探测本机已安装的 **7-Zip / WinRAR / unzip**，提供「解压到当前文件夹」「解压到同名文件夹」入口，解压后自动刷新面板；**多选多个压缩包时按顺序逐个解压**（菜单标签显示「依次解压 N 个」，图形界面工具会等上一个窗口结束再启动下一个，不会一次弹出 N 个窗口），失败的压缩包在汇总提示里列出文件名，成功的部分照常生效
- **复制 / 剪切 / 粘贴**（Ctrl+C / Ctrl+X / Ctrl+V）：与系统剪贴板双向互通（Windows `CF_HDROP`，可与资源管理器互拷），支持多选批量与跨卷移动，拷贝过程带进度条；目标存在同名项时可选「跳过 / 覆盖」。
  - 覆盖策略（防数据丢失 + 目录合并）：同名**文件夹**冲突时采用**合并**（merge）而非整目录替换删除——例如把 `root/a/a` 移动/拷贝到 `root/`，其内容会并入已存在的 `root/a`（移动后 `root/a/a` 自身被清空移除），不会误删数据；同名**文件**冲突才按覆盖/跳过处理。仍拒绝真正危险的操作：把目录移动到自身内部（`root/a` → `root/a/b`）。跨卷移动若复制阶段出错则保留源文件不删除。
- **F5 复制到对面栏 / Shift+F5 移动到对面栏**（与 Total Commander 一致）：把**当前活动面板**的选中项直接送到**对面面板当前所在的目录**。与 `Ctrl+V` 是两条独立的路——`Ctrl+V` 只认系统剪贴板，F5/Shift+F5 完全不碰剪贴板（连复制都不写剪贴板），源目录与目标目录可以在任意两个盘符之间。执行后两个面板都自动刷新，键盘焦点留在**源面板**，可以继续按方向键操作原选中项。
  - 目标已有同名项时复用粘贴的冲突确认（跳过 / 覆盖），目录冲突同样是**合并**而非替换删除
  - 与拖拽一致地跳过无意义项：已经直接躺在目标目录里的文件不会被「移动到自身所在目录」
  - 两栏停在同一目录时直接提示「对面栏与当前栏在同一目录」，不做自我复制
  - 与其他 `F*` 快捷键（`F2` 重命名）一样可在**配置 → 快捷键设置**里改键；焦点在内联改名输入框内时 F5 不生效（那是文本框）
- **鼠标拖拽移动**（跨应用、跨进程）：直接用鼠标把文件/文件夹（单个或 Ctrl/Shift 多选集合）拖到目标文件夹、空白区（= 当前目录）或「..」（= 父目录）即可移动到该目录；支持**跨栏拖拽**（从左栏拖到右栏目录），**也支持直接拖到资源管理器 / QQ / 7-Zip 等外部应用**——接收方拿到的是真实文件（Windows 走 `CF_HDROP` + `Preferred DropEffect=DROPEFFECT_MOVE`，macOS 走 `NSFilenamesPboardType`），行为与从资源管理器拖出完全一致；外部往 mini-tc 拖入的文件则按复制（copy）处理，落到文件行上忽略。落点高亮提示，移动/复制后自动刷新源栏与目标栏，冲突处理与同名项合并策略复用粘贴逻辑。
  - ⚠️ **依赖 `tauri-plugin-drag`（CrabNebula 维护的 drag-rs）**：前端在文件行 `dragstart` 时调用 `startDrag({ item: 绝对路径, mode: 'move' })`，Rust 后端走 Windows 的 OLE `DoDragDrop` / macOS 的 `NSPasteboard` 直接写出 `CF_HDROP` / `NSFilenamesPboardType`。预览图标故意传一个无法解码的字节（0x00），让 drag-rs 跳过 `IDragSourceHelper::InitializeFromBitmap`，由 OS 从 `CF_HDROP` 自动渲染文件图标（多文件显示「多文件缩略图 + 数量」），行为与资源管理器完全一致；如果传了真实图标则会覆盖 OS 默认渲染，反而不如默认直观。Linux 下 drag-rs 需 GTK 应用窗口（winit 类不支持），跨进程拖出会失效，本项目不针对 Linux 保证。`dragDropEnabled: true` 让 Tauri 接管 webview 拖放，配合 `tauri://drag-enter / drag-over / drag-drop / drag-leave` 事件拿到光标坐标 + 文件路径；前端 `elementFromPoint(x, y)` 反推落点（目录行 / `..` / 空白区 / 文件行），自拖自时走 move（cut），外部拖入时走 copy。
- **递归文件搜索**（`Alt+F7`，`Ctrl+F` 同效，与 Total Commander 一致）：在任意根目录下按文件名递归查找，可在**当前活动面板**中直接跳转到结果所在目录并选中该文件。
  - 文件名语法沿用 TC：**分号分隔多个模式**（`*.txt;*.md`）、`*`/`?` 通配符、**不含通配符的普通词按「名字包含」匹配**、留空则列出全部。另有「区分大小写」「包含隐藏文件」两个开关。
  - 可选**内容搜索**：只保留文件内容里包含指定文字的条目；自动跳过二进制（前 4KB 含 NUL 字节）和大于 8MB 的文件，避免扫大文件拖慢整个遍历。
  - 后端 `start_search` 在**独立线程**里跑，结果以 `search-batch` 事件**分批流式**回传（每 200 条或 200ms 一批）；扫描期间另有 `search-progress`（约每 300ms）实时回传**已扫描条目数**和**当前正在扫描的目录**，状态栏据此显示「正在扫描：…」，不会出现「看起来卡住了其实在跑」；扫描结束发 `search-done`。界面全程可响应，随时可点「停止」取消（`cancel_search` 置标志位，线程在每个条目上检查）。新搜索会自动取消上一次未完成的扫描，旧结果不会串进新列表（每批结果带 `id` 校验）。
  - 结果列表是**虚拟滚动**的（只渲染可视行），上万条也不卡；默认上限 5000 条，达到上限状态栏会提示「结果已达上限」。
  - 双击 / 回车 = 跳转到该文件（对侧是预览时会自动先关掉预览）；右键菜单可「跳转到该文件」「打开所在目录」「复制完整路径」「用系统默认程序打开」。
  - 与 `/` 键的即时过滤是两种东西：`/` 只过滤**当前目录**、轻量即时；搜索面板是**跨目录递归**的重量级查找，两者并存。
  - 遍历只用 `DirEntry::metadata()`（Windows 上直接复用目录扫描已返回的 `WIN32_FIND_DATA`，**零额外系统调用**），不用 `fs::metadata(path)`——后者会对每个条目重新解析并打开一次文件。实测 4 782 个条目：373 ms vs 1.3 ms；`C:\Program Files` 递归 51 100 个条目：1.89 s vs 0.22 s。**列目录（`list_directory`）同样受益**：它原先每个条目要打两次系统调用（一次取属性、一次判隐藏属性），打开大目录明显变快。目录内排序用 `sort_by_cached_key`，每个名字只做一次小写化。
  - **模态行为**：搜索框打开期间是**真正的模态**——Esc 在 capture 阶段关闭它，其余按键一律**不穿透**到背后（否则在文件名框里按 `Backspace` 会让面板返回上级目录、按 `Delete` 会删文件、方向键会移动背后的光标）。关闭时（Esc / 点遮罩 / 跳转结果）焦点**精确归还**给打开前的那个元素：文件列表、地址栏或文件名过滤框，元素已失效时才回退到文件列表
  - **诊断日志**：每次搜索把完整轨迹写入 `%USERPROFILE%\.minitc\logs\search.log`（每次搜索覆盖，GUI 程序无控制台，日志是唯一可查的线索）。记录入口参数、进入的每个目录、每个命中、三种事件的 `emit` 结果（**`emit` 失败以前被 `let _ =` 吞掉**，日志里会明确写 `emit ... FAILED`）、`read_dir` 失败、以及汇总行（scanned / matched / 耗时）。搜索线程包在 `catch_unwind` 里，**panic 也会发 `search-done`**，Rust 的 panic 信息通过全局 hook 也写进同一文件。点对话框底部的「诊断日志」可显示该路径。
  - **「送到左栏 / 送到右栏」：把结果变成一个真正能干活的文件列表**（对标 TC 把查找结果送进文件面板）。点一下，当前这批结果会在目标栏开一个新标签页，**不是只读的结果表，而是能正常操作的目录列表**，于是可以：预览、打开、重命名、删除、`Ctrl+C/X`、`F5` / `Shift+F5` 传到对面栏、拖出到资源管理器 / 外部应用、按空格算目录大小、视频预览的上下曲切换，还能把外部文件**拖到结果里的某个子目录上**。
    - **搜索途中就能送**：不必等扫完，面板接管事件流继续接收后续批次，可以边扫边处理已出来的结果；此时地址栏显示「搜索中…」，对话框关闭**不会**取消扫描。只有「刷新」（↻）会重新跑一遍。
    - **虚拟目录的由来**：这类标签页的「路径」是一个哨兵字符串 `minitc://search/{id}`，不是真实文件夹。关键前提是**每个文件条目自带绝对路径**——原先所有操作都是「当前目录 + 文件名」拼绝对路径，对跨目录的搜索结果必然拼错。为此后端 `FileEntry` 增加了 `path` 字段，前端所有取绝对路径的地方统一走 `src/paths.js` 的 `entryPath()`（有条目路径时直接返回，省一次 IPC）。哨兵刻意长得像 URI scheme：不可能与盘符 / UNC 路径冲突，万一漏判也只是「路径明显不对」而非静默操作错目录。
    - **同名是常态**：同一个结果集里完全可能出现两个 `a.txt`（来自不同父目录），所以删除后移除行、剪切灰显、目录大小缓存这些**一律按绝对路径匹配**，不按文件名。
    - **排序**：默认「按搜索顺序」，即后端 DFS 流出的原始顺序（结果天然按所属目录聚在一起）；表头多一列「顺序」可点击切换，只在结果页出现。该排序返回的是**同一份数组引用**而非拷贝——流式追加批次时若重新排序或拷贝，行会在光标下跳动。
    - **做不到的操作会明确拒绝并提示**，不静默失败：粘贴（`Ctrl+V`）、拖到列表空白处（这两者没有真实目标目录）、新建目录、锁定标签页、返回上级（「结果列表没有上级目录」）。解压可用，但**每个压缩包解到它自己的父目录**（结果分散在多处，不能全解到同一个地方）。
    - **结果集标签页不持久化**：刷新一下就消失（与 TC 一致）。所以别把它当书签用——需要保留的搜索条件请用「重新搜索」（标签页右键菜单里也有）。
- **删除 / 永久删除**：`Delete`（`Ctrl/Cmd+Backspace` 同效）移入系统回收站；**`Shift+Delete` 永久删除**——绕过回收站、无法恢复，按下去直接抹除，不弹确认框。两者在权限不足（只读、被占用、系统文件）时都自动回退到 **UAC 提权删除**
  - 删除后光标自动落到**最后删除项的下一个文件**（若删的是末尾一段，则回退到它前面最近的一个幸存项），单选与多选行为一致，不会清空选中
- **窗口切回自动恢复选中与键盘焦点**：从外部程序（例如 7-Zip 解压窗口）切回 mini-tc 时，自动重新列目录、恢复切换前的选中项并滚动到可见位置、把键盘焦点交还给文件列表，方向键可直接继续操作；正在输入（地址栏 / 文件名过滤 / 内联改名）或焦点在预览区内时不抢焦点
- **窗口位置 / 大小 / 全屏状态记忆**：关闭时记下窗口的位置、大小以及是否最大化 / 全屏，下次启动直接恢复到上次的模样，无需手动摆。
  - 存档在 `~/.minitc/window-state.json`（dev 模式另存 `window-state-dev.json`，避免调试时的窗口尺寸污染正式版），由后端 `src-tauri/src/window_state.rs` 在 `setup` 阶段读写，**前端零参与**——所以不占用启动预算，也没有「先闪一下默认尺寸再跳过去」的跳动（`tauri.conf.json` 里窗口设 `visible: false`，几何套用完才 `show()`）。
  - 几个已处理的边界：**最大化 / 全屏 / 最小化时读到的几何不可信**（全屏时等于整块屏幕，最小化时 Windows 给的是 `-32000` 的 iconic 偏移），这些状态下只更新标志位、几何保持最后一次普通态的值，于是「还原」不会得到一个全屏大小的窗口；**外接显示器拔掉后**存档位置会落在屏幕外，此时自动回退到居中（判定要求整条标题栏仍在工作区内，否则用户抓不到窗口拖不回来）；跨屏导致的 DPI 变化（`ScaleFactorChanged`）也会一并采样。
  - 拖动 / 缩放时 `Moved` / `Resized` 是每秒几十次的高频事件，直接每次写盘会拖垮主线程 IO，所以只保留最后一次几何、由后台线程每 400ms 落盘一次，窗口关闭时再强制同步一次（写临时文件 + 改名，避免崩溃时留下半截 JSON）。
- **左右分栏比例记忆**：拖动中间分隔条调整左右面板宽度后，下次启动保持上次的比例。**双击分隔条**可一键复位为 50/50。
  - 存档在 `~/.minitc/panel-split.json`，存的是**比例**（左栏 flex-grow 系数）而非像素宽度：两侧 wrapper 都是 `flex-basis: 0` 的 flex 子元素，比例本身就完整决定分割，所以窗口缩放或换到另一块显示器后比例依然成立，不会因为上次记的是 640px 而在新屏上显得突兀。
  - 落盘做了 300ms 防抖（拖动时 mousemove 每几毫秒一次）；**拖动路径本身也参与调度**，这样即使鼠标在窗口外松开、`mouseup` 收不到，最后一次移动的结果依然会写盘。
  - 恢复时重新 clamp 到 20%~80%，并且非有限值（配置被改坏）直接忽略退回 50/50，不会出现某一栏被压成 0 的情况。配置读取是异步的，若用户在这期间就拖了分隔条，以用户操作为准、不覆盖。
- **快捷键自定义**（配置 → 快捷键设置）：独立页面集中展示代码中的全部快捷键；支持按名称/组合键搜索、按作用域（全局 / 文件列表 / 视频播放）分组折叠、录制式重新绑定（Ctrl / Alt / Shift / Command 任意组合）、同一命令绑定多个快捷键、同作用域重复时红色高亮冲突并提示占用方。配置持久化到 `~/.minitc/shortcuts.json`，仅存增量，新版本新增的默认快捷键会自动生效
- **自动更新**（帮助 → 检查更新）
- Windows / macOS / Linux 跨平台支持

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | [Tauri 2](https://v2.tauri.app/) |
| 前端 | Vue 3 + Vite 5 |
| 后端 | Rust (20+ 条 Tauri 命令) |
| 编译 | MSVC (Windows) / Clang (macOS) / GCC (Linux) |

## 前置条件

- [Rust](https://rustup.rs/) (stable-msvc on Windows，**1.99.0+**)
- [Node.js](https://nodejs.org/) >= 18
- Windows：Visual Studio 2022 Build Tools（含 C++ 桌面开发工作负载）
- macOS：Xcode Command Line Tools
- Linux：`build-essential` + `libwebkit2gtk-4.1-dev` 等

> **Windows 编译**：请装 **2022 Build Tools**（含 Community / Professional / Enterprise /
> **BuildTools** 四个版本均可）。`dev.bat` / `dev.sh` 的 MSVC 探测会扫描这几个路径，
> 但请注意把它们装在**默认路径下**（`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`），
> 否则探测会漏检并静默退回 rustup 默认工具链，导致 `link.exe` 找不到。

> **⚠️ 若`cargo check` 报 `rmeta encoder panic` 或出现 `拒绝访问 (os error 5)`**：
> 这多半不是 rustc 缺陷，而是**安全软件 / 零信任客户端的文件操作拦截**
> （如腾讯 iOA 的 `fileflow` 模块等minifilter 驱动）。它会劫持 rustc 写增量编译目录的
> 写入动作，导致增量缓存残缺、下次改动时 metadata encoder 取不到 key 而 panic；
> 同时也会让构建产物被搬进回收站。**排查方法**：看 `cargo check` 输出里有没有
> `error copying object file ... to incremental directory` 这条警告——
> **它就是根因信号**。处置方式是关掉对应软件的文件管控模块，而不是去禁增量编译。
> 验证时务必做**真实的源码内容改动**，`touch` 文件不会触发这个 panic。

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

也可以用启动脚本，它会自动探测 Node.js 与 MSVC 环境：

```bash
./dev.sh            # 或 Windows 下双击 dev.bat —— 开发模式
./dev.sh build      # 构建发布版
./dev.sh check      # 仅 cargo check
./dev.sh clean      # 清理构建产物
./dev.sh deps       # 强制 npm install
```

> `npm install` 只在 `package.json` / `package-lock.json` 变化后才会真正执行
> （依赖已同步时 npm 仍要约 20 秒却什么都不装）。改依赖后若想手动强制安装，
> 跑 `./dev.sh deps` / `dev.bat deps`。

`dev.sh` / `dev.bat` 的每个阶段都会打印耗时，便于定位慢在哪：

```
   [探测 Node.js] 569 ms
   [探测 MSVC] 1126 ms
   [MSVC 环境] 323 ms
   [cargo check] 13846 ms
   [总计] 17162 ms
```

## 前端导入静态检查

`vite build` 只做语法转换，**不解析名字**——所以漏掉一个 `computed` 导入、或把某个导出改了名
却忘了改调用方，构建都会顺利通过，运行时才炸成白屏
（`Unhandled error during execution of setup function`）。本项目两种都真实发生过。

```bash
npm run lint:imports          # 扫描整个 src/
node scripts/lint-imports.js src/App.vue src/components/FileList.vue   # 只查指定文件
```

两项检查，都是秒级：

1. **Vue 响应式 API 的使用 vs `from "vue"` 导入表** —— 抓「用了 `computed` 但没导入」
   （老文件的 import 列表往往只覆盖历史上用到的那几个，新增 API 时极易漏）
2. **本地模块具名导入 vs 对方的 `export`** —— 抓「改了导出名忘了改调用方」

改动 `.vue` / `src/*.js` 后跑一次，比等运行时白屏再回头找快得多。

## 构建生产版本

```bash
# 生成签名密钥（仅首次）
npx tauri signer generate -p mini-tc-updater -w src-tauri/keys/mini-tc.key

# 构建并准备发布产物
bash scripts/release/build-release.sh
```

产物在 `scripts/release/out/` 下，包含 `.msi` 安装包和 `latest.json` 更新清单。

## 发布新版本

构建与发布由 GitHub Actions 自动完成（见 [`.github/workflows/release.yml`](.github/workflows/release.yml)）：

1. 修改 `package.json` 和 `src-tauri/tauri.conf.json` 中的版本号
2. 提交后打 tag 并推送：`git tag v0.x.0 && git push github v0.x.0`
3. Actions 自动构建 Windows / macOS / Linux 三平台安装包并发布到 [GitHub Releases](https://github.com/simonlei/mini-tc/releases)，同时生成带签名的 `latest.json` 更新清单
4. 已安装用户下次启动时点击 **帮助 → 检查更新** 即可自动升级

## Windows 安装提示（SmartScreen）

`x64-setup.exe` 未做 Authenticode 代码签名（个人开源项目未购买证书），首次运行会被 Microsoft Defender SmartScreen 拦截，提示「已保护你的电脑 / 发布者未知」。

继续安装：点击弹窗中 **「更多信息」→「仍要运行」** 即可。

文件来自 [GitHub Actions 构建](https://github.com/simonlei/mini-tc/actions)，构建过程公开可审计，可放心运行。


## 项目结构

```
mini-tc/
├── src/                      # Vue 前端
│   ├── App.vue               # 主双面板布局 + 菜单栏
│   ├── main.js               # 应用入口
│   ├── api.js                # Tauri invoke 封装
│   ├── paths.js              # 绝对路径解析唯一入口：entryPath / 虚拟目录哨兵 minitc://search/{id}
│   ├── style.css             # 全局样式（4 套主题变量）
│   ├── shortcuts.js          # 快捷键注册表：命令 / 作用域 / 匹配 / 冲突检测
│   ├── bookmarks.js          # 目录书签全局 store（~/.minitc/bookmarks.json + 下拉展开者令牌）
│   ├── viewState.js          # 视图状态全局 store（~/.minitc/view-state.json：隐藏文件 / 列宽 / 默认排序 / 预览恢复）
│   ├── alwaysOnTop.js         # 窗口置顶控制器（去重 / 失败回滚 / 退出还原）
│   ├── heicDecoder.js         # HEIC 解码主线程侧：Worker 调度 +像素转 JPEG
│   ├── heicDecode.worker.js   # HEIC 解码 Worker：libheif wasm → RGBA
│   └── components/
│       ├── FilePanel.vue        # 面板容器（Tab + 路径 + 文件列表 + 右键菜单）
│       ├── TabBar.vue           # 多 Tab 管理
│       ├── PathBar.vue          # 可编辑路径栏 + 盘符切换 + 面包屑
│       ├── BookmarkMenu.vue     # 目录书签下拉（Ctrl+D）：列表 / 改名 / 删除 / 最近访问 / 失效置灰
│       ├── FileList.vue         # 文件列表（排序 + 多选 + 列宽拖拽 + 隐藏过滤 + 右键触发）
│       ├── FilePreview.vue      # 文件预览（文本/图片）
│       ├── VideoPreview.vue     # 视频预览
│       ├── ContextMenu.vue      # 通用右键菜单组件
│       ├── SettingsDialog.vue   # 文件预览设置
│       ├── GeneralSettingsDialog.vue # 通用设置（声明式 GROUPS schema：预览 / 视图两组）
│       ├── SearchDialog.vue     # 递归文件搜索（Alt+F7）：流式结果 + 虚拟滚动 + 送到面板
│       └── ShortcutsDialog.vue  # 快捷键设置（独立页面）
├── src-tauri/                # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs            # list_directory / read_file_preview / extract_archive / get_archive_tools / start_search 等
│   │   ├── search_log.rs     # 搜索诊断日志（GUI 无控制台，是唯一可查的线索）
│   │   └── window_state.rs   # 窗口位置/大小/最大化/全屏持久化（setup 阶段恢复 + 防抖落盘）
│   ├── tauri.conf.json
│   └── icons/
├── .cnb.yml                  # CNB CI 流水线配置
├── package.json
└── vite.config.mjs
```

## License

MIT
