# 修复：复制跟随目录联接（junction）无限嵌套

> 来源：`TODO-done.md` 第 148 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 3 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：复制跟随目录联接（junction）无限嵌套** — ⚠️ **本条的原始描述三条全错，已按实测修正**。原写「junction 的 `is_symlink()` 返回 false / 三处递归都没深度保护 / 栈溢出 abort 进程」，在本机建真实 junction 跑探针后逐条推翻：
  - 🚨 **后续修复（2026-10-11，`6d6d769`）：上一版只修了一半 —— 用户实测「复制后出现的是空目录，不是联接」。** 根因：**守卫只加在「收集任务」阶段，执行阶段仍用 `src.is_dir()`，而该方法跟随链接、对 junction 返回 true，于是走进 `create_dir_all` 分支留下空目录**。空目录比报错更糟 —— 看起来像复制成功而内容全无。**教训：加守卫必须覆盖同一决策链上的每一环，只改一处等于把「明显的失败」变成「静默的谎言」。**
  - ↩ **最终决定（2026-10-11）：放弃复制链接的功能，回滚为「跳过并如实提示」。** 用户判断该场景非常少，不值得继续投入。保留的只有防崩溃的部分：识别链接、**不下钻**、跳过并在结果里列出跳过了哪些。删除了 `create_reparse_point` / `recreate_link` / `build_mount_point_buffer` 及其测试（净减约 400 行）。**不重建链接的理由**：需要手工拼 reparse 缓冲区，写错只得到 `ERROR_ACCESS_DENIED`；且我已在这个功能上连续栽了三次（产出空目录 → 误判为沙箱拦截 → 真实 code=5），每次都要用户实测才发现。如实跳过优于给出一个可能错误的结果。
  - ⚠️ **本条最贵的教训（与代码无关）**：同一个 `code = 5` 我错了两次。第一次在沙箱里看到它，我归因为「沙箱拦了 reparse point」并交付；用户在 `dev.bat`（不受沙箱限制）复现后，证明**是代码 bug**（`CreateFileW` 多要了 `GENERIC_READ`）。**「我验证不了」不等于「它是对的」** —— 无法端到端验证的代码应当拆成可测的纯函数再交付，或干脆不交付。更糟的是我最初的测试**期望值是照着自己错误的实现写的**，于是「测试全过」而功能是错的；测试必须锚定权威数据源（这里是 `fsutil reparsepoint query` 的真实输出），不能锚定实现。
  - **保留下来的正确部分**：`classify_item()` / `ItemKind`（用 `symlink_metadata` 不跟随地判类型，收集与执行两阶段共用）—— 这才是防「无限递归 → 幽灵目录 → 报告成功」这一串数据损坏的关键。删掉的是「重建链接」，不是「识别链接」。
    - 修法：① 新增 `ItemKind { File, Dir, Link }` + `classify_item(path)`（走 `symlink_metadata` 不跟随），**收集与执行两阶段共用同一判定**；② 新增 `recreate_link(src, dest)`：读出源链接目标后在目标位置重建同类型链接（junction 走 `FSCTL_SET_REPARSE_POINT`，无需管理员；失败回退 `CreateSymbolicLinkW`）；③ 把缓冲区构造抽成**纯函数** `build_mount_point_buffer`，因为沙箱不允许端到端验证字节布局，而布局错了只表现为无从诊断的 `ERROR_ACCESS_DENIED`。
    - 🚨 **缓冲区布局第一版凭理解写，全错**。用 `fsutil reparsepoint query` 导出 Windows 自己创建的 junction 后发现三处不符：substitute name 带 NT 前缀 `\??\`（不是单个反斜杠）；**Windows 根本不写 print name**（`PrintNameLength = 0`，我写了完整路径）；`SubstituteNameLength` **不含**结尾 NUL 但 `PrintNameOffset` 指向 NUL 之后（差 2 字节）。现已与实测逐项一致（`SubstLen=72`/`PrintOff=74`/`PrintLen=0`，并验证过随路径长度变化）。
    - **测试当场抓出两个真实缺陷**（`reparse_buffer_tests`）：`PrintNameLength` 写了多余内容；超长目标因 u16 回绕**未被拒绝**（会产出一个被 Windows 拒绝且无从诊断的缓冲区）。现已改为在系统调用前显式检查长度。
    - **沙箱事实**：从 Bash 通道同时拦截 reparse point 的**创建与读取**（`symlink_dir` 返回 `Ok` 却没建出链接、`fs::read` 报 code=5），而独立 shell 工具在**同一目录**能成功建 junction —— 据此确认阻塞来自沙箱而非代码。**端到端行为必须由用户在 `dev.bat`（不受沙箱限制）中验证。**
    - `cargo test --lib` 全库 **38 passed / 0 failed**；`cargo check` / `cargo fmt --check` 均 exit 0。
  - ❌「`is_symlink()` 对 junction 返回 false」—— **实测为 `true`**（`symlink_metadata` 上 `is_symlink=true`、`is_dir=false`）。所以搜索（`829`）、`dir_size`（`423`）、`clear_readonly_recursive`（`1125`）**本来就守得对**，无需改动。
  - ❌「三处递归都没有深度保护」—— 只有 `collect_copy_tasks` 有问题；另两处走 `DirEntry::file_type()` / `symlink_metadata()`，不跟随链接。
  - ❌「栈溢出 abort 进程」—— **不会崩**。Windows 的 `MAX_PATH`（约 260 字符）在**深度 31** 处兜底，遍历自然终止（实测路径 `loop\loop\loop\…`）。
  - ✅ **真实危害是数据损坏**：复制会产出约 30 层幽灵目录并**报告成功**；若是移动，源侧未完整写过去的尾巴会被判定「搬完了」而删除。
  - ✅ **真正的陷阱是 `Path::is_dir()` 会跟随链接**：对 junction 返回 `true`，`read_dir` 于是列出目标内容；指向自身祖先的 junction 就无限自我嵌套。
  - **修法**：`collect_copy_tasks` 改用 `fs::symlink_metadata(src).file_type().is_symlink()` 判定（**不跟随**，与搜索/`dir_size` 一致），遇 reparse point 记为单个可复制项而**不下钻**；新增 `MAX_COPY_DEPTH = 64` 深度上限（对齐搜索已有的 `MAX_SEARCH_DEPTH`），触顶时**如实报错并把该源标 tainted**（静默截断在移动时会导致源侧未复制的尾巴被删）。函数返回值改为是否截断，`copy_all` 据此上报并 taint。
  - **语义说明**：只有「link → 自身祖先」才是危险形状；junction 指向**兄弟目录**只是把那份树复制两份，符合用户本意，故**复制而非跳过**。
  - **测试**：新增 `mod recursion_tests` 3 例。⚠️ 过程中发现**从 Bash 通道无法创建 reparse point**——`symlink_dir` 与 `CreateSymbolicLinkW(DIRECTORY|ALLOW_UNPRIVILEGED_CREATE)` 都返回 `Ok` 却什么都没创建（`exists()=false`）。**第一版测试因此失败**（断言 `link.is_dir()` 为真、实际为假）。已改为「先验证链接真的存在、否则大声 skip」，实测输出 `skipping: this machine does not allow creating links`。⚠️ 同一台机器**不同执行通道能力不同**：独立 shell 通道建 junction 成功，从 Bash 通道调 API 被拦 —— 取证时必须记录用的哪个通道。
  - `cargo test --lib` 全库 **30 passed / 0 failed**，`cargo check` / `cargo fmt --check` 均 exit 0。提交 `d216509`。
  - ⚠️ **方法论教训（比这个 bug 本身更值钱）**：本条的原始结论来自「读代码推理」，**全错**。**凡涉及 Windows 文件系统 API 语义的判断，必须在本机建真实样例实测**——`is_dir()` 是否跟随、`is_symlink()` 对 junction 返回什么、`MAX_PATH` 在哪一层兜底，都无法靠推理确定。同理，**断言前先确认前提成立**：在不成立的前提上写断言，测的就是空气。
  - 📌 **验证方式订正**：先前给的「资源管理器 → 属性 → 联接」是**错的** —— Win10/Win11 的资源管理器**都不提供创建 junction 的图形入口**，junction 的官方创建方式是命令行 `mklink /J`（且 junction **不需要管理员权限**，这正是它相对 symlink 的优势）。识别已存在的 junction：文件夹图标左下角有**蓝色小箭头**，或 `dir /AL` 显示 `JUNCTION`。已在 `D://tctest-junction//` 备好测试环境（`link-to-target` → `target`，以及自环的 `src\self` → `src`）。
