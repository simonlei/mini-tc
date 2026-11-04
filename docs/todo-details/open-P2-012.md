# 收敛：配置持久化失败一律 `console.error`，用户完全无感

> 来源：`TODO.md` 第 79 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 12 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：配置持久化失败一律 `console.error`，用户完全无感** — `App.vue:419/662/873/943/1086`。面板宽度、主题、文本预览扩展名、剪贴板写入，任一失败只在 devtools 留一行：用户改了主题、重启后弹回旧主题，界面上没有任何提示。同理 `pasteFromClipboard` 的 `catch (e) { sys = null; }`（`1166-1170`）把 IPC 失败伪装成「剪贴板为空」，误导排查方向。修法：至少 `setTheme`/`onSettingsSave` 这类用户主动触发的写走 `showToast`。
