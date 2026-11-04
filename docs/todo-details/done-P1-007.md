# 修复：`onDelete` 循环内每次 `await` 之后重新读 `activeTab.value.path` 与 `entries.value`

> 来源：`TODO-done.md` 第 302 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 7 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`onDelete` 循环内每次 `await` 之后重新读 `activeTab.value.path` 与 `entries.value`** — 原 `FilePanel.vue:onDelete`。
  **已修（2026-10-15）**。⚠️ **实测发现原描述高估了修复状态**：入口处的 `tab/tabId/dir` 快照**早就存在**（连注释都写好了「reading `activeTab` inside the loop then points at a different directory」），但循环之后**仍然直接读活的 `entries.value`** —— 也就是说当年只修了一半，判据被写在了注释里而没落到代码上。原条目里「1390 的 filter 作用在错误列表上」「1416 把新目录的条目数当 remainingCount 上报」两条**都仍然成立**。
  - **三个落地点，逐个说清后果**：
    - `entries.value = entries.value.filter(...)` 落在**新目录**的行上：真正的删除结果不反映到任何面板（用户切回来才看得出少了几行），同时那个目录的列表被换成一个内容相同的副本 —— 数组身份一变，`FileList` 的 entries watcher 就重置了用户在新目录里的选中集。
    - `emit("deleted", { remainingCount: entries.value.length })` 把**新目录**的条目数当成这次删除的结果上报：新目录恰好为空就关掉一个毫不相关的预览，非空就让一个文件已被删掉的预览继续开着。
    - 提权删除后的 2 秒延迟刷新里，`refresh()` 读的是**活动 tab**，同一个错误再犯一次，且这次连「刷新了哪个目录」都是错的（用户已经走了）。
  - 🚨 **`remainingCount` 必须是快照算的，不能改成「切走了就不 emit」**：不 emit 等于放弃联动 —— 用户在预览中对侧面板删光整个目录、随后走开，预览就该关掉。正确做法是**始终 emit，但用快照列表减掉已删路径**算个数。
  - **判据用「这个面板现在还指着这份列表吗」，不用自增序号** —— 与 `loadGate.js` / `previewRequest.js` 同一条纪律。A→B→A 折返时迟到的删除**应该**落地（那些文件确实已不在磁盘上），序号模型会误杀。
  - 🚨 **纯逻辑表写了但测不到调用点，等于没测**：本条正是这个形状。所以除纯逻辑表外补了**静态断言**（`stripComments` 剥注释后按花括号配平抽出 `onDelete` 函数体），钉住：快照必须在第一个 `await` 之前、`filter` 必须被 `if (stillOnTarget())` 包住、两次 `emit` 的 `remainingCount` 来源、延迟刷新里守卫查了两次。
  - ⚠️ **静态断言的 helper 自己踩了一次坑**（写测试时真发现的）：`bodyOf` 一开始用 `indexOf("{", at)` 找函数体，而 `onDelete(targets, opts = {})` 的**默认参数里就有一对花括号** → 配平后返回的是 `{}`，13 条静态断言全灭而代码毫无问题。改成先配平圆括号跳过参数列表。
  - **测试**：`scripts/delete-scope-check.mjs`（40 例，含一组显式的**旧实现对照臂**：恒 `true` 的守卫 + 只看总数的 `remainingCount`，在本表下必须露馅）。
    - **4 个变异全部实测会失败**：① 判据退化成恒 `true` → 6 条红；② `remainingAfterDelete` 改按 `name` 扣 → 6 条红（这正是搜索结果页同名塌成一条的原 bug）；③ **删掉调用点的守卫、判据本身完好** → 纯逻辑 27 条**全绿**，2 条静态断言红 —— 这就是静态断言存在的理由；④ `remainingCount` 改回读活的 `entries.value.length` → 2 条红。
    - ⚠️ 断言「`deleteScopeLands` 只出现在 import 与调用处」（防止把判据就地重写一遍）时，靠的是**计数恰好为 2**。将来若新增第二个调用点，这条断言会误报 —— 届时应改成数出全部调用点逐个检查，而不是改成 `>= 2` 放水。
  - `npm run check` exit 0（lint + 12 个脚本全绿）、`vite build --outDir .bootcheck` exit 0（临时产物已删）。**待用户双击 `dev.bat` 实测**：开一个左右都有预览的状态，在一栏选中几十个文件按 Shift+Delete 或 Delete，在 UAC 弹窗出现前立刻点进别的目录 —— 删除应正常完成、不报错，面板不被刷成空白，切回去只少该少的行且选中集不被打乱。
