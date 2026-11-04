# 收敛：`edit.selectAll` 的输入框守卫只判 INPUT，漏 TEXTAREA / contenteditable

> 来源：`TODO-done.md` 第 374 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 3 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **收敛：`edit.selectAll` 的输入框守卫只判 INPUT，漏 TEXTAREA / contenteditable** — `App.vue:2141-2147`（Ctrl+A）vs `2160-2164`（Ctrl+C/X/V）/ `2108`（Esc）/ `2350`/`2382`（bookmark.toggle / view.toggleHidden）。
  **已修（2026-10-16）**。🚨 **TODO 原文给的修法（「三处统一调 `isTypingTarget`」）不足以修好这个 bug** —— 那正是「改错版本」的样子，已用断言钉住：
  - **根因比原文更宽**：`.preview-text` 是 `<pre>`，既不是 INPUT/TEXTAREA 也不是 contenteditable，**且没有 `tabindex`** → 点击它不产生焦点，`isTypingTarget` 对它**恒为 false**。所以只收敛守卫的话，预览文本全选照样失效。真正的判据是「**事件是否属于某个文本面**」，两块都要答：焦点在可编辑元素里，或选区/焦点落在预览文本面内。
  - **守卫其实有五份**，不是三份：`isTypingTarget`（已存在的正确实现，只被用了 1 处）+ Ctrl+A 的 INPUT-only 版 + Ctrl+C/X/V 与Esc 的两份内联副本 + `bookmark.toggle` / `view.toggleHidden` 的两份内联副本（原文漏查）。全部收敛到唯一入口。
  - **新模块 `src/keyboardText.js`**（组件与测试共用，不留在 `.vue` 里）：`isTypingTarget` / `previewTextRoot` / `selectionPreviewRoot` / `classifySelectAll`（返回 `"native" | "previewText" | "fileGrid"` 三态）/ `selectAllPreviewText`（`Range.selectNodeContents`，返回 false 时调用方回落文件网格，**不吞键**）。Ctrl+A 分支按三态分发：`native` 直接 return 不消费事件。
  - **`selectionPreviewRoot` 刻意不要求非折叠选区**：纯点击进预览留下的是折叠光标，而「全选」正是用户此刻想要的动作。（Ctrl+C 那侧仍用 `hasPreviewTextSelection` 的严格判据 —— 折叠光标不该遮蔽文件剪贴板。）
  - **`tabindex="0"` 加到 `.preview-text` / `.preview-doc`**：非 editable 元素没有焦点站，键盘用户到不了、读屏也会跳过。加焦点**不等于**给编辑权 —— 守卫判的是元素类型与选区，不是焦点。
  - ⚠️ **反向断言**：F5 / Ctrl+M 的 `t.tagName === "INPUT" && classList.contains("rename-input")` 是**有意**的窄语义（只避让改名框，让 F5 在地址栏/筛选框里继续生效），**必须保持原样** —— 改成 `isTypingTarget` 是行为变更而非收敛，测试双向钉住。
  - **测试 `scripts/keyboard-text-check.mjs`**（73 例，已挂进 `npm test`）：
    - jsdom **不实现 `isContentEditable`**（真实 contenteditable 元素上返回 `undefined`，Chromium/WebView2 有）→ 测试里显式 `defineProperty` 补种并注明，否则 contenteditable 分支在套件里静默不可达、「contenteditable 是输入类」这条规则根本没被测。
    - 含一组**旧实现对照臂**：旧守卫在「文件行焦点 + 预览选区」场景下判false（会误选文件列表），在 TEXTAREA/contenteditable 上也判 false（漏项）。
    - 🚨 **10 个变异全部实测被抓到**（每个都打印 `anchor found: N` 并断言 N==1）：含③ 判据退回「只看焦点」（原 bug 复活）、⑥ Ctrl+A 分支不判意图、⑧ rename-input 窄守卫被误改、⑨ 落地点换回内联三段判定、⑩ 去掉 `tabindex`。
  - `npm run check` exit 0（lint 37 文件 + 13 个脚本全绿）。**待用户双击 `dev.sh` 实测**：预览一个文本/json/log 或 docx → 点进预览正文（鼠标划选或键盘）→ Ctrl+A 应选中**预览里的文本**而不是背后的文件列表，且 Ctrl+C 复制出来的是文本；焦点在地址栏/筛选框时 Ctrl+A 仍是全选输入框内容。
