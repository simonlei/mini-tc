# 修复：`delete_to_trash` 把所有失败一律映射成 `permission_denied`，提权重试陷入必然失败循环

> 来源：`TODO.md` 第 37 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 12 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`delete_to_trash` 把所有失败一律映射成 `permission_denied`，提权重试陷入必然失败循环** — 现址 `lib.rs:1118-1142`（原 1104-1110 已漂移）。
  - ✅ 2026-10-19 取证：三个子项**全部成立，且前端行为比原文更糟**。(a) `1134` `trash::delete` 的**任何**错误都无条件映射为 `permission_denied`（`1137`），代码里没有任何 `no_recycle_bin`/`quota`/回收站满/卷不支持的区分；(b) `1119-1124` 注释把这说成有意为之；(c) `delete_permanently`（`1664-1694`）在 `1678` 无条件 `clear_readonly_recursive(p)`，`1680` 若失败直接走到 `1688` 返回 Err，**没有任何恢复只读属性的代码路径**；且 `clear_readonly_recursive`（`1550-1572`）是**整棵子树**递归，`1563` 的 `let _ =` 还吞掉 `set_permissions` 错误 → 不可逆的状态破坏且用户无任何提示。
  - 🚨 **三点原文没说清**：(1) `DeleteError.kind`（`1110-1116`）是 **`String` 不是枚举**，所谓「三态设计」只活在注释里、从未有类型保障 —— 全库不存在 `no_recycle_bin`/`quota` 字符串。准确表述是「`delete_to_trash` 退化成两态（`other` 不可达），而 `delete_permanently` 仍是三态」。(2) 注释里的理由（错误消息跨 OS 版本/locale 不稳定）指向的修法应该是**别依赖消息文本**（按错误类型或先探测卷是否支持回收站），而非现状。(3) **前端不是「永远弹『以管理员身份重试』」而是自动弹 UAC**：除 `not_found` 外**任何**失败都直接进 `failed` 数组并立即 `deleteWithAdmin`（`FilePanel.vue:1466-1479` → `1547-1552`），无需用户选择；批处理删除时是**每个失败项一次 UAC**。原文说「陷入必然失败循环」成立，但交互成本比它描述的更高。修法：补 `no_recycle_bin`/`quota` 档；只读属性改成「先试删，失败且确属 PermissionDenied 时才清属性重试」。
