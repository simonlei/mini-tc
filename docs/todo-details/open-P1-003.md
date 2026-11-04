# 修复：`FileList.onKeydown` 没有 `isActive` 守卫，与 `onMouseUp` 不一致

> 来源：`TODO.md` 第 12 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 3 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`FileList.onKeydown` 没有 `isActive` 守卫，与 `onMouseUp` 不一致** — ⚠️ **2026-10-19 取证：仍成立，行号已漂移。** `onKeydown`（现 `FileList.vue:864-866`）开头只有 IME 与 INPUT 两道闸，无 `isActive`；`onMouseUp`（`718-719`）第一行即 `if (!props.isActive) return;`。模板 `:5` 的 `tabindex="0"` 常驻、`props.isActive` 有定义（`:182`）、`onMouseUp:708-709` 注释自称「claimed only on the active panel」而 onKeydown 无对应约束 —— 分歧前提全部成立。方向键分支（`942-957`）直接落到 `moveSelection`，操作本组件的 `selectedIndices`。
