# 修复：`dragOutTracker` 用大小写敏感的精确串比较，自拖出可能被判为外部拖入（move 变 copy）

> 来源：`TODO.md` 第 47 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 17 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`dragOutTracker` 用大小写敏感的精确串比较，自拖出可能被判为外部拖入（move 变 copy）** —  ✅ 2026-10-19 复核：`dragOutTracker.js:14-33` 全文确认 —— 第 `27` 行是裸 `!==`、零归一化（无 `toLowerCase`/`normDir`/分隔符统一）；导出仅 `noteDragOut`/`consumeDragOut`，**无 disarm API**，`lastOutPaths` 只在成功匹配时置 null（`30`）、失败路径（`25`/`27`）**不清状态**；5 秒窗口在 `23`。`FileList.vue` 侧现址 `1220-1226`（原写 1216），`noteDragOut` 确在 try 块之外、catch 只 `console.error` 不解锁。`dragOutTracker.js:17-32`。写入的是 `entryPath()` 的规范形式，读回的是 OS 回传 paths，盘符大小写 / 分隔符可能不一致 → `isSelfOut` 为 false 就走 **copy** 分支：用户明明是「拖到别处移走」，结果源目录多出一份副本。**静默的数据行为错误**。另 `FileList.vue:1216` 在 `startNativeDrag` **之前**就 `noteDragOut`，若它抛错则标志仍 armed 5 秒。
