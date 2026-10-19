// 验证右键菜单的并发守卫（src/ctxMenuGate.js）。直接 `node scripts/ctx-menu-gate-check.mjs` 跑。
//
// 判据：断言必须在「去掉守卫」（恒返回 true）的实现下失败。全绿但抓不住
// 退化的测试等于没测试 —— 变异臂在文件末尾。
//
// 另含**静态断言**：守卫被 import、被调用、以及三个 await 之后都复核过。
// 纯逻辑断言管不了「走哪条路」—— 把 onCtxMenu 里的 `superseded()` 调用删掉，
// 下面所有行为断言仍然全绿（它们测的是 gate，不是 gate 有没有被用）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ctxMenuLands, createCtxGate } from "../src/ctxMenuGate.js";
import stripCommentsMod from "./stripComments.cjs";

const stripComments = stripCommentsMod.stripComments || stripCommentsMod;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

// ── ctxMenuLands：纯判据 ──

const DIR_A = "C:\\work\\a";
const DIR_B = "C:\\work\\b";
const t1 = { id: 1 };
const t2 = { id: 2 };

console.log("同一行右键：token 与目的地都没变 → 可落地");
{
  const r = ctxMenuLands({
    token: t1, current: t1, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  });
  check("首次右键可落地", r === true);
}

console.log("\nB 行右键先落地，A 的慢流程后到：必须作废（这就是原 bug）");
{
  const r = ctxMenuLands({
    token: t1, current: t2, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  });
  check("迟到的旧右键被作废", r === false);
  const newer = ctxMenuLands({
    token: t2, current: t2, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  });
  check("新右键自己可落地", newer === true);
}

console.log("\n等待期间面板导航走：菜单项会打到别的目录，必须作废");
{
  const r = ctxMenuLands({
    token: t1, current: t1, path: DIR_A, currentPath: DIR_B, tabId: 3, currentTabId: 3,
  });
  check("路径已变 → 作废", r === false);
}

console.log("\n等待期间切到另一个 tab（同一目录也会切）：必须作废");
{
  const r = ctxMenuLands({
    token: t1, current: t1, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 4,
  });
  check("tabId 已变 → 作废", r === false);
}

console.log("\nA→B→A 折返：判据是对象身份而非序号，谁都不落地的坑不存在");
{
  const a1 = {};
  const b = {};
  const a2 = {};
  // 第三次右键回到 A 行；第一个 A 的 token 已被换掉，必须作废（否则它会拿
  // 旧坐标覆盖 A2 的菜单），而 A2 必须能落地。
  check("首个 A 作废", ctxMenuLands({
    token: a1, current: a2, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  }) === false);
  check("中间的 B 作废", ctxMenuLands({
    token: b, current: a2, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  }) === false);
  check("最后一个 A 落地", ctxMenuLands({
    token: a2, current: a2, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  }) === true);
}

console.log("\nreset() 之后：仍在飞的构建全部作废");
{
  check("未 reset 时可落地", ctxMenuLands({
    token: t1, current: t1, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  }) === true);
  check("reset 后 current 为 null → 恒作废", ctxMenuLands({
    token: t1, current: null, path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3,
  }) === false);
}

// ── createCtxGate：行为 ──

console.log("\ncreateCtxGate：每次 begin 换掉 token");
{
  const g = createCtxGate();
  const ctx = { path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3 };
  const a = g.begin();
  check("刚 begin 就能落地", g.lands(a, ctx) === true);
  const b = g.begin();
  check("第二次 begin 后，第一个失效", g.lands(a, ctx) === false);
  check("第二个可落地", g.lands(b, ctx) === true);
  g.reset();
  check("reset 后第二个也失效", g.lands(b, ctx) === false);
  const c = g.begin();
  check("reset 不影响后续 begin", g.lands(c, ctx) === true);
  check("reset 前的 token 不会复活", g.lands(b, ctx) === false);
}

console.log("\ncreateCtxGate：同一个 token 不会自我作废（closeCtxMenu 的安全前提）");
{
  // handleCtxSelect 第一行就是 closeCtxMenu() → reset()。若 lands 对「刚
  // begin 的自己」也返回 false，整条右键流程永远弹不出菜单。这里钉住它。
  const g = createCtxGate();
  const ctx = { path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3 };
  const a = g.begin();
  for (let i = 0; i < 5; i += 1) {
    if (g.lands(a, ctx) !== true) {
      check(`第 ${i + 1} 次复核仍可落地`, false);
      break;
    }
    if (i === 4) check("连续 5 次复核都通过", true);
  }
}

console.log("\n两次右键并发：慢的第一个不能覆盖快的第二个");
{
  // 模拟 onCtxMenu 的交错：A 慢（探测数秒），B 快。
  const g = createCtxGate();
  const ctxA = { path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3 };
  const tokenA = g.begin();
  const tokenB = g.begin();
  const landed = [];
  if (g.lands(tokenB, ctxA)) landed.push("B");
  if (g.lands(tokenA, ctxA)) landed.push("A");
  check("只有 B 落地", landed.length === 1 && landed[0] === "B");
}

console.log("\n导航后旧构建作废，且新右键仍能弹菜单");
{
  const g = createCtxGate();
  const tokenA = g.begin();
  // 用户右键 A（探测要几秒）→ 期间按了 Backspace 导航到 B → 面板现在指向 B。
  const afterNav = { path: DIR_A, currentPath: DIR_B, tabId: 3, currentTabId: 3 };
  check("导航后 A 作废", g.lands(tokenA, afterNav) === false);
  // 然后用户在 B 目录重新右键：这次右键的起点就是 B，两边都是 B。
  const tokenB = g.begin();
  const atB = { path: DIR_B, currentPath: DIR_B, tabId: 3, currentTabId: 3 };
  check("导航后新右键可落地", g.lands(tokenB, atB) === true);
  // 旧 token 不会因为新右键而复活。
  check("旧 A 仍作废", g.lands(tokenA, atB) === false);
}

// ── 静态断言：守卫真的被用上了 ──
// 纯逻辑断言只管「判据对不对」，管不了「调用点有没有查」。
// 下面这组断言针对 FilePanel.vue 源码；先剥注释，免得注释里的符号名自己
// 把断言喂饱（见 scripts/stripComments.cjs 顶部）。

console.log("\n静态断言：FilePanel.vue 真的接上了守卫");
{
  const raw = fs.readFileSync(PANEL, "utf8");
  const code = stripComments(raw);

  check("import 了 createCtxGate", /import\s*\{[^}]*createCtxGate[^}]*\}\s*from\s*"\.\.\/ctxMenuGate\.js"/.test(code));
  check("创建了 gate 实例", /const\s+ctxGate\s*=\s*createCtxGate\(\)/.test(code));

  // onCtxMenu 的函数体：逐个 await 之后都必须复核。
  const start = code.indexOf("async function onCtxMenu(");
  check("找得到 onCtxMenu", start !== -1);
  const body = start === -1 ? "" : code.slice(start, code.indexOf("\nasync function handleCtxSelect(", start));
  const awaits = body.match(/\bawait\b/g) || [];
  // ensureArchiveTools / entryPath / isExecutable 三个 await
  check(`onCtxMenu 里有 3 个 await（实测 ${awaits.length}）`, awaits.length === 3);
  // 逐个 await 检查：紧跟其后的下一个 `if (...)` 必须是 superseded 复核。
  // 不能只数总数 —— 守卫全堆在最后一个 await 之后也会「看起来对」。
  const awaitIdxs = [];
  for (let i = body.indexOf("await"); i !== -1; i = body.indexOf("await", i + 1)) {
    awaitIdxs.push(i);
  }
  let allGuarded = true;
  for (const at of awaitIdxs) {
    // 取该 await 语句结束（分号）之后、下一个块中断点之前的片段。
    // ⚠️ 边界必须切在下一个 await / catch / finally，否则「catch 分支里的那次
    // 复核」会被算到前一个 await 头上 —— 实测正是这样漏掉了「删掉 isExecutable
    // 之后的复核」这个变异（catch 里本来就还有一次 if (superseded())）。
    const semi = body.indexOf(";", at);
    const stops = [
      body.indexOf("await", semi),
      body.indexOf("catch", semi),
      body.indexOf("finally", semi),
      body.length,
    ].filter((i) => i !== -1);
    const span = body.slice(semi + 1, Math.min(...stops));
    if (!/if \(superseded\(\)\) return;/.test(span)) allGuarded = false;
  }
  check(`每个 await 之后都有复核（${awaitIdxs.length} 个 await 逐个查）`, allGuarded);

  // 共享状态只在末尾一次性提交：ctxEntry / ctxIsExecutable / ctxMenu 的
  // 赋值必须全部位于最后一个 await 之后。
  const lastAwait = body.lastIndexOf("await");
  for (const [what, re] of [
    ["ctxEntry.value =", /ctxEntry\.value\s*=/],
    ["ctxIsExecutable.value =", /ctxIsExecutable\.value\s*=/],
    ["ctxMenu.value =", /ctxMenu\.value\s*=/],
  ]) {
    const at = body.search(re);
    check(`${what} 只在末尾提交一次`, at !== -1 && at > lastAwait);
  }

  // closeCtxMenu 必须 reset，否则用户在探测期间点掉遮罩后菜单还会再弹一次。
  const closeAt = code.indexOf("function closeCtxMenu(");
  const closeBody = closeAt === -1 ? "" : code.slice(closeAt, code.indexOf("\n}", closeAt));
  check("closeCtxMenu 调了 ctxGate.reset()", /ctxGate\.reset\(\)/.test(closeBody));

  // handleCtxSelect 必须用菜单快照的 path，而不是重读 activeTab。
  const selAt = code.indexOf("async function handleCtxSelect(");
  const selBody = selAt === -1 ? "" : code.slice(selAt, code.indexOf("\nasync function doRunAsAdmin", selAt));
  check("handleCtxSelect 用 ctxMenu.value.path 快照", /const\s+path\s*=\s*ctxMenu\.value\.path/.test(selBody));
  check(
    "handleCtxSelect 不再重读 activeTab.value?.path",
    !/const\s+path\s*=\s*activeTab\.value\?\.path/.test(selBody),
  );
  // 菜单 actions 必须把 path 透传下去，否则快照到了一半又被内部重读覆盖。
  for (const [action, callee] of [
    ["run-as-admin", "doRunAsAdmin(entry, path)"],
    ["extract", "doExtract(targets, item.tool, item.mode, path)"],
    ["add-to-archive", "doAddToArchive(path)"],
    ["new-folder", "doNewFolder(path)"],
    ["open", "onOpen(entry, path)"],
  ]) {
    check(`${action} 把 path 传给 ${callee}`, selBody.includes(callee));
  }
  check("进入目录也透传 path", selBody.includes("navigateInto(entry, path)"));

  // 每个 action 实现都必须真的用上形参，而不是 `basePath || activeTab…`
  // 之后又忽略它。
  for (const [fn, sig] of [
    ["doRunAsAdmin", "async function doRunAsAdmin(entry, basePath)"],
    ["doAddToArchive", "async function doAddToArchive(basePath)"],
    ["doExtract", "async function doExtract(targets, tool, mode, basePath)"],
    ["doNewFolder", "async function doNewFolder(basePath)"],
    ["onOpen", "async function onOpen(fileNameOrEntry, basePath)"],
    ["navigateInto", "async function navigateInto(entryOrName, basePath)"],
  ]) {
    const at = code.indexOf(sig);
    check(`${fn} 接受 basePath 形参`, at !== -1);
  }
  check(
    "doExtract 用 basePath 解析行（而非重读 activeTab）",
    /await entryPath\(entry, path\)/.test(code.slice(code.indexOf("async function doExtract("))),
  );
  check(
    "doRunAsAdmin 用 basePath 解析行",
    /await entryPath\(entry, basePath \|\| activeTab\.value\?\.path \|\| ""\)/.test(code),
  );
}

// ── 对照臂 ──
// 一个「彻底坏掉」的 harness 照样全绿，所以先证明这套断言抓得住退化：
// 把判据换成恒 true 的退化实现，同样这批场景必须全部失败。

console.log("\n对照臂：判据退化为恒 true 时必须崩");
{
  // 退化实现：无门卫，所有在飞构建都放行。
  const broken = () => ({
    begin: () => ({}),
    lands: () => true,
    reset: () => {},
  });

  // 每个场景是一段「操作序列 → 是否落地」。两个实现各跑一遍。
  // expected = 生产语义下这次右键该不该弹菜单。
  const scenarios = [
    {
      name: "迟到的旧右键",
      expected: false,
      run: (g, A, B) => g.lands(A, { path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3 }),
      setup: (g) => {
        const a = g.begin();
        g.begin(); // 用户又右键了一次
        return a;
      },
    },
    {
      name: "导航之后",
      expected: false,
      run: (g, A) => g.lands(A, { path: DIR_A, currentPath: DIR_B, tabId: 3, currentTabId: 3 }),
      setup: (g) => g.begin(),
    },
    {
      name: "切到另一个 tab",
      expected: false,
      run: (g, A) => g.lands(A, { path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 4 }),
      setup: (g) => g.begin(),
    },
    {
      name: "菜单被关掉后仍在飞的构建",
      expected: false,
      run: (g, A) => g.lands(A, { path: DIR_A, currentPath: DIR_A, tabId: 3, currentTabId: 3 }),
      setup: (g) => {
        const a = g.begin();
        g.reset();
        return a;
      },
    },
  ];

  let diverged = 0;
  for (const s of scenarios) {
    // setup 与 run 必须共用同一个 gate 实例 —— 否则 token 是另一份 gate 发的。
    const realGate = createCtxGate();
    const real = s.run(realGate, s.setup(realGate));
    const bGate = broken();
    const bad = s.run(bGate, s.setup(bGate));
    check(`生产实现下「${s.name}」判为${s.expected ? "落地" : "作废"}`, real === s.expected);
    if (real !== bad) diverged += 1;
    else console.log(`       （对照臂：退化实现给出同样的 ${bad}，该场景无分辨力）`);
  }
  check(
    `退化实现与生产实现在全部 ${scenarios.length} 个场景上相反（实测 ${diverged}/${scenarios.length}）`,
    diverged === scenarios.length,
  );
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);