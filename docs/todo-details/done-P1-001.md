# 修复：`FileList.onKeydown` 缺 IME 守卫，中文输入会触发列表快捷键

> 来源：`TODO-done.md` 第 233 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 1 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`FileList.onKeydown` 缺 IME 守卫，中文输入会触发列表快捷键** — 原 `FileList.vue:862-866`。同文件的 `onSearchKeydown`（`671`）/`onRenameKeydown`（`775`）都写了 `if (e.isComposing || e.keyCode === 229) return;`，唯独认领全部 18 个 `list.*` 绑定的列表主处理器没有。
  **已修（2026-10-19）**，🚨 **TODO 原文的因果被实测推翻一半**：
  - 原文说「首个拼音字母的 keydown 带 keyCode 229，`matches()` 照常命中」→ **拼音字母不命中**。字母的 `e.code` 是 `KeyN` → `eventCombo` 得到 `"N"`，而没有任何命令绑在裸字母上。**别从「第一个拼音字母」推演这个 bug。**
  - 真正泄漏的是**功能键**：IME 在选词 / 上屏时按下的键，`e.code` 仍是 Space / Enter / Backspace / 方向键 / PgUp / PgDn / Home / End / Delete / F2。用生产 `matches()` 逐个实测：**18 个默认绑定无一幸免**。后果是选词时空格触发「计算目录大小」、回车触发「打开/进入」（当场把文件打开）、退格触发「返回上一级」，而这些分支还会 `preventDefault()`，把上屏本身一并掐掉。
  - **守卫必须查两个信号**：`isComposing` 不覆盖**启动**合成的那一下（那一次 `isComposing === false`），`keyCode === 229` 不覆盖部分 IME 的另一种形状。少一个就漏一半（变异③④ 分别只留一半，都被抓）。
  - **判据收敛到唯一入口**：抽 `keyboardText.js` 的 `isImeKeydown(e)`（与 `isTypingTarget` / `classifySelectAll` 同住一个文件——那里本来就是「这个按键归谁」的唯一判据）。`FileList` 三个处理器 + `ShortcutsDialog.onRecordKeydown` 四处统一调用，内联的 `e.keyCode === 229` 副本全仓清零（静态断言钉住）。
  - ⚠️ **`onRenameBlur` 刻意不动**：它查的是 `e.isComposing`（blur 事件没有 `keyCode` 可言，语义不同），不被这次收敛波及；变异⑥专门守这条反向断言。
  - **守卫的位置即正确性**：必须是 `onKeydown` 的**第一行**。挪到函数末尾就成了死代码 —— 此时 Space / Enter 在 kc=229 下已经走过 `matches()`（变异②被抓）。
  - **测试**：`scripts/ime-guard-check.mjs`，53 例 + **6 变异全被抓**（删守卫 / 挪到末尾 / 只留 `isComposing` / 只留 `229` / 另写内联副本 / 误改 `onRenameBlur`），已挂 `npm test`。三层结构：
    - 纯逻辑跑 `isImeKeydown` 真值表（含 `isComposing=undefined` / `=0` 不能当 true 这类边界）+ 用**真实** `matches()` 逐个验证 18 个绑定在 kc=229 下都不被认领。
    - **对照臂**钉住「去掉守卫后同一批事件会被认领」（18/18 全泄漏）。没有这组，第一组在 `matches()` 哪天自己学会看合成状态时会整体变成恒绿。
    - 静态断言守位置（早于首个 `matches()`）与唯一入口，外加两个 `.vue` 过一遍 `compileScript()` —— 守卫是新增调用，import 写错只有编译期才报。
  - ⚠️ 变异脚本本身踩了两次坑，都已修：① 锚点 `  if (isImeKeydown(e)) return;` 在 FileList.vue 里有 **3 处** → `anchor found: 3` = 变异没注入却被读成「断言瞎」，改用「守卫 + 空行 + INPUT 守卫」这段唯一文本；② 变异②初版是「挪到首个 `matches()` 之后」，实测 0 FAIL —— 判为**等价变异**（中间只有一条无副作用的 early-return），换成真盲点「挪到函数末尾」。
