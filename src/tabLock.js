// 标签页锁定的动作判定（纯逻辑，组件与测试共用同一份）。
//
// 背景：TabBar 的右键菜单里，「回到锁定位置」跳的是**被右击的那个标签页**。
// 但一个面板一次只显示一个标签页，于是后台标签页跳回去了、屏幕上纹丝不动 ——
// 用户看着就是「无效」。这不是错觉，是真的什么都没发生：
//   ① 目录确实变了（tab.path 改了），但显示的还是原来那个活动标签页；
//   ② 触发重读的 watcher 只盯着**活动**标签页的 path，后台 tab 变了它不看。
//
// 所以这个判定要回答两件事：
//   kind   — 跳不跳（跳过去是什么结果：没锁 / 已在锁定位置 / 真跳）
//   follow — 面板要不要跟到那个标签页去（跳的是后台标签页时必须跟，
//            否则「跳回去了」和「什么都没发生」在用户眼里完全一样）
//
// 放在 plain node 可加载的模块里（而不是留在 .vue 里），组件与测试才能共用
// 同一份实现 —— 复制进测试等于测自己的副本。

export const LOCK_JUMP_NONE = "none"; // 找不到这个标签页
export const LOCK_JUMP_UNLOCKED = "unlocked"; // 这个标签页没锁
export const LOCK_JUMP_SAME = "same"; // 已经在锁定位置，路径不用动
export const LOCK_JUMP_OK = "ok"; // 真跳

/**
 * 判定「回到锁定位置」这个动作的结果。
 *
 * @param {object} args
 * @param {object|null} args.tab         目标标签页（null = 找不到）
 * @param {number} args.targetTabId       被右击（要跳）的标签页 id
 * @param {number} args.activeTabId       面板当前正在显示的标签页 id
 * @returns {{kind: string, path: string, follow: boolean}}
 *   kind   — LOCK_JUMP_* 之一
 *   path   — 跳过去以后的位置（kind !== LOCK_JUMP_OK 时为空串）
 *   follow — 面板要不要切到该标签页（跳的是后台标签页时才切）
 */
export function planLockedJump({
  tab = null,
  targetTabId = 0,
  activeTabId = 0,
} = {}) {
  if (!tab) {
    return { kind: LOCK_JUMP_NONE, path: "", follow: false };
  }
  const lockedPath = tab.lockedPath || "";
  if (!lockedPath) {
    return { kind: LOCK_JUMP_UNLOCKED, path: "", follow: false };
  }
  // 跳后台标签页时，面板必须跟过去 —— 这是整个判定的关键：
  // 跟不过去，用户看到的和「点了没反应」一模一样。
  // （与右键菜单里「重新搜索」同一条规则：动作落在哪个标签页，
  //   面板就跟到哪个标签页去。）
  const follow = targetTabId !== activeTabId;
  const currentPath = tab.path || "";
  if (lockedPath === currentPath) {
    // 已经在锁定位置：路径不用改，但面板仍可能停在别的标签页上，
    // 那样这次点击同样「看不见」——所以照样要跟过去。
    return { kind: LOCK_JUMP_SAME, path: lockedPath, follow };
  }
  return { kind: LOCK_JUMP_OK, path: lockedPath, follow };
}
