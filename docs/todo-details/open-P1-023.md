# 修复：书签下拉每次打开对全部书签并发发起 `pathExists`（上限 200 条 IPC），且探测无序号守卫

> 来源：`TODO.md` 第 53 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 23 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：书签下拉每次打开对全部书签并发发起 `pathExists`（上限 200 条 IPC），且探测无序号守卫** —  ✅ 2026-10-19 复核：行号全对（`probeDead` 在 `BookmarkMenu.vue:147-155`、`onToggle` 触发在 `164-172`）。`154` 的 `deadPaths.value = next` 是无条件赋值、函数内无 seq/token/AbortController → 迟到结果会覆盖；`149-151` 的 `Promise.all` 对全部 path 一次并发，入参是 200 条书签 + recent + currentPath（`new Set` 只去重不截断）→ 上限 201+。注：`133-135` 的注释「Probed once per open」是设计意图不是守卫。`BookmarkMenu.vue:147-155/171`。点一次 ☆ 就并发 201+ 个 `path_exists`，每个走完整 IPC 往返（`api.js:140` 注释说单次约 14ms）→ 可感知的点击延迟。且第 1 次探测的迟到结果会覆盖第 2 次（`deadPaths.value = next` 无条件赋值），快速开关下拉会看到错误的删除线标记。修法：加 `probeSeq` 守卫；探测降级为节流批量（后端加接受数组的 `paths_exist`）。
