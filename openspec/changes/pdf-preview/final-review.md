# Final Review: PDF 预览功能代码实现

## 审查结论：通过 ✓（评分 A）

代码实现正确、完备，与 design.md 和 tasks.md 完全吻合。未发现严重问题或阻塞性问题。

---

## 0. 文件范围合规检查

| 检查项 | 结论 |
|--------|------|
| design.md 定义变更文件 | `src/App.vue`（修改）、`src/components/FilePreview.vue`（修改）、`openspec/changes/pdf-preview/*.md`（新增） |
| 实际变更文件 | 上述 2 个业务文件 + openspec 文档。未见 `src-tauri/`、`src/api.js`、`package.json`、`package-lock.json` 及其他组件被修改 |
| `.gitignore` 最后一行 `.agent` | 仓库既有条目（`.workbuddy/` 同类工具目录），与本次 PDF 预览任务无关 |
| 超范围变更 | **无** |

**结论：✅ 文件范围完全合规。**

---

## 1. PDF 分支位置正确性

### 审查 `FilePreview.vue` `loadPreview()` 函数

代码流程（line 195-215）：
```
line 196: if (IMAGE_EXTENSIONS.includes(ext)) { ... return; }
line 203: if (ext === "pdf") { ... return; }  ← PDF 分支
line 215: try { result = await readFilePreview(...) }  ← 文本 IPC 分支
```

PDF 分支位于图片分支之后、文本 IPC 分支之前。两者都是早期 `return`，PDF 永远不会落入文本 IPC 路径。

### 审查 `App.vue` 放行链路

`PREVIEWABLE_EXTENSIONS`（line 344）：数组已含 `"pdf"`。

三处调用点均通过 `isPreviewableExt(ext)` 统一放行：
- `togglePreview()` — line 533
- 第一处 `watch(() => panel?.selectedEntry, ...)` — line 555
- 第二处 `watch(activePanel, ...)` — line 598

每处都调用 `showFilePreview(entry, path, isTextPreviewExt(ext))`，其中 `isTextPreviewExt("pdf")` 恒为 `false`（PDF 不在 `textPreviewExtensions` 中），`asText=false`，`FilePreview.vue` 内部先判断扩展名分流 → 正确命中 PDF 分支。

**结论：✅ PDF 分支位置完全正确，不会误入文本 IPC 分支。**

---

## 2. iframe 切换重载

### 审查点

| 机制 | 位置 | 分析 |
|------|------|------|
| `watch(() => props.filePath, ..., { immediate: true })` 触发 `loadPreview()` | `FilePreview.vue:227-233` | 每次 `previewFilePath` 在 `App.vue` 中变化时，`FilePreview.vue` 的 `props.filePath` 同步变化，`watch` 触发 `loadPreview()` |
| `loadPreview()` 入口重置所有状态 | `FilePreview.vue:182-191` | `previewType`、`previewContent`、`pdfLoadError` 等全部归零。新扩展名会导致 `previewType` 重新赋值为 `"pdf"` 或 `"image"` 或 `"text"` 等 |
| `:key="props.filePath"` 绑定 | `FilePreview.vue:42` | **强制 Vue 在 filePath 变化时销毁旧 iframe 并创建新的**。即使 `previewType` 保持为 `"pdf"`，`iframe` 也不会复用旧实例，避免残留上一个 PDF 的内容 |

`loadPreview()` 中 `pdfLoadError.value = false` 重置后：
- 新 PDF → `pdfSupported=true` & `!pdfLoadError` → 渲染新 iframe
- 旧 PDF 的 iframe 被 Vue 销毁（`:key` 变化），WebView 释放旧的渲染进程

**结论：✅ 切换文件时 iframe 正确重载，无残留风险。**

---

## 3. Ctrl+C 放行逻辑

### 3.1 `isPdfIframeFocused()` 实现审查

`App.vue:372-377`：

```javascript
function isPdfIframeFocused() {
  const el = document.activeElement;
  if (!el || el.tagName !== "IFRAME") return false;
  if (!el.classList.contains("preview-pdf-frame")) return false;
  const src = el.getAttribute("src") || "";
  return src.startsWith("asset://");
}
```

**双重校验（class + src）**，相比 gate-review 推荐的设计更加健壮：
- `tagName === "IFRAME"` — 确保当前焦点是 iframe 元素
- `classList.contains("preview-pdf-frame")` — 确保是 PDF 预览 iframe（而非其他可能的 iframe）
- `src.startsWith("asset://")` — 额外一层校验，防止非 asset 协议的 iframe 被误判

**与 `hasPreviewTextSelection()` 关系**：两者在 keydown 中并列（`App.vue:566-568`），分别检查不同的放行条件，互不干扰：
```javascript
if (hasPreviewTextSelection()) return;          // 文本选区 → 放行
if ((e.key === "c" || e.key === "C") && isPdfIframeFocused()) return;  // PDF 聚焦 → 仅 Ctrl+C 放行
```

**Ctrl+X 不放行**：line 568 明确只对 `c`/`C` 放行，Ctrl+X 走原有文件剪切逻辑。这符合 PDF 只读语义。

**不影响文件列表 Ctrl+C**：当用户焦点在文件列表时，`document.activeElement` 不会是 iframe，`isPdfIframeFocused()` 返回 `false`，文件复制逻辑正常执行。

**结论：✅ 实现健壮，接入位置正确，与既有逻辑无冲突。**

---

## 4. 三态占位完整性

### 审查 `FilePreview.vue` 模板（line 40-56）

```html
<div class="preview-body pdf-body" v-else-if="previewType === 'pdf'">
  <iframe
    v-if="pdfSupported && !pdfLoadError"
    :key="props.filePath"
    :src="previewContent"
    class="preview-pdf-frame"
    title="PDF 预览"
    @error="onPdfError"
  ></iframe>
  <div class="preview-placeholder error" v-else-if="pdfLoadError">
    ...
  </div>
  <div class="preview-placeholder" v-else>
    ...
  </div>
</div>
```

### 三态完备性矩阵

| `pdfSupported` | `pdfLoadError` | 渲染结果 | 正确性 |
|---|---|---|---|
| `true` | `false` | `<iframe>` 正常渲染 | ✅ 正常态 |
| `true` | `true` | 加载失败占位 `.preview-placeholder.error` | ✅ 错误态 |
| `false` | `false` (由 `loadPreview()` 保证重置) | 降级占位 `.preview-placeholder` | ✅ 降级态 |
| `false` | `true` (不会发生) | 错误占位（理论上） | ⚠️ 见下 |

**关于 `pdfSupported=false` & `pdfLoadError=true` 场景**：由于 `pdfSupported` 是纯 computed（基于 UA），在一次会话中不会变化。且 `pdfLoadError` 只在 `<iframe @error>` 时被置为 `true`，而 `pdfSupported=false` 时 `<iframe>` 根本不会被渲染，因此 `pdfLoadError` 永远不会在降级时变为 `true`。**这不构成逻辑漏洞**——该组合在实际运行中不可达。

**关于"三态都不显示"的空洞**：`v-else` 是兜底分支，不会出现三态都不命中的情况。

### 组件级 loading/error 态

- **loading**：`v-if="loading"` (line 12) 在 `v-else-if="previewType === 'pdf'"` 之前，PDF 分支中 `loading` 被立即置 `false`，loading 态仅持续极短时间（`convertFileSrc` 同步操作前的一帧），对用户不可见。
- **error**：`v-else-if="error"` (line 18) 使用组件级 `error` ref，PDF 分支不使用此路径。PDF 加载失败走 `pdfLoadError` 局部状态，不影响 header/footer。

**结论：✅ 三态完备，无逻辑空洞。**

---

## 5. Footer / Header 正确性

### 5.1 Header

`FilePreview.vue`:
- `headerIcon` computed (line 119): `previewType === "pdf"` → `"📕"` ✅
- `typeLabel` computed (line 127): `previewType === "pdf"` → `"PDF"` ✅

实现与 design.md 3.5 节完全吻合，位置在既有 `headerIcon`/`typeLabel` 分支序列中，与 JSON/log/图片模式一致。

### 5.2 Footer

`FilePreview.vue` footer（line 62-71）：
```html
<div class="preview-footer" v-if="!loading && !error">
  <span>{{ fileSize }}</span>
  <span v-if="(previewType === 'text' || previewType === 'log') && lineCount !== null">{{ lineCount }} lines</span>
  <span v-if="previewType === 'image'">{{ imageInfo }}</span>
  <button class="copy-all-btn" v-if="previewType === 'text' || previewType === 'json' || previewType === 'log'" ...>
```

- `fileSize`：无条件渲染（PDF 分支中已赋值），✅ 显示文件大小（如 `2.3 MB`）
- 行数 `lineCount`：`v-if` 条件不包含 `pdf`，天然不显示 ✅
- `imageInfo`：`v-if` 条件不包含 `pdf`，天然不显示 ✅
- 复制全部按钮：`v-if` 条件不包含 `pdf`，天然不显示 ✅
- **未编造页数**：模板中无任何与页数相关的内容 ✅

### 5.3 `pdfLoadError` 是否误隐藏 Header/Footer

- **Header**：不受任何 `v-if` 条件限制，始终渲染 ✅
- **Footer**：条件是 `!loading && !error`。`error` 是组件级 ref（`""`），PDF 分支不使用 `error`；`loading` 在 PDF 分支中立即置 `false`。`pdfLoadError` 是独立 ref，不参与 footer 显隐控制。**Footer 始终正常展示** ✅

**结论：✅ Header/Footer 展示完全正确。**

---

## 6. 代码质量

### 6.1 与既有模式一致性

| 模式 | 既有实现 | PDF 实现 | 一致性 |
|------|----------|----------|--------|
| `PREVIEWABLE_EXTENSIONS` 放行 | JSON/log 加扩展名 | 加 `"pdf"` | ✅ |
| `convertFileSrc` 直连本地文件 | 图片分支 | PDF 分支 | ✅ |
| `headerIcon`/`typeLabel` 展开分支 | JSON/log 有独立分支 | PDF 加独立分支 | ✅ |
| `.preview-placeholder` 占位复用 | 图片加载失败 | PDF 降级/加载失败 | ✅ |
| Footer 无条件 `fileSize` 展示 | 图片/文本均如此 | PDF 复用 | ✅ |
| `watch filePath` → `loadPreview()` | 图片/文本 | PDF | ✅ |

### 6.2 命名与注释

- 函数名 `isPdfIframeFocused()`：命名清晰，语义明确
- 变量名 `pdfSupported`、`pdfLoadError`、`pdfFrameRef`：遵循项目 camelCase 命名约定
- 中文注释：与既有 JSON/log 分支保持一致的中文注释风格（`FilePreview.vue:202-203`, `App.vue:368-370`）

### 6.3 CSS 规范

`FilePreview.vue` 新增样式：
```css
.pdf-body { background: var(--bg); }
.preview-pdf-frame { width: 100%; height: 100%; border: 0; display: block; }
```

- 使用 2 空格缩进 ✅
- 无 `!important` ✅
- 属性命名遵循项目约定 ✅
- 与既有 `.image-body`、`.text-body` 风格一致 ✅

### 6.4 内存泄漏检查

| 风险点 | 分析 | 结论 |
|--------|------|------|
| iframe 未清理 | `:key="props.filePath"` 绑定确保 Vue 在路径变化时销毁旧 iframe；组件卸载时（`closePreview` → `previewVisible=false` → Vue 移除 `<FilePreview>` 组件）iframe 随组件销毁 | ✅ 无泄漏 |
| 事件监听未解绑 | 无新增 DOM 事件监听（仅 `<iframe @error>` 是 Vue 模板绑定，随组件生命周期管理） | ✅ 无泄漏 |
| `watch` 未清理 | 使用 Vue 3 `watch`（`FilePreview.vue:227`），随组件销毁自动停止 | ✅ 无泄漏 |

**结论：✅ 代码质量良好，无内存泄漏，与既有模式高度一致。**

---

## 7. 安全性

### 7.1 `convertFileSrc` 路径注入风险

`convertFileSrc(props.filePath)` 中的 `props.filePath` 来源链路：
1. `App.vue` 中 `showFilePreview()` → `await joinPath(path, entry.name)` 拼接
2. `joinPath` 是 Tauri 后端命令（`api.js:28`），用 Rust 原生路径拼接，内置路径穿越防护
3. `convertFileSrc` 是 Tauri 官方 API，对路径进行 URL 编码

**不存在路径注入风险** ✅。因为 `props.filePath` 来自受控的 `joinPath` 后端命令，且 `convertFileSrc` 做 URL 编码处理。

### 7.2 iframe sandbox 分析

评估：是否需要对 PDF iframe 加 `sandbox` 属性？

**不放 sandbox 的理由（当前方案）**：
- WebView2 内置 PDF 查看器需要 `scripts` 权限来渲染 PDF 交互界面（翻页、缩放、搜索等）
- `sandbox` 会阻止 PDF 查看器的脚本执行，导致 PDF 无法正常渲染
- `asset://` 协议资源是本机文件，不存在远程脚本注入风险

**加 sandbox 的风险**：
- `sandbox=""` 或 `sandbox="allow-same-origin"` 会禁用脚本 → PDF 查看器无法工作
- 即使最宽松的 `sandbox="allow-scripts allow-same-origin"` 也可能因缺少其他权限（如 `allow-forms`、`allow-popups` 等）导致 PDF 查看器部分功能异常

**结论：不加 sandbox 是正确的取舍** ✅。`asset://` 协议下加载的是本地 PDF 文件，攻击面极小。与图片的 `<img>` 不加 sandbox 同理（项目约定）。若未来引入远程 URL 场景，届时再评估加 sandbox。

**结论：✅ 安全性合理，无已知安全漏洞。**

---

## 8. gate-review 推荐改进跟进

| gate-review 推荐改进 | 实现状态 | 评价 |
|----------------------|----------|------|
| 1. `pdfSupported` 用 `platform()` API 增强 | 未采用（保持 UA 方案） | 可接受——项目未安装 `@tauri-apps/plugin-os`，UA 方案满足"零新增依赖"约束 |
| 2. `isPdfIframeFocused()` 加 src 双重校验 | ✅ **已实现** | 实际实现优于设计——class + tagName + src 三重校验 |
| 3. `pdfLoadError` 不误隐藏 header/footer | ✅ **已验证** | `preview-footer` 条件只检查 `error`（组件级），不检查 `pdfLoadError` |

**结论：✅ 关键推荐改进已被采纳（#2、#3）。#1 在零新增依赖约束下可接受。**

---

## 9. 验收标准逐项核验

| # | 验收标准 | 代码支持 | 结论 |
|---|----------|----------|------|
| 1 | Windows 下 `Ctrl+Q` 内联渲染 PDF | `convertFileSrc` + `<iframe>` + `PREVIEWABLE_EXTENSIONS` 含 `"pdf"` | ✅ |
| 2 | ↑/↓ 切换文件时联动刷新 | `watch filePath` → `loadPreview()` + `:key` 强制重建 | ✅ |
| 3 | 与其他类型切换无干扰 | `loadPreview()` 入口全量重置状态 | ✅ |
| 4 | 非 Windows 降级提示 | `pdfSupported` UA 检测 + 降级占位 | ✅ |
| 5 | 加载失败占位 | `<iframe @error>` → `pdfLoadError` → 占位 | ✅ |
| 6 | header 徽标 PDF 📕 | `headerIcon` / `typeLabel` computed | ✅ |
| 7 | footer 文件大小、不编造页数 | `<span>{{ fileSize }}</span>` 无条件渲染，无页数相关代码 | ✅ |
| 8 | iframe 内 Ctrl+C 不被截断 | `isPdfIframeFocused()` 放行 + 仅 Ctrl+C | ✅ |
| 9 | 不经过后端 text IPC | `ext === "pdf"` 分支在文本 IPC 之前 `return` | ✅ |
| 10 | 不新增 npm 依赖 | `package.json` 未修改 | ✅ |

**结论：✅ 10 项验收标准全部满足。**

---

## 10. 评分

- **文件范围合规**：✅（仅变更 design.md 约束的文件）
- **规格合规**：✅（TODO.md 需求 100% 覆盖，无缺失/多余/偏差）
- **代码规范合规**：✅（命名、注释、CSS 均符合项目约定，npm run build exit 0）
- **代码质量**：✅（if 分支正确、三态完备、无内存泄漏、与既有模式一致）
- **安全性**：✅（路径无注入、sandbox 取舍合理）
- **测试**：n/a（项目无 type-check/lint/test 脚本，按 tester 结论 npm run build exit 0 通过）

**总分：A**

---

## 附录：审查覆盖的代码行

### `src/App.vue`
- Line 344: `PREVIEWABLE_EXTENSIONS` — 含 `"pdf"` ✅
- Line 368-377: `isPdfIframeFocused()` 定义 ✅
- Line 533: `togglePreview()` 放行 ✅
- Line 555: 第一处 watch 放行 ✅
- Line 564-572: 全局 keydown 拦截逻辑 ✅
- Line 598: 第二处 watch 放行 ✅

### `src/components/FilePreview.vue`
- Line 40-56: PDF 模板区块（三态） ✅
- Line 42: `:key="props.filePath"` + `pdfSupported && !pdfLoadError` ✅
- Line 43: `ref="pdfFrameRef"` ✅
- Line 48: `@error="onPdfError"` ✅
- Line 50-52: 错误占位 ✅
- Line 53-55: 降级占位 ✅
- Line 62-71: Footer（不受 pdfLoadError 影响） ✅
- Line 97-98: `pdfLoadError` / `pdfFrameRef` ref 定义 ✅
- Line 103-107: `pdfSupported` computed（UA 检测） ✅
- Line 119: `headerIcon` — PDF 📕 ✅
- Line 127: `typeLabel` — PDF ✅
- Line 145-147: `onPdfError()` 处理函数 ✅
- Line 182-191: `loadPreview()` 入口状态重置 ✅
- Line 196-199: 图片分支 ✅
- Line 203-210: PDF 分支（位置正确） ✅
- Line 215+: 文本 IPC 分支（PDF 不会命中） ✅
- Line 227-233: `watch filePath` ✅
- Line 347-356: `.pdf-body` / `.preview-pdf-frame` CSS ✅
