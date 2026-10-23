# mini-tc 实现笔记

给维护者看的实现决策、测量数据和踩过的坑。功能与用法见 [README.md](README.md)。

## 目录

- [启动](#启动)
- [预览](#预览)
- [视图、选中与键盘](#视图选中与键盘)
- [标签、历史与书签](#标签历史与书签)
- [复制、移动、拖拽与压缩](#复制移动拖拽与压缩)
- [搜索](#搜索)
- [重复文件](#重复文件)
- [删除与撤销](#删除与撤销)
- [批量重命名](#批量重命名)
- [配置落盘与窗口几何](#配置落盘与窗口几何)
- [开发环境](#开发环境)
- [前端测试](#前端测试)
- [后端测试](#后端测试)
- [本地发布构建](#本地发布构建)
- [目录结构](#目录结构)

## 启动

**启动屏。** splash 是 `index.html` 里的静态元素，冷启动时全屏 logo + 三点循环，几乎立刻绘制，加载在其下并行进行。它的职责是让等待可见，工作一完成就必须立刻让位。淡出条件是「展示时长 ≥ 250ms（防一闪）且左右两栏首次列目录都完成」，两者同时满足即淡出（250ms），另有 2500ms 硬兜底，避免慢目录或网络盘把用户留在加载页。

计时起点必须取 `index.html` 内联脚本里的 `__MINITC_SPLASH_SHOWN_AT__`，不能取 `main.js` 里的 `performance.now()`。后者比 splash 实际出现晚约 390ms（模块求值完才执行），MIN_SHOW 会在「早已显示」的基础上再加一段死等（实测白等约 160ms）。常量 `SPLASH_MIN_SHOW_MS` / `SPLASH_FADE_MS` / `SPLASH_MAX_SHOW_MS` 在 `src/main.js` 顶部。淡出时长由 JS 在运行时内联写入 `transitionDuration`，是单一真源；`index.html` 里的 CSS 只是兜底。

埋点里 `splash:fade-start` 的 note 是 `shown=…ms panels=N after-ready=…ms`。`after-ready` 才是调参依据：它表示数据全就绪后，用户还得盯着一个已完成的动画多久，应当恒为 0。`shown` 只是 splash 总显示时长。

**启动耗时埋点。** `src/bootLog.js` + 后端 `boot_mark` / `boot_timings`。开发模式下 devtools 控制台打印两张 `console.table`（JS 阶段 / Rust 阶段，共用同一时钟）。Rust 侧另有 `[boot] ... ms` 逐行输出。`localStorage.setItem("minitc-boot-log", "off")` 可关闭。

**启动路径上的两处瘦身。** 实测大头是 Tauri 固有的 WebView2 `setup`。JS 侧能砍的主要是重复探测与无谓排序。

- **驱动器列表缓存。** 后端 `list_drives` 要遍历 A–Z，逐个 `Path::exists`，并对应答的卷调 `GetDiskFreeSpaceExW`（空光驱、断连网络盘可阻塞数百 ms）。左右两栏在 mount 和每次窗口重新获得焦点时都会各调一次，一次切窗就是 4 次走盘。现由后端 `OnceLock<Mutex<..>>` 缓存，TTL 2 秒。**锁要持跨越探测本身**：两栏的请求在同一 tick 发出，只包缓存检查的话，两者会双双 miss，各跑一遍全盘扫描。
- **`list_directory` 不再排序。** 前端 `sortedEntries` 对除 `found`（搜索顺序，仅搜索结果伪目录有意义）外的所有列都会重排，后端排的序必被丢弃。那个比较器每次比较要 `to_lowercase()` 两次，等于 O(n log n) 次堆分配，故直接删掉。
- **不要把 9 次 `load_config` 合并成 1 次 `load_configs`。** 曾实现并实测为负优化。配置总量约 4 KB，瓶颈是 IPC 往返：合并后的单次调用要 57ms，被它替代的 9 次并行单文件调用每个只要约 14ms。把 9 次并行排到 1 道屏障后面，等于让页面上最慢的东西变成那道屏障。这个量级下并行独立优于批量串行。
- `list_directory` 每条目 stat 两次（改为 `entry.metadata()`）在实现递归搜索时已顺带修掉。

## 预览

### HEIC / HEIF

WebView2 没有原生 HEIC 解码器，走 `src/heicDecoder.js` + `src/heicDecode.worker.js`。Worker 里用 libheif 的 WebAssembly 版解码成 RGBA，主线程再 canvas 编成 JPEG 交给 `<img>`，图上标注「已转换为 JPEG」。wasm 约 2 MB，按需加载（`?worker` 导入 + `optimizeDeps.include` 登记），启动不受影响。两道上限：单文件 60 MB、解码后 5000 万像素（12MP 手机照片约需 48.8 MB RGBA 缓冲）。

**像素上限必须在 Worker 里 `display()` 之前判断。** 原先上限在 `decodeHeic()` 返回之后才检查，那时 `display()` 早已跑完。实测一张 12240×16320 的文件先烧掉 4.4 s / 762 MB RGBA / 2.1 GB RSS，然后才弹「已跳过预览」。现在上限由 `heicDecoder.js` 的 `MAX_HEIC_PIXELS` 经 postMessage 传进 Worker，在分配像素缓冲前拦截。

**超大图回退到容器内嵌的缩小版。** 超限时先在容器里找同图的内嵌预览，找不到才拒绝。HEIC 的 grid 派生图会把这事变成刚需：主图是 N×M 个 tile 拼成的马赛克（每个 tile 是独立的隐藏 item），所以能出现「3 MB 文件装 200 MP」。实测 `P (3).HEIC` 有 768 个 512×512 tile 拼成 16320×12240（`irot` 转 90° 后显示 12240×16320），全量解码要 762 MB；改用 item 770 内嵌的 384×512 缩小版后，4.4 s / 762 MB 变成 56 ms / 0.8 MB。筛选条件：跳过 top-level id、跳过 hidden item（否则会取到拼图碎片）、跳过 `Exif/mime/uri`、像素数 ≥ 64K 且 ≤ 上限、长宽比与主图差 ≤ 2%（挡掉深度图 / alpha 平面），多候选取像素最多者，扫描上限 2048 个 item。命中降级时图上标注「原图 WxH 过大，已显示内嵌预览图」。

**多帧 HEIC。** 容器里有多个 top-level 图元时（连拍 / 序列 / Live Photo）走动画播放。`<canvas>` + `putImageData` 逐帧绘制，不用 `<img>`：换 src 会闪，且每帧泄漏一个 objectURL。首帧随初始解码一起返回；其余帧按需向 Worker 索取（`decodeHeicFrame(index)`），Worker 缓存已解析的容器（实测 19 ms/次）。帧率读每帧的 `heif_image_get_duration()`，真有时序就按真实速度播，文件完全没有时序数据时才回落 100 ms/帧。换文件与组件卸载都会停掉循环。

**循环令牌 `animToken` 必做。** `clearTimeout` 只能取消当前那个定时器。若某帧正在 `await` 解码，换文件时它回来后还会继续调 `decodeHeicFrame()`，对着 Worker 里已被替换的容器反复取帧，表现为方向键快速切文件后 canvas 自己乱跳。每次启停递增令牌，旧循环回来一比对即退出。帧解码失败时结束循环，避免卡在同一帧反复报错。

**不用 heic2any**（已移除）。它内嵌的是 emscripten asm.js 版 libheif，YUV→RGBA 转换跑在 JS 解释器上。实测 12MP 手机照片中位数：asm.js 1047 ms，wasm 422 ms。`libheif-js` 的 package.json `main` 指向的正是 asm.js 版（`libheif/libheif.js`），必须显式引 `libheif-wasm/libheif-bundle.mjs` 才拿到 wasm。

**耗时诊断。** 每次预览在 devtools 控制台打一张折叠表（`[heic] <文件名> <总耗时> ms`），分 `start / file-read / worker-decode / encoded / ready / painted`。`worker-decode` 的 note 里进一步拆出 `hevc=Xms`（比特流解码）和 `rgba=Yms`（颜色转换）。失败、翻页中断、超限中止也会补打（末行标 `failed` / `interrupted` / `aborted`）；多帧文件在 `ready` 步显示 `frame 1/N`。

**libheif-js 的 embind 调用约定（实测）。** 高层 `HeifDecoder.decode()` 拿到的 `HeifImage` 有 `.handle`（原生 handle）和 decoder 的 `.decoder`（`heif_context`），可直接调 `heif_item_get_item_type` / `heif_item_is_item_hidden` / `heif_js_context_get_image_handle(ctx,id)` / `heif_image_handle_release`。返回 struct 的函数分两类：`heif_context_read_from_memory(ctx, buf)`、`heif_context_has_sequence(ctx)` 这类已被 embind 封装，正常传参、返回 `{code, subcode, message}`；而 `heif_image_handle_get_image_tiling` / `decode_image_tile` 等裸导出必须自己 `_malloc` 传隐藏 sret 指针，再从 `HEAP32` 读。少传会静默返回垃圾值而不报错，极易误判成「API 不可用」。grid 分块解码走不通这条路，只能靠内嵌缩小版绕过。

**剩余慢点。** 换成 wasm 后 12MP 仍需约 420 ms，瓶颈仍是全尺寸 YUV420→RGBA。HEVC 比特流解码只占 2–10 ms。根治要靠降采样，但 libheif-js 的高层 API 不暴露尺寸参数（C API 有 `heif_image_scale_image`，在 embind 下调不通）。后端 Rust `libheif-rs` 有 `HeifDecodingOptions::max_width`，是后续方向。

### docx 与 CSP

docx 预览是本项目唯一的内容注入面，按不可信输入处理（`src/docxSanitize.js` + `tauri.conf.json` 的 `csp`）。mammoth 的输出经 `v-html` 进 webview，而 .docx 就是一包攻击者可选的 XML。在 Tauri 里同源导航等价于任意命令执行：`window.__TAURI_INTERNALS__` 在主框架所在源上一直可用，所以让 webview 导航到攻击者的 HTML 就等于拿到完整 IPC。

原先的净化是黑名单（只黑 `<script>` / `on*` / `javascript:` 前缀），`<a href="data:text/html,<script>…">` 原样保留。现在改为显式白名单（`ALLOWED_TAGS` / `ALLOWED_ATTR` 只放行 mammoth 的输出子集，`FORBID_TAGS` / `FORBID_ATTR` 再兜一层），交给 DOMPurify。

**`ALLOWED_URI_REGEXP` 不是最后一道关。** 实测 DOMPurify 3.4.17 在正则之后还有一条内建放行（`purify.es.mjs:2164`）：只要标签在 `DATA_URI_TAGS` 内，`src` / `href` / `xlink:href` 上的任意 `data:` 值都直接放行，而该内建集合包含 `img`。`<img src="data:text/html;base64,…">` 能活过一条明确拒绝 `data:` 的正则。`ADD_DATA_URI_TAGS` 经 `_resolveSetOption(..., { base: DEFAULT_DATA_URI_TAGS })` 是并集语义，传 `[]` 不会缩小集合。所以 `data:` 的判定自己做（`uponSanitizeAttribute` 钩子，且用完立刻摘掉——钩子挂在共享实例上，泄漏出去会放宽别处的 `sanitize()`）。

`data:` 只对 `img@src` 放行，且必须匹配 `data:image/(png|jpeg|jpg|gif|webp|bmp|x-icon);base64,`。`image/svg+xml` 不在内。判定前先剥掉 C0 控制字符：浏览器解析 scheme 时会忽略它们，`data:\ttext/html` 与 `java\tscript:` 都是活的绕过。

**CSP 是第二道防线**（`csp` + 单独的 `devCsp`，后者含 vite 的 `ws://localhost:5173`，否则 HMR 连不上）：`object-src 'none'`、`form-action 'none'`、`base-uri 'self'`，图片来源显式列出 asset 协议 / `blob:` / `data:`。Tauri 不会自动补 `ipc:` / `http://ipc.localhost`，漏一条会静默打死全部 IPC。

`script-src` 必须留 `'wasm-unsafe-eval'`：libheif 的 wasm 以 base64 内嵌并直接 `WebAssembly` 实例化，CSP 视同 eval，去掉这条 HEIC 预览直接坏。

测试：`scripts/docx-sanitize-check.mjs`（已挂进 `npm test`），33 个攻击载荷 + 结构断言 + CSP 配置守卫。带对照臂：同一批载荷过一遍旧黑名单实现，实测漏掉 17/33。

### 视频与窗口置顶

`mp4/webm/ogv/mov/m4v` 由 WebView 直接解码（字幕自动探测同目录 `srt/vtt/ass`、外挂字幕、±0.5s 偏移、倍速、音量记忆）。`mkv/avi/flv/wmv/rmvb` 无法解码时回退「用系统播放器打开」，HEVC/H.265 这种有声音没画面的情况也会识别并回退。进度条常驻，仅下方按钮行在播放 3 秒后收起。

预览时窗口置顶默认关闭。置顶是操作系统窗口级属性，浮起来的是整个 MiniTC 窗口，浏览器没有 API 能把单个 DOM 元素抬到其他程序窗口之上。置顶联动由一个 `watch` 驱动 `src/alwaysOnTop.js`（对上下曲、面板切换、自动连播、Esc 全部生效，做了状态去重与失败回滚），退出时强制还原。

通用设置页的配置项以声明式 schema 声明（`GeneralSettingsDialog.vue` 顶部的 `GROUPS` 数组，分组 + 行，行类型 `toggle` / `select`）。按 key 前缀分流存储：`view.*` 归 `viewState.js`（`~/.minitc/view-state.json`），其余归 `~/.minitc/app-config.json`。

## 视图、选中与键盘

**视图状态**在 `~/.minitc/view-state.json`，模块级单例 `src/viewState.js`，150ms 防抖写盘。

- **隐藏文件。** 后端始终全量返回，过滤在前端做，所以上万项的目录切换也是瞬时的。左右栏独立。过滤会整体平移行号，选中集合按条目对象身份迁移到新列表，按下标迁移会把选中静默变成另一个文件。
- **列宽。** Name / Size / Type / Modified 四列表头可拖，双击手柄恢复默认。列宽左右栏共用。四列都是字面宽度，面板多出来的空间留成右侧空白。窗口缩小时 Size / Type / Modified 优先完整显示，文件名栏承担让步（缩窄 → 省略号 → 归零）；面板连三栏都放不下时，三栏才等比缩小（可读下限：Size 60 / Type 48 / Modified 96），并且 Name 先归零。这些是渲染时的临时调整，存储值不动。拖拽起始宽度取存储值，取实测宽度会让窗口缩小后的 Name 被永久卡在挤扁后的尺寸。
- **新标签默认排序**写在视图状态里。每个 tab 的排序存在自己的 `tabs-<id>.json` 里，改默认值不追溯重排已有 tab。
- **预览恢复。** 退出时开着预览则重启后恢复，并把源列表设为活动栏、重新选中该文件。「格式不支持」占位页不恢复。恢复会等两栏都完成首次列目录。
- 配置损坏时：列宽按上下限夹取，非有限值落回默认，排序列必须是已知键，损坏的 JSON 只丢该项。

**Tab 切换左右面板**只在焦点处于文件列表时生效。焦点在地址栏、过滤框、内联改名、对话框或右键菜单时，`Tab` 保持浏览器的原生焦点切换。

**输入法合成期间快捷键让路**，判据在 `src/keyboardText.js` 的 `isImeKeydown`。每个 keydown 处理器在调用 `matches()` 之前先问这个键归输入法还是归快捷键。`matches()` 用 `e.code` 拼组合键，不看合成状态。漏掉守卫时，实测 18 个 `list.*` 默认绑定都会在选词时触发（空格算目录大小、回车打开文件、退格返回上级，并且 `preventDefault()` 把上屏也掐掉）。守卫查两个信号：`e.isComposing` 与 `keyCode === 229`。前者不覆盖启动合成的那一下，后者不覆盖部分 IME 的另一种形状。拼音字母不会泄漏（字母的 `e.code` 是 `KeyN`，没有任何命令绑在裸字母上）。`onRenameBlur` 只查 `e.isComposing`（blur 事件没有 `keyCode`）。

**`Ctrl+A` 三态**，判据是 `classifySelectAll`：焦点在可编辑元素（`INPUT` / `TEXTAREA` / contenteditable）里交给浏览器；在文本预览正文里（`.preview-text`、`.preview-doc`，含鼠标划选）全选预览文本；其余情况全选文件。预览正文原先是纯展示的 `<pre>`，点击不产生焦点，`Ctrl+A` 会落到文件列表。现可聚焦（`tabindex="0"`），但守卫判的是元素类型与选区。`F5` / `Ctrl+M` 仍只避让内联改名输入框。

**选中态**按条目身份记住。排序或 `/` 过滤之后仍是同一个文件。被过滤掉或目录刷新后，选中态清空。改名（F2）进行中同样跟随条目。

## 标签、历史与书签

**多标签。** `Ctrl+T` 在当前活动面板按当前目录新开标签，`Ctrl+W` 关闭当前标签（仅剩一个时无操作），`Ctrl+Tab` / `Ctrl+Shift+Tab` 在该面板的标签之间环绕。四者在地址栏和过滤框里同样生效，执行后焦点交回文件列表。轮换成功时 toast 报出落点路径；只有一个标签时静默。左右栏互不影响。

**锁定。** `Ctrl+Shift+L` 把当前目录记为锁定锚点（再按一次解除），`Ctrl+Y` 跳回锚点。锁定不阻止目录切换。本应用没有实现 TC 的 `Ctrl+Num*` 严格锁定。已锁定的标签显示锁标记。右键菜单：锁定当前位置 / 回到锁定位置 / 以当前目录重新锁定 / 关闭此标签页。锚点随标签页写到 `~/.minitc/tabs-<panelId>.json`。

**历史。** 每个标签页独立目录历史栈，随标签页持久化，重启后仍能往回走，每档上限 100 条。新导航截断前进分支。后退 / 前进回到某个目录时选中刚离开的那个文件夹。已删除的目录或已拔掉的盘会从栈里剔除并继续找，剔除了几个会弹 toast。地址栏上的前进后退按钮无历史可走时置灰，不隐藏。鼠标 XButton1 / XButton2 走同一套历史栈，仅活动面板响应。

**书签**是全局一份列表（`src/bookmarks.js`，`~/.minitc/bookmarks.json`），和标签页锁定是两件事。搜索结果标签页是虚拟目录，隐藏星标，也不响应 `Ctrl+D`。星标用 `☆` / `★`，不用 `⭐`：emoji 由彩色字体渲染，`color` 对它无效。失效书签加删除线，点击时再验一次。 「最近访问」从该标签页自己的历史栈现算，最多 10 条，不含当前目录，不另存一份。两个面板各有一个下拉，共享一个「当前展开者」令牌。菜单的 mousedown / Esc 监听走 capture 阶段，Esc 还会 `stopPropagation`，以免连带关闭预览。

**搜索结果标签页没有历史。** `minitc://search/{id}` 不是真实目录。从结果集跳进真实目录时重新起一段历史。

**窗口切回。** 从外部程序切回时重新列目录、恢复选中并滚动到可见、把键盘焦点交还文件列表。正在输入或焦点在预览区内时不抢焦点。

**目录大小缓存**按标签页分桶。`setPath()` 是所有目录切换的唯一收口（面包屑、返回上级、前进后退、书签、锁定跳转、搜索结果下钻），在这里丢弃缓存。重新列当前目录不经过 `setPath`，所以切窗回来数字还在。一旦切换目录就清空，即使切回来也不恢复。大目录统计期间若用户已经导航走，晚到的结果丢弃。删掉文件夹时同步清掉它的大小条目。计算中的 `...` 占位曾经因为判断顺序永远走不到，会显示成 `NaN undefined`。

## 复制、移动、拖拽与压缩

**右键解压。** 压缩包（zip/rar/7z/tar/gz/iso…）自动探测本机的 7-Zip / WinRAR / unzip。多选时按顺序逐个解压，图形界面工具会等上一个窗口结束再启动下一个。

`extract_archive` / `add_to_archive` 只接受 `tool_id`（`get_archive_tools` 探测时下发的标识）。可执行文件路径与参数模板由后端从自己的发现结果里查。未知 id 直接报错（`未知的压缩工具 id`），注册表为空时才补跑一次探测。曾经把前端传来的 `tool_exe` 直接交给 `Command::new`，webview 里任何 XSS 都能把它换成 `cmd.exe`。

**以管理员身份运行**（Windows，弹 UAC）由后端按内容判定。`.exe` / `.com` / `.scr` 要读出 `MZ` + `PE\0\0` 头。`.bat` / `.cmd` / `.ps1` 要真有可执行命令行。`.lnk` / `.msi` / `.msp` 按扩展名放行。不查注册表的文件关联。启动方式：`.bat/.cmd` → `cmd /c`，`.ps1` → PowerShell，`.msi/.msp` → `msiexec /i|/p`，其余直接启动。工作目录设为文件所在目录。只作用于右键点的那一行。已标记剪切的行该菜单置灰。拒绝 UAC 只提示「已取消管理员权限请求」。

**复制 / 剪切 / 粘贴**走 Windows `CF_HDROP`，可与资源管理器互拷。同名文件夹冲突时合并，例如把 `root/a/a` 移动到 `root/`，内容并入已存在的 `root/a`。仍拒绝把目录移动到自身内部（`root/a` → `root/a/b`）。

「是否合并目录」与「是否覆盖文件」是两个独立决策。移动到已存在的同名目录必须合并（`rename` 到非空目录不可能，整体替换会丢数据），但合并进去的每一层遇到同名文件时，仍然尊重冲突框里的跳过 / 覆盖。早先共用一个 `overwrite` 参数，为了目录合并只能传 `true`，那个 `true` 会漏到每个叶子冲突上。

只有「整棵树完整无冲突地搬走」的源才会被删除。判据是 `copy_all` 回报的 `moved_sources` 白名单。用户选择「不覆盖」产生的是静默跳过，用「错误列表为空」当判据会把从未写到目标的文件删掉。

**不跟随符号链接与目录联接。** `Path::is_dir()` 会跟随链接、对联接返回 `true`，指向自身祖先的联接会让遍历无限嵌套（实测 `loop\loop\loop\…`）。Windows 只在路径超过 `MAX_PATH`（约 260 字符、约第 31 层）时兜底，于是复制出约 30 层幽灵目录并报告成功。复制成普通目录会在链接位置留下空目录。重建链接要手工拼 `FSCTL_SET_REPARSE_POINT`，写错只会得到无从诊断的 `ERROR_ACCESS_DENIED`。另有 64 层深度上限，触顶明确报错：静默截断在移动时会把源侧未复制的尾巴删掉。

**F5 / Shift+F5** 把当前活动面板的选中项送到对面面板当前目录，完全不碰剪贴板。执行后两个面板都刷新，焦点留在源面板。已经直接躺在目标目录里的项会跳过。两栏停在同一目录时提示「对面栏与当前栏在同一目录」。焦点在内联改名输入框内时 F5 不生效。

**拖拽**依赖 `tauri-plugin-drag`（CrabNebula 的 drag-rs）。前端在文件行 `dragstart` 时调用 `startDrag({ item: 绝对路径, mode: 'move' })`。Rust 后端走 Windows OLE `DoDragDrop` / macOS `NSPasteboard`，写出 `CF_HDROP` / `NSFilenamesPboardType`。预览图标故意传一个无法解码的字节（0x00），让 drag-rs 跳过 `IDragSourceHelper::InitializeFromBitmap`，由 OS 从 `CF_HDROP` 渲染文件图标。传了真实图标会覆盖 OS 默认渲染。Linux 下 drag-rs 需 GTK 应用窗口，跨进程拖出不保证。`dragDropEnabled: true` 让 Tauri 接管 webview 拖放，配合 `tauri://drag-enter / drag-over / drag-drop / drag-leave`。前端 `elementFromPoint(x, y)` 反推落点。自拖自走 move，外部拖入走 copy。

**覆盖写文件的三条规矩**（复制/移动曾经在三处先删目标再写，而那一步发生在一个字节都还没拷之前）：

- 普通文件目标不预先删除，由 `copy_file_with_progress` 用「同目录 tmp + `rename`」原子替换。tmp 必须建在目标的同级目录，放 `%TEMP%` 会跨卷，最后一步退化成非原子的 copy+delete。`fs::rename` 覆盖已存在文件在 Windows 上是原子的（`MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`）。
- 只有目标是非空目录时才需要预删。`rename` 换不了非空目录（`ERROR_DIR_NOT_EMPTY`），`create_dir_all` 也覆盖不了文件。空目录不用。
- 移动时若必须清空目标，先把源 park 成临时名，目标空出来后再改名回去。任何一步失败都把源改名回原位。提交失败时如实报出文件仍在哪个临时名下，绝不删除。

Windows 上 `fs::rename` 会无条件覆盖已存在目标（连目录 rename 到已存在文件也成功），所以不能靠 rename 报错来避让占用名。`park_source` 先用 `symlink_metadata` 查存在性。

纯逻辑要能单测，就把 IO 以参数注入。例如 `copy_all` 把「某个任务怎么处理、是否污染其所属源」抽成 `plan_task_action(...)`。

## 搜索

`Alt+F7` 与 `Ctrl+F` 同效。文件名语法：分号分隔多个模式，`*` / `?` 通配符，不含通配符的普通词按「名字包含」匹配，留空列出全部。另有「区分大小写」「包含隐藏文件」。内容搜索自动跳过二进制（前 4KB 含 NUL）和大于 8MB 的文件。

后端 `start_search` 在独立线程里跑。结果以 `search-batch` 事件分批回传（每 200 条或 200ms 一批）。扫描期间 `search-progress`（约每 300ms）回传已扫描条目数和当前目录。结束发 `search-done`。`cancel_search` 置标志位，线程在每个条目上检查。新搜索自动取消上一次，每批结果带 `id` 校验。

结果列表虚拟滚动，默认上限 5000 条。

遍历只用 `DirEntry::metadata()`（Windows 上复用目录扫描已返回的 `WIN32_FIND_DATA`，零额外系统调用），不用 `fs::metadata(path)`。实测 4782 个条目：373 ms vs 1.3 ms；`C:\Program Files` 递归 51100 个条目：1.89 s vs 0.22 s。目录内排序用 `sort_by_cached_key`。

**模态。** 搜索框打开期间 Esc 在 capture 阶段关闭它，其余按键不穿透。关闭时焦点归还打开前的那个元素。

**诊断日志**写到 `%USERPROFILE%\.minitc\logs\search.log`（每次搜索覆盖）。记录入口参数、进入的每个目录、每个命中、三种事件的 `emit` 结果（`emit` 失败以前被 `let _ =` 吞掉）、`read_dir` 失败，以及汇总行。搜索线程包在 `catch_unwind` 里，panic 也会发 `search-done`，panic 信息通过全局 hook 写进同一文件。

**送到面板。** 结果在目标栏开一个新标签页，面板接管事件流继续接收后续批次。地址栏显示「搜索中…」时，关掉对话框不会取消扫描。只有刷新会重新跑一遍。

这类标签页的路径是哨兵 `minitc://search/{id}`。每个文件条目自带绝对路径。后端 `FileEntry` 有 `path` 字段，前端取绝对路径统一走 `src/paths.js` 的 `entryPath()`。哨兵长得像 URI scheme，不会与盘符或 UNC 冲突。同名是常态，删除后移除行、剪切灰显、目录大小缓存一律按绝对路径匹配。

排序默认「按搜索顺序」（后端 DFS 流出的原始顺序）。该排序返回同一份数组引用。流式追加时若重新排序或拷贝，行会在光标下跳动。

做不到的操作会明确拒绝：粘贴、拖到列表空白处、新建目录、锁定标签页、返回上级。解压可用，但每个压缩包解到它自己的父目录。结果集标签页不持久化。

## 重复文件

判重靠内容。先按文件长度分组（零 IO），同长度组内先比首尾各 64 KB，再逐字节流式比全文件。不用哈希：哈希碰撞在这里意味着静默删掉用户还想要的文件。`Cargo.toml` 里没有哈希依赖。

比较结果分三态：相同 / 不同 / 读不出来。读不出来的永远不会被当成重复。0 字节文件默认不参与（前端固定传 `includeEmpty: false`）。不跟随符号链接，目录链接不下钻，深度上限 64 层。

每组默认保留修改时间最新的一份（mtime 相同则按路径取小者）。单选圆点换保留项，复选框单独取消某个副本。取消保留项的复选框无效。「本组全选」只作用于本组。

**删除前重新核对**（`dedup_delete`）。每个文件进回收站之前重新 `stat`，长度或修改时间对不上就跳过，报进「已变化」。判「存在」用 `symlink_metadata`，`metadata` 会跟随链接。

整批用一对 `begin_trash_delete` / `commit_trash_delete` 包住，可以一次 `Ctrl+Z` 全撤回。撤销栈深 1，不能每个文件开一次括号。不提供永久删除。

Windows 上把文件送进回收站是一次跨卷移动。后端每删一个文件后发 `dedup-delete-progress`。进度条按「已删除」前进，跳过和失败的项不算进分子，否则一次全是失败的删除会走到 100%。不能由前端分批调用 `dedup_delete` 来做进度，那会把回收站括号开成 N 次。节流是每 1 个文件或 60ms，最后一步强制上报。删除进行中对比列表整体隐藏，Esc 和点遮罩不关闭对话框。

删除完成后清空对比列表，`hasRun` 回到 false，结果摘要留在状态区。成功消息走 `notice`，有失败时同时写进 `error`。扫描按钮只在扫描中或删除中禁用。`DEDUP_CANCEL` 是 `HashMap<u64, Arc<AtomicBool>>`，和 `SEARCH_CANCEL` 那个单槽相互独立。模态行为与搜索框一致。删除完成后刷新两个面板。

前端判定在 `src/dedupRules.js`。测试见 `scripts/dedup-rules-check.mjs` 与 `scripts/dedup-rules-mutation.mjs`，后端比较逻辑在 `src-tauri/src/dedup.rs`。

## 删除与撤销

`Delete`（`Ctrl/Cmd+Backspace` 同效）移入回收站。`Shift+Delete` 永久删除，不弹确认框。权限不足时两者都回退到 UAC 提权删除。删除后光标落到最后删除项的下一个文件；若删的是末尾一段，则回退到前面最近的幸存项。

删链接走 `remove_link_or_tree`：联接用 `RemoveDirectory`，其余用 `DeleteFile`。断链也能删掉。移动/复制路径上的删除也走这个入口。

`Ctrl+Z` 只恢复最近一次送入回收站的项目，多选算一步。彻底删除和 UAC 提权删除都不可撤销。改名、移动、覆盖也不在这个栈里。只认 mini-tc 自己送进回收站的那一步。输入框里的 `Ctrl+Z` 仍是文本撤销。

原位置被占用时不覆盖，可选改名恢复（`report.txt` → `report (1).txt`，复用批量重命名的 Windows 合法名校验）或跳过。

**怎么知道删了哪些回收站条目。** `trash::delete` 只给一个 `Result`。`trash` crate 自带 `os_limited::list()` / `restore_all()`（仅 Windows / Linux，macOS 无此模块，该平台不可撤销），不必自己解析 `$RECYCLE.BIN`。删除整批的前后各取一次回收站条目 id 做差集（`begin_trash_delete` / `commit_trash_delete`）。快照按批取。差集还要和本次实际删除的路径集合求交集，避免把删除期间别的程序塞进去的条目认进来。同一路径删过两次时按 `time_deleted` 取最新的一条，`list()` 不保证顺序。

## 批量重命名

规则：查找替换（可选正则、区分大小写）、序号（起始值 / 步长 / 位数；自动追加成 `名称_1`，或用 `[N]` 占位符）、前后缀、大小写（小写 / 大写 / Title Case / camelCase / kebab-case / snake_case）、扩展名（保留 / 转小写 / 替换 / 去掉）。查找替换、大小写、序号只作用于主名。

冲突与非法名在动手之前标红：非法字符、以点或空格结尾、Windows 保留设备名、超过 255 字符、与本批次其他项重名、与目录里已存在的项重名。有一项有误，「重命名」按钮禁用。判重按目录分组且忽略大小写。本批次里被别人腾出来的名字（`a→b` 且 `b→a`）不算冲突。

环形改名走两阶段：先落到临时名再改到目标名。任一步失败就逆序回滚已完成的改动。回滚本身也失败时，列出残留路径。

**序号输入框被清空时回落到默认值，而不是变成 0。** 对话框用 `v-model.number` 绑在 `<input type="number">` 上，清空得到的是空串（Vue 的 `looseToNumber("")` 是 `parseFloat("") || ""`）。守卫 `Number.isFinite(+v) ? +v : 1` 对此失明，因为 `+""` 就是 `0`。清空「起始」会从 0 编号；清空「步长」会让每一行拿到同一个序号，而 `a_1/b_1/c_1` 互不相同，判重不会触发，整批会顺利执行并把名字改错。`seqNumber(value, fallback)` 只把空（`null` / `undefined` / 空串 / 纯空白）当缺失，`0` 是合法起始值。解析用 `Number`，免得 `"3abc"` 被 `parseInt` 当成 `3`。

后端复用 `rename_file`。规则与执行顺序是纯函数（`src/renameRules.js` / `src/renameRunner.js`）。执行期间规则区是 `<fieldset disabled>`。回传给面板的新旧名对照取自执行时的计划快照。回滚过的批次不回传对照。搜索结果标签页里改完名就地更新那一行。

## 配置落盘与窗口几何

**窗口几何**存在 `~/.minitc/window-state.json`（dev 模式为 `window-state-dev.json`），由 `src-tauri/src/window_state.rs` 在 `setup` 阶段读写，前端不参与。`tauri.conf.json` 里窗口 `visible: false`，几何套用完才 `show()`。最大化 / 全屏 / 最小化时读到的几何不可信（全屏等于整块屏幕，最小化时 Windows 给 `-32000`），这些状态下只更新标志位。外接显示器拔掉后，若整条标题栏不在工作区内，回退到居中。`ScaleFactorChanged` 一并采样。`Moved` / `Resized` 只保留最后一次几何，后台线程每 400ms 落盘，关闭时再强制同步一次。

**全部配置**经由 `load_config` / `save_config` 落到 `~/.minitc/<name>.json`。这条通道坏掉时，文件解析失败，各 store 的 `catch` 静默回落默认值，书签、标签页、键位会一起消失。

- **完整性**在后端 `src-tauri/src/atomic_file.rs` 的 `write_atomic()`：先写目标同目录下的临时文件（`create_new` 独占占名）、`sync_all`、再 rename 覆盖。写入失败时目标原封不动。`save_config` 与窗口几何存档共用它。原先 `window_state.rs` 的注释声称「Windows 上 rename 不能覆盖已存在的目标，必须先删」——前半句经实测是错的（`MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`），先删等于凭空开了一个「文件不存在」的窗口。
- **顺序**在前端 `src/configWriter.js`。`api.js` 用它包住 `invoke("save_config")`，按 name 建 promise 链。同一个配置名的多次写入按调用顺序落地。不同 name 之间仍然并行。不要在后端用 Mutex 统一：原子写保证不了顺序，Mutex 的获取顺序也不是 FIFO，跨阻塞文件 IO 持锁是本项目吃过亏的反模式。链尾的 `.then(noop, noop)` 让存进 map 的 promise 永不 reject，否则一次写失败会让该配置名后续每一笔都跟着失败。

标签页状态的两个 `watch` 走 200ms 防抖。防抖只是省掉重复写。

**分栏比例**存在 `~/.minitc/panel-split.json`，存的是左栏 flex-grow 系数。两侧 wrapper 都是 `flex-basis: 0`。落盘 300ms 防抖，拖动路径本身也参与调度，这样鼠标在窗口外松开、收不到 `mouseup` 时，最后一次移动仍会写盘。恢复时 clamp 到 20%–80%，非有限值退回 50/50。配置读取是异步的，若用户在这期间拖了分隔条，以用户操作为准。

## 开发环境

Windows 请装 **2022 Build Tools**（Community / Professional / Enterprise / BuildTools 均可），装在默认路径 `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`。`dev.sh` 的 MSVC 探测扫这几个路径，装在别处会漏检并静默退回 rustup 默认工具链，导致找不到 `link.exe`。

若 `cargo check` 报 `rmeta encoder panic` 或 `拒绝访问 (os error 5)`，多半是安全软件 / 零信任客户端的文件操作拦截（如腾讯 iOA 的 `fileflow` minifilter），它会劫持 rustc 写增量编译目录的写入，导致增量缓存残缺，也会把构建产物搬进回收站。根因信号是输出里的 `error copying object file ... to incremental directory`。关掉对应软件的文件管控模块。验证时要做真实的源码内容改动，`touch` 不会触发这个 panic。

**启动脚本只有 `dev.sh`**（Windows 上在 Git Bash 里跑），外加 `scripts/cargo-check.sh`。此前并存 `dev.bat`、`scripts/check.bat`、`scripts/check.ps1`，四份探测逻辑互相漂移，后三个已删除。`cargo-check.sh` 按 `sort -V` 取最大的 MSVC/SDK 版本，按脚本位置定位项目根。它曾经写死 node 目录 `22.22.2`，实际目录名是 `22.22.2-6`。

`npm install` 只在 `package.json` / `package-lock.json` 变化后才会真正执行。强制安装用 `./dev.sh deps`。

**Node 版本**由 [`scripts/pick-node.js`](scripts/pick-node.js) 决定：按 `engines.node` 过滤后取最新的一个（PATH 从前往后，然后各版本管理器目录），选中目录写到 stdout，诊断走 stderr。

此前两个启动器按字典序取第一个命中，`22.12.0` 永远排在 `22.22.2` 前面。症状是运行时在 import 阶段崩，且没有告警。自查：

```bash
node scripts/pick-node.js --print-all
```

`dev.sh` 的每个阶段都会打印耗时：

```
   [探测 Node.js] 569 ms
   [探测 MSVC] 1126 ms
   [MSVC 环境] 323 ms
   [cargo check] 13846 ms
   [总计] 17162 ms
```

**导入静态检查。** `vite build` 只做语法转换，不解析名字。漏掉一个 `computed` 导入，或改了导出名忘了改调用方，构建都会通过，运行时才白屏。

```bash
npm run check        # 导入检查 + SFC 编译 + 全部单元测试
npm run lint:imports # 只跑导入检查
npm test             # 只跑单元测试
node scripts/lint-imports.js src/App.vue src/components/FileList.vue
```

两项都是秒级：Vue 响应式 API 的使用 vs `from "vue"` 导入表；本地模块具名导入 vs 对方的 `export`。

`jsdom` 锁在 `~28.1.0`。jsdom 30 要求 node `^22.22.2`。`undici` 7.x 声明 `engines: >=20.18.1`，纸面上 22.12.0 受支持，但是声明不是保证。实测 jsdom 30 在 22.12.0 上产生 45 条 EBADENGINE 且测试崩溃。启动器现在会按 `engines.node` 取最新版本；jsdom 留在 28，是因为升到 30 并在更新的 Node 上验证是另一件事。

## 前端测试

```bash
npm test
```

各套件挂在 `package.json` 的 `test` 脚本里。下面只记每个套件挡住的失效，以及写测试时踩过的恒绿陷阱。

- `scripts/rename-rules-check.mjs` — 批量重命名规则与两阶段执行，含失败回滚。静态断言钉住三个序号字段都走 `seqNumber`。只改实现、不改调用点时，纯逻辑断言仍会全绿。
- `scripts/seq-number-mutation.mjs` — 序号输入的变异测试。清空「步长」会让所有行同一序号，判重不触发，整批照常执行。脚本打印 `anchor found: N` 并断言 `N === 1`，跑完还原源文件。
- `scripts/selection-remap-check.mjs` — 选中态在排序 / 过滤后的重映射。选中态若按下标存储，重排后按 Delete 删掉的是另一个文件。
- `scripts/entry-key-check.mjs` — `entryKey()`。文件名只在单个目录内唯一。断言模板确实调用了 `entryKey`，只测纯逻辑时「改实现但模板仍写 `entry.name`」会全绿。
- `scripts/row-key-identity-check.mjs` — 用真实 `@vue/runtime-core` 跑 keyed diff。key 撞车时 Vue 的 `key -> 下标` map 被后者覆盖，节点复用错位一格，目录大小、缩略图、内联改名状态会贴到错误的行。原先文档称这会让改名输入框挂到错误文件上，实测推翻：输入框位置只由 `renamingIndex` 决定。身份重映射的 watcher 先于 `props.entries` watcher，残留缺口（`found` 排序下同引用 + 就地 `splice`）当前调用方不可达，归档在 `TODO-done.md`。
- `scripts/load-gate.test.mjs` — `loadLands()`。快速导航时先发后到的旧结果曾覆盖当前目录。发号排序（只有最新一次能落地）和 `inFlightLoads` 的同 key 折叠互斥：A→B→A 时回到 A 的请求被折叠，A 的首个请求又被 B 的序号作废，谁都不落地。转圈不能复用落地判据，归属由 `createSpinner()` 单独记。
- `scripts/preview-gate.test.mjs` — `previewLands()`。HEIC 解码要几百毫秒，按住方向键时先发的文件会后到。守卫要落在每一个 `await` 之后。作废一个已经产出资源的结果时，必须把 blob revoke。`releaseHeicUrl()` 必须在加载入口调用，不能只在 HEIC 分支里。
- `scripts/autoplay-gate.test.mjs` — `arm()` / `claim()`。`VideoPreview` 曾在 `ended` 时自己把 `pendingAutoplay` 置真，父组件拒绝换曲后标志永远悬着，此后手动点选任何视频都会自动播放。按路径校验拦不住。谁决定，谁置位。消费点必须在所有分支的共同入口，且在 `isExternalOnly` 提前 return 之前。`claim()` 无论命中与否都清空。`await entryPath(...)` 期间用户可能已关掉预览，撤销做在 `closePreview` 里的 `arm(null)`。
- `scripts/sfc-check.mjs` — 把 `src/components/*.vue` 过一遍 `@vue/compiler-sfc` 的 `parse` + `compileScript`，挂在 `npm run check` 里、先于 `npm test`。其余套件把 `.vue` 当文本读，抓不到重复声明。`parse()` 不报重复声明，`compileScript` 才报。传给编译器的 `id` 用正斜杠。变异还原只写回内存里的原文，不要 `git checkout -- <file>`，那会把同一轮尚未提交的修复一起回滚。
- `scripts/subtitle-gate-check.mjs` + `scripts/subtitle-gate-mutation.mjs` — `begin()` / `lands()`。字幕探测要串四次 await，旧链 resolve 时会把旧目录的字幕推进新文件的轨道列表。`detectSubtitles` 若在 `listDirectory` 之后才读文件名，dir 取自旧文件、base 取自新文件。快照必须在 await 之前取。这里可以用「意图身份」，因为字幕探测没有同 key 折叠；`loadGate` 有折叠，所以那边不能用序号。`begin()` 必须无条件调用，包括不探测字幕的分支。共享状态只在全部 await 之后一次性提交。
- `scripts/preview-request.test.mjs` — 打开预览的入口守卫。四个入口都要先 `await entryPath(...)`。`showFilePreview` 若在 await 之后才读 `activePanel`，期间按 Tab 会把预览挂到已经离开的那一侧。快照记源面板、活动面板、目录、条目身份，四项全等才落地。空快照必须判为不可落地。纯逻辑断言抓不住「删掉守卫调用」，所以额外数调用点。
- `scripts/keyboard-text-check.mjs` — `classifySelectAll` 与 `selectAllPreviewText`。带对照臂：旧守卫（只判 `INPUT`）必须露馅。
- `scripts/ime-guard-check.mjs` — `isImeKeydown`。对照臂钉住去掉守卫后 18 个 `list.*` 绑定会被认领。静态断言守卫早于第一个 `matches()`。jsdom 不实现 `isContentEditable`，脚本显式补种。
- `scripts/global-keydown-check.mjs` — 全局 keydown 监听器必须具名，并在 `onUnmounted` 里用同一引用移除。匿名箭头会在 HMR 时叠监听。存在即可型断言会漏掉 `if (false && matches(...))`，要用 `conditionOf()` 反查条件。
- `scripts/delete-scope-check.mjs` — `onDelete` 逐项 await，期间 `entries` 已是新目录的列表。`remainingCount` 必须用快照算，不能改成「切走了就不 emit」。判据是目的地还是不是它：A→B→A 折返时迟到的删除应该落地。抽函数体必须先配平圆括号跳过参数列表，`onDelete(targets, opts = {})` 的默认参数里就有花括号。
- `scripts/ctx-menu-gate-check.mjs` — 右键菜单在 `ensureArchiveTools` / `entryPath` / `isExecutable` 三个 await 之后才提交 `ctxEntry` / `ctxIsExecutable` / `ctxMenu`。慢的右键会接管快的那次菜单，点重命名改的是另一个文件。意图身份用对象 token，不用自增序号。关闭语义（`gate.reset()`）必须和落地判据分开，否则 `handleCtxSelect` 第一行的 `closeCtxMenu()` 会把自己作废。路径快照要透传到六个 action。逐个查 await 的边界要收到下一个 `await` / `catch` / `finally`，收到函数末尾会把 `catch` 里的复核算到前一个 await 头上。
- `scripts/config-writer-check.mjs` — 同 name 的写入 FIFO。后端 Mutex 解决不了顺序，变异去掉锁后「并发写不产生拼接文件」仍然全绿，因为 `write_atomic` 已经保证每次写完整。乱序测试的延迟若随 body 变长，短的会先完成，反例根本没发生。要先断言「无串行化确实会落地过期值」。
- `scripts/format-size-check.mjs` — 体积格式化曾经有 8 份副本。2 TB 在预览里显示 `2.0 undefined`，在列表里显示 `2.0 TB`。索引要双向钳制（小于 1 字节时 `log < 0`）。`Number.isFinite` 与 `<= 0` 要在取对数之前。静态断言要先剥注释，否则文档里的 `Math.log` 会让断言自己判自己过。
- `scripts/node-pick-check.mjs` — `pick-node.js` 的版本决策。`realIo()` 漏掉 `readFile` 时，`engines` 被空 `catch` 吞掉，测试仍全绿。要故意把 `engines.node` 改成一个违反约束的版本。`console.error` 改成 `console.log` 的变异，在本机没有告警可发时也是恒绿，所以改成真跑 CLI 并检查 stdout 恰好一行。
- `scripts/docx-sanitize-check.mjs` — 见上文 [docx 与 CSP](#docx-与-csp)。对照臂要求旧黑名单至少漏掉 3 个（实测 17/33）。断言解析回 DOM 查属性，不比对输出字符串。

## 后端测试

在 Git Bash 里运行（`scripts/cargo-check.sh` 会配置 MSVC）：

```bash
cargo test --lib
cargo test --lib overwrite_tests
```

覆盖 `glob_match`、`executable_kind` / `has_pe_header` / `script_has_command`、窗口几何 `resolve`、地址栏 `%VAR%` 展开、文件覆盖策略、原子替换、配置落盘、递归守卫。

**地址栏 `%VAR%`。** 手输 `%USERPROF`（漏了收尾 `%`）时，旧实现返回 `%`，后面的字符被吞掉，用户看到的是「路径不存在」。未闭合则原样保留。`%%` 是字面量，展开成空串会让路径凭空消失。未知变量仍展开为空。查找以参数注入（`expand_env_vars_with`）。「wrapper 仍读真实环境」这条，把实现改成硬编码返回值时行为测试仍全绿，因为测试自己 `set_var` 设了值。补了 `include_str!` 静态断言，needle 用 `concat!` 在运行时拼，否则判据文本会被自己读回来。

**配置落盘。** 完整性与顺序各在一侧，见上文。第一版在后端加了按 name 的 Mutex，去掉锁重跑，「并发写不产生拼接文件」仍然全绿。并发测试用 8 个不同长度的 body，40 个写线程与 1 个读线程对打，并断言读者确实观测到了内容。

**覆盖写与递归。** `cargo check` 查不出竞态、丢数据和泄漏，这些缺陷类型是正确的。写完测试要把修复回退成旧写法重跑一次。本机沙箱会拦截 reparse point 的创建与读取：从 Bash 通道 `symlink_dir` 可能返回 `Ok` 却没建出链接。写涉及链接的测试必须先断言前提，否则 skip。同一个 `code = 5`：沙箱里是「无法验证」，在 `dev.sh` 里出现则是代码有 bug（当时是 `GENERIC_READ` 多要了权限）。

Windows 文件系统 API 的语义不要靠推理。`Path::is_dir()` 是否跟随链接、`file_type().is_symlink()` 对 junction 返回什么、`MAX_PATH` 在第几层兜底，都要在本机建真实样例。曾有一处「junction 会导致栈溢出 abort」的结论是错的：实测 `is_symlink()` 返回 `true`，不会崩，只是产出约 30 层幽灵目录。

## 本地发布构建

```bash
npx tauri signer generate -p mini-tc-updater -w src-tauri/keys/mini-tc.key
bash scripts/release/build-release.sh
```

产物在 `scripts/release/out/`，包含 `.msi` 和 `latest.json`。打 tag 触发 GitHub Actions 的步骤见 [README](README.md#发布新版本)。

## 目录结构

```
mini-tc/
├── src/                      # Vue 前端
│   ├── App.vue               # 主双面板布局 + 菜单栏
│   ├── main.js               # 应用入口（含启动屏计时）
│   ├── api.js                # Tauri invoke 封装
│   ├── paths.js              # entryPath / entryKey / minitc://search/{id}
│   ├── style.css             # 全局样式与 4 套主题变量
│   ├── shortcuts.js          # 快捷键注册表
│   ├── keyboardText.js       # isTypingTarget / classifySelectAll / isImeKeydown
│   ├── bookmarks.js          # 书签 store
│   ├── viewState.js          # 视图状态 store
│   ├── alwaysOnTop.js        # 窗口置顶
│   ├── heicDecoder.js        # HEIC 主线程侧
│   ├── heicDecode.worker.js  # libheif wasm → RGBA
│   ├── dedupRules.js         # 重复文件的保留项 / 待删清单
│   ├── configWriter.js       # 同名配置写入的顺序
│   └── components/
│       ├── FilePanel.vue
│       ├── TabBar.vue
│       ├── PathBar.vue
│       ├── BookmarkMenu.vue
│       ├── FileList.vue
│       ├── FilePreview.vue
│       ├── VideoPreview.vue
│       ├── ContextMenu.vue
│       ├── SettingsDialog.vue
│       ├── GeneralSettingsDialog.vue
│       ├── SearchDialog.vue
│       ├── DedupDialog.vue
│       └── ShortcutsDialog.vue
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # Tauri 命令
│   │   ├── dedup.rs          # 按内容比较
│   │   ├── atomic_file.rs    # 原子写
│   │   ├── search_log.rs     # 搜索诊断日志
│   │   └── window_state.rs   # 窗口几何
│   └── tauri.conf.json
├── scripts/                  # 前端检查与发布脚本
├── package.json
└── vite.config.mjs
```
