# 修复：帧检测每次播放都做全分辨率 `getImageData`（4K ≈ 33MB 回读 + 830 万次循环）

> 来源：`TODO.md` 第 61 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 31 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：帧检测每次播放都做全分辨率 `getImageData`（4K ≈ 33MB 回读 + 830 万次循环）** —  ⚠️ 2026-10-19 复核：缺陷本体（全分辨率回读）**仍在**，现址 `399-409`（`c.width = el.videoWidth` 无缩放）；但**触发频率被夸大** —— canvas 回读是 **backstop**，只在 `requestVideoFrameCallback` 2 秒内没回调时才执行（`390-393` 主路径，`394-397` 才判 `frameReceived` 为假），即绝大多数正常播放走主路径、不每次都做 4K `getImageData`。`onPlay` 触发关系（`269-270`）成立。`VideoPreview.vue:389-410`。`startVideoFrameWatch()` 由 `onPlay` 触发，而 `onPlay` 在每次播放、每次 seek 恢复、每次自动续播都会来。检测只需要知道「有没有画过东西」，不需要原始分辨率。修法：缩到 32px 宽再采样。
