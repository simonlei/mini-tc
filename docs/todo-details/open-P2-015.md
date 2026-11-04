# 收敛：`Esc` 的捕获阶段竞争 —— VideoPreview 的 window-capture 抢在 SearchDialog 的 document-capture 之前

> 来源：`TODO.md` 第 82 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 15 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`Esc` 的捕获阶段竞争 —— VideoPreview 的 window-capture 抢在 SearchDialog 的 document-capture 之前** — `VideoPreview.vue:566-575` vs `SearchDialog.vue:541-546/554`。捕获阶段顺序是 window → document → …，所以视频预览开着时按 Esc，**关掉的是视频预览、搜索对话框纹丝不动** —— 而 SearchDialog 的注释明确声称自己「注册在捕获阶段，因此也能赢过 App.vue」。另 `onEscCapture` 硬编码 `e.key !== "Escape"` 而没用 `matches("preview.close", e)`，用户改绑后行为分裂。
