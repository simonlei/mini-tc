# 修复：`extract_archive` / `add_to_archive` 直接执行前端传来的 `tool_exe`，等价于任意程序执行

> 来源：`TODO-done.md` 第 226 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 10 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`extract_archive` / `add_to_archive` 直接执行前端传来的 `tool_exe`，等价于任意程序执行** — `lib.rs:2949` / `3152`。`get_archive_tools()` 返回的 exe 是后端自己探测的，但 `extract_archive(archive, target_dir, tool_exe, syntax, ...)` 不信任这个来源——webview 里任何一处 XSS 或被劫持的前端资源都能把 `tool_exe` 换成 `cmd.exe` 拿到完整用户权限。`syntax` 还能任意切换参数分支。对比同文件 `run_as_admin` 至少用 `executable_kind`（`1439`）做了白名单，这里连「是不是解压工具」都不校验。修法：后端维护 `tool_id → (exe, 参数模板)` 权威表，命令只接受 `tool_id`，删掉 `tool_exe`/`syntax` 两个前端可控参数。
  - ✅ **已实现（2026-10-14）**。实现：原 `get_archive_tools` 的探测体重命名为 `discover_archive_tools()`（**唯一**决定「哪些 exe 可以跑」的地方），命令版 `get_archive_tools` 把结果写进进程级注册表 `ARCHIVE_TOOLS`（`OnceLock<Mutex<Vec<ArchiveTool>>>`）后返回——这份列表同时就是允许清单。`resolve_archive_tool(tool_id)` 经纯函数 `find_tool_by_id` 精确匹配（**非前缀、非忽略大小写**），未命中报 `未知的压缩工具 id`；注册表为空时补跑一次探测（避免把「前端必须先调 get_archive_tools」变成安全检查的隐含前置条件，漏了就退化成「压缩功能莫名失效」；但**已填充**的注册表遇到非法 id 不重扫，否则每个 bogus id 都触发一次全盘驱动遍历）。`extract_archive` / `add_to_archive` 签名换成 `tool_id: String`，函数体开头 `let tool = resolve_archive_tool(&tool_id)?;` 再取 `tool.exe` / `tool.syntax`。前端 `api.js` 两个函数与 `FilePanel.vue` 两处调用改传 `toolId` / `tool.id`；`ArchiveTool.exe`/`syntax` 仍随列表返回，但**只用于菜单显示**（哪些项是 GUI、是否等窗口），不再被回传给后端。
  - 测试（67 passed）：① `find_tool_by_id` 表测 9 例（命中解析出正确 exe+syntax；`cmd.exe` 路径 / 空串 / 空列表 / 前缀 / 多余后缀 / 大小写不同 / 前导空格全部拒绝）；② `unknown_tool_id_is_refused_end_to_end` 过真实注册表与真实 resolver（先播种注册表避免单测里跑驱动遍历——空机器会拒一切 id，让测试「因错误的理由通过」）；③ 静态断言 `archive_commands_no_longer_accept_an_executable_from_the_frontend` 卡**签名**（needle 用 `concat` 片段拼，防自引用）：两个命令都不得再收 exe/syntax 参数、必须收 `tool_id`；④ 静态断言 `frontend_sends_the_tool_id_and_nothing_else` 用 `include_str!` 读 `src/api.js` + `FilePanel.vue`，卡住「改了后端没改前端」——那种不一致 `cargo check`/`cargo test` 全绿，只有用户右键压缩包时才炸成缺参数错误。
  - 变异测试（三个都确认注入成功并真的变红）：① 把 `extract_archive` 改回收 `tool_exe` 并真的用它 → 只有签名断言失败，其余 65 个纯逻辑测试全绿（正是分层的意义）；② `find_tool_by_id` 改成前缀匹配 → 表测 2 个失败；③ `api.js` 重新发送 `toolExe` → 前端断言失败。
