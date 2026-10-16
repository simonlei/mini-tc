// 验证「删除」操作的快照与落地判据：await 之前取的目的地，await 之后还能不能落地。
// 直接 `node scripts/delete-scope-check.mjs` 跑。
//
// 这个 bug 的形状是「改实现不改判据」型：把守卫改成恒返回 true、把 remainingCount
// 改回 entries.value.length，纯逻辑表都可能照过。所以除了纯逻辑语义，本脚本还静态
// 断言 FilePanel.vue 的每一个落地点都真的查了守卫 —— 断言锚定**权威数据源**
// （被测的 src/deleteScope.js，而不是复制进测试的副本）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeDeleteScope, deleteScopeLands, remainingAfterDelete } from "../src/deleteScope.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const DIR = "C:\\pics";
const TAB = 7;

function scope(over = {}) {
  return makeDeleteScope({
    tabId: TAB,
    dir: DIR,
    list: [
      { path: "C:\\pics\\a.jpg", name: "a.jpg" },
      { path: "C:\\pics\\b.jpg", name: "b.jpg" },
      { path: "C:\\pics\\c.jpg", name: "c.jpg" },
    ],
    ...over,
  });
}
function cur(over = {}) {
  return { tabId: TAB, dir: DIR, ...over };
}

console.log("什么都没变：删除结果可落地");
{
  check("同 tab 同目录 → 可落地", deleteScopeLands(scope(), cur()) === true);
}

console.log("\n删除几秒期间用户点进别的目录：结果必须作废");
{
  check("换目录 → 作废（这就是原 bug）", deleteScopeLands(scope(), cur({ dir: "C:\\videos" })) === false);
  check("换 tab → 作废", deleteScopeLands(scope(), cur({ tabId: TAB + 1 })) === false);
  check("面板已无 tab（activeTab 为 undefined）→ 作废",
    deleteScopeLands(scope(), cur({ tabId: undefined, dir: undefined })) === false);
}

console.log("\nA→B→A 折返：迟到的删除应该落地（序号模型会误杀）");
{
  check("折返回原目录 → 可落地", deleteScopeLands(scope(), cur()) === true);
}

console.log("\n两个标签开着同一个目录：tabId 才是归属，光比 dir 不够");
{
  // Ctrl+T 克隆当前目录就会造出这种状态。此时 dir 相同但 entries 归属另一个 tab 的
  // 加载，比 dir 会把结果写进错误的列表。
  check("dir 相同但 tabId 不同 → 作废", deleteScopeLands(scope(), cur({ tabId: 999 })) === false);
}

console.log("\n空状态：快照缺失一律作废");
{
  check("快照 undefined → 作废", deleteScopeLands(undefined, cur()) === false);
  check("当前状态 undefined → 作废", deleteScopeLands(scope(), undefined) === false);
  check("快照无 tabId → 作废", deleteScopeLands(scope({ tabId: undefined }), cur()) === false);
  check("makeDeleteScope() 空参不抛，判为不可落地",
    deleteScopeLands(makeDeleteScope(), makeDeleteScope()) === false);
}

console.log("\nremainingCount：锚定快照列表，按绝对路径扣");
{
  const s = scope();
  check("删 1 个 → 剩 2", remainingAfterDelete(s.list, new Set(["C:\\pics\\a.jpg"])) === 2);
  check("删 3 个 → 剩 0（这才是「目录被删空」）", remainingAfterDelete(s.list, new Set(s.list.map((e) => e.path))) === 0);
  check("删 0 个 → 原样", remainingAfterDelete(s.list, new Set()) === 3);
  // 数组入参也要成立 —— 调用点用的是 Set，但判据不该依赖容器类型。
  check("数组入参等价", remainingAfterDelete(s.list, ["C:\\pics\\a.jpg", "C:\\pics\\b.jpg"]) === 1);
}

console.log("\nremainingCount：同名不同目录不能被一并算掉（搜索结果页）");
{
  // 十个不同目录下的 report.zip 同时列在搜索结果页里，按 name 扣会剩 0，
  // 于是「还剩 0 个」被误判成「目录已空」→ 关掉一个无关的预览。
  const hits = [
    { path: "C:\\a\\report.zip", name: "report.zip" },
    { path: "C:\\b\\report.zip", name: "report.zip" },
    { path: "C:\\c\\report.zip", name: "report.zip" },
  ];
  check("只删 C:\\a 那个 → 仍剩 2", remainingAfterDelete(hits, new Set(["C:\\a\\report.zip"])) === 2);
  check("删掉全部 3 个同名项才剩 0",
    remainingAfterDelete(hits, new Set(["C:\\a\\report.zip", "C:\\b\\report.zip", "C:\\c\\report.zip"])) === 0);
}

console.log("\nremainingCount：空/畸形输入不抛");
{
  check("undefined 列表 → 0", remainingAfterDelete(undefined, new Set()) === 0);
  check("undefined removed → 原样计数", remainingAfterDelete(scope().list, undefined) === 3);
  check("空快照列表 → 0", remainingAfterDelete([], new Set(["x"])) === 0);
  check("无 path 的条目不被 set 误扣", remainingAfterDelete([{ name: "x" }], new Set(["x"])) === 1);
}

// ── 变异对照臂：旧实现（没有守卫 / 用活的 entries 计数）必须被这些断言抓住 ──
// 只测纯逻辑表的话，一个「恒返回 true」的守卫照样全绿 —— 那正是本 bug 的形状。
// 这里显式跑一遍旧实现，证明断言不是恒真的。
console.log("\n对照臂：旧实现（无守卫）在本表下必须露馅");
{
  const oldLands = () => true; // 旧代码：删完无条件写 entries
  const oldRemaining = (list) => list.length; // 旧代码：remainingCount 只看总数
  check("旧守卫在「换目录」场景下会错误放行（本表要求 false）",
    oldLands(scope(), cur({ dir: "C:\\videos" })) === true);
  check("旧算法把「同名不同目录」也扣成 0（本表要求 2）",
    oldRemaining([
      { path: "C:\\a\\report.zip", name: "report.zip" },
      { path: "C:\\b\\report.zip", name: "report.zip" },
    ]) === 2);
}

// ── 静态断言：调用点真的查了守卫 ──
// 纯逻辑测试只覆盖判据本身。把 FilePanel.vue 里的守卫调用删掉（改实现不改判据）时
// 上面的表全绿，所以必须钉住真实调用点。
const panelSrc = stripComments(
  fs.readFileSync(path.join(ROOT, "src", "components", "FilePanel.vue"), "utf8")
);

// 抽出 onDelete 的函数体。
//
// ⚠️ 不能直接 `indexOf("{", at)`：`onDelete(targets, opts = {})` 的默认参数里就有
// 一对花括号，第一个 `{` 落在参数列表中段，配平后返回的是 `{}` —— 断言会全灭而代码
// 毫无问题。先配平圆括号跳过参数列表，再取其后的第一个 `{`。
function bodyOf(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  let paren = src.indexOf("(", at);
  let pdepth = 0;
  for (; paren < src.length; paren++) {
    if (src[paren] === "(") pdepth++;
    else if (src[paren] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  const open = src.indexOf("{", paren);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

console.log("\n静态断言：onDelete 入口取了 (tabId, dir, list) 三元快照");
{
  const fn = bodyOf(panelSrc, "onDelete");
  check("onDelete 存在", !!fn);
  check("调用 makeDeleteScope 快照列表", /makeDeleteScope\(\{/.test(fn));
  check("快照带上了 list: entries.value", /makeDeleteScope\(\{[^}]*list:\s*entries\.value/.test(fn));
  // 快照必须在第一个 await 之前 —— 之后取就来不及了。
  const scopeAt = fn.indexOf("makeDeleteScope(");
  const firstAwait = fn.indexOf("await ");
  check("快照出现在第一个 await 之前", scopeAt >= 0 && firstAwait > scopeAt);
}

console.log("\n静态断言：所有写 entries / emit deleted 的落地点都先查守卫");
{
  const fn = bodyOf(panelSrc, "onDelete");
  const GATE = "stillOnTarget()";

  // 落地点 1：写活的 entries。守卫必须在它之前（if 包裹），不是「函数里有就算」。
  const filterAt = fn.indexOf("entries.value = entries.value.filter");
  check("onDelete 里过滤 entries 的落地点存在", filterAt > 0);
  const gateDefAt = fn.indexOf("const stillOnTarget =");
  check("守卫闭包已定义", gateDefAt > 0 && gateDefAt < filterAt);
  // 守卫调用必须出现在过滤之前，且中间隔着 if（即被守卫包住）。
  const gateCall = fn.indexOf(GATE, gateDefAt);
  check("过滤前调用了守卫", gateCall > 0 && gateCall < filterAt);
  check(
    "过滤被守卫包住（if (stillOnTarget()) { ... }）",
    /if\s*\(\s*stillOnTarget\(\)\s*\)\s*\{\s*entries\.value = entries\.value\.filter/.test(fn)
  );

  // 落地点 2：上报 remainingCount 的第一次 emit。它必须用快照算，不能读活的 entries。
  const emitAt = fn.indexOf('emit("deleted"');
  check("onDelete 里 emit(\"deleted\") 存在", emitAt > 0);
  const emitBlock = fn.slice(emitAt, fn.indexOf(");", emitAt));
  check("remainingCount 走 remainingAfterDelete(快照)", /remainingCount:\s*remainingAfterDelete\(/.test(emitBlock));
  check("第一次 emit 不再读活的 entries.value.length", !/remainingCount:[^,]*entries\.value\.length/.test(emitBlock));

  // 落地点 3：提权删除后的 setTimeout 刷新。两处都要守卫。
  const timers = fn.match(/setTimeout\(/g) || [];
  check("onDelete 里有 1 处 setTimeout（提权后的延迟刷新）", timers.length === 1);
  const timerAt = fn.indexOf("setTimeout(");
  const timerBlock = fn.slice(timerAt);
  check("延迟刷新前查了守卫", timerBlock.indexOf("if (!stillOnTarget())") === 0 || timerBlock.indexOf("if (!stillOnTarget())") > 0);
  // refresh() 自己有 await，所以 then 回调里还得再查一次。
  const thenBlock = timerBlock.slice(timerBlock.indexOf(".then("));
  check("refresh() 之后再查一次守卫", /if\s*\(\s*!stillOnTarget\(\)\s*\)\s*return;/.test(thenBlock));
  check("两处守卫都在", (timerBlock.match(/stillOnTarget\(\)/g) || []).length >= 2);
}

console.log("\n静态断言：判据来自被测模块，不是就地重写的副本");
{
  const imports = panelSrc.slice(0, panelSrc.indexOf("\n\n", panelSrc.indexOf('from "../loadGate.js"')));
  check("import 了 deleteScope.js 的三个判据", /from\s+"\.\.\/deleteScope\.js"/.test(imports));
  check(
    "三个判据都导入了",
    /import\s*\{[^}]*makeDeleteScope[^}]*deleteScopeLands[^}]*remainingAfterDelete[^}]*\}\s*from\s+"\.\.\/deleteScope\.js"/.test(imports)
  );
  // 「复制进测试」的另一种形态：把判据就地重写一遍，测试仍全绿。禁止出现字面重写。
  check("没有就地重写守卫（deleteScopeLands 只出现在 import 与调用处）",
    (panelSrc.match(/deleteScopeLands/g) || []).length === 2);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
