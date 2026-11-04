# Ctrl/Shift 多选文件

> 来源：`TODO-done.md` 第 16 行 · 章节 已实现功能（想法暂存区） · 第 7 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **Ctrl/Shift 多选文件** — 在文件列表中支持 `Ctrl`+点击 进行不连续多选、`Shift`+点击 进行连续范围多选，从而可一次性选中多个文件/文件夹，配合上述 ctrl+c / ctrl+x / ctrl+v 进行批量拷贝/剪切与粘贴。需处理：选中态的视觉高亮、活动面板 vs 另一侧面板的选中隔离、与模糊搜索过滤态共存、剪切态（移动）对多项的标记、全选/取消等便捷操作
  - 实现：`FileList.vue` 选中模型改为 `selectedIndices`(Set)+`activeIndex`+`anchorIndex`；`Ctrl+点击`切换、`Shift+点击`连续范围、`Ctrl+A`全选、`Esc`/点空白取消；每面板独立实例天然隔离左右选中；与 `/` 过滤态共存（索引基于 displayedEntries）；`App.vue` 的 ctrl+c/x/v 改为读取整个 `selectedEntries` 集合（后端 `copy_items`/`move_items` 本就支持多路径）；`Ctrl+X` 时通过 `cutNames` 把源面板中的待移动项以 `is-cut` 半透明斜体标记，粘贴后清除；`Delete` 支持批量删除。
