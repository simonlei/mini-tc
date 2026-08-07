# Archive: 支持 PDF 预览

## 需求来源

`TODO.md` 中「支持 PDF 预览」条目（7 项实现指引），用户发起提案后经 architect 输出 proposal → design → tasks → gate review → coder 实现 → tester 构建验证 → final review 全流程。

## 最终方案

**iframe + WebView2 内置 PDF 查看器**（用户拍板，否决 pdf.js 方案）。

### 关键技术决策

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 渲染方式 | `<iframe>` + `convertFileSrc` | 复用图片预览的 asset 协议直连模式，零新增依赖；WebView2 内置 PDF 查看器提供翻页/缩放/搜索等原生交互 |
| 是否引入 pdf.js | 否 | 用户明确拍板：当前仅 Windows 平台有内联需求，pdf.js 体积大（~2MB）、需调整 CSP、跨平台一致体验非当前目标 |
| 后端改动 | 零改动 | PDF 是二进制格式不应走 `read_file_preview` text 分支；`assetProtocol.scope: ["**"]` + `csp: null` 已放行 |
| 平台检测 | UA 启发式 | 项目未安装 `@tauri-apps/plugin-os` 且约束零新增依赖；`Edg/` 判 WebView2 支持，纯 AppleWebKit 判降级 |
| Ctrl+C 放行 | `isPdfIframeFocused()` | 跨源 iframe 无法读取内部选区，改用 `document.activeElement` 判定（class + tagName + src 三重校验） |
| iframe 切换重载 | `:key="props.filePath"` | 强制 Vue 在文件切换时销毁旧 iframe 重建新实例，避免残留 |

### 各阶段结论

| 阶段 | 结论 |
|------|------|
| **Proposal** | 通过，明确 iframe 方案 vs pdf.js 的取舍，输出 10 项验收标准 |
| **Design** | 通过，详细设计后端零改动三条论据、三态占位、Ctrl+C 放行 |
| **Gate Review** | 通过（评分 A），3 项推荐改进（平台检测增强、`isPdfIframeFocused()` 加 src 校验、`pdfLoadError` 不误隐藏 header/footer） |
| **Coder** | 实现完成，2 个 Task 分别改动 `App.vue` 和 `FilePreview.vue` |
| **Tester** | `npm run build` exit 0 通过 |
| **Final Review** | 通过（评分 A），10 项验收标准全部满足，代码质量/安全性/一致性均达标 |

### 变更文件

- `src/App.vue`：`PREVIEWABLE_EXTENSIONS` 加 `"pdf"`、新增 `isPdfIframeFocused()`、全局 keydown 追加 PDF 聚焦放行
- `src/components/FilePreview.vue`：`loadPreview` 新增 PDF 分支、三态占位模板、`pdfSupported`/`pdfLoadError`/`pdfFrameRef` 状态、header 徽标、footer 文件大小

### 已知限制

1. **平台检测局限**：UA 启发式无法覆盖所有 WebView 内核变种（如 Linux WebKitGTK），误判只会导致体验降级而非功能错误
2. **页数缺失**：footer 只能展示文件大小，无法显示页数（iframe 跨源限制无法读取 PDF 元数据）
3. **macOS/Linux 降级**：非 Windows 平台仅显示降级提示，不提供内联渲染
4. **大文件性能**：不做专门优化，行为与 WebView2 原生加载一致

### 后续可选优化

- 引入 `@tauri-apps/plugin-os` 用 `platform()` 替代 UA 检测，提升平台判断可靠性
- 若未来需跨平台一致体验，可引入 `pdf.js`（`pdfjs-dist`）做 Canvas 渲染，届时需调整 CSP 允许 worker 与本地 blob
- 可使用 Tauri v2 的 `WebviewWindow` API 在新窗口中打开 PDF 作为降级替代方案
