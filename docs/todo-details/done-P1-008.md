# 修复：`onCtxMenu` 三个 await 之间无守卫，慢的旧右键接管新右键的菜单

> 来源：`TODO-done.md` 第 317 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 8 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`onCtxMenu` 三个 await 之间无守卫，慢的旧右键接管新右键的菜单** — `FilePanel.vue` 的 `onCtxMenu`（原 1765-1785）。首次右键要 `await ensureArchiveTools()` 扫盘探测 7-Zip/WinRAR（可能数秒），随后还有 `await entryPath()` 与 `await isExecutable()` 两次 IPC。
  **已修（2026-10-19）**。实测比原描述多找到一个**更严重的**后果，原文只提到 `ctxIsExecutable` 被改写：
  - 🚨 **真正的破坏是「菜单与动作指向不同的文件」**：原代码在**第一个 await 之前**就写了 `ctxEntry = entry`，而 await 之后无条件写 `ctxMenu`。A 行右键（慢）→ 用户右键 B 行（快）→ B 的菜单弹出、A 的流程后到把 `ctxMenu` 连同**旧坐标**整个覆盖掉。此时屏幕上显示 B 行坐标处弹着**按 A 行算出来的菜单项**，而 `ctxEntry` 早已指向 B —— 用户点「重命名」改的是 B、点「以管理员身份运行」提权跑的是 B，却以为在操作 A。**静默的错误对象操作，全程无报错。**
  - 🚨 **「判据用序号」这条修法本身有坑，写第一版时踩了**：`handleCtxSelect` 的**第一行就是 `closeCtxMenu()`**。把「菜单是否已关闭」写进落地判据，等于让正在派发的那一次点击自己作废自己 → 右键菜单永远弹不出来。所以关闭语义单独由 `gate.reset()` 承担（作废**仍在飞的构建**：用户在探测期间点掉遮罩，之后不该再弹一次），与「结果能否落地」分成两件事。测试里专门钉了「同一 token 连续复核 5 次都通过」这条前提。
  - **判据 `src/ctxMenuGate.js` 的 `ctxMenuLands()`**，两条都在问「目的地还是不是它」：① **意图身份** —— 每次右键 `begin()` 拿一个全新对象 token。用**对象身份而非自增序号**：本项目里序号已被反复证伪（`rerunSearch` 的 `Date.now() % 1000000` 16.7 分钟循环一次），且 A→B→A 折返时第一个 A 的 token 已被第三次右键换掉，不会「谁都不落地」。② **目的地** —— tab 身份 + 目录路径。`entryPath` 拿**活动 tab 的 path** 去拼行，等待期间导航走就打到别的目录；两项都得比，因为 Ctrl+T 克隆当前目录会造出「两个 tab 开着同一个目录」。
  - 🚨 **共享状态只在末尾一次性提交**（守卫的真正价值所在）：`ctxEntry` / `ctxIsExecutable` / `ctxMenu` 三次写入全部挪到最后一个 await 之后，`ctxIsExecutable` 改成局部变量、确认落地才赋给 ref。**半更新的中间态比完全不更新更毒。**
  - 🚨 **路径快照必须一路传下去，停在半路等于没做**：`ctxMenu` 现在存菜单**建的时候**的 path，`handleCtxSelect` 用它并透传给 `doRunAsAdmin` / `doExtract` / `doAddToArchive` / `doNewFolder` / `onOpen` / `navigateInto`（六个都加了 `basePath` 形参）。原因是菜单遮罩吞掉鼠标点击，但**键盘导航（Ctrl+Tab、Alt+←）仍会打到全局处理器** —— 菜单开着时面板完全可能已经换目录。这是原文没提的第二处。
  - **测试 `scripts/ctx-menu-gate-check.mjs`**（51 例）：纯逻辑表 + A→B→A 折返 + reset 语义 + **对照臂**（判据退化为恒 `true` 时 4 个「必须作废」场景全部反向，实测 4/4 有分辨力）。
    - ⚠️ 纯逻辑断言抓不住「改实现不改调用点」，故补**静态断言**：守卫被 import、`ctxGate` 实例存在、**3 个 await 逐个查**后面都有复核、三处共享状态赋值都在最后一个 await 之后、`closeCtxMenu` 调了 `reset`、`handleCtxSelect` 用 `ctxMenu.value.path` 且不再重读 `activeTab`、六个 action 都接了 `basePath`。
    - 🚨 **静态断言自己踩了一次坑（变异测试抓出来的）**：「每个 await 后都有复核」第一版把跨度取到**函数末尾**，于是 `catch` 分支里那次复核被算到了前一个 `await` 头上 → **「删掉 `isExecutable` 之后的复核」这个变异 0 FAIL 逃过了**。边界收紧到下一个 `await` / `catch` / `finally` 才抓住。**「守卫总数 == await 数」这种数总数的写法也会漏**（全堆在最后一个 await 之后照样「看起来对」），必须逐个查。
    - **变异测试 `scripts/ctx-menu-gate-mutation.mjs`：14/14 全部实测被抓到**（判据恒 true / 漏比目的地 / 漏比 tabId / 路径改宽松相等 / `reset` 变空操作 / `begin` 不换 token / 删任一 await 后的复核 / `ctxEntry` 提前赋值 / `ctxIsExecutable` 写共享 ref / `closeCtxMenu` 不 reset / 路径快照改回读 `activeTab` / `doExtract` 不接 `basePath`）。每个都打印 `anchor found: N` 并断言 N==1。
  - 其余套件全绿：`rename-rules-check` 140、`keyboard-text-check`、`node-pick-check` 109、`docx-sanitize-check`、`config-writer-check` 16、`format-size-check` 87、`entry-key-check` 12、`row-key-identity-check` 11、`selection-remap-check` 22、`lint-imports` 38 文件。**待用户双击 `dev.sh` 实测**：冷启动后**立刻**在文件上右键（触发数秒的压缩工具探测），探测期间立刻右键**另一行** —— 菜单应只为第二行弹出，且各项作用在第二行；开着菜单时按 Ctrl+Tab 换 tab，再点「复制路径」，复制的应是菜单那一行的路径。
