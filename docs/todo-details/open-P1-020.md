# 修复：`app-config` / `theme` 加载零类型校验，界面显示与实际行为可能相反，甚至全站无样式

> 来源：`TODO.md` 第 50 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 20 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`app-config` / `theme` 加载零类型校验，界面显示与实际行为可能相反，甚至全站无样式** — `App.vue:397-410/656-694`。与 `viewState.sanitize()`（逐字段类型/枚举/NaN 校验）形成鲜明反差 —— 同一份代码里两套健壮性标准。① `{"videoPreviewAlwaysOnTop": "false"}`（字符串）→ `!!"false"` 为 true → **窗口被置顶**，而设置对话框的 `typeof raw === "boolean"` 校验不通过、回落 schema 默认 false → **界面显示「已关闭」**。② `theme.json` 写 `{"x":"1"}` → `data-theme="x"` 匹配不到任何主题规则 → **全站 CSS 变量为空**（不可读、布局塌陷），且 `setTheme` 还把这个垃圾值**写回磁盘**，形成永久损坏。修法：两处各写 sanitize；`setTheme` 拆成 `applyTheme`（纯 DOM）与 `persistTheme`，杜绝「读路径产生写副作用」。
