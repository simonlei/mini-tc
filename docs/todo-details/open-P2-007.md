# 收敛：`list_directory` / 搜索 / `collect_copy_tasks` 三处把整棵树一次性物化到 Vec，无上限无分批

> 来源：`TODO.md` 第 71 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 7 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`list_directory` / 搜索 / `collect_copy_tasks` 三处把整棵树一次性物化到 Vec，无上限无分批** — ⚠️ **2026-10-19 取证：搜索那条已修，另两条仍完全成立。**
  - ✅ **搜索已修，原文对当前代码不成立**：`run_search` 现为**逐目录物化 + 边走边发** —— 显式栈迭代 DFS（`804-808`，避开 1MB 线程栈），每目录的 entries 分类进 `files`/`subs` 两个 Vec（`835-836`）后**立即**释放，发批发生在循环内部（`922-927`），且有硬上限 `787` 处 `clamp(1, 50_000)`。🚨 原文把场景写成「50 万条目的**树**」不准 —— `files`/`subs` 本身仍无上限，实际风险是「单个扁平的超大目录」才需要一次性持有 50 万个三元组。
  - 🚨 **`collect_copy_tasks` 仍完全无上限、无分批**（`2375-2382`，`tasks: &mut Vec` 只 push，唯一约束是深度 `MAX_COPY_DEPTH = 64`、与条目数无关）。**「全部发生在第一个 `copy-progress` 事件之前」成立**：`copy_all` 在 `2645` 对**每个**源累积进同一个 `tasks` → `2689/2690` 全部累积完才算 `total_bytes`/`file_total` → `2696` 执行循环才开始 → **首次** `emit_progress` 在 `2744`。即从收集开始到第一条进度之间，所有源的三元组已全部驻留内存。
  - 🚨 **`list_directory` 仍完全无上限**（`133-171`，`result: Vec<FileEntry>` 从头到尾只 push，无上限无 `truncated` 标志；返回类型 `DirectoryListing:71-74` 也无容量语义）；「`max_results` 只在搜索里钳制」属实（它是 `SearchOptions` 的字段 `523`，只出现在 `run_search:787`）。`173-179` 注释还明确说明**不做排序**（前端每次列举都重排），进一步说明这里没为截断预留余量。
