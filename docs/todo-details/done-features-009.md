# 地址栏面包屑 + 点击进入编辑态

> 来源：`TODO-done.md` 第 20 行 · 章节 已实现功能（想法暂存区） · 第 9 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **地址栏面包屑 + 点击进入编辑态** — 当前 `src/components/PathBar.vue` 的地址栏**一直是可编辑 `<input>`**（见 line 15-27），缺少面包屑形态。目标改成：① **默认以面包屑展示**完整路径（按分隔符 `\\`/`/` 拆成各层目录段，`C:\Users\simon` → `C:` › `Users` › `simon`），每段为可点击元素；② **点击任意父目录段即可 `navigate` 回跳到该层**（如点 `Users` 跳到 `C:\Users`）；③ **仅当用户主动点击「编辑」时才切换到文本输入态**（保留现有 `onEnter`/`expandPath`/`pathExists` 校验逻辑）——可形式：点面包屑区右侧的 ✎/🖊 按钮、或双击面包屑空白区进入编辑，进入后复用现有 input 行为（聚焦全选、回车校验导航、Esc/失焦还原、非法路径标红 `invalid`）。需处理：驱动器前缀（如 `C:`）在面包屑里作为首段且可点；`~`/`%VAR%` 等展开态在面包屑里展示为展开后的真实路径段；面包屑过长时的省略/横向滚动；当前已有的「复制路径」📋 与「刷新」↻ 按钮保留。注意与现有 `editing` ref、`displayValue` watch、`onFocus/onBlur/onEnter/onEscape` 的衔接，不要丢失 `%VAR%`/`~` 展开校验能力。
  - 实现：`PathBar.vue` 新增 `segments` computed 将路径拆成可点击面包屑段（支持盘符 `C:`、`\\server\share` UNC、相对/POSIX 路径；末段 path 固定为原始 path 规避尾斜杠差异）；默认渲染面包屑，点击父段 `emit('navigate')` 回跳；新增 ✎ 按钮与双击面包屑进入编辑态（`startEdit` 复用聚焦全选），编辑态保留原 `onEnter`/`expandPath`/`pathExists` 校验与 `invalid` 标红；过长面包屑横向滚动。前端改动未跑构建，待用户双击 `dev.bat` 实测。
