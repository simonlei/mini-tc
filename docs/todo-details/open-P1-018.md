# 修复：`PathBar.segments` 给每个中间面包屑段加尾反斜杠，污染历史栈与持久化

> 来源：`TODO.md` 第 48 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 18 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`PathBar.segments` 给每个中间面包屑段加尾反斜杠，污染历史栈与持久化** —  ⚠️ 2026-10-19 复核：成立，行号已漂移（现 `189-239`，emit 在 `337-340`），且**位置描述有误** —— `navOf` 不在 `App.vue:790` 而在 `FilePanel.vue:816-835`，裸比较 `includes(cur)` 确在 `829`。尾反斜杠确认 drive 段（`212`）、每个中间段（`216`）、UNC 每级（`203`）都带；`237` 只把末段钉回原串 → 中间段必然带。POSIX 分支（`226-231`）**不带** → Windows 专属。`PathBar.vue` 零 `../paths.js` 导入、`normDir` 零出现，绕过成立。🚨 **但「按一次后退没反应」这一症状 UNVERIFIABLE** —— `setPath:849` 的 `oldPath === newPath` 早退会先挡住重复导航、后退栈本身仍能走；真实可观测症状是历史栈里堆积带尾斜杠与不带尾斜杠两种写法、面包屑当前段与历史条目显示不一致。`PathBar.vue:206-217/236`。点中间段 `C:\Users` 实际 emit 的是 `C:\Users\`，经 `setPath` 进入 `nav.entries` 并写进 `tabs-left.json`；而 `navOf:790` 用**裸比较** `!tab.nav.entries.includes(cur)`，`normDir` 帮不上忙 → 「按一次后退没反应」+ 重启后导航行为不一致。整段面包屑路径构造完全绕过 `paths.js`。修法：`paths.js` 增加同步版 `joinPathPure(parent, name)`，`segments` 只做「逐级下降 + normDir」。
