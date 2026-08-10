# Tasks: 支持 PDF 预览

> 拆分原则：每个任务可独立交付、可独立验证，预计单任务工作量控制在 2 小时内。共 2 个任务。

## Task 1：`FilePreview.vue` 新增 PDF 渲染分支（核心渲染能力）

**涉及文件**：`src/components/FilePreview.vue`

**内容**：
- [ ] `loadPreview()` 新增 `ext === "pdf"` 分支：用 `convertFileSrc(props.filePath)` 生成 URL 赋值给 `previewContent`，`previewType = "pdf"`，`fileSize` 用 `props.fileBytes` 格式化，不经过 `readFilePreview` IPC。
- [ ] 新增 `pdfSupported` computed（基于 `navigator.userAgent` 判断是否为已知不支持内联 PDF 的 WebKit-only 内核）。
- [ ] 新增 `pdfLoadError` ref 与 `onPdfError()` 处理函数（`<iframe>` 的 `@error` 事件绑定）。
- [ ] 新增 `pdfFrameRef`（供 `App.vue` 的 Ctrl+C 判定按 class 选择器识别即可，ref 本身非强制，但建议加上以便未来扩展）。
- [ ] `headerIcon` computed 追加 `previewType === "pdf"` 分支返回 `"📕"`。
- [ ] `typeLabel` computed 追加 `previewType === "pdf"` 分支返回 `"PDF"`。
- [ ] 模板新增 PDF 渲染区块：`pdfSupported` 为真时渲染 `<iframe class="preview-pdf-frame" :src="previewContent">`；为假时渲染降级占位（复用 `.preview-placeholder` 样式，文案"当前平台不支持内联预览 PDF，请使用系统程序打开查看"）；`pdfLoadError` 为真时渲染加载失败占位（复用 `.preview-placeholder.error` 样式）。
- [ ] footer 保持现有 `<span>{{ fileSize }}</span>` 覆盖 PDF 类型即可（不显示页数，无需新增 span）。
- [ ] `<style>` 新增 `.pdf-body`（flex 撑满容器）与 `.preview-pdf-frame`（`width: 100%; height: 100%; border: 0;`）规则，遵循项目 CSS 规范（2 空格缩进、单引号字符串、无 `!important`）。

**验证方式**：Windows 下手动选中 `.pdf` 文件按 `Ctrl+Q`，确认对面栏内联渲染 PDF；手动触发一次加载失败（如临时改错路径）确认占位显示正确；手动伪造 UA（浏览器 devtools）验证降级占位文案展示正确、不触发下载。

---

## Task 2：`App.vue` 放行 PDF 扩展名 + Ctrl+C 聚焦放行

**涉及文件**：`src/App.vue`

**内容**：
- [ ] `PREVIEWABLE_EXTENSIONS` 数组追加 `"pdf"`（自动豁免 `togglePreview` 与两处 `watch` 的 unsupported 占位判断，无需改动这三处的判断结构）。
- [ ] 新增 `isPdfIframeFocused()` 函数：判断 `document.activeElement` 是否为 class 含 `preview-pdf-frame` 的 `IFRAME` 元素。
- [ ] 全局 `keydown` 监听中，在现有 `if (hasPreviewTextSelection()) return;` 判断旁，追加对 `Ctrl+C`（仅 C，不含 X）在 `isPdfIframeFocused()` 为真时的放行分支（`return`，不触发文件剪贴板复制）。

**验证方式**：Windows 下打开 PDF 预览、点击 iframe 内部使其获得焦点，在 PDF 查看器内选中文字后按 `Ctrl+C`，确认剪贴板拿到的是 PDF 文本内容而非触发"已复制 N 项"的文件 toast；确认切回文件列表选中文件后 `Ctrl+C` 仍正常触发文件复制（无回归）。

---

## 依赖关系

Task 1 与 Task 2 可并行开发（分别改动不同文件，互不依赖），但 Task 2 中 `isPdfIframeFocused()` 依赖的 `.preview-pdf-frame` class 名需与 Task 1 中 `<iframe>` 实际使用的 class 名保持一致，建议合并到同一次提测前完成联调确认。
