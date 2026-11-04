# 支持 doc / docx 文件预览

> 来源：`TODO-done.md` 第 39 行 · 章节 已实现功能（想法暂存区） · 第 19 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **支持 doc / docx 文件预览** — 当前 `.doc`/`.docx` 不在预览支持范围，选中会显示「暂不支持预览该格式」占位。目标：在文件预览（Ctrl+Q 对面面板）中内联渲染 Word 文档。需改动：① 前端 `App.vue` 的 `PREVIEWABLE_EXTENSIONS`（`src/App.vue:366`）增加 `"doc"`, `"docx"`（豁免 unsupported 占位）；② Word 文档（尤其 .docx）是 OOXML（zip + xml），浏览器/webview 无法直接渲染，需转成 HTML 或纯文本再显示，可选方案：
  - **方案 A（推荐，纯前端零后端改动）**：引入 `mammoth` npm 包，前端用 Tauri 读文件二进制为 `ArrayBuffer`（可让后端 `read_file_preview`/`lib.rs:333` 新增 `binary` 分支按扩展名返回字节，或独立 `read_docx` 命令返回 `Vec<u8>`/base64），再用 `mammoth.convertToHtml({ arrayBuffer })` 转 HTML 在预览区以 `v-html` 渲染；样式还原度限于基础排版（标题/列表/加粗/表格/图片），复杂样式会丢失，UI 需注明。`.doc` 旧二进制格式 mammoth 不支持。
  - **方案 B（后端 Rust）**：引入 `docx` crate 提取文本/转 HTML；但 `.doc` 旧二进制格式 Rust 生态支持差，基本无解，需降级提示「仅支持 .docx，请另存为 .docx 后再预览」。
  - **方案 C（统一转 PDF 复用预览）**：调用本机 LibreOffice 命令行 `soffice --headless --convert-to pdf` 把 doc/docx 转 PDF，复用「支持 PDF 预览」的 iframe 渲染链路；代价是依赖用户安装 LibreOffice，且转换有延迟。  
    ③ 前端 `FilePreview.vue` 新增 `previewType === 'doc'/'docx'` 分支渲染 HTML（`<div class="preview-doc" v-html="...">` + 基础排版样式，务必 **禁用 scripts 防 XSS**）；④ 后端可按方案 A 扩展 `read_file_preview` 的返回，或新增独立命令返回字节；⑤ header 徽标 `DOC`/`DOCX`(图标 📘)、footer 显示字数/页数；⑥ `.doc` 旧格式优先提示「格式不支持，建议用 Word 另存为 .docx 后再预览」；⑦ 渲染的 HTML 内用户选中文本后 Ctrl+C 应放行原生复制，参考「预览文本文件时支持选中文本复制」的 `hasPreviewTextSelection` 放行逻辑；⑧ 大文件 / 转换失败需有占位提示。
  - 实现：采用方案 A（纯前端零后端改动）。新增 npm 依赖 `mammoth`(1.12.0)，前端 `import mammoth from "mammoth/mammoth.browser.js"`（自包含浏览器包，避免 Node 版 `fs`/`path` 导致 Vite 构建失败）；`.docx` 经 `convertFileSrc` 拿 `asset://` URL 后 `fetch` 取 `arrayBuffer`，`mammoth.convertToHtml` 转 HTML，再用 `DOMParser` 防腐（去 `script/style/iframe/object/embed/link/meta`、去 `on*` 事件属性、去 `javascript:` 链接）后 `v-html` 渲染（基础排版样式用 `:deep` 作用于 v-html 内容）；`.doc` 旧二进制格式 mammoth 不支持，显示友好提示「请用 Word / WPS 另存为 .docx 后再预览」；header 徽标 `DOCX`/`DOC`(📘)、footer 显示字数（字符数）；`App.vue` 的 `hasPreviewTextSelection` 扩展匹配 `.preview-doc`，预览区内选中文本后 Ctrl+C 放行原生复制；>25MB 大文件与转换失败走占位/错误提示。前端改动未跑构建，待用户双击 `dev.bat` 实测。
