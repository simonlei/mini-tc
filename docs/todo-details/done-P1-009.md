# 修复：`VideoPreview.loadVideo()` 与 `detectSubtitles()` 无并发守卫 → 字幕串台

> 来源：`TODO-done.md` 第 330 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 9 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`VideoPreview.loadVideo()` 与 `detectSubtitles()` 无并发守卫 → 字幕串台** — 已修（2026-10-19）。新 `src/subtitleGate.js` + `scripts/subtitle-gate-check.mjs`（70 断言）+ `scripts/subtitle-gate-mutation.mjs`（**20/20 全抓**），均已挂 `npm test`。
  🚨 **TODO 原文的因果部分不成立，取证后重写**：原文说是「`onMounted` 与 watcher 各跑一次 `loadVideo`」。实测 `onMounted` 只在**首次挂载**时跑，而 watcher 是 `props.filePath` 变化时跑 —— 两者要撞上需要「挂载后立刻换文件」，不是常见路径。真正的触发路径是原文完全没提的另一半：`detectSubtitles` 在 `listDirectory` **之后**才读 `props.fileName`（原 529 行）→ **dir 取自旧文件、base 取自新文件**，「同名前缀」判定直接跨两个文件；再叠加 `addTrack` 无条件 `subtitleTracks.value.push(...)`，而新链已在链首清空过该数组 → **旧目录的字幕出现在新视频的下拉框里**。
  - **判据用「意图身份」而非「目的地」**（与 `loadGate` / `previewRequest` 相反，但这是对的）：字幕探测**没有 in-flight 折叠**（每次 `loadVideo()` 都真扫一遍目录），所以「序号/身份判据在 A→B→A 折返时让谁都不落地」这个坑在这里不存在 —— 折返时第一个 A 的链不落地是**正确的**（它会重复提交），第三个 A 的链落地。有折叠的是 `loadDirectory` 那几处，别把判据抄反。`begin()` 返回全新对象而非自增序号（`Date.now() % 1000000` 的教训）。
  - **`begin()` 无条件调用**，含 `isExternalOnly` 分支 —— 那些分支不探测字幕，但同样换了目的地，必须作废在飞探测。同 `autoplayGate.claim()` 的「消费点在所有分支的共同入口」。
  - **共享状态只在全部 await 之后一次性提交**：逐文件 push 会暴露「新数组已清空、旧链还在往里塞」的半更新中间态。`onFilePicked`（手工外挂字幕）虽不走探测链，也从 `push` 改成展开成新数组 —— `push` 会就地改动 `<select>` 正在渲染的数组。
  - **循环内在写 `loaded` 之前就查守卫**（不只是循环之后）：陈旧链继续累积是纯浪费。
  - `onMounted` 里 `await loadPlayerConfig()` 期间 `filePath` 可能已变，watcher 已为新文件跑过一次 —— 用同步捕获的 `mountedPath` 复核，避免两条链探测两个视频。
  - **对照臂实测暴露了原文的第二个错误**：旧实现在「切到 b」场景下的真实输出是 `b.srt(matched=true), a.en.srt(false), a.srt(false)` —— 它**从不按 base 过滤**，base 只用来算 `matched`。我第一版按「4 个字幕文件」写期望值，实测 3 个才对。**期望值必须实测，别凭猜。**
  - 🚨 **变异脚本踩了一次假阴性，且是新形态**：锚点里的 `\n` 对不上目标文件的 CRLF（`VideoPreview.vue` 实测 985/985 全 CRLF，`src/*.js` 是 LF）→ `count == 0`、文件没被改、套件全绿，被误读成「断言瞎」。修法：`mutate()` 按目标文件实际换行符归一化锚点。**METHODOLOGY 那条「anchor found 必须 assert == 1」救了这次**，否则这 3 个变异会静静溜过去。
  - ⚠️ **两次「存活变异」都是真盲区，不是等价变异**（逐个实测判别，别硬凑断言）：① 「排除目录」恒真 —— 测试数据里目录叫 `sub`，不带字幕扩展名，过滤器去掉也不改变输出 → 补一个 `video.srt`（**是目录**）；② 「matched 优先排序」恒真 —— 未命中项 `a2/AAA` 在纯码顺序与 localeCompare 下**巧合同序** → 补一组视频叫 `z.mp4`、未命中项叫 `A.srt` 的数据（纯码顺序下 `A` < `z`，只有 matched 分量才能救）。同理 `stemOf`/`extOf` 的长度判断也是补数据后才抓到的。
  - 其余套件全绿（`npm test` exit 0），`lint-imports` 39 文件通过。**待用户双击 `dev.sh` 实测**：找一个**同目录有多个视频、且每个各有 `.srt`** 的目录，选中视频 A 后**立刻**按 ↓ 切到视频 B —— B 的字幕下拉框里只应出现 B 相关的字幕，不含 A 的；再快速 ↓↓ 连切几个（构造多链在飞），最终只显示最后一个视频的字幕。
