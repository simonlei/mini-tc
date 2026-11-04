# 修复：`F2` 改名时输入字母变成「搜索」—— IME 合成开始时焦点被无条件抢到过滤框

> 2026-11-04 用户报告：「选中文件夹按 F2 修改文件名时，此时输入任何字母，都会变成搜索」
> 章节：P1 — 真 bug / 竞态 / 泄漏 / 明显性能

## 现象

在文件列表里选中一项，按 `F2` 进入改名态，改名框已获得焦点。此时敲任意一个字母：

- 字母没有进改名框，而是进了**隐藏的过滤输入框**（`v-model="searchQuery"` 绑着它），
  于是列表开始按这个字母过滤 —— 用户看到的就是「一打字就变成搜索」；
- 改名框同时**失焦消失**（`onRenameBlur` → `commitRename`），并且 `renameValue`
  里还留着合成的拼音残片，存在把文件真的改成半个拼音的风险。

## 根因（实测复现，不是照注释推理）

`src/components/FileList.vue` 的 `onCompositionStart` 被绑在**三个**地方：
列表容器（`FileList.vue:11`）、过滤输入框（`65`）、**改名输入框**（`132`）。

而它的实现是「焦点不在搜索框 → 把焦点抢到搜索框」：

```js
function onCompositionStart() {
  if (searchInput.value && document.activeElement !== searchInput.value) {
    searchInput.value.focus();
  }
}
```

中文输入法下每敲一个字母都会启动一次合成 → `compositionstart` 在改名框上触发 →
`document.activeElement` 是改名框、不是搜索框 → 焦点被抢走。

复现脚本（已删，从 `FileList.vue` **抽取真实的 `onCompositionStart` 源码**在 jsdom 里跑，
不复制逻辑）实测：

```
初始焦点： rename-input
搜索框 focus() 调用次数： 1
合成后焦点： search-input
>>> BUG 复现：焦点被抢到搜索框 → 字母进「过滤」，改名框失焦关闭
```

⚠️ **判据用错了**：这个 handler 的**原意**是「合成起点是列表 div（存不住字）→
把焦点交给过滤框」，注释也这么写。但实现用的是「焦点现在在不在搜索框」——
两者在「合成起点是输入框」时结论相反，而那正是改名的场景。

## 修法

判据从「焦点现在在不在搜索框」换成「**合成从哪儿开始的**」：

- 合成起点是能存文字的元素（改名框 / 过滤框 / 任何 input）→ 焦点原地不动；
- 合成起点是列表 div 自己（存不住字）→ 才把焦点交给过滤框（原功能保住）。

判据函数放在 `src/keyboardText.js`（plain node 可加载，组件与测试共用同一份 ——
留在 `.vue` 里只能复制进测试，等于测自己的副本）：

```js
export function compositionFocusTarget(target, searchElement, activeElement) {
  if (isTypingTarget(target)) return null;      // 起点能存字 → 焦点不动
  if (!searchElement) return null;               // 没地方可去 → 不动
  if (activeElement === searchElement) return null; // 已经在那儿 → 不用动
  return searchElement;
}
```

`FileList.vue` 的调用点改成传事件对象：

```js
function onCompositionStart(e) {
  const target = compositionFocusTarget(e && e.target, searchInput.value, document.activeElement);
  if (target) target.focus();
}
```

## 测试

`scripts/composition-focus-check.mjs`（**33 断言** + **6/6 变异全抓**），挂 `npm test`。

四层：

1. **纯逻辑**：import 生产 `compositionFocusTarget`，跑真值表（含对照臂：旧判据在
   「改名框里合成」时确实会抢焦点 → 新判据有分辨力）。
2. **端到端**：从 `FileList.vue` **抽取真实的 `onCompositionStart` 源码**在 jsdom 里跑
   （改实现不改调用点时纯逻辑断言会全绿，这一层才 FAIL）。
3. **静态断言**：落地点真的调了生产判据；旧的无条件抢焦点的写法已消失；三个
   `@compositionstart` 绑定点都还在（否则搜索功能整体坏掉）。
4. **变异臂**：6 个变异全部被抓。

### 踩到的两个坑

- 🚨 **jsdom 吞掉事件监听器里的异常**：只报进 `virtualConsole`，**进程退出码仍是 0**。
  所以「调用方漏了判空 → 对 null 调 focus → 崩」这个变异在默认配置下**测不出来**
  （焦点没变，断言照样绿）。实测确认过：`dispatchEvent` 正常返回、脚本跑到末尾、`exit=0`。
  → 用 `VirtualConsole` 的 `jsdomError` 事件把异常接出来，「崩了」才成为可断言的事实。
- ⚠️ **一个变异是等价变异，如实记录而不是硬凑断言**：原拟的「删掉生产判据的
  `if (!searchElement) return null;`」实测 0 FAIL —— 因为删掉后走到
  `return searchElement`，而 `searchElement` 本来就是 `null`，结果一模一样。
  按 METHODOLOGY「0 FAIL 先判等价变异还是测试盲区」，换成真盲点
  （调用方去掉判空 → 崩 → 被 `jsdomError` 断言抓到）。

## 待用户实测

`npm run check` exit 0（`lint:imports` + `sfc-check` + 全套件）。**待双击 `dev.sh`**：

1. 选中一个文件/文件夹按 `F2`，用中文输入法打几个字 → 文字应留在改名框里，
   列表**不**应开始过滤，改名框也**不**应消失；
2. 回车提交 → 名字应被改成输入的中文；
3. 回归原功能：直接点列表空白处（焦点在列表 div 上）用中文输入法打字 →
   文字仍应进过滤框（这是 `onCompositionStart` 原本要保的行为）。
