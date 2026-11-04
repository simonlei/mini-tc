# 地址栏路径过长时优化显示（消除横向滚动条）

> 来源：`TODO-done.md` 第 33 行 · 章节 已实现功能（想法暂存区） · 第 16 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **地址栏路径过长时优化显示（消除横向滚动条）** — 当前 `PathBar.vue` 的面包屑区域（`.breadcrumb`）使用 `white-space: nowrap` + `overflow-x: auto`，当路径层级深或某段目录/文件名过长时会出现横向滚动条，既不美观也影响操作。目标：给出更好的方案替代横向滚动，让长路径在有限宽度内优雅展示。可选方案：① **中间折叠**——始终显示首段（盘符/根）和末段（当前目录名），中间段超宽时用 `…` 折叠（点击 `…` 可展开中间段列表供跳转）；② **逐段省略**——每个 `crumb` 设 `max-width` + `text-overflow: ellipsis` 截断过长的单段名称（hover/title 显示完整名）；③ **末段优先**——容器 `direction: rtl` 让溢出从左侧截断，保证当前目录名始终可见；④ 组合方案：单段过长用 `…` 截断 + 整体过长时中间段折叠。需处理：折叠后各段仍可点击导航、`title` 悬浮提示完整路径、与现有面包屑点击/双击编辑/✎ 按钮等交互不冲突。
  - 实现：`PathBar.vue` 面包屑改为默认 `overflow: hidden` 消除横向滚动条；新增隐藏测量代理 `.crumbs-measure`（含全部段）与 `measure()`（ResizeObserver / window resize 触发），路径整体超宽时 `needsCollapse=true` 自动折叠为「首段 › … › 末段」，中间段隐藏；每段 `max-width:220px` + `text-overflow:ellipsis` 单段过长截断，`title` 悬浮显示全名；点击 `…` 切换 `expanded` 临时展开全部（此时 `overflow-x:auto` 可滚动查看），各段仍 `.crumb` 可点击导航；与双击编辑 / ✎ 按钮 / 复制路径等交互无冲突。前端改动未跑构建，待用户双击 `dev.bat` 实测。
