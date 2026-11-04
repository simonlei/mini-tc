# H.265/HEVC 视频「有声音没图像」自动引导系统播放器（方案①）

> 来源：`TODO-done.md` 第 52 行 · 章节 已实现功能（想法暂存区） · 第 23 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **H.265/HEVC 视频「有声音没图像」自动引导系统播放器（方案①）** — 用户文件 `爱莉希雅 (2).MP4` 编码为 HVC1(=HEVC/H.265)+AAC；WebView2(Chromium) 不解码 HEVC 的 Web 内容，但能解 AAC，于是黑屏有声且不触发 `<video>` 的 `error` 事件，原 `externalFallback` 兜底（仅靠 `@error`）永远不生效。用户选方案①：检测到"视频轨解不出画面"就自动弹出"用系统播放器打开"。实现（`VideoPreview.vue`）：① `onLoadedMetadata` 若 `videoWidth/videoHeight===0`（无可用视频轨）立刻 `triggerVideoFallback`；② 新增 `startVideoFrameWatch()` 在 `onPlay` 时启动：以 `requestVideoFrameCallback`（每帧上屏回调，设 `frameReceived`）为主信号，2s 后若仍无帧且 `currentTime>0.05`（声音在放）则用 canvas 采样——未解码视频画到 canvas 是**全透明**(alpha=0)、真实黑帧是**不透明**(alpha=255)，据此区分，确认无帧则 `triggerVideoFallback`；③ `cancelFrameWatch()` 在 `loadVideo`/`onBeforeUnmount` 清理定时器与回调，避免泄漏/误判；④ `triggerVideoFallback` 置 `externalFallback=true`+`loadError` 文案。正常 H.264 首帧几百 ms 内上屏不会误伤。纯前端改动，未跑构建，待用户双击 `dev.bat` 实测（重点：H.265 文件应在约 2s 内自动显示"用系统播放器打开"，普通 H.264 视频不受影响）。
