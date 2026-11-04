# 修复：`loadDirectory` 无请求序号，先发后到的旧目录结果覆盖新目录并污染 tabCache

> 来源：`TODO-done.md` 第 255 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 3 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`loadDirectory` 无请求序号，先发后到的旧目录结果覆盖新目录并污染 tabCache** — `FilePanel.vue:1005-1072`。`inFlightLoads`（`271`）只折叠**完全相同**的 `${tabId}:${path}` 请求，挡不住 `A→B→C` 快速导航的三个不同 path 并发。B 的结果先回、A 后回时 `entries.value` 被写回 A 而 `activeTab.path === C` —— 面包屑显示 C、列表显示 A，且 `tabCache[tabId]` 被钉死在 A，下次切回该 tab 命中脏缓存。`finally` 的 `loading.value = false`（`1070`）也会被先完成的那次误清。修法：模块级 `let loadSeq = 0`，入口 `const seq = ++loadSeq`，`await` 后先 `if (seq !== loadSeq) return;` 再写 `entries`/`tabCache`/`loading`。
  - ✅ **已实现（2026-10-12）**。但**没有照原描述做序号** —— 那个方案会引入比原 bug 更严重的问题，见下。
    - 🚨 **原提的修法（`loadSeq` 序号）是错的，与 `inFlightLoads` 折叠互相打架**。A→B→A 快速导航时，回到 A 的请求因 key 命中被折叠（`return`，不落地），而 A 的**首个**请求又已被 B 的序号作废 → **谁都不落地**，面板卡在 B，目录内容永远出不来。序号模型天然无法与「同 key 折叠」共存：折叠意味着「本次不发请求」，而作废判据是「本次不是最新」，两个前提互斥。**教训：并发守卫的判据必须与折叠策略一起设计，不能只补一个计数器。**
    - **改用路径判据** `loadLands({path, tab, tabId, activeTabId})`（新增 `src/loadGate.js`）：结果只服务于它被请求时的那个目的地，「这个 tab 现在还指着这个路径吗」—— 目的地变了就是垃圾。与项目里已有的两条同源经验一致（目录大小缓存的 per-tab path 戳、tabCache 读时校验 `cached.path === newPath`）。返回 `{cache, ui}` 分离两种写入：后台预热**能**写自己 tab 的缓存但**不能**动界面。
    - `tab` 在 await 之后**重新查** `tabs.value.find(...)`，顺带覆盖了「await 期间 tab 被关闭」—— 原代码会往已关闭的 tab 写 `tabCache`，泄漏条目。
    - 🚨 **转圈不能用同一个判据清**。切到**有缓存**的 tab 走 silent 分支、根本不新建转圈，于是先前的请求一走，面板就**永久停在「Loading…」**。所以归属单独记：`createSpinner().claim(key)` / `release(key)`，**谁点亮谁熄灭**，与 await 后的状态无关。（我第一版正是把 `loading` 挂在 `land.ui` 上，写完才发现自己造了个永久转圈的 bug —— spinner 归属和落地判据是两个正交的问题。）
    - `loadDirectory` 改为**返回是否落地**。`refresh()`（`1186`）原来 `await` 之后无条件恢复选中态，现在被作废时直接返回 —— 否则会把本次刷新的快照盖到已经切走的那个 tab 的列表上。同源缺陷一并修。
    - catch 分支同步用 `land.cache` 把门：原代码用 await 前捕获的 `isActive`，用户已切 tab 时仍会把旧目录的「路径不存在」糊到当前界面，并清空列表。
    - **测试**：`scripts/load-gate.test.mjs` 共 23 例（`node scripts/load-gate.test.mjs`），覆盖 A→B→C 乱序落地、**A→B→A 不得谁都不落地**（钉死上面那个序号模型的坑）、tabCache 不被钉死、预热写缓存不写界面、切 tab 期间不写界面、tab 被关闭不写不泄漏，以及 spinner 的 4 组归属/顺序/重复释放。**变异测试验证有效性**：去掉路径判据 → 4 例失败；`cache` 无条件 true → 1 例失败；`ui` 忽略 `activeTabId` → 2 例失败；序号退化成全局单计数器 → 2 例失败。**全绿但抓不住退化的测试等于没测试。**
    - `vite build` exit 0、`cargo check` exit 0、`cargo fmt --check` exit 0。**待用户双击 `dev.bat` 实测**（A→B→C 快速连点目录行 / 面包屑，确认面包屑与列表始终一致；Alt+← 后退后再前进，确认列表不被旧结果覆盖；切到有缓存的 tab 确认不卡转圈）。
