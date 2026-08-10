# Proposal: 支持 PDF 预览

## 背景

当前 mini-tc 的文件预览面板（`Ctrl+Q` 唤起，渲染在对面栏）已支持文本类（txt/md/json/log）与图片类（jpg/png/gif/webp/bmp/svg/avif）格式，但选中 `.pdf` 文件时会命中「暂不支持预览该格式」占位（`src/App.vue` 的 `PREVIEWABLE_EXTENSIONS` 未包含 `pdf`）。需求来源见 `TODO.md` 中「支持 PDF 预览」条目（①~⑦ 实现指引）。

项目已有两条同类改动可直接参照复用同一套「双端放行模式」：
- **JSON 预览**：前端 `PREVIEWABLE_EXTENSIONS` 加 `"json"` + 后端 `TEXT_EXTENSIONS` 加 `"JSON"`，走文本 IPC 分支。
- **log 预览**：同上模式，外加超大文件 tail 截断。

PDF 与上述两者不同：**PDF 不是文本，不应走 `read_file_preview` 的 text 分支**，而应复用**图片预览的 `convertFileSrc` 模式**——图片分支完全不经过 IPC 读取文件内容，只是把本地路径转换成 `asset://` URL 交给 `<img>` 加载；PDF 同理，把 URL 交给 `<iframe>`，渲染工作完全交给系统 WebView 内置的 PDF 查看器。

## 目标

1. 选中 `.pdf` 文件并触发预览（`Ctrl+Q` 或选中态联动）时，对面栏内联显示 PDF 内容，不再命中「暂不支持预览该格式」占位。
2. 复用现有 `convertFileSrc` + `<iframe>` 渲染方案，不引入 `pdf.js`/`pdfjs-dist`，不增加任何 npm 依赖。
3. Windows（WebView2）下呈现原生 PDF 查看体验（可翻页/缩放/内置搜索，均由 WebView2 自带）。
4. 非 Windows 平台（macOS WKWebView 等不支持内联 PDF 的 WebView）给出明确的降级提示占位，不静默失败、不触发下载。
5. header 展示 PDF 徽标（📕 PDF），footer 展示文件大小（页数无法可靠获取时不编造）。
6. PDF iframe 内原生选中文本后按 `Ctrl+C`，走浏览器/WebView 原生复制，不被 `App.vue` 的全局文件剪贴板逻辑截断。

## 非目标

- 不做跨平台统一渲染（不引入 `pdf.js`），非 Windows 平台仅做优雅降级提示，不追求内联渲染效果一致。
- 不做页数统计、目录大纲、书签、注释、表单填写等 PDF 高级功能。
- 不做大文件（如 >100MB）PDF 的专门性能优化，行为与系统 WebView 原生加载一致，成功与否交给 WebView2/WKWebView 自身处理。
- 不修改 `.doc`/`.docx` 预览（TODO.md 中的另一条独立需求，不在本次范围）。
- 不改动图片 / 文本预览已有逻辑（除非为复用而做最小公共提取）。

## 验收标准

- [ ] Windows 下选中 `.pdf` 文件并 `Ctrl+Q`，对面栏内联渲染 PDF 内容（WebView2 内置查看器可翻页/缩放）。
- [ ] 在文件列表中用 ↑/↓ 切换选中项到另一个 `.pdf` 文件时，预览面板联动刷新为新 PDF（复用现有 `watch` 联动逻辑，不误入 unsupported 占位）。
- [ ] 从其他已支持类型（如 txt）切到 `.pdf` 再切回，两者互不干扰、无残留状态（loading/error 状态正确复位）。
- [ ] 非 Windows 平台（或任何不支持内联 PDF 的 WebView）显示明确的「当前平台不支持内联预览 PDF」占位提示，不触发浏览器下载、不空白卡死。
- [ ] iframe 加载失败（文件损坏、路径不存在等）时展示「加载失败」占位而非白屏或永久 loading。
- [ ] header 徽标显示 `PDF` 文案 + 📕 图标；footer 显示文件大小（不显示编造的页数）。
- [ ] 在 PDF 预览区域内（iframe 内部或聚焦态）按 `Ctrl+C` 不被 `App.vue` 全局键盘拦截逻辑吞掉、不误触发文件剪贴板复制。
- [ ] `.pdf` 不经过后端 `read_file_preview` 的 text 分支（不受 `MAX_TEXT_SIZE` 2MB 限制），仅用 `convertFileSrc` 生成 URL。
- [ ] 不新增 npm 依赖（`package.json` 无变化）。
