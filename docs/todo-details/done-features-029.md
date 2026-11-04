# 修：splash 在加载完成后仍白等约 160ms（MIN_SHOW 计时起点错了）

> 来源：`TODO-done.md` 第 67 行 · 章节 已实现功能（想法暂存区） · 第 29 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修：splash 在加载完成后仍白等约 160ms（MIN_SHOW 计时起点错了）** — 用户指出「splash 应该尽早展示、其余事情并行做，而不是加载完成后还硬撑一段时间」，方向完全正确，启动 log 随即证实确有 bug。**根因**：`splashShownAt = performance.now()` 写在 `src/main.js`，而 splash 是 `index.html` 里的**静态元素**、43.3ms 就已绘制，**模块求值要到 431.5ms 才结束**（Δ 388ms）—— 计时起点因此晚约 390ms，于是 MIN_SHOW 变成「在已经显示了 590ms 的 splash 上再强加 250ms」。实测：`panel:*:first-listing` 533.4ms 就绪（**app 已可用**），`splash:fade-start` 却到 690.7ms（**迟 157ms**），`splash:removed` 971ms 用户才看到界面。**修法**：`index.html` 内联脚本（与 `__MINITC_BOOT_MARKS__` 同处，即 `html:parsed` 那一刻）导出 `window.__MINITC_SPLASH_SHOWN_AT__`，`main.js` 读它（带 `?? performance.now()` 兜底）。判定逻辑本就是 `elapsed >= MIN_SHOW && panelsListed >= PANEL_COUNT`（`&&`，两者互不等待），修起点即够，**不改结构**。**附带**：埋点 note 从 `waited=…ms`（splash 总显示时长，**不是延迟**，拿来调参会误导）改为 `shown=…ms panels=N after-ready=…ms`，其中 `after-ready` = 数据就绪后还盯多久，**应恒为 0**，这才是调参依据。**教训**：「防闪烁下限」这类时间常量，起点必须是**用户看到该元素的时刻**，绝不是「写这行代码的时刻」—— 在有模块求值延迟的应用里两者差着几百毫秒。
  - 当前 JS 侧时间线（dev，供后续定位）：`html:parsed` 43 → `main.js:eval` 431（**Δ 388ms，最大单项，dev 未打包**）→ 两栏 onMounted 476 → vue:mounted 478 → 配置读 ~14ms → `first-listing` 530/533 → 淡出 → 界面可见。**下一目标应是 `main.js:eval` 的 388ms**（模块求值，占整条时间线 42%），而不是继续抠splash 常量。
