# 收敛：`videoPreviewAlwaysOnTop` 的默认值在 App.vue 与 GeneralSettingsDialog 各存一份，仅靠注释约束同步

> 来源：`TODO.md` 第 87 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 20 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`videoPreviewAlwaysOnTop` 的默认值在 App.vue 与 GeneralSettingsDialog 各存一份，仅靠注释约束同步** — `App.vue:330` vs `GeneralSettingsDialog.vue:78-84`。注释自己承认「Default MUST mirror the schema default」，靠一个注释维持一致。修法：由 `GeneralSettingsDialog` 导出 `DEFAULTS`，App.vue 改为 `ref({ ...DEFAULTS })`。
