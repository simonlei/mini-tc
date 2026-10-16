// 一次「删除」操作的目的地快照，以及它现在还能不能落地的判据。
//
// 背景：`FilePanel.onDelete` 逐项 `await`（进回收站 / 永久删除 / 提权重试，每项
// 都是一次 IPC 往返），一次几百项的删除能跑上好几秒。期间用户完全可以点进别的
// 目录、切标签、关掉标签 —— 而 `entries` 是**这个面板当前正在显示的那份列表**，
// 不是「删除发生时的那份列表」。
//
// 无条件落地的三个具体后果：
//   ① `entries.value = entries.value.filter(...)` 作用在新目录的行上：真正的删除
//      结果不反映到任何面板，而新目录的列表被换成了一个内容相同的副本（顺带丢掉
//      它的数组身份，FileList 的 entries watcher 会重置选中集）；
//   ② `emit("deleted", { remainingCount: entries.value.length })` 把**新目录**的条目
//      数当成这次删除的结果上报 —— 新目录恰好为空就关掉一个毫不相关的预览，非空
//      就让一个文件已被删掉的预览继续开着；
//   ③ 提权删除后的 2 秒延迟刷新里同一个错误再犯一次。
//
// 判据是「这个面板现在还指着这份列表吗」，不是请求序号 —— 与 `loadGate.js` /
// `previewRequest.js` 同一条思路：结果只服务于它被请求时的那个目的地。A→B→A 快速
// 折返回 A 时，迟到的删除**应该**落地（那些文件确实已经不在磁盘上了），所以这里
// 不能用序号模型。
//
// 纯逻辑，不碰 Vue / IPC，可直接 `node scripts/delete-scope-check.mjs` 跑。

/// 快照一份「这次删除瞄着的列表」。
///
/// `list` 必须在 await 之前取：`entries` 会被整体替换（不是原地 mutate），所以留一个
/// 数组引用就能保住删除发生时的那一份内容。
export function makeDeleteScope({ tabId, dir, list } = {}) {
  return {
    tabId: tabId === undefined || tabId === null ? null : tabId,
    dir: typeof dir === "string" ? dir : "",
    list: Array.isArray(list) ? list : [],
  };
}

/// 这个面板现在显示的还是这份列表吗 —— 即删除结果可以写进 `entries`。
///
/// tabId 与 dir 都得比：切标签但两个标签恰好开着同一个目录（Ctrl+T 克隆当前目录
/// 就是这样）是真实存在的，而那种情况下 `entries` 归属的确实是另一个 tab 的加载。
export function deleteScopeLands(scope, current) {
  if (!scope || !current) return false;
  // 快照里没有 tabId = 入口就没取到目标 tab，它描述的删除无从落地。
  if (scope.tabId === null || scope.tabId === undefined) return false;
  if (current.tabId === null || current.tabId === undefined) return false;
  return scope.tabId === current.tabId && scope.dir === current.dir;
}

/// 这份列表在删掉 `removed` 之后还剩几个条目。
///
/// 判据锚定**绝对路径**而不是 name：搜索结果页里同名是常态（十个不同目录下的
/// `report.zip` 同时列出），按 name 过滤会把另一个目录的行一并算成已删。
export function remainingAfterDelete(list, removed) {
  const set =
    removed instanceof Set
      ? removed
      : new Set(Array.isArray(removed) ? removed : []);
  const rows = Array.isArray(list) ? list : [];
  let n = 0;
  for (const e of rows) {
    if (!set.has(e && e.path)) n++;
  }
  return n;
}
