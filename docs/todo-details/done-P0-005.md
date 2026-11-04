# 修复：预览加载无请求序号，旧结果覆盖新文件 + blob URL 泄漏

> 来源：`TODO-done.md` 第 177 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 5 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：预览加载无请求序号，旧结果覆盖新文件 + blob URL 泄漏** — `FilePreview.vue`（`loadPreview` / `loadHeicPreview` / `loadDocxPreview` 全程无 token，grep `loadToken|loadSeq` 零命中）。用 ↓ 快速翻 HEIC 时，A 的 `fetch + decodeHeic(~400ms) + pixelsToBlob(~150ms)` 必然晚于 B：A 覆盖 B 的 `previewType/previewContent/fileSize`，界面上标题写着 B、内容是 A；`heicObjectUrl` 被覆写成 A 的 URL，**B 的 blob 从此无引用、永不 revoke**，每次快速翻页泄漏一份 JPEG。`loadDocxPreview` 同理（25MB docx 转换数秒）。附带 `releaseHeicUrl()` 只在 `loadHeicPreview` 和 `onBeforeUnmount` 调用，预览过 HEIC 后切到 PNG/TXT/PDF 走 `loadPreview` 其它分支时**从不 revoke**。修法：`let loadToken = 0`，入口取 `my = ++loadToken`，每个 `await` 后 `if (my !== loadToken) return;`；`releaseHeicUrl()` 移到 `loadPreview()` 开头（幂等）。
  - ✅ **已实现（2026-10-12）**。同样**没有照原描述用序号** —— 与前一条 `loadGate` 同源，序号会和折叠策略互斥。这里的判据更简单：直接比对 `props.filePath` 现在指向谁（`src/previewGate.js` 的 `previewLands()`）。**沿用同一条教训：并发守卫的判据必须是状态（「目的地还是不是它」），不是请求序号。**
    - 守卫落在**每一个 await 之后**，不只是入口 —— HEIC 路径有 4 处 await（fetch / decode / nextTick / encode），每处都可能落在导航之后。`beginLoad()` 返回 `{path, lands()}`，`lands()` 实时比对 `props.filePath`。
    - 🚨 **`pixelsToBlob` 之后那道守卫是防泄漏的关键**：那一步刚产出一个多 MB 的 JPEG blob，作废时**必须直接丢弃**，只跳过后续的界面写入是不够的 —— 那正是 blob 泄漏本身。每快速翻一页泄漏一份的说法就出在这里。
    - **`releaseHeicUrl()` 从 `loadHeicPreview` 移到 `loadPreview` 开头**（幂等）。原位置只在 HEIC 分支释放，于是「预览过 HEIC → 切到 PNG/TXT/PDF」这条路**从不 revoke**，blob 活到窗口关闭。
    - **动画 HEIC 的额外处理**：`await nextTick()` 之前已经写了 `frameState`/`frameDurations`，若在 nextTick 期间翻页，本文件的 frame 计数会遗留给新文件。故该处守卫失败时额外调 `stopAnimation()` 清理自己写下的状态。
    - **预览关闭（filePath 变空）** 补了 `releaseHeicUrl()` + `loading = false`：watcher 的 `if (props.filePath)` 拦住了这种情况，原本谁都不会清理。在飞请求靠 `lands()` 天然作废（空串 ≠ 原路径）。
    - catch / finally 同步收口：旧文件读失败不该把报错糊到当前文件上，`finally` 的 `loading = false` 也加了守卫。
    - **测试**：`scripts/preview-gate.test.mjs` 11 例，已挂进 `npm test`。含 **A→B→A 折返**（钉死序号模型那个坑）与「同名不同目录判为不同文件」。**变异测试**：改成恒 `true`（=无守卫）后 6 例失败。第一版有一条断言前提不成立（我断言 `previewLands("","")` 应为 false，实际 true 是**正确**的 —— 调用点已被 `if (props.filePath)` 拦掉），已改为断言无害性。**断言前先确认前提成立，否则测的是空气。**
    - `vite build` / `cargo check` / `npm test`（四组全过）均 exit 0。**待用户双击 `dev.bat` 实测**：在一个 HEIC 较多的目录里按住 ↓ 快速翻页，确认标题/内容/分辨率始终一致（修前会出现标题 B 内容 A）；预览过 HEIC 后切到 txt/png 再切回来，反复几次观察内存不涨。
