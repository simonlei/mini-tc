# 修复：全局 keydown 监听器注册在 `onMounted` 匿名函数里，`onUnmounted` 无法移除

> 来源：`TODO-done.md` 第 388 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 4 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：全局 keydown 监听器注册在 `onMounted` 匿名函数里，`onUnmounted` 无法移除** — `App.vue:2078` ↔ `2433`。
  **已修（2026-10-19）**。
  - **根因形状**：整个全局快捷键处理是一个 `document.addEventListener("keydown", (e) => {...})` 内联箭头。匿名函数一旦交给 `addEventListener`，`onUnmounted` 手里**没有可传给 `removeEventListener` 的引用** —— 同文件里 `onWindowFocusRegain` / `onVisibilityRegain` 都是具名函数且被正确移除，唯独这条不是。闭包持有整个组件作用域（所有 ref、两个 panel ref），组件卸载后仍驻留在 `document` 上，HMR 或任何重新挂载都会再叠一份，每一份都还在对按键做反应。
  - **修法**：把 351 行 handler 体整体搬成 setup 顶层具名函数 `onGlobalKeydown(e)`，`onMounted` 注册它、`onUnmounted` 移除**同一个引用**。搬移用 Python 按行锚点机械完成（先断言锚点内容再改），逐行去掉两格缩进；handler 体的分支一个没动，只顺带把 `F5` 那条注释里的锚点换成命令名（见下）。
  - **函数声明会提升**，所以 `onMounted`（源码上更早）里引用它不会有 TDZ 问题 —— 但这依赖提升语义，测试里显式断言了「注册调用出现在函数声明之前」，让这个顺序依赖可见而不是隐式。
  - 🚨 **为什么只能静态断言**：handler 的函数体搬前搬后**逐字相同**，纯逻辑/行为断言全绿 —— 这个 bug 的全部内容就是「注册与移除不对称」这个静态形态。所以判据钉的是**配对关系**：add 与 remove 必须引用同一个标识符，且该标识符必须有声明。
  - **测试 `scripts/global-keydown-check.mjs`**（64 例，已挂进 `npm test`）：
    - 逐个列出**全部** keydown 注册点（不是「存在即可」），要求传入的是裸标识符；判据不是「handler 里没有箭头」—— 那种会被 `f && guard()` 骗过。
    - 移除点与注册点**数量相等**且引用同一标识符；移除必须落在 `onUnmounted` 内（配平花括号取调用块，起点在 `onUnmounted(` 之后，规避 METHODOLOGY 记的「默认参数花括号导致配平错位」）。
    - 被注册的标识符**必须有声明**：注册一个未声明的名字会让 `addEventListener` 收到 `undefined`，静默无操作。
    - 分支完整性：15 条判据锚点（三个模态闸门、Esc / Ctrl+Q / Ctrl+F / Ctrl+A / 剪贴板 / 撤销 / F5 / Shift+F5 / 历史 / 书签 / 隐藏文件 / 面板切换）。⚠️ **F5 那条最初锚在注释里的 `"F5"` 字面量上**，剥注释后直接失败 → 换成真正的命令名 `edit.copyToOther` / `edit.moveToOther`。
    - **对照臂**：旧写法（匿名箭头 + 无移除）在本判据下必须露馅。
  - 🚨 **写断言时自己踩了一次「存在即可型恒绿」**：分支完整性首版用 `app.includes(needle)`，而变异 `if (false && matches("preview.toggle", e))` 里**那段字面量仍然在**，行为已成死代码而断言通过 —— 首版变异测试 `0 FAIL` 逃过。修法：加 `conditionOf()` 反查每个分支的 `if (...)` 条件文本（只配平圆括号、起点固定在 `if (` 之后），拒绝 `false &&` / `true ||` 之类恒假/恒真前缀，并额外断言「条件可定位」以防判据自身静默失效。
  - **5 个变异全部实测被抓到**（每个打印 `anchor found: N` 并断言 N==1）：① 改回匿名箭头（原 bug 形状）② 删掉 `removeEventListener` ③ 移除时引用另一个名字（看起来成对实则不是同一引用）④ 函数名打错（注册 undefined）⑤ 掏空分支体。
  - `npm run check` exit 0（lint 37 文件 + 16 个套件全绿）、`npx vite build` 通过。**待用户双击 `dev.sh` 实测**：快捷键应与改动前完全一致（Esc 关预览、Ctrl+Q、Ctrl+A、Ctrl+C/X/V、Ctrl+Z、F5/Shift+F5、Alt+←/→、Ctrl+D、Ctrl+H、Tab）；编辑任一 `.vue` 触发 HMR 后再按快捷键**不应出现一次按键触发两遍**的现象（改动前旧闭包仍驻留时会叠加）。
