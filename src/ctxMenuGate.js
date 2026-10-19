// 右键菜单构建流程的并发守卫：一次右键的结果，只有当「用户要的还是这一行、
// 在这个目录」时才允许弹出菜单。
//
// 病根：`onCtxMenu` 在真正弹菜单之前要 await 两样东西 —— 压缩工具探测（首次要扫
// 盘，可能数秒）与后端的可执行性判定（IPC 往返）。这段时间里用户完全可以再右键
// 另一行，或者干脆把面板导航走。没有守卫时先发的旧流程会迟到落地：
//   ① `ctxIsExecutable` 被写成旧行的判定，而菜单已按新行弹出，于是「以管理员身份
//      运行」要么凭空消失，要么挂在一个其实跑不起来的行上；
//   ② 更糟的是整个 `ctxMenu` 被旧流程连同旧坐标一起覆盖，而 `ctxEntry` 早已
//      指向新行 —— 用户点「重命名」改的是另一个文件。这是静默的错误对象操作。
//
// 判据两条，都问「目的地还是不是它」，与 `loadGate.loadLands` 同款问法：
//   ① 意图身份：每次右键生成一个全新的对象 token 存进 `current`，只有 token 仍等于
//      它的那个流程能落地。用对象身份而不是自增序号，是因为本项目里序号已经被反复
//      证伪（`rerunSearch` 用 `Date.now() % 1000000`，16.7 分钟就循环）；对象身份
//      天然唯一，且 A→B→A 折返时第一个 A 的 token 已被第三次右键覆盖。
//   ② 目的地：那一行的绝对路径由「发起时的 tab + 其 path」拼出，等待期间面板一旦
//      导航走（或切到另一个 tab），菜单动作（打开/重命名/复制路径）就会打到别的
//      目录上。判「这个 tab 现在还指着这个路径吗」+「活动 tab 还是它吗」。
//
// ⚠️ 判据里故意没有「菜单是否已关闭」这一条。它看起来该有（用户点遮罩关掉菜单后
// 不该再弹出来），但 `handleCtxSelect` 的第一行就是 closeCtxMenu —— 把关闭算作
// 作废条件，正在派发的那一次点击会被自己作废。关闭语义由 `reset()` 单独承担：
// 它作废的是仍在飞的构建，与「结果能否落地」是两件事。

/**
 * @param {object} args
 * @param {object} args.token         本次右键生成的意图身份（唯一对象）
 * @param {object} args.current       当前登记在案的意图身份（更新的右键会换掉它）
 * @param {string} args.path          发起右键时活动 tab 的 path
 * @param {string} args.currentPath   await 之后活动 tab 的 path
 * @param {number} args.tabId         发起右键时的活动 tab id
 * @param {number} args.currentTabId  await 之后的活动 tab id
 * @returns {boolean} 本次右键的结果是否仍可弹出菜单
 */
export function ctxMenuLands({ token, current, path, currentPath, tabId, currentTabId }) {
  // A newer right-click replaced this one. Its menu items were computed for a
  // different row, so landing them here would show one row's menu at another
  // row's coordinates while acting on yet another row (ctxEntry has moved on).
  if (token !== current) return false;
  // The panel navigated away (or switched tabs) while we waited: `entryPath`
  // resolves against the *active* tab's path, so every menu action would be
  // aimed at the wrong directory.
  if (path !== currentPath) return false;
  if (tabId !== currentTabId) return false;
  return true;
}

/**
 * 意图登记处：每次右键调`begin()` 拿到一个独占 token 并登记；`lands()` 在每个
 * await 之后复核；`reset()` 作废所有在飞构建（菜单关闭 / 面板卸载时调）。
 *
 * 用法（FilePanel.vue 里就是这个形状）：
 *   const token = gate.begin();
 *   await something();
 *   if (!gate.lands(token, { path, currentPath, tabId, currentTabId })) return;
 */
export function createCtxGate() {
  let current = null;
  return {
    begin() {
      // A fresh object per right-click: identity is the whole point, so two
      // right-clicks can never collide the way two timestamps can.
      current = {};
      return current;
    },
    lands(token, ctx) {
      return ctxMenuLands({ ...ctx, token, current });
    },
    // Invalidate everything still in flight. Not the same as "close the menu":
    // this is about builds that have not produced a menu yet.
    reset() {
      current = null;
    },
  };
}