# 修复：`formatSize`/`formatBytes` 多份实现，其中两份缺上限 clamp → 超 1TB 显示 `"undefined"`

> 来源：`TODO-done.md` 第 269 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 5 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`formatSize`/`formatBytes` 多份实现，其中两份缺上限 clamp → 超 1TB 显示 `"undefined"`** — 原 TODO 写「四份」，实测是 **8 份**（`App.vue`、`FileList.vue`、`FilePanel.vue`、`FilePreview.vue`、`PathBar.vue`、`SearchDialog.vue`、`VideoPreview.vue` 的 `fmtSize`，另有一处更早的 App.vue 副本），已全部收敛到 `src/format.js` 的 `formatBytes(bytes, empty = "0 B")`。
  **已修（2026-10-14）**。把旧副本逐字复刻后实测，漂移是这些（不是原 TODO 描述的那一组）：

  | 输入 | `FilePreview.vue` 旧版 | `FileList.vue` 旧版 |
  |---|---|---|
  | 2 TB | `2.0 undefined`（units 4 级，`i=4` 越界） | `2.0 TB` |
  | 1 PB | `1.0 undefined` | `1.0 undefined`（units 5 级，`i=5` 越界） |
  | 0.5 B | `512.0 undefined`（**`i=-1`**，负索引） | `512.0 undefined` |
  | `undefined` | `NaN undefined`（守卫只判 `=== 0`） | `NaN undefined` |

  **同一个 2 TB 文件在预览面板与搜索对话框显示不同字符串** —— 「多份实现」的代价是既成事实，不是理论风险。
  - 🚨 **原 TODO 与我第一版注释都把 `undefined` 的来源说窄了**：以为只有 units 上界越界，实际**负索引是独立且更早的一类** —— 任何 < 1 字节的值 `log < 0` → `i = -1` → `units[-1]`，**所有副本都中招**。只钳上界抓不到它。实测 `0.5 B` 在**两份**旧副本上都给 `512.0 undefined`（值被 `1024^-1` 放大）。
  - ⚠️ **我把 `String` vs `toFixed(0)` 说成「已产生的漂移」，是错的**：实测在现实输入下两版**完全一致**（整数 < 1024 时都是 `512`；分数根本走不到那里，先被负索引炸了）。保留 `String` 只是廉价保险，**不能当 bug 修**。**注释里的因果断言同样会错。**
  - **测试**：`scripts/format-size-check.mjs`（87 例），含对照臂把两份旧实现逐字复刻重跑。**5 个变异全部实测会失败**：① 去掉 `Math.max(0,…)` → 6 条红；② 去掉 `Math.min(LAST,…)` → 4 条红；③ 守卫退化成 `!bytes` → 8 条红（负数/Infinity/字符串漏过）；④ 把副本粘回 `FilePreview.vue` → 静态断言红（纯函数表此时**仍全绿**）；⑤ 删掉 PathBar 三处调用中**一处**的 `empty` 参数 → 红。
    - 🚨 **变异 ⑤ 暴露了一条「看起来在测」实则恒绿的断言**：我最初写「文件里有带参调用即可」，删掉其中一处参数照样全绿。改成「剥注释后数出**全部**调用点，逐个必须带参」才抓住。
    - ⚠️ **静态断言把注释当代码**：「守卫在 `Math.log` 之前」是顺序约束，而 `format.js` 自己的注释里就出现这两个名字，直接比 `indexOf` 等于**让文档自己判自己过**。抽出 `scripts/stripComments.cjs`（原 `lint-imports.js` 的私有函数，两边共用而非复制）先剥再比。剥完才发现 PathBar 注释里的 `formatBytes(…)` 让调用点数从 3 变 2。
    - ⚠️ **对照臂的两份旧实现在 0.5 B 上结果恰好相同**（都是 `512.0 undefined`）。别断言「每个旧实现在每个输入上都不同」—— 漂移是**逐副本**的（2 TB 在 FileList 上本来就对），那么写会逼我把正确的对照改成错的。同理我第一版写「2 TB 与有钳制的旧版一致」时把 `1023.9 TB` 的值记成了 `1024.0 TB`。
  - **保留的唯一差异是 `empty` 参数**：PathBar 容量未知显示 `—`（「0 B 可用」是谎话），VideoPreview 无体积显示空串，其余为 `0 B`。测试逐个调用点断言，且 PathBar/VideoPreview 是「**全部**调用都必须带参」。
  - ⚠️ **已知且接受的边界**：超出 `u64` 上限（约 16 EB）的值只钳单位不截数字，`1e30` → `888178419700125.3 PB`。算术上诚实，且后端 `size` 是 `u64` 给不出更大的数。**不为不可达输入说谎。**
  - `npm run check` exit 0（lint 33 文件 + 9 个脚本全绿）、`vite build --outDir .bootcheck` exit 0。**待用户双击 `dev.bat` 实测**（找一个 >1TB 的文件看预览面板标题栏，确认不再出现 `undefined`；顺带看下路径栏驱动器容量与搜索结果页的体积列）。
