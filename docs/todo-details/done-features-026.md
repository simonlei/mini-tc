# 鼠标拖拽文件到目标文件夹（拖放移动）

> 来源：`TODO-done.md` 第 62 行 · 章节 已实现功能（想法暂存区） · 第 26 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **鼠标拖拽文件到目标文件夹（拖放移动）** — 在文件列表中用鼠标拖拽已选中的文件/文件夹（单个或 `Ctrl/Shift` 多选集合），落到目标文件夹上时视为「移动到该文件夹」（等同剪切+粘贴到目标）。需处理：① 源项 `draggable` + `dragstart`（携带 `selectedEntries` 路径集合，多选时任一选中项被拖都拖整个选中集合）；② 目标目录行的 `dragover`（`preventDefault` + 高亮落点）与 `drop`（解析路径，调用现有后端 `move_items` 完成移动）；③ 落到空白区 = 当前目录本身（移动到当前目录，通常是无操作或跨面板语义）；④ 跨面板拖拽：从左面板拖到右面板的目录/空白区（=右面板当前目录）也应支持，注意与预览面板（FilePreview）的事件冲突隔离；⑤ 目标是文件时忽略或提示；⑥ 移动后刷新源面板与目标面板，失败走现有 toast 聚合错误反馈；⑦ 与模糊搜索过滤态、多选 `is-cut` 视觉标记共存；⑧ 可选：拖到 PathBar 面包屑段 = 移动到该父目录；`dataTransfer.effectAllowed = 'move'` 光标语义。纯前端 + 复用现有 `move_items`，无需后端改动。
  - 实现：新增 `src/dragState.js`（模块级单例，跨面板共享拖拽源 `sourceNames`/`sourcePath`——HTML5 DnD 的 `dragover` 阶段读不到自定义 payload，故用共享对象承载）。`FileList.vue`：行 `draggable="true"` + `data-row-type/is-dir/name/index` 属性；`onRowDragStart` 决定拖拽集合（选中项中的行拖整组、否则仅该行），写入 `dragState` 并 `setData("application/x-minitc-move")` + `effectAllowed='move'`；容器 `@dragover`/`@dragleave`/`@drop` 经 `resolveDropTarget` 判定落点（目录行→进入该目录、`..`→父目录、空白区→当前目录、文件行→忽略），高亮 `drag-over`/`drag-over-empty`；`onDrop` 解析源/目标绝对路径、过滤「已在目标目录」的 no-op，向 `FilePanel` 发 `drop-move`。`FilePanel.vue` 转发 `drop-move` 到 `App.vue`；`App.vue` 复用 `doPaste('cut', sources, destDirOverride)`（冲突弹窗 + 进度条 + 双栏刷新 + toast 聚合），新增 `doDropMove`/`onDropMove`。与模糊搜索过滤态（`displayedEntries` 索引）、`is-cut` 标记、`FilePreview`（`v-show` 隐藏时其区域无落点）均无冲突。前端改动未跑构建，待用户双击 `dev.bat` 实测。
