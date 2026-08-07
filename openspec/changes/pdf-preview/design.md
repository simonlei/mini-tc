# Design: 支持 PDF 预览

## 1. 现状分析

### 1.1 前端放行链路（`src/App.vue`）

- `PREVIEWABLE_EXTENSIONS`（约 line 344）：`["txt", "md", "json", "log", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"]`，不含 `pdf`。
- `togglePreview()`：`Ctrl+Q` 触发，若 `!isPreviewableExt(ext)` 则 `showUnsupportedPreview(entry)`，否则 `showFilePreview(entry, path, isTextPreviewExt(ext))`。
- 两处 `watch`（选中项变化 `watch(() => panel?.selectedEntry, ...)`；活动面板切换 `watch(activePanel, ...)`）：逻辑与 `togglePreview` 一致地判断 `VIDEO_EXTENSIONS` → `isPreviewableExt` → unsupported 占位 / `showFilePreview`。
- `hasPreviewTextSelection()`：判断当前选区是否落在 `.preview-text` 内、非空，用于全局 `Ctrl+C`/`Ctrl+X` 拦截前的放行判断（命中则 `return`，交还浏览器原生复制）。

**结论**：PDF 走的是与 JSON/log 完全相同的「双端放行模式」——只需在 `PREVIEWABLE_EXTENSIONS` 加 `"pdf"`，`togglePreview` 与两处 `watch` 无需改动其判断结构，因为它们都是通过 `isPreviewableExt(ext)` 这一统一函数放行的，新增扩展名后自动豁免占位。

### 1.2 预览组件（`src/components/FilePreview.vue`）

- `IMAGE_EXTENSIONS` 判断在最前，图片走 `previewType = "image"` + `convertFileSrc(props.filePath)` 直接赋值给 `<img :src>`，**完全不调用 IPC**（`readFilePreview` 只服务于文本分支）。
- 文本/JSON/log 走 `readFilePreview(props.filePath, props.asText)` IPC 读取原始内容，再按扩展名做前端二次处理（JSON 美化 / log 原样展示）。
- `headerIcon` / `typeLabel` 是基于 `previewType` 的 computed，footer 展示 `fileSize` + 行数（文本类）或 `imageInfo`（图片类，图片加载后由 `onImageLoad` 填充分辨率）。
- `loadPreview()` 在 `watch(() => props.filePath, ..., { immediate: true })` 中触发，每次切换文件都会重置 `loading`/`error`/`previewType`/`previewContent` 等状态。

**结论**：PDF 应在 `IMAGE_EXTENSIONS` 判断之外新增独立分支，同样使用 `convertFileSrc(props.filePath)` 拿到 URL，赋值给新增的 `previewType = "pdf"`，渲染 `<iframe :src="...">` 而非 `<img>`。**不复用图片分支的 `<img>` 标签**，因为 PDF 需要 `<iframe>` 才能让 WebView2/WKWebView 接管渲染。

### 1.3 后端（`src-tauri/src/lib.rs`）

- `TEXT_EXTENSIONS = &["TXT", "MD", "JSON", "LOG"]`，`read_file_preview` 仅识别这些扩展名（或 `as_text` 强制标记）为文本读取，否则返回 `Err("Unsupported file type: .xxx")`。
- **PDF 不应加入 `TEXT_EXTENSIONS`**：PDF 是二进制格式，加入会导致 `read_file_preview` 试图用 `String::from_utf8_lossy` 解码 PDF 二进制内容，产生乱码且毫无意义，也会被 `MAX_TEXT_SIZE`（2MB）不合理地限制（PDF 往往比 2MB 大）。

**结论：本次不需要任何后端改动**（详见第 2 节）。

### 1.4 `tauri.conf.json` 资源协议与 CSP

```json
"security": {
  "csp": null,
  "assetProtocol": { "enable": true, "scope": ["**"] }
}
```

- `csp: null` 表示**不启用 CSP 限制**，因此没有 `frame-src`/`object-src`/`img-src` 白名单需要额外放开——`<iframe>` 加载任意协议（包括 `asset://localhost/...`）不会被 CSP 拦截。
- `assetProtocol.scope: ["**"]` 表示 asset 协议对本机任意路径全放行，图片预览已经验证过这条链路可用（`convertFileSrc` + `<img>` 现网工作正常），PDF 走相同的 `convertFileSrc` 生成 URL，`<iframe>` 与 `<img>` 在资源协议层面无差异，天然可用。

**结论：`tauri.conf.json` 不需要任何改动。**

## 2. PDF 是否需要后端改动：不需要

**理由**：
1. `convertFileSrc` 是 Tauri 前端 API（`@tauri-apps/api/core`），直接把本地文件路径转换为 `asset://localhost/<encoded-path>` 形式的 URL，全程不经过任何自定义 `#[tauri::command]`，图片预览已验证此链路可行且无需后端参与。
2. 后端唯一的文件预览命令 `read_file_preview` 是为**文本内容读取**设计的（返回 `String` 塞进 `FilePreview.content`），语义上不适合 PDF；若强行让 PDF 走此命令，需要新增 `preview_type: "pdf"` 分支返回文件路径或 base64，但这既不必要（asset 协议已能直接服务二进制文件）又会引入不必要的 IPC 序列化开销（PDF 文件可能几十 MB，base64 编码会显著放大体积、阻塞主线程）。
3. `assetProtocol.scope: ["**"]` 已经放行本机任意路径，无需为 PDF 单独设白名单。

**唯一的后端相关注意事项（非改动，是约束确认）**：确保 `.pdf` 扩展名**不会被误加入** `TEXT_EXTENSIONS`；本次实现只触碰前端文件，天然满足此约束。

## 3. 前端改动方案

### 3.1 `src/App.vue`

- `PREVIEWABLE_EXTENSIONS` 数组追加 `"pdf"`。
- `togglePreview()`、两处 `watch`：**不需要新增分支**。三处逻辑都是先判断 `VIDEO_EXTENSIONS.includes(ext)`（PDF 不命中），再判断 `isPreviewableExt(ext)`（加入 `pdf` 后自动为 true），最终统一调用 `showFilePreview(entry, path, isTextPreviewExt(ext))`——PDF 未被加入用户自定义 `textPreviewExtensions`，因此 `isTextPreviewExt("pdf")` 恒为 `false`，`asText` 参数为 `false`，与图片预览走同一条 `showFilePreview` 路径，不会误触发文本 IPC 读取（`FilePreview.vue` 内部会先判断扩展名分流，见 3.2）。
- `hasPreviewTextSelection()`：**PDF 场景不复用此函数**，因为 `<iframe>` 内部是独立的浏览上下文（跨 document），`window.getSelection()` 无法穿透读取 iframe 内部的选区，且 `.preview-text` 选择器本身就是文本预览专属的类名。PDF 的 Ctrl+C 放行需要新的判定方式，见 3.4。

### 3.2 `src/components/FilePreview.vue`

新增 `PDF_EXTENSIONS = ["pdf"]`（或直接复用单一扩展名判断，不建立数组也可，为与 `IMAGE_EXTENSIONS` 风格保持一致，采用数组形式便于未来扩展）。

`loadPreview()` 改动：在 `IMAGE_EXTENSIONS` 判断分支之后（同级 `if`，图片分支已 `return`，故不冲突）新增：

```javascript
// PDF: 同图片一样，用 convertFileSrc 直连本地文件，不经过 IPC 文本读取。
// 依赖系统 WebView 内置 PDF 查看器（Windows WebView2 支持；macOS WKWebView 不支持，走降级提示）。
if (ext === "pdf") {
  previewType.value = "pdf";
  previewContent.value = convertFileSrc(props.filePath);
  fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
  loading.value = false;
  return;
}
```

- `previewType` 新增取值 `"pdf"`。
- `headerIcon` computed 追加一支：`if (previewType.value === "pdf") return "📕";`
- `typeLabel` computed 追加一支：`if (previewType.value === "pdf") return "PDF";`
- 模板新增 PDF 渲染分支（与图片分支平级的 `v-else-if`）：

```html
<!-- PDF preview -->
<div class="preview-body pdf-body" v-else-if="previewType === 'pdf'">
  <iframe
    v-if="pdfSupported"
    :src="previewContent"
    class="preview-pdf-frame"
    title="PDF 预览"
    @load="onPdfLoad"
    @error="onPdfError"
  ></iframe>
  <div v-else class="preview-placeholder">
    <span class="placeholder-icon">📕</span>
    <span>当前平台不支持内联预览 PDF，请使用系统程序打开查看</span>
  </div>
</div>
```

- footer 展示：`<span v-if="previewType === 'pdf'">{{ fileSize }}</span>`——**只显示文件大小，不显示页数**（页数无法从 `<iframe>` 加载结果中可靠获取，`iframe.onload` 触发时机仅代表 WebView 开始渲染，不代表能读到 PDF 内部页数元数据，且跨域/沙箱限制下也无法通过 JS 探测 `<iframe>` 内部 DOM）。既有 `fileSize` 逻辑已在 3.2 分支内赋值，无需额外改动 footer 结构，只需让现有 `<span>{{ fileSize }}</span>`（无条件展示的那一行）继续覆盖 PDF 类型即可；行数统计 `<span v-if="...lineCount">` 天然不对 PDF 生效（`lineCount` 保持 `null`）。

### 3.3 三种占位态定义

| 状态 | 触发条件 | 表现 |
|---|---|---|
| 加载中 | `loading.value = true`（`loadPreview` 起始设置） | 复用现有 `.preview-placeholder` + `spinner`，展示"正在加载..."（PDF 分支中 `loading` 会被立即置 `false`，因为 `convertFileSrc` 是同步操作；真正的"加载"发生在 iframe 内部由 WebView 异步渲染，这段过程无法从外部感知进度，因此不额外做"iframe 内部加载中"状态，只做初始极短暂的组件级 loading） |
| 加载失败 | `iframe` 触发 `@error`，或 `pdfLoadError.value` 被设置为 true | 复用现有 `.preview-placeholder.error` 样式，展示"⚠️ 无法加载 PDF，文件可能已损坏或不存在" |
| 非 Windows 降级 | 通过平台检测判定当前 WebView 不支持内联 PDF（见下） | 展示"📕 当前平台不支持内联预览 PDF，请使用系统程序打开查看"，**不渲染 `<iframe>`**，不触发下载 |

**平台检测方式**：使用 Tauri v2 提供的 `@tauri-apps/plugin-os`（若项目未引入则用 `navigator.platform`/`navigator.userAgent` 判断，避免新增 npm 依赖）。鉴于约束「不引入新的 npm 依赖」，采用 **UserAgent 检测**方案：

```javascript
// 粗略判断当前 WebView 是否为已知不支持内联 PDF 的内核（如 macOS WKWebView）。
// Windows WebView2（基于 Chromium）内置 PDF 查看器，天然支持 <iframe src="asset://...pdf">。
const pdfSupported = computed(() => {
  const ua = navigator.userAgent || "";
  // WebView2 UA 含 "Edg/"；WKWebView（macOS/iOS）UA 含 "AppleWebKit" 但不含 "Chrome"/"Edg"。
  const isWebKitOnly = /AppleWebKit/.test(ua) && !/Chrome|Edg/.test(ua);
  return !isWebKitOnly;
});
```

此判断只在 PDF 分支渲染时生效，不影响其他类型预览。若未来需要更精确判断，可替换为读取 Tauri 的平台 API，但当前不新增依赖，UA 判断已足够区分 Windows WebView2 与 macOS WKWebView。

`@error` 处理函数：

```javascript
function onPdfError() {
  pdfLoadError.value = true;
}
```

（`error.value`——组件已有的通用错误 ref——语义是"整个预览失败"，会导致连 header 都可能受影响；PDF 场景更适合复用一个局部的 `pdfLoadError` ref，仅影响 PDF 渲染区域，不冲击 header/footer 的正常展示，因为哪怕加载失败也应保留 header 徽标与 footer 文件大小的展示。）

### 3.4 Ctrl+C 放行判定（PDF 场景）

现有 `hasPreviewTextSelection()` 依赖 `window.getSelection()` + `.preview-text` 类名选择器，这对**同源文本内容**有效，但 PDF 走的是 `<iframe>` 嵌入 asset 协议资源，两者不同源（`asset://` 与应用主 origin 不同），浏览器安全策略下**主文档的 JS 无法访问 iframe 内部的选区状态**（`contentDocument`/`contentWindow` 会因跨域被拒绝访问）。因此不能靠"检测 iframe 内部有无选区"来判断放行。

**采用的判定方式：判断当前焦点元素是否为 PDF 预览的 `<iframe>` 本身。**

原理：当用户点击 iframe 内部（PDF 查看器界面）时，浏览器会将该 `<iframe>` DOM 元素设为 `document.activeElement`（这是跨 origin iframe 仍然遵守的标准聚焦行为，与内部内容无关，不涉及访问内部 DOM，因此不受同源限制）。只要 `document.activeElement` 指向该 `<iframe>` 元素，说明用户正在与 PDF 查看器交互，此时应放行 `Ctrl+C`，让 WebView2/WKWebView 原生处理复制（复制 PDF 内选中文本）。

`FilePreview.vue` 中给 `<iframe>` 加一个 ref：

```html
<iframe ref="pdfFrameRef" ... ></iframe>
```

`App.vue` 中新增判定函数（与 `hasPreviewTextSelection` 并列、风格一致）：

```javascript
// 判断当前焦点是否落在 PDF 预览的 <iframe> 上（跨源 iframe 无法读取内部选区，
// 但浏览器会将 iframe 元素本身设为 activeElement，据此放行原生 Ctrl+C）。
function isPdfIframeFocused() {
  const el = document.activeElement;
  return !!(el && el.tagName === "IFRAME" && el.classList.contains("preview-pdf-frame"));
}
```

全局 `Ctrl+C`/`Ctrl+X` 拦截逻辑中，在现有 `if (hasPreviewTextSelection()) return;` 判断旁并列追加：

```javascript
if (e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X") {
  if (hasPreviewTextSelection()) return;
  // PDF 预览聚焦时放行 Ctrl+C（复制），Ctrl+X 不适用于 PDF（只读内容），
  // 仍按原逻辑走文件剪贴板剪切（不放行），避免误剪切当前选中文件。
  if ((e.key === "c" || e.key === "C") && isPdfIframeFocused()) return;
}
```

**语义边界**：Ctrl+X 在 PDF 聚焦态**不放行**（PDF 只读，没有"剪切内容"的概念，Ctrl+X 应仍视为对文件列表选中项的剪切操作意图，行为与非预览态一致）；只有 Ctrl+C 在 iframe 聚焦时放行给浏览器原生处理。

### 3.5 header 徽标与 footer

- **header 徽标**：`typeLabel = "PDF"`，`headerIcon = "📕"`，展示位置与现有 `<span class="preview-type-badge">{{ typeLabel }}</span>` 一致，无需改动模板结构，仅扩展 computed 分支。
- **footer**：仅显示 `fileSize`（如 `2.3 MB`）。**不显示页数**——原因：`<iframe src="asset://...">` 加载 PDF 后，页面内容由 WebView 内置查看器渲染在**独立的渲染上下文**中，主文档 JS 无法可靠地跨这层边界读取 PDF 内部结构化信息（页数属于 PDF 文档元数据，需要解析 PDF 文件本身，而本方案明确不引入 `pdf.js` 等解析库）。若后续接入 `pdf.js` 才能可靠拿到页数，属于超出本次范围的另一形式方案，不在本次实现。

## 4. 文件范围

本次变更仅涉及以下文件，其他文件不应被改动：

| 文件路径 | 改动类型 | 改动内容概述 |
|---|---|---|
| `src/App.vue` | 修改 | `PREVIEWABLE_EXTENSIONS` 追加 `"pdf"`；新增 `isPdfIframeFocused()` 判定函数；全局 `Ctrl+C` 拦截逻辑中追加 PDF iframe 聚焦放行分支 |
| `src/components/FilePreview.vue` | 修改 | `loadPreview()` 新增 PDF 分支（`convertFileSrc` 生成 URL）；`previewType` 新增 `"pdf"` 取值；`headerIcon`/`typeLabel` computed 新增 PDF 分支；新增 `pdfSupported`（平台检测）、`pdfLoadError`、`pdfFrameRef` 等状态；模板新增 PDF 渲染区块（`<iframe>` + 降级占位 + 加载失败占位）；新增/调整对应 `<style>` 规则（`.pdf-body`、`.preview-pdf-frame`） |
| `openspec/changes/pdf-preview/proposal.md` | 新增 | 本次变更的需求提案 |
| `openspec/changes/pdf-preview/design.md` | 新增 | 本文档 |
| `openspec/changes/pdf-preview/tasks.md` | 新增 | 任务拆解 |

**明确不涉及的文件**（供 reviewer 核对超范围改动）：
- `src-tauri/src/lib.rs`：不改动（见第 2 节理由）。
- `src-tauri/tauri.conf.json`：不改动（见 1.4 节理由）。
- `src/api.js`：不改动（`convertFileSrc` 来自 `@tauri-apps/api/core`，非项目自定义 API，图片预览已直接 `import { convertFileSrc } from "@tauri-apps/api/core"` 在 `FilePreview.vue` 内使用，PDF 复用同一 import，无需在 `api.js` 新增封装）。
- `package.json` / `package-lock.json`：不改动，不新增依赖。
- 其他组件（`FilePanel.vue`、`FileList.vue`、`UnsupportedPreview.vue`、`VideoPreview.vue` 等）：不涉及，PDF 预览完全在 `FilePreview.vue` 内以新分支形式承载，不需要新建独立组件（与图片、文本共用同一个 `FilePreview.vue` 是既有约定）。

## 5. 风险与权衡

- **平台检测的局限性**：UA 检测是启发式判断，无法覆盖所有 WebView 内核变种（如未来 Linux WebKitGTK 的行为未知）。若检测有误判，最坏情况是 Windows 某些边缘 WebView2 版本被误判为不支持而走降级提示（体验降级但不出错），或反过来在真正不支持的平台上错误尝试渲染 `<iframe>`（此时会命中"加载失败"占位而非崩溃，仍是可控的兜底行为）。本次按用户拍板方案不引入 pdf.js，此风险为可接受的已知局限，后续如有需求可用更精确的 Tauri 平台 API 替换。
- **页数缺失**：footer 只能展示文件大小，属于用户已确认的验收前提（"页数拿不到就退化为文件大小，不要硬编造页数"），非缺陷。
- **iframe 聚焦判定的边界情况**：若用户先点击 PDF iframe（聚焦），随后不经过任何操作直接切换到文件列表选中其他文件再按 Ctrl+C，此时 `document.activeElement` 可能仍短暂保留在旧的 iframe 上（取决于 Vue 组件切换时机与浏览器焦点管理）。这种边界情况发生概率低且后果轻微（最多是一次误放行未触发文件复制，用户可再按一次），不做额外处理。
