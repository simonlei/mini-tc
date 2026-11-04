# 修复：`SearchDialog` 在 `onMounted` 的 `await listen()` 期间被卸载 → 三个监听器永久泄漏

> 来源：`TODO.md` 第 56 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 26 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`SearchDialog` 在 `onMounted` 的 `await listen()` 期间被卸载 → 三个监听器永久泄漏** — `SearchDialog.vue:550-581`。三句 `await` 串行，若在第一条兑现前关闭对话框（Alt+F7 连按 Esc 很容易），`onBeforeUnmount` 跑时变量还是 `null`、`?.()` 什么都不做；随后 promise 兑现把真正的 unlisten 赋给已销毁组件的变量，**再也不会被调用**。残留监听会持续对已销毁组件的 `hits` 做 `concat`，把整个闭包（连同最多 5000 条结果）钉在内存里。`App.vue:1846` 对同一场景有 `appUnmounted` 守卫，这里漏了。修法：照抄 App 的 `unmounted` 标志写法。
