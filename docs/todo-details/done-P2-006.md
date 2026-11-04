# 文件夹内重复文件去重：扫描出内容相同的文件，确认后删除多余的

> 来源：`TODO-done.md` 第 408 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 6 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **文件夹内重复文件去重：扫描出内容相同的文件，确认后删除多余的** — 菜单栏「重复文件」打开对话框，对**当前目录**（可选递归子目录）做内容去重：找出内容完全相同的文件，分组列出让用户确认，**确认后**才把每组多余的副本移入回收站。
  - **判重算法（零新增依赖，如约）**：核心放在新文件 `src-tauri/src/dedup.rs`（纯逻辑 + 8 个 Rust 单测）。先按 `size` 分组（长度不同必不相同，这一步零 IO 就滤掉绝大多数），同长度组内**先比首尾各 64 KB**（`quick_eq`）再**逐字节流式比全文件**（`files_equal`，256 KB 块）。**刻意不引哈希 crate** —— `Cargo.toml` 里本来一个哈希依赖都没有，而哈希碰撞在这里意味着静默删掉用户还想要的文件；逐字节比零误判。`bucket_by_size` 返回最大长度优先的桶，`cluster` 只比较每个簇的**代表**（首个成员）而非全体，把内层从 O(n²) 次文件比对降到 O(n × 簇数)。
  - **比较结果分三态**（`Same::Yes/No/Unknown`）：`Unknown` = 读不出来（被占用 / 无权限 / 已消失），**永远不会被当成「重复」**。宁可漏掉一对，也不误删。`quick_eq` 对长度不同的两个文件直接返回 `No`，不读内容。
  - **保留哪一个**：每组默认保留**修改时间最新**的（mtime 相同则取路径较小者，保证多次扫描一致 —— 后端已按 path 排序，所以结果与组内顺序无关）。每组可单选圆点切换保留项、复选框单独取消某个副本。判定逻辑全在纯函数模块 `src/dedupRules.js`（`defaultKeepers`/`redundantFiles`/`switchKeeper`/`fileChecked`/`toggleChecked`/`checkAllInGroup`/`summarize`/`buildDeletePayload`），组件只渲染。**自定义对话框 `DedupDialog.vue`** —— `showConfirm` 只渲染 `items.slice(0,5)`，几十组会被截断。
  - **删除前 TOCTOU 复检**：`dedup_delete` 里每个文件进回收站**之前**重新 `stat`，长度或 mtime 对不上就跳过、如实报进 `changed` 列表。四项复检缺一不可：`is_symlink()`（路径已变成链接）、`!is_file()`（已变成目录）、长度、mtime。判「存在」用 `symlink_metadata` 而非 `metadata`（后者跟随链接，会把已变成符号链接的路径当成它的目标来检查）。
  - **删除走回收站 + 一对 begin/commit**：整批只用**一对** `begin_trash_delete`/`commit_trash_delete` 包住 → 一次 `Ctrl+Z` 全撤回。撤销栈深 1，逐文件开括号只会让最后一个文件可恢复。**不提供「永久删除」选项**。
  - **取消槽独立**：`DEDUP_CANCEL` 是 `LazyLock<Mutex<HashMap<u64, Arc<AtomicBool>>>>`，**没复用 `SEARCH_CANCEL`**（单槽 + `start_search` 抢占式 cancel，共用会互相顶掉）。同 id 的新扫描才取消上一次；线程收尾用 `Arc::ptr_eq` 只移除自己的 flag。⚠️ 踩到 `Mutex::new(HashMap::new())` 编不过 —— `Mutex::new` 是 const fn 但 `HashMap::new` 不是，必须 `LazyLock`。
  - **扫描范围与排除**：只处理文件不处理目录；文件符号链接不参与、目录链接不下钻（否则遍历成环）；深度上限 64；**0 字节文件默认排除**（前端固定传 `includeEmpty: false`）；隐藏文件有开关。⚠️ 「0 字节不参与」这条规则**故意不放在 `dedup.rs` 里** —— 那里两个空文件确实字节相同也确实会成簇（`empty_files_compare_equal_so_the_caller_must_filter_them` 这个单测就是在钉这个前提），因为「一堆空文件不是一堆副本」是产品决定，属于知道 `include_empty` 的扫描层。
  - **进度与取消**：`dedup-progress`（约每 300ms）回传已扫描数 + 当前目录；比对阶段把「已比对次数」放在 `phase` 字段回传（大目录逐字节比可能要一会儿，没进度就像卡死）。`cancel_dedup(id)` 按 id 取消，对话框关闭时也会取消。`dedup-done` 一次发全量结果（半成品的簇集合是误导）。后端沿用 `search_log::log` 写诊断日志 + `catch_unwind`（panic 也会发 `dedup-done`）。
  - **模态拦截**：App.vue `onGlobalKeydown` 开头加 `if (dedupVisible.value) return;` —— 在勾选框之间按 `Delete` 会删掉背后面板的文件。Esc 在对话框 capture 阶段处理，关闭时焦点精确归还（与搜索框同一套写法）。
  - **报告与刷新**：删除后刷新两个面板（文件可能在活动面板目录之外，勾了递归甚至在其子目录里）；`deleted`/`changed`/`failed` 三个列表都上报到可见的错误行，不静默吞掉。
  - **测试**：`scripts/dedup-rules-check.mjs`（110 条断言：纯逻辑 + 跨语言边界的静态断言，如后端是否真用 `symlink_metadata`、是否真只开一对括号、取消槽是否被搜索碰过）+ `scripts/dedup-rules-mutation.mjs`（28 个变异）+ `src-tauri/src/dedup.rs` 8 个 Rust 单测，均已挂进 `npm test`。变异测试期间抓到 4 个真盲区并补掉：① `eq()` 用 `JSON.stringify` 比 Map → 所有 Map 都序列化成 `{}`，「map 未变」的断言恒真（新增 `eqMap()`）；② 单成员组的 `files.length < 2` 守卫是恒真的（keeper 检查独立地挡住了它，要用「keeper 索引越界」才暴露）；③ stale-event 守卫只断言「存在」而非「两个处理器各有」（删掉任一个仍全绿）；④ 「已变化/失败」上报只查子串存在，`false &&` 包一层照样过。`config-writer-check` 的「总耗时」用例在并发跑全套时偶发失败（计时敏感，单独跑 16/16 通过），与本次改动无关。
