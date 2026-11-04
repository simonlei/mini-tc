# 收敛：`.vp-buttons` 在同一个 `<style scoped>` 里写了两遍

> 来源：`TODO.md` 第 86 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 19 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`.vp-buttons` 在同一个 `<style scoped>` 里写了两遍** — `VideoPreview.vue:836-845` 与 `872-878`。第二块是纯复制粘贴且漏掉了 `max-height/overflow/transition`；目前靠 CSS 层叠侥幸正常，但只要有人「整理」成删掉前一块，自动隐藏的折叠动画就会静默失效。
