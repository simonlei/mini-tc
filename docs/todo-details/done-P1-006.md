# 修复：预览状态的两个 watcher 在 `await` 后无条件写 preview，快速方向键会预览到旧文件

> 来源：`TODO-done.md` 第 290 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 6 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：预览状态的两个 watcher 在 `await` 后无条件写 preview，快速方向键会预览到旧文件** — 原 `App.vue` 的两个 `watch`、`showFilePreview`、`playNextVideo`、`togglePreview`。
  **已修（2026-10-14）**。原描述准确，但漏了 `togglePreview`（它自己也 await `entryPath` 后直接 `openVideo`）和 `playNextVideo`（已有 `previewVisible` 检查，但**没有**检查选中项/面板是否已变），实际是 **5 个落地点**而不是 2 个。
  - **第二个 bug 比描述里更深一层**：`showFilePreview` 在 await **之后**才读 `previewPanel.value = activePanel.value === "left" ? ...`，所以 await 期间按一下 Tab 就把预览挂到用户已经离开的那一侧。现在 panel 由调用方作为参数传下去（`panelId` 默认参数只作兼容，实际 4 个调用点全部显式传）。
  - **判据用「目的地还是不是它」，不用原提的自增 `previewToken`** —— `entryPath` 不做同 key 折叠，但序号模型在 A→B→A 折返时同样会让谁都不落地（与 `loadGate.js` / `previewGate.js` 同一条纪律）。纯逻辑在 `src/previewRequest.js`，快照记四项：源面板、活动面板、目录、条目身份（`entryKey`）。
  - 🚨 **「少比一项就等于漏掉一种真实操作」**：只比条目身份会漏掉切面板与换目录；只比目录+条目会漏掉「同名不同目录」（搜索结果页里同名是常态）。四项是逐一加上去的，不是随手一起比。
  - 🚨 **空快照会自判为可落地**（写测试时真发现的缺陷，不是预防性条款）：`makePreviewRequest()` 两个空对象本来就全等，返回 `true` 等于把「面板此刻没有选中项」（导航后清空选中）当成「目的地没变」，调用点会因此打开一个空预览。加 `if (!request.key || !current.key) return false`。
  - **测试**：`scripts/preview-request.test.mjs`（29 例）。除纯逻辑表外补了**静态断言**：剥注释后逐个数出**直接 await `entryPath` 的落地点**（4 个）与**转发给 `showFilePreview` 的调用点**（4 个）—— 纯逻辑断言抓不住「改实现不改调用点」，删掉守卫调用时判据测试仍全绿。
    - ⚠️ 写静态断言时踩了两次自己的坑：① 过滤条件一开始没带「是否写 preview* 状态」，把 `openBatchRename`（也 await `entryPath`，但写的是 `batchRenameItems`）也算进来；② 用 `/showFilePreview\([^)]*panelId\s*\)/` 匹配实参列表，而 `isTextPreviewExt(ext)` 自带右括号会让匹配半途截断 —— 改用 `/,\s*panelId\s*\)/`。
    - **4 个变异全部实测会失败**：① 判据退化成恒 `true` → 11 条红；② 删掉 `activePanelId` 那一行（漏比活动面板）→ 1 条红；③ 删掉 `showFilePreview` 里的守卫调用 → 2 条红；④ `panelId === "left"` 改回 `activePanel.value === "left"` → 1 条红。
    - ⚠️ **只测纯逻辑是不够的**：变异 ③ 就是反例 —— 判据本身完好无损，测试却应该抓住。所以静态断言那一节不能省。
  - `npm run check` exit 0（lint + 11 个脚本全绿）、`vite build --outDir .bootcheck` exit 0。**待用户双击 `dev.bat` 实测**：开一个预览，按住 ↓ 快速翻一串图片，确认标题/内容始终一致；再按住 ↓ 的同时按 Tab，确认预览不会挂到已离开的那一侧。
