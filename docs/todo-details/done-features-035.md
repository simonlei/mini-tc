# 目录书签 / 常用目录（Ctrl+D）

> 来源：`TODO-done.md` 第 97 行 · 章节 已实现功能（想法暂存区） · 第 35 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **目录书签 / 常用目录（Ctrl+D）** — 快速在深层目录间跳转。目标：① `Ctrl+D` 把当前目录加入书签（再按一次可编辑名称 / 删除），存 `~/.minitc/bookmarks.json`（通用 `load_config`/`save_config`），结构 `{ name, path, addedAt }`；② UI：PathBar 常驻书签下拉（或面包屑旁 ⭐ 按钮），点击即 `navigate`，右键可重命名 / 删除 / 排序；③ 附带「最近访问目录」列表（可从第 1 条的历史栈派生，不必单独存）；④ 书签路径失效（盘符卸载 / 目录被删）时置灰并提示，跳转失败不要写坏当前路径；⑤ 每栏独立 vs 全局共享（建议全局一份，左右栏通用）；⑥ 与 `PathBar.vue` 已有的面包屑折叠（`needsCollapse`）逻辑共存，书签按钮需在折叠区之外固定占位；⑦ 快捷键进 `shortcuts.js`。
  - 实现：新增 `src/bookmarks.js`（模块级单例 store，`bookmarks` ref + 增删改名排序 API，写盘 150 ms 防抖，上限 200 条，`sanitize()` 清洗手改文件：去重/补 id/补默认名）+ 新增 `src/components/BookmarkMenu.vue`（⭐ 按钮 + 下拉：书签列表点击即`navigate`、右键 ContextMenu 重命名/上移/下移/删除、行内改名输入框、失效路径删除线置灰、底部「添加当前目录」+ 提示区）。**最近访问不落盘**，由 `FilePanel.vue` 新增的 `recentDirs` computed 从当前 tab 自己的 `nav.entries[0..index]` 倒序派生（上限 10、排除当前目录与搜索哨兵）——历史栈已持久化且已驱动 `Alt+←`，另存一份只会与它不一致。失效路径每次开下拉时批量 `pathExists` 探测，点击时再复验一次，避免面板被带进报错页。两侧面板各渲染一个下拉，用 `bookmarks.js` 的 `openMenuOwner` token 选主，保证同时只有一个展开。搜索结果 tab 隐藏 ⭐ 且 `Ctrl+D` 落空不消费按键。`shortcuts.js` 注册 `bookmark.toggle`（scope `global`，默认 `Ctrl+D`），`App.vue` keydown 里处理（输入框焦点时不认领——行内改名时按 Ctrl+D 会误删书签）。**注意**：下拉的 mousedown/Esc 监听必须用 **capture** 阶段，否则面板根节点的 `@click` 会先于 document冒泡响应把面板激活；Esc 还需 `stopPropagation`，否则会连带触发 App.vue 的「关闭预览」。vite build exit 0，待用户双击 `dev.bat` 实测。
