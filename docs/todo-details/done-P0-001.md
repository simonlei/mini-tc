# 修复：mammoth 预览的 `v-html` 净化器是黑名单且漏 `data:` URL，配合 `csp: null` 可在 Tauri 源上执行脚本

> 来源：`TODO-done.md` 第 126 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 1 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：mammoth 预览的 `v-html` 净化器是黑名单且漏 `data:` URL，配合 `csp: null` 可在 Tauri 源上执行脚本** — `FilePreview.vue:386-409` + `tauri.conf.json:27`。✅ **已实现（2026-10-14）**。
  - **病根**：`sanitizeHtml` 是黑名单 —— 只移除 `<script>/<style>/<iframe>/<object>/<embed>/<link>/<meta>`、`on*` 属性和 `javascript:` 前缀的 href/src。`.docx` 就是一包攻击者可选的 XML，mammoth 的输出直接进 `v-html`，于是 `<a href="data:text/html,<script>…">` **原样保留**；用户点击 → webview 导航到**同源** HTML → `window.__TAURI_INTERNALS__` 在该源可用 → **等价于任意命令执行**（读文件、删文件）。`"csp": null` 意味着没有第二道防线。也不处理 `srcdoc` / `formaction` / `xlink:href` / `svg`·`math` 命名空间。
  - **修法①白名单**：新增 `src/docxSanitize.js`，用 DOMPurify 的 `ALLOWED_TAGS`/`ALLOWED_ATTR`（只放行 mammoth 的输出子集）+ `FORBID_TAGS`/`FORBID_ATTR` 兜底，替掉手写遍历。**不用手写 walker**：绕过面（mutation XSS、命名空间混淆、解析器差异）正是每年被重新挖出来的那一类。`id`/`name` 不放行（DOM clobbering），`ALLOW_UNKNOWN_PROTOCOLS: false`。
  - 🚨 **修法②的关键实测：`ALLOWED_URI_REGEXP` 不是最后一道关**。DOMPurify 3.4.17 在正则**之后**还有一条内建放行（`purify.es.mjs:2164`）：只要标签在 `DATA_URI_TAGS` 内，`src`/`href`/`xlink:href` 上的**任意** `data:` 值直接放行，而该内建集合**包含 `img`** —— 实测 `<img src="data:text/html;base64,…">` 能活过一条明确拒绝 `data:` 的正则。`ADD_DATA_URI_TAGS: []` **修不了**：它经 `_resolveSetOption(..., { base: DEFAULT_DATA_URI_TAGS })` 是**并集**语义，传空数组不会缩小集合。所以 `data:` 的判定只能自己做（`uponSanitizeAttribute` 钩子），且**必须用完立刻 `removeHook`** —— 钩子挂在共享实例上，泄漏出去会顺手放宽别处的 `sanitize()`。⚠️ 我第一版写的钩子设了 `data.allowedURI`，**那不是 DOMPurify 的字段，等于空操作**，是读到源码才发现的。
  - **`data:` 的唯一正当需求**是 docx 内嵌图片（mammoth 输出 `data:image/...;base64`），故只对 **`img@src`** 放行 `^data:image/(png|jpeg|jpg|gif|webp|bmp|x-icon);base64,`。**`image/svg+xml` 不在内** —— SVG 是脚本上下文，放它等于把刚补上的洞重新打开。判定前剥掉 C0 控制字符（U+0000–U+0020 与 U+007F–U+009F）：浏览器解析 scheme 时忽略它们，`data:\ttext/html` 与 `java\tscript:` 都是活的绕过。
  - **修法③CSP**：`csp` + 独立 `devCsp`（后者含 vite 的 `ws://localhost:5173`，否则 HMR 连不上）。`object-src 'none'`、`form-action 'none'`、`base-uri 'self'`。⚠️ Tauri **不会**自动补 `ipc:`/`http://ipc.localhost`（官方注释里是手写的），漏一条会**静默打死全部 IPC**。⚠️ `script-src` **必须留 `'wasm-unsafe-eval'`**：libheif 的 wasm 以 base64 内嵌并直接 `WebAssembly` 实例化，CSP 视同 eval，去掉这条 HEIC 预览直接坏。
  - **测试**：`scripts/docx-sanitize-check.mjs`（已挂 `npm test`），90 条断言 = 33 个攻击载荷（`data:text/html` 导航 / `srcdoc` / `formaction` / `xlink:href` / `svg`·`math` / mXSS / 控制字符混淆…）+ 结构与合法内容断言 + 静态断言（`FilePreview.vue` 确实走 `sanitizeDocxHtml`、旧黑名单已不在）+ CSP 配置守卫。断言**解析回 DOM 逐属性检查**而非比对输出字符串（后者会被转义顺序之类的无关差异带偏）。
    - 🚨 **对照臂是这条测试的必要组成部分**：同一批载荷再过一遍**旧黑名单实现**，要求至少漏 3 个 —— 实测漏 **17/33**。没有它，一个「净化器彻底坏了」的 harness 照样全绿，而这是安全测试最常见的假阳性。
    - **三次变异验证**（攻击侧与正常侧同时钉住）：关掉 `data:` 钩子 → 6 条失败；把许可放宽到任意 `data:image`（含 svg）→ 3 条失败；连合法内嵌图片一起禁 → 3 条失败。
    - **CSP 守卫同样验过变异**：`csp` 退回 `null` → 立刻失败。守卫同时接受 Tauri 的**字符串形式**与对象形式（先写成只认对象，等于会对合法配置误报，已改）。
  - **依赖**：`dompurify@^3.4.17`（运行时）、`jsdom@^30.1.2`（仅测试，供 node 侧跑真实 DOMPurify）。DOMPurify 是**静态导入**，故不进 `optimizeDeps.include`（那条只对动态导入的 mammoth / libheif 才有意义）。
  - ⚠️ **未做端到端验证**：CSP 是否误伤某条预览路径，只能由用户双击 `dev.bat` 实测（重点看：docx 预览、HEIC 预览的 wasm、图片 / PDF / 视频预览、以及 vite HMR 是否正常）。纯逻辑表 / 静态断言 / 端到端这三层不可混为一谈。
