# 支持 ctrl+c / ctrl+v / ctrl+x 剪贴板操作

> 来源：`TODO-done.md` 第 15 行 · 章节 已实现功能（想法暂存区） · 第 6 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **支持 ctrl+c / ctrl+v / ctrl+x 剪贴板操作** — 在文件列表中选中条目后，可通过快捷键执行复制（ctrl+c）、粘贴（ctrl+v）、剪切（ctrl+x）。复制/剪切将当前选中项写入内存剪贴板（记录源路径+操作类型），粘贴时在**当前活动面板（用户当前选中的目录）**&#x76EE;录执行拷贝/移动。已在 App.vue 全局 keydown 拦截并 preventDefault（输入框焦点时放行，文本编辑正常）；粘贴后目标面板+活动面板都 refresh；复制保留剪贴板可重复粘贴，剪切粘贴后清空；后端 `copy_items`/`move_items` 递归处理目录，跨卷 move 用 copy+delete 兜底；目标已存在/源不存在则跳过并聚合错误，前端用 toast 反馈成功/失败
