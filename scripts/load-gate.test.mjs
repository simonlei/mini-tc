// 验证 loadGate 的落地判定。直接 `node scripts/load-gate.test.mjs` 跑。
//
// 判据：每组断言都必须在「去掉守卫」或「换成序号模型」的实现下失败。
// 全绿但抓不住退化的测试等于没测试。

import { loadLands, createSpinner } from "../src/loadGate.js";

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

const TAB = 1;
const OTHER = 2;
// 模拟 tab 对象：path 会被导航改写
const tab = { id: TAB, path: "C:\\a" };

console.log("A→B→C 快速导航：旧目录结果不得覆盖新目录");
{
  // 请求 A 发出，await 期间 tab 已导航到 C
  check("A 的结果不落地（这就是原 bug）",
    loadLands({ path: "C:\\a", tab: { id: TAB, path: "C:\\c" }, tabId: TAB, activeTabId: TAB }).ui === false);
  // 导航尚未发生时，同一份结果本该落地
  check("未导航时 A 的结果可落地",
    loadLands({ path: "C:\\a", tab: { id: TAB, path: "C:\\a" }, tabId: TAB, activeTabId: TAB }).ui === true);
  // 最新的 C 一定要落地
  check("C 的结果可落地",
    loadLands({ path: "C:\\c", tab: { id: TAB, path: "C:\\c" }, tabId: TAB, activeTabId: TAB }).ui === true);
}

console.log("\nA→B→A 快速导航：不能谁都不落地（序号模型的回归用例）");
{
  // 首个 A 请求拖尾才回，此时 tab 已经回到 A —— 它必须落地，
  // 否则「回到 A」这个动作永远等不到内容。
  check("回到 A 后，迟到的 A 结果仍落地",
    loadLands({ path: "C:\\a", tab: { id: TAB, path: "C:\\a" }, tabId: TAB, activeTabId: TAB }).ui === true);
  // 中途那个 B 的结果必须被丢弃（tab 已不在 B）
  check("中途的 B 结果被丢弃",
    loadLands({ path: "C:\\b", tab: { id: TAB, path: "C:\\a" }, tabId: TAB, activeTabId: TAB }).ui === false);
}

console.log("\ntabCache 不能被钉死在陈旧路径");
{
  // 拖尾的 A 结果：既不写界面，也不该写缓存 —— 写进去会让下次回到该 tab
  // 命中一份 path 对不上的脏数据。
  const r = loadLands({ path: "C:\\a", tab: { id: TAB, path: "C:\\c" }, tabId: TAB, activeTabId: TAB });
  check("陈旧结果不写 tabCache", r.cache === false);
  check("陈旧结果不写界面", r.ui === false);
}

console.log("\n后台预热：不是活动 tab，但要写自己的缓存");
{
  const r = loadLands({ path: "C:\\x", tab: { id: OTHER, path: "C:\\x" }, tabId: OTHER, activeTabId: TAB });
  check("预热写缓存", r.cache === true);
  check("预热不写界面", r.ui === false);
}

console.log("\n切 tab 期间 in-flight 结果不得写进界面");
{
  // 请求在 tab1 还是活动 tab 时发出，await 期间用户切到了 tab2
  const r = loadLands({ path: "C:\\a", tab: { id: TAB, path: "C:\\a" }, tabId: TAB, activeTabId: OTHER });
  check("切走后不写界面", r.ui === false);
  check("切走后仍写自己的缓存", r.cache === true);
  check("同一结果在未切走时可落地",
    loadLands({ path: "C:\\a", tab: { id: TAB, path: "C:\\a" }, tabId: TAB, activeTabId: TAB }).ui === true);
}

console.log("\ntab 在 await 期间被关闭");
{
  const r = loadLands({ path: "C:\\a", tab: undefined, tabId: TAB, activeTabId: TAB });
  check("已关闭的 tab 不写界面", r.ui === false);
  check("已关闭的 tab 不写缓存（否则泄漏 tabCache 条目）", r.cache === false);
}

console.log("\n转圈归属：谁点亮谁熄灭");
{
  // 切到有缓存的 tab 走 silent 分支，不新建转圈。此时先前的请求必须仍然
  // 负责关掉它 —— 否则面板永久停在「Loading…」。
  const spin = createSpinner();
  spin.claim("1:C:\\a");
  check("无新转圈时，先前请求仍能关闭", spin.release("1:C:\\a") === true);
}
{
  // 同 tab 快速 A→B，两次都非 silent：B 抢走归属。
  const spin = createSpinner();
  spin.claim("1:C:\\a");
  spin.claim("1:C:\\b");
  check("A 先完成不得关闭 B 的转圈", spin.release("1:C:\\a") === false);
  check("B 完成才关闭转圈", spin.release("1:C:\\b") === true);
  check("归属已清空", spin.owner() === null);
  check("重复释放无效", spin.release("1:C:\\b") === false);
}
{
  // 反向完成顺序（B 先回）同样只有 B 能关。
  const spin = createSpinner();
  spin.claim("1:C:\\a");
  spin.claim("1:C:\\b");
  check("B 先完成关闭转圈", spin.release("1:C:\\b") === true);
  check("随后 A 完成不再重复关闭", spin.release("1:C:\\a") === false);
}
{
  // 两个 tab 并发：非活动 tab 的预热从不点亮，也不该熄灭别人的。
  const spin = createSpinner();
  spin.claim("1:C:\\a");
  check("无关 tab 的请求不能关闭转圈", spin.release("2:C:\\x") === false);
  check("真正的主人仍能关闭", spin.release("1:C:\\a") === true);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
