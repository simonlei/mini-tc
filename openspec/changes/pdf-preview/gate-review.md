# Gate Review: PDF 预览功能方案设计

## 评审结论：通过 ✓

方案整体设计合理，与既有架构一致，文件范围约束明确，后端零改动结论成立。存在若干需在实现阶段修正的问题（已列为推荐修改），不构成驳回理由。

---

## 1. 文件范围章节检查

### 结论：✅ 通过

`design.md` 第 4 节「文件范围」明确列出了：

| 状态 | 文件 | 说明 |
|------|------|------|
| 修改 | `src/App.vue` | `PREVIEWABLE_EXTENSIONS` + `isPdfIframeFocused()` + Ctrl+C 放行 |
| 修改 | `src/components/FilePreview.vue` | PDF 分支 + 模板 + 样式 |
| 新增 | `openspec/changes/pdf-preview/proposal.md` | 提案文档 |
| 新增 | `openspec/changes/pdf-preview/design.md` | 设计文档 |
| 新增 | `openspec/changes/pdf-preview/tasks.md` | 任务拆解 |

同时明确了**不涉及的文件**：`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`、`src/api.js`、`package.json`/`package-lock.json`、其他组件。文件范围约束完整且合理。

---

## 2. 后端零改动结论核实

### 2.1 `tauri.conf.json` 配置核实

经实际读取 `/src-tauri/tauri.conf.json`，确认：

- **CSP**：`"csp": null` — 不启用任何内容安全策略限制。这意味着 `<iframe>` 加载 `asset://localhost/...` 协议不会被 `frame-src`/`object-src` 指令拦截。设计文档 1.4 节结论正确。
- **assetProtocol.scope**：`"scope": ["**"]` — asset 协议对本机任意路径全放行。设计文档 1.4 节结论正确。

### 2.2 `convertFileSrc` 无需后端配合

经实际验证，`convertFileSrc` 来自 `@tauri-apps/api/core`（是 Tauri 官方前端 API），在 `FilePreview.vue` 和 `VideoPreview.vue` 中均已直接使用，将本地文件路径转换为 `asset://localhost/<encoded-path>` URL。图片分支已验证此链路可用（`FilePreview.vue:163`），PDF 走相同链路无差异。设计文档 2.1 节推理完全正确。

### 2.3 PDF 不进 TEXT_EXTENSIONS

经读取 `/src-tauri/src/lib.rs`，确认 `TEXT_EXTENSIONS = &["TXT", "MD", "JSON", "LOG"]`（line 299），不含 `PDF`。设计文档正确判断 PDF 不应加入 `TEXT_EXTENSIONS`——PDF 是二进制格式，用 `String::from_utf8_lossy` 解码会产生乱码且被 `MAX_TEXT_SIZE`（2MB）不合理限制。**后端不需要任何改动**。

### 结论：✅ 通过。后端零改动的三条论据均经过核实，完全站得住。

---

## 3. Ctrl+C 放行方案核实

### 3.1 全局 keydown 拦截逻辑分析

当前 `App.vue` 的 `Ctrl+C`/`Ctrl+X` 拦截逻辑位于 `onMounted` 的 `keydown` 监听器中（约 line 1087-1103）：

```javascript
if (e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X") {
  if (hasPreviewTextSelection()) return;
}
if (e.key === "c" || e.key === "C") {
  e.preventDefault();
  setClipboard("copy");
  return;
}
```

`hasPreviewTextSelection()` 依赖 `window.getSelection()` + `.preview-text` 选择器，这对跨源 iframe 完全无效（同源策略限制）。设计文档正确指出了这一点，并设计了一个不依赖访问 iframe 内部 DOM 的替代方案。

### 3.2 `document.activeElement` 跨源 iframe 聚焦行为

设计文档提出的方案：通过 `document.activeElement.tagName === "IFRAME"` 判断用户是否在 PDF 预览 iframe 中交互。在 Chromium/WebView2 中，**当用户点击跨源 iframe 内部时，`document.activeElement` 确实会指向该 `<iframe>` DOM 元素本身**。这是浏览器聚焦的标准行为，与同源策略无关（不涉及访问 iframe 内部 DOM），因此可行。

### 3.3 与既有 `hasPreviewTextSelection()` 的兼容性

两个判定函数互不冲突：

- `hasPreviewTextSelection()` — 服务于同源文本预览区（`.preview-text`）
- `isPdfIframeFocused()` — 服务于跨源 PDF iframe（`.preview-pdf-frame`）

两者在 `keydown` 中并列，各自放行自己的场景。Ctrl+X 在 PDF 分支不放行（设计文档 3.4 节明确说明"PDF 只读，Ctrl+X 不放行"），这与文本预览区分支 (`hasPreviewTextSelection()` 对 Ctrl+X 也放行) 不同——这里的差异是故意的且合理。

### 3.4 边界情况分析

设计文档 5 节识别了一个边界情况：用户点击 PDF iframe 后不操作直接切文件按 Ctrl+C，`document.activeElement` 可能短暂残留。这个边界情况发生概率低且后果轻微（最多一次误放行），可接受。

### 3.5 ⚠️ 推荐改进

设计文档在 `design.md` 的 Ctrl+C 放行代码中使用了 `classList.contains("preview-pdf-frame")` 来识别 iframe，但 `tasks.md` Task 2 中提到用 class 做判定。建议 `isPdfIframeFocused()` 也考虑检查 iframe 的 `src` 属性是否以 `asset://` 开头——这比 class 名称更可靠（class 名可能被未来改动影响），但不会导致功能错误。class 方式在当前项目中足够命中目标。

### 结论：✅ 通过。方案在 WebView2 中可行，与既有代码兼容良好。

---

## 4. 降级判定的可靠性

### 4.1 UserAgent 启发式分析

设计文档 3.3 节提出的检测逻辑：

```javascript
const isWebKitOnly = /AppleWebKit/.test(ua) && !/Chrome|Edg/.test(ua);
```

**优点**：
- WebView2 的 UA 确实含 `Edg/`（Edge 内核标识），能被正确识别为支持
- 纯 WKWebView（macOS）UA 含 `AppleWebKit` 但不含 `Chrome`/`Edg`，能被正确识别为不支持
- 不引入新 npm 依赖

**风险与局限**：
- `Edg/` 是微软 Edge 浏览器的 UA 特征，WebView2 确实继承了它——在 Edge 稳定版及以上可用。**但极少数旧版 WebView2（如 Edge Legacy 时代的）可能不含 `Edg/`**，会被误判为不支持而走降级（体验降级但不崩溃，可接受）
- Linux 平台可能使用 WebKitGTK 或其他 WebView，UA 不规则，行为未知——设计文档已在 5 节作为已知风险记录
- 若用户修改了 WebView2 的 UA（企业策略可配置），可能误判

### 4.2 更可靠的替代方案（推荐，非阻塞）

Tauri v2 提供了 `@tauri-apps/api/os` 的 `platform()` 函数可获取系统平台（`"windows"` / `"macos"` / `"linux"`），无需额外依赖（`@tauri-apps/api` 已在 `package.json` 中）。按平台判断比 UA 启发式更可靠：

```javascript
import { platform } from "@tauri-apps/api/os";
const isWindows = (await platform()) === "windows";
```

但这也存在问题：Windows 上的 WebView2 也有可能因企业策略禁用了 PDF 查看器。UA 检测能间接反映内核能力，平台检测则不能。

**建议**：优先用 Tauri 的 `platform()` 做一级判断（`platform !== "windows"` → 直接降级），再辅以 UA 检测做二级兜底（某些 Windows 旧版 WebView2 也可能不支持）。两者组合可覆盖绝大多数场景。但这不是驳回理由——当前方案的最坏后果只是体验降级，不会崩溃或丢失数据。

### 结论：✅ 通过。UA 启发式在 Windows WebView2 vs macOS WKWebView 场景下足够可靠。误判只会导致体验降级而非功能错误，属于已知可接受风险。

---

## 5. 与既有实现模式的一致性

### 5.1 双端放行模式

`design.md` 1.1 节正确描述了既有模式：JSON/log 均通过前端 `PREVIEWABLE_EXTENSIONS` 加扩展名 + `isPreviewableExt()` 统一放行。PDF 遵循相同模式，只需在一处数组追加即可自动豁免三处判断（`togglePreview` + 两处 `watch`）的 unsupported 占位。**与既有模式完全一致**。

### 5.2 `convertFileSrc` 复用

图片分支在 `FilePreview.vue:163` 使用 `convertFileSrc(props.filePath)` 生成 URL，不经过任何 IPC 文本读取。PDF 分支采用完全相同的方式，直接生成 `asset://` URL 交给 `<iframe>`。**与图片分支模式一致**。

### 5.3 占位样式体系复用

现有 `.preview-placeholder` 样式定义在 `FilePreview.vue`（line 282-296），被 loading 态、error 态、图片加载失败态复用。PDF 的降级占位和加载失败占位均复用此样式体系。**与既有占位模式一致**。

### 5.4 Footer 展示模式

`FilePreview.vue` footer（line 39-47）已有无条件展示的 `<span>{{ fileSize }}</span>`，PDF 分支中 `fileSize` 被赋值后自动覆盖。PDF 不涉及行数 (`lineCount`)、图片分辨率 (`imageInfo`)、复制全部按钮 (`copyAll`)，这些由对应的 `v-if` 条件天然过滤。**footer 展示模式一致性良好**。

### 结论：✅ 通过。方案在所有关键模式上与既有代码高度一致，复用充分。

---

## 6. 遗漏项检查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 加载中状态 | ⚠️ 注意 | 设计文档 3.3 节说明 `loading` 在 PDF 分支中被立刻置为 `false`（因为 `convertFileSrc` 是同步操作），真正加载由 iframe 内部异步完成且外部无法感知。这符合实际约束，但 `loadPreview()` 入口处 `loading.value = true` 的短暂闪现仍存在——**对用户体验无感知影响**（瞬间从 loading 切换到 iframe），不是问题。 |
| 加载失败状态 | ✅ | `@error` → `pdfLoadError` → 复用 `.preview-placeholder.error` 占位 |
| 降级状态 | ✅ | `pdfSupported` 为假时不渲染 `<iframe>`，渲染降级占位 |
| header 徽标 | ✅ | `📕` + `PDF`，与既有 pattern 一致 |
| footer 内容 | ✅ | `fileSize` 展示、页数不编造 |
| 切换文件时 iframe 重载 | ✅ | `watch(() => props.filePath, ...)` 触发 `loadPreview()`，`previewType`、`previewContent` 等被重置后重新赋值，Vue 响应式会使 `<iframe :src>` 更新为新 URL，WebView 自然重新加载。不会残留上一个 PDF。 |
| 大文件处理 | ✅ | 设计文档明确声明"不做专门优化，交给 WebView 自身处理"，属于非目标范围 |
| Ctrl+X 在 PDF 聚焦态 | ✅ | 设计文档 3.4 节明确：Ctrl+X 不放行，"PDF 只读，没有剪切内容概念" |

### 结论：✅ 通过。关键状态覆盖完整，切换文件重载逻辑由既有 `watch` 机制自然保障。

---

## 7. 规格合规审查

对照 `TODO.md` 中 PDF 预览需求（原文 7 个子项），逐项检查 proposals 中的覆盖情况：

| 需求子项 | 覆盖情况 | 说明 |
|----------|----------|------|
| ① `PREVIEWABLE_EXTENSIONS` 加 `pdf` | ✅ | design 3.1 / Task 2 |
| ② PDF 不走上 IPC 文本读取，走 `convertFileSrc` + `<iframe>` | ✅ | design 3.2 / Task 1 |
| ③ `loadPreview` 中独立 PDF 分支，不误入 text 分支 | ✅ | design 3.2（在 `IMAGE_EXTENSIONS` 分支之后、文本 IPC 之前） |
| ④ 确认 asset scope / CSP 允许 `<iframe>` 加载 | ✅ | design 1.4（`csp: null` + scope `**`） |
| ⑤ 非 Windows 降级提示 | ✅ | design 3.3 |
| ⑥ header 徽标 + footer 页数/大小 | ✅ | design 3.5（footer 仅大小，不编造页数） |
| ⑦ 大文件处理 + 加载状态 + Ctrl+C 放行 | ✅ | design 3.3/3.4/5 |

**无缺失、无多余实现、无理解偏差**。

---

## 8. 总体评分

- **规格合规**：✅ 全部覆盖
- **代码规范合规**：✅ 与既有模式一致（新增代码需实现时 lint 验证）
- **代码质量风险**：低（方案设计清楚、边界情况已识别）
- **测试覆盖**：验收标准定义清晰，8 项可独立验证

**评分：A**

---

## 9. 推荐改进（非阻塞，实现阶段参考）

1. **平台检测增强**：在 `pdfSupported` 中优先用 Tauri `platform()` API（`@tauri-apps/api/os`，已在 `package.json` 的 `@tauri-apps/api` 中包含）判断平台，再辅以 UA 检测做二级兜底，比纯 UA 启发式更可靠。

2. **`isPdfIframeFocused()` 健壮性**：除 `classList.contains("preview-pdf-frame")` 外，可额外检查 iframe 的 `src` 是否以 `asset://` 开头，增强判定抗干扰性。

3. **PDF 加载失败时保留 header/footer**：当前设计用 `pdfLoadError` 局部 ref 而非组件级 `error`，这个设计是正确的（保留了 header 徽标与 footer 文件大小）。需在 Task 1 实现时确认 `pdfLoadError` 占位不会导致 `preview-footer` 被隐藏（模板中 `v-if="!loading && !error"` 条件仅检查 `error`，不检查 `pdfLoadError`，因此 footer 会正常展示——确认无误）。
