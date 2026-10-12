// 判定一次 `loadDirectory` 的结果能否落地，以及「Loading…」转圈由谁负责关闭。
//
// 曾经的落地判据是「给每次请求发一个序号，只有最新一次能落地」。那个模型是错的：
// 它和 `inFlightLoads` 的同-key 折叠互相打架 —— A→B→A 快速导航时，回到 A 的请求
// 因 key 命中被折叠（不落地），而 A 的首个请求又已被 B 的序号作废，结果**谁都不
// 落地**，面板卡在 B。比原 bug 更糟。
//
// 正确的判据是「这个 tab 现在还指着这个路径吗」：结果只服务于它被请求时的那个
// 目的地，目的地变了它就是垃圾。这与目录大小缓存用 per-tab path 戳、tabCache
// 读时校验 `cached.path === newPath` 是同一条思路。
//
// 转圈则相反：它**不能**按「await 后是否还是当前目录」来清。切到有缓存的 tab 时
// 走的是 silent 分支、根本不新建转圈，于是先前的请求一走，面板就永久停在
// 「Loading…」。所以归属必须记在发起方身上：谁点亮谁熄灭。
//
// 纯逻辑，不碰 Vue / IPC，可直接 `node scripts/load-gate.test.mjs` 跑。

/**
 * @param {object} args
 * @param {string} args.path            本次请求加载的路径
 * @param {object|undefined} args.tab   await 之后重新查到的 tab；undefined = 已关闭
 * @param {number} args.tabId
 * @param {number} args.activeTabId
 * @returns {{cache: boolean, ui: boolean}}
 *   cache — 是否写入 tabCache（该 tab 自己的数据，与是否可见无关）
 *   ui    — 是否写入 entries / hasParent / error（仅活动 tab）
 */
export function loadLands({ path, tab, tabId, activeTabId }) {
  // Tab closed while we were waiting: writing anything for it would resurrect
  // state for a tab that no longer exists (and leak a tabCache entry).
  if (!tab) return { cache: false, ui: false };
  // The tab has navigated elsewhere since this request went out — its result
  // describes a directory the user is no longer looking at. Dropping it also
  // keeps tabCache from being pinned to a stale path, which is what made a
  // later return to this tab serve a poisoned cache.
  if (tab.path !== path) return { cache: false, ui: false };
  return { cache: true, ui: tabId === activeTabId };
}

/**
 * 转圈归属：返回一个记录 owner 的可变容器。`claim` 由发起非 silent 加载的请求
 * 调用，`release` 在其 finally 里调用，返回 true 表示「该关闭转圈了」。
 *
 * 用法（FilePanel.vue 里就是这个形状）：
 *   const spin = createSpinner();
 *   if (isActive && !silent) { loading.value = true; spin.claim(key); }
 *   try { ... } finally { if (spin.release(key)) loading.value = false; }
 */
export function createSpinner() {
  let owner = null;
  return {
    claim(key) {
      owner = key;
    },
    // Only the request that raised the spinner may lower it. A newer request
    // overwrote the owner, and an older one finishing late must not hide the
    // "Loading…" belonging to whatever is loading now.
    release(key) {
      if (owner !== key) return false;
      owner = null;
      return true;
    },
    owner() {
      return owner;
    },
  };
}
