# 收敛：docx 净化器漏掉 `data:` URL 与 SVG/MathML 命名空间

> 来源：`TODO.md` 第 88 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 21 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：docx 净化器漏掉 `data:` URL 与 SVG/MathML 命名空间** — `FilePreview.vue:386-410`。只黑了 `javascript:`。`<a href="data:text/html,...">` 可点开执行脚本；`<svg>`/`<math>` 内的 `xlink:href` 与 `foreignObject` 也不在黑名单。与 P0 的净化器条目一起修。
