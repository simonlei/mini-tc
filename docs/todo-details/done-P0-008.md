# 修复：批量重命名执行中规则表单仍可编辑，`applied` 回传的 pairs 与磁盘实际结果不一致

> 来源：`TODO-done.md` 第 198 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 8 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：批量重命名执行中规则表单仍可编辑，`applied` 回传的 pairs 与磁盘实际结果不一致** — `BatchRenameDialog.vue:186-202`。`plan` 是 `computed(() => buildRenamePlan(props.items, props.existing, rules))`，`rules` 是 reactive；14 个 `v-model` 输入框**全部没有 `:disabled="running"`**（grep `disabled` 只有主按钮那一处），所以 await 期间任何击键都会重算 `plan.value`，第 199 行读到的是**新规则算出的名字**、磁盘上落的是**旧规则**。`FilePanel.applyRenames(pairs)` 随后按错误 pairs 就地改行，用户看到一批磁盘上并不存在的文件名，且无任何报错。执行器 `renameRunner.js` 特意用独立 `applied` 日志避免自我污染，dialog 层却把同一个 bug 重新引入了。修法：`apply()` 开头 `const rows = plan.value` 快照，await 后用 `rows`；规则容器包一层 `<fieldset :disabled="running">` 让注释成立。
  - ✅ **已实现（2026-10-13）**。原描述的两处修法都做了，但**顺序反过来更稳**：先修不变量，再修 UI。
    - **不变量收到执行层**：新增 `applyRenamePlan(getRows, {existing, move})`（`renameRunner.js`）—— 入参是**取值函数**而非数组，`getRows()` 在函数内**只调一次**，`await runRenamePlan(rows, …)` 与回传的 `pairs` 用**同一个 `rows`**。把快照放进拥有 await 的那个函数里，调用方就**不可能**因为忘记而退化。若快照留在 dialog（`const rows = plan.value`），可测性只能靠测试复刻一遍组件逻辑 —— 那测的是测试自己的副本，正是本项目吃过两次亏的形态。
    - **UI 只是 courtesy**：规则容器从 `<div class="rules">` 换成 `<fieldset class="rules" :disabled="running">`。用真 `<fieldset>` 而非给14 个输入框各加 `:disabled` —— 浏览器一次性挡住键入与原生键盘交互，且**以后新增规则行不可能忘记锁**（要漏就得故意去掉 fieldset）。`.rules` 补了 `<fieldset>` 的 UA reset（`border/margin/padding/min-inline-size`），视觉外壳仍在 `.rule-block` 上。
    - **顺带钉住「失败不发 pairs」**：`applyRenamePlan` 的 `pairs` 受 `res.ok` 门禁，回滚过的批次不会让面板按 rows 改行（那等于凭空显示一批没改成的名字）。
    - **测试**：`scripts/rename-rules-check.mjs` 新增 8 例（共 **110 passed / 0 failed**），核心那条让 `getRows()` **第一次返回旧 plan、之后返回 drifted plan**（同 path、新名字），断言 ①getter 恰好被读一次 ②回传 pairs 解析出的路径与**内存文件系统的真实状态**一致（不与 row 对象对照 —— 那还是在测自己的副本）③ drifted 名字没渗进 pairs。
    - **变异测试**（两次都失败才算数）：把 `applyRenamePlan` 退回「await 前后各读一次 `getRows()`」→ **4 例失败**（含 `NEW-a.txt` 渗入）；去掉 `res.ok` 门禁 → **1 例失败**。恢复后全绿。
    - ⚠️ 第一版断言写错了（拿 `pairs` 的 `oldPath` 去比对磁盘 key）—— 改完名后**旧路径本就该消失**，这是断言错不是代码错。已改成「旧目录 + 新名」推导磁盘路径。**断言写错时先分清是测试错还是代码错，别顺手改生产代码去迎合测试。**
  - `npm run check` 全绿（lint 28 文件 + 110 + 22 + 23 + 11）、`vite build` exit 0（主 bundle 260.88 kB）。**待用户双击 `dev.bat` 实测**：多选几个文件 → Ctrl+M → 填规则 → 点「重命名」→ 在执行过程中能看到规则区变灰不可编辑、预览区保持不变；完成后文件列表显示的名字与磁盘一致。
