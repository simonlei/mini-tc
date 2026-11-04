# 启动性能优化（第二轮：收尾两项 + 一处回退）

> 来源：`TODO-done.md` 第 65 行 · 章节 已实现功能（想法暂存区） · 第 27 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **启动性能优化（第二轮：收尾两项 + 一处回退）** — 第一轮已落地 splash MIN/FADE 250（运行时内联单一真源）+ `mammoth` 按需 `import()`（主 bundle 670→169.79 KB）+ `optimizeDeps.include`。本轮**先核实再动手**：TODO 原列的候选①（`list_directory` 每条目 stat 两次）**早已在实现递归搜索时顺带修掉**（`entry.metadata()` + `is_hidden(name, &meta)`），无需再做。**落地两项**：① **`list_drives` 加缓存** —— 原实现每次调用都遍历 A–Z 做 `Path::exists` + 对应答的卷做 `GetDiskFreeSpaceExW`（空光驱 / 断连网络盘可阻塞数百 ms），而**左右两栏各自**在 mount 时和**每次窗口重新获得焦点**时都会调一遍（`App.vue` focus handler → 两个 panel 的 `refreshDrives()`），**一次切窗就是 4 次 A–Z 走盘**。改为后端 `OnceLock<Mutex<Option<(Instant, Vec<DriveInfo>)>>>` + 2s TTL；🚨 **锁必须持跨越探测本身**，只包缓存检查的话两栏的 mount 请求（同一 tick 发出）会双双 miss 各跑一遍全盘扫描；`DriveInfo` 需补 `derive(Clone)`（原只有 `Serialize`）。② **删掉 `list_directory` 末尾的 `sort_by`** —— 前端 `sortedEntries` 对除 `found` 外的所有列都重排，后端排的序必被丢弃，而那个比较器每次比较 `to_lowercase()` 两次 = O(n log n) 次堆分配；核查了后端顺序的全部消费者（`VideoPreview.detectSubtitles` 自己又 sort 一遍；`found` 的行来自 `start_search`）后确认可删。原候选③（配置 IPC 合并）**实测为负优化已回退**，另立一条记录。
