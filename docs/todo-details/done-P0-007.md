# 修复：`pendingAutoplay` 在多条路径上泄漏，用户手动选的视频会自己开始播

> 来源：`TODO-done.md` 第 188 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 7 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`pendingAutoplay` 在多条路径上泄漏，用户手动选的视频会自己开始播** — `VideoPreview.vue:341/655`。`App.vue:999 playNextVideo()` 有 4 个提前 return（预览已关 / 非视频 / 无当前名 / 已是最后一个 / 无目录），命中任一条 `pendingAutoplay` 就永远停在 `true`；此后用户手动点选**任意另一个**视频 → `loadVideo()` → 新文件 `onLoadedMetadata` 看到标志为真就 `play()`。同理切到 EXTERNAL_ONLY 格式时 `loadVideo` 跳过整个分支、标志却已污染下一次切换。修法：`onEnded` 同时记 `pendingAutoplayFor = props.filePath`，`loadVideo()` 开头按路径校验后立即清零；`onPause()` 里无条件清（`ended` 前 `pause` 先触发，不会误伤）。
  - ✅ **已实现（2026-10-13）**。**原提的修法（路径戳 + onPause 清零）不采纳** —— 路径校验根本拦不住：手动选的路径当然和刚播完那条不同，校验只会把「立刻播」变成「换一个照样播」。`onPause` 清零也救不了：`ended` 之后到下次 `loadVideo()` 之间并没有 pause 事件。
  - **病根是置位方向反了**：谁决定续播，谁就该置位。子组件 `onEnded` 单方面置真、父组件 `playNextVideo` 却可以拒绝 —— 这个 flag 天生泄漏，所有 bail 分支都会留下残留。改成**只有父组件 arm**（`autoplayGate.arm(p)`，放在 `previewFilePath` 赋值的紧前面），子组件只在 `loadVideo()` 开头 `claim()` 一次消费。
  - **消费点必须选在所有分支的共同入口**：`loadVideo()` 第一行，**在 `isExternalOnly` 提前 return 之前**。放在 `if (!isExternalOnly)` 里面的话，「下一条是 mkv」这条路径又会跳过消费、把标志留给下一次手动选择 —— 与之前 HEIC blob 那个教训同型。
  - `claim()` **无论是否命中都清空** armed。授权是一次性的：无法跨过一次加载存活。不这么做的话「置位了但没真换文件」（提前 return、加载失败）仍会残留。
  - **顺带补两个窗口**：① `await entryPath(next, dir)` 期间用户可能已关掉预览或切走，`playNextVideo` 在 await **之后**补了一次 `previewVisible/previewKind` 复核（await 前的快照在 await 后一律不可信）；② `closePreview()` 里 `arm(null)` —— 关闭会 unmount VideoPreview，`loadVideo()` 根本不会跑，授权永远等不到消费者，撤销必须做在**事件发生处**而非「状态不匹配时」。
  - **模块级单例** `src/autoplayGate.js`（与 `dragState.js` 同形态）：App 里两个 `<VideoPreview>` 由 `v-else-if` 互斥渲染，任意时刻只有一个存活，「下一次加载是不是续播」是进程内唯一一件事，做成单例免掉 App 侧拿组件 ref。同时导出 `createAutoplayGate()` 供测试注入。
  - **测试**：`scripts/autoplay-gate.test.mjs` 37 例，已挂进 `npm test`。覆盖 5 个 bail 分支各自不残留、健康状态必须授权（**反向断言，防止「修成永不自动播」也算过**）、授权一次性消费、路径精确匹配、`arm(''/null/undefined)` 不凭空授权、A→B→C 连续续播、重复 arm 覆盖。**变异测试三次全部被抓住**：`claim` 不清 armed → 3 例失败；`arm(null)` 不撤销 → 1 例失败；`claim` 忽略路径 → 3 例失败。
  - ⚠️ 第一版测试里 `BAILS` 循环断言的是**恒真的初始状态**（bail 函数没被真正调用、状态全是「有值」），13 例失败暴露后重写为「每个分支配对应状态 + 照抄 `playNextVideo` 判定链」。**断言前先确认前提成立，否则测的是空气。**
  - `npm run check` 全绿（lint 31 文件 + 203 例）、`vite build` exit 0（主 bundle 261.12 kB）。**待用户双击 `dev.bat` 实测**：① 播到列表最后一条 → 手动点另一个视频，确认它**不自动播放**；② 正常播完自动续播到下一条，确认**照旧自动播放**（别只测 bug 场景把功能改没了）；③ 视频播完后立刻按 Esc 关预览，再手动打开那个视频，确认不自动播。
