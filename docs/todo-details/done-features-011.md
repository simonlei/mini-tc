# 预览文本文件时支持选中文本复制

> 来源：`TODO-done.md` 第 24 行 · 章节 已实现功能（想法暂存区） · 第 11 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **预览文本文件时支持选中文本复制** — 当前 `FilePreview.vue` 的文本预览区（`<pre class="preview-text">`，约 line 35）是只读渲染，鼠标拖选文本后无法便捷复制：`App.vue` 全局 keydown 拦截了 `Ctrl+C` 走**文件剪贴板**，不会复制选中的预览文本；且 `<pre>`/`.text-body` 的可选性需确认未被 `user-select: none` 之类关掉。目标：预览 **文本类型** 文件（txt / json / log / md 等走后端 `read_file_preview` text 分支的）时，用户可在预览区内拖选文本并复制。需处理：① 确保文本预览区 `user-select: text` 可正常选中；② `Ctrl+C` 在预览区且存在文本选区时，走 `navigator.clipboard.writeText(selection)`（或 `document.execCommand('copy')`）复制选中文本，而非触发文件复制——即 `App.vue` 的全局 `Ctrl+C` 需判断「当前焦点/选区是否在预览文本区」，是则放行或主动复制选区；③ 可选：右键菜单「复制选中」、预览区「复制全部」按钮；④ 与现有「文件剪贴板」`Ctrl+C` 互不冲突（文件列表选文件→复制文件，预览区选文本→复制文本），注意区分「文件选中」与「文本选区」两种语义。
  - 实现：① `FilePreview.vue` 的 `.preview-text` 显式加 `user-select: text`；② `App.vue` 新增 `hasPreviewTextSelection()`（用 `window.getSelection()` 判断选区非空且锚点在 `.preview-text` 内），全局 `Ctrl+C`/`Ctrl+X` 命中该选区时直接 `return` 放行原生复制，不再触发文件复制/剪切——文件列表选文件→复制文件、预览区选文本→复制文本两种语义互不冲突；③ 预览区 footer 新增「复制全部」按钮（`copyAll`，优先 `navigator.clipboard.writeText`、失败回退隐藏 textarea + `execCommand('copy')`，成功后按钮短暂显示「已复制 ✓」）；④ 右键菜单「复制选中」本就由浏览器原生上下文菜单在选区存在时提供，无需额外实现。前端改动未跑构建，待用户双击 `dev.bat` 实测。
