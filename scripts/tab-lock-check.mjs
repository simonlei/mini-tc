// 验证「回到锁定位置」在**后台标签页**上真的生效（2026-11 修复）。
//
// 直接 `node scripts/tab-lock-check.mjs` 跑。
//
// ── 这个 bug 的形状 ────────────────────────────────────────────────
// 标签页右键菜单的「回到锁定位置」跳的是**被右击的那个标签页**，但一个面板
// 一次只显示一个标签页。于是：
//   ① 目录确实变了（tab.path 改了），但屏幕上的列表纹丝不动；
//   ② 触发重读的 watcher 只盯着**活动**标签页的 path，后台 tab 变了它不看。
// → 用户点完什么都没发生 =「回到锁定位置无效」。
//
// 🚨 关键教训（2026-11-04 同款）：**只断言 tab.path 会全绿**。数据层确实
// 变了，变的正是「无效」这个 bug 的核心。下面第 3 层断言的是**用户可见的
// 面板内容**（面包屑 + 文件行），不是内部状态。
//
// ── 四层断言 ───────────────────────────────────────────────────────
//   1. 纯逻辑：import 生产 `planLockedJump`（src/tabLock.js），跑真值表。
//   2. 对照臂：一个「不跟随」的退化实现，在同一批场景下必须给出不同答案。
//   3. 端到端：真挂载 FilePanel + TabBar + ContextMenu（jsdom），右击一个
//      **后台**锁定标签页 → 点「回到锁定位置」→ 断言面板真的换了目录。
//   4. 静态断言：落地点真的调了生产判据、真的切了活动标签页。
//
// 变异臂在 scripts/tab-lock-mutation.mjs。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import mod from "./stripComments.cjs";
import {
  planLockedJump,
  LOCK_JUMP_NONE,
  LOCK_JUMP_UNLOCKED,
  LOCK_JUMP_SAME,
  LOCK_JUMP_OK,
} from "../src/tabLock.js";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const LOCK = path.join(ROOT, "src", "tabLock.js");

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    if (detail) for (const d of detail) console.log(`         ${d}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

// ══════════════ 1. 纯逻辑（import 生产判据）══════════════

section("1. planLockedJump 真值表（import 生产 src/tabLock.js）");

const DIR_A = "D:\\BaiduNetdiskDownload";
const DIR_B = "D:\\BaiduNetdiskDownload\\子目录";

{
  const r = planLockedJump({ tab: null, targetTabId: 1, activeTabId: 1 });
  check("没有这个标签页 → none", r.kind === LOCK_JUMP_NONE);
  check("没有这个标签页 → 不跟随", r.follow === false);
}
{
  const r = planLockedJump({ tab: { path: DIR_A, lockedPath: "" }, targetTabId: 1, activeTabId: 1 });
  check("没锁 → unlocked", r.kind === LOCK_JUMP_UNLOCKED);
  check("没锁 → 不跟随", r.follow === false);
}
{
  const r = planLockedJump({ tab: { path: DIR_A, lockedPath: DIR_A }, targetTabId: 1, activeTabId: 1 });
  check("已在锁定位置 → same", r.kind === LOCK_JUMP_SAME);
  check("已在锁定位置 → 活动标签页不跟随", r.follow === false);
}
{
  const r = planLockedJump({ tab: { path: DIR_B, lockedPath: DIR_A }, targetTabId: 1, activeTabId: 1 });
  check("目录不同 → ok", r.kind === LOCK_JUMP_OK);
  check("ok → 目标是锁定位置", r.path === DIR_A);
  check("ok → 活动标签页不跟随（已经在显示它了）", r.follow === false);
}
{
  // 这条是本次修复的核心：跳的是**后台**标签页 → 面板必须跟过去。
  const r = planLockedJump({ tab: { path: DIR_B, lockedPath: DIR_A }, targetTabId: 2, activeTabId: 1 });
  check("跳后台标签页 → ok", r.kind === LOCK_JUMP_OK);
  check("跳后台标签页 → 面板必须跟随（否则用户看不到任何变化）", r.follow === true);
}
{
  const r = planLockedJump({ tab: { path: DIR_A, lockedPath: DIR_A }, targetTabId: 2, activeTabId: 1 });
  check("后台标签页已在锁定位置 → same", r.kind === LOCK_JUMP_SAME);
  check("后台标签页已在锁定位置 → 仍然跟随（切过去让用户看见那个位置）", r.follow === true);
}
{
  // 活动标签页与后台标签页的差别必须只由 id 决定，不能由 path 决定。
  const tab = { path: DIR_B, lockedPath: DIR_A };
  const asActive = planLockedJump({ tab, targetTabId: 1, activeTabId: 1 });
  const asBackground = planLockedJump({ tab, targetTabId: 1, activeTabId: 2 });
  check("同一个 tab：作为活动页 follow=false，作为后台页 follow=true", asActive.follow === false && asBackground.follow === true);
}

// ══════════════ 2. 对照臂 ══════════════

section("2. 对照臂 —— 退化实现（不跟随）必须给出不同答案");

{
  // 退化实现：只改路径，永远不切活动标签页 —— 也就是修复前的行为。
  const broken = ({ tab, targetTabId, activeTabId }) => {
    if (!tab) return { kind: LOCK_JUMP_NONE, path: "", follow: false };
    const lockedPath = tab.lockedPath || "";
    if (!lockedPath) return { kind: LOCK_JUMP_UNLOCKED, path: "", follow: false };
    if (lockedPath === (tab.path || "")) return { kind: LOCK_JUMP_SAME, path: lockedPath, follow: false };
    return { kind: LOCK_JUMP_OK, path: lockedPath, follow: false };
  };
  const scenarios = [
    { name: "跳后台标签页", tab: { path: DIR_B, lockedPath: DIR_A }, targetTabId: 2, activeTabId: 1 },
    { name: "后台标签页已在锁定位置", tab: { path: DIR_A, lockedPath: DIR_A }, targetTabId: 2, activeTabId: 1 },
  ];
  let diverged = 0;
  for (const s of scenarios) {
    const real = planLockedJump(s);
    const bad = broken(s);
    if (real.follow !== bad.follow) diverged += 1;
    else console.log(`       （对照臂：退化实现在「${s.name}」上答案相同，无分辨力）`);
  }
  check(
    `退化实现在全部 ${scenarios.length} 个场景上与生产实现相反（实测 ${diverged}/${scenarios.length}）`,
    diverged === scenarios.length
  );
}

// ══════════════ 3. 端到端（真挂载组件，断言用户可见的面板）══════════════

section("3. 端到端：右击后台锁定标签页 → 回到锁定位置 → 面板真的换目录");

// ── jsdom 环境 ──────────────────────────────────────────────────────
const vc = new VirtualConsole();
const jsdomErrors = [];
vc.on("jsdomError", (e) => {
  jsdomErrors.push(e && e.message);
});
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
for (const k of ["localStorage", "CustomEvent", "MouseEvent", "Event", "HTMLElement", "Element", "Node", "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, k, {
    value: /^(requestAnimationFrame|cancelAnimationFrame)$/.test(k) ? w[k].bind(w) : w[k],
    configurable: true,
    writable: true,
  });
}

const { parse, compileScript, compileTemplate } = await import("@vue/compiler-sfc");
const { createApp, nextTick } = await import("vue");

// ── 编译真组件（不是复制品）──────────────────────────────────────────
// API 层换成桩：每个目录列出一个可辨认的行（行名 = 目录），这样「面板换了
// 目录」是可观测的事实，而不是靠内部状态推断。
const stubs = [
  'export const listDirectory = async (p) => { await new Promise(r => setTimeout(r, 5)); return { entries: [{ name: "OF_" + p, is_dir: false, is_hidden: false, size: 0, modified: 0, extension: "", path: p + "\\\\x" }], has_parent: true }; };',
  'export const getHomeDir = async () => "C:\\\\Users\\\\simon";',
  'export const getParentDir = async () => "C:\\\\Users";',
  'export const joinPath = async (a, b) => a + "\\\\" + b;',
  'export const listDrives = async () => [];',
  'export const getDirSize = async () => 0;',
  'export const pathExists = async () => true;',
  'export const expandPath = async (p) => p;',
  'export const startNativeDrag = async () => {};',
  'export const loadConfig = async () => null;',
  'export const saveConfig = async () => {};',
  'export const listen = async () => () => {};',
  'export const cancelSearch = async () => {};',
  'export const startSearch = async () => {};',
  'export const getArchiveTools = async () => [];',
  'export const extractArchive = async () => {};',
  'export const addToArchive = async () => {};',
  'export const deleteToTrash = async () => {};',
  'export const deletePermanently = async () => {};',
  'export const deleteWithAdmin = async () => {};',
  'export const beginTrashDelete = async () => {};',
  'export const commitTrashDelete = async () => {};',
  'export const undoTrashDelete = async () => {};',
  'export const isExecutable = async () => false;',
  'export const runAsAdmin = async () => {};',
  'export const renameFile = async () => {};',
  'export const openFile = async () => {};',
  'export const createDirectory = async () => {};',
].join("\n") + "\n";

// 编译产物放在临时目录，跑完删掉 —— 不污染仓库。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "minitc-tablock-"));
fs.writeFileSync(path.join(TMP, "stubs.mjs"), stubs);

const LOCAL = (name) => pathToFileURL(path.join(ROOT, "src", name + ".js")).href;
// 编译产物落在系统临时目录（不污染仓库），那里的裸 `from "vue"` 解析不到
// node_modules —— 指向仓库里那份绝对路径。
const VUE_URL = pathToFileURL(path.join(ROOT, "node_modules", "vue", "index.mjs")).href;
function rewrite(code) {
  let c = code
    .split('from "./TabBar.vue"').join('from "./TabBar.mjs"')
    .split('from "./ContextMenu.vue"').join('from "./ContextMenu.mjs"')
    .split('from "./PathBar.vue"').join('from "./PathBar.mjs"')
    .split('from "./FileList.vue"').join('from "./FileList.mjs"')
    .split('from "./BookmarkMenu.vue"').join('from "./BookmarkMenu.mjs"')
    .split('from "../api.js"').join('from "./stubs.mjs"')
    .split('from "@tauri-apps/api/event"').join('from "./stubs.mjs"')
    .split('from "vue"').join('from "' + VUE_URL + '"');
  c = c.replace(/from "\.\.\/([\w-]+)\.js"/g, (_m, name) => 'from "' + LOCAL(name) + '"');
  return c;
}

const COMP = path.join(ROOT, "src", "components");
for (const name of ["TabBar", "ContextMenu", "BookmarkMenu", "PathBar", "FileList", "FilePanel"]) {
  const abs = path.join(COMP, name + ".vue");
  const src = fs.readFileSync(abs, "utf8");
  const filename = abs.split(path.sep).join("/");
  const { descriptor, errors } = parse(src, { filename });
  if (errors.length) throw new Error("parse " + name + ": " + errors.map((e) => e.message).join("; "));
  const script = compileScript(descriptor, { id: name, inlineTemplate: false });
  const tpl = compileTemplate({ source: descriptor.template.content, filename, id: name, compilerOptions: { bindingMetadata: script.bindings } });
  if (tpl.errors.length) throw new Error("template " + name + ": " + tpl.errors.map((e) => e.message || e).join("; "));
  let code = script.content.replace("export default", "const __sfc__ =");
  code += "\n" + tpl.code + "\n__sfc__.render = render;\nexport default __sfc__;\n";
  fs.writeFileSync(path.join(TMP, name + ".mjs"), rewrite(code), "utf8");
}

const { default: FilePanel } = await import(pathToFileURL(path.join(TMP, "FilePanel.mjs")).href);
const app = createApp(FilePanel, { panelId: "left", isActive: true });
app.mount(document.getElementById("app"));
await nextTick();
await new Promise((r) => setTimeout(r, 80));
await nextTick();

const st = app._instance.setupState;
const tabs = st.tabs;

async function settle() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 80));
  await nextTick();
}
function panelView() {
  return {
    breadcrumb: [...document.querySelectorAll(".breadcrumb .crumb")].map((e) => e.textContent.trim()).join("›"),
    row: [...document.querySelectorAll(".file-row .file-name")].map((e) => e.textContent.trim())[0] || null,
    tabTitles: [...document.querySelectorAll(".tab-name")].map((e) => e.textContent.trim()),
    activeTabIndex: [...document.querySelectorAll(".tab")].findIndex((e) => e.classList.contains("active")),
  };
}
async function rightClickTab(index) {
  const el = [...document.querySelectorAll(".tab")][index];
  if (!el) throw new Error("tab #" + index + " missing");
  el.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 2 }));
  await nextTick();
  const menu = document.querySelector(".ctx-menu");
  if (!menu) throw new Error("no menu");
  return menu;
}
async function clickMenuItem(menu, label) {
  const el = [...menu.querySelectorAll(".ctx-item")].find((e) => e.textContent.trim() === label);
  if (!el) throw new Error("no item " + label);
  el.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true, button: 0 }));
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

// ── 场景 A：活动标签页（修复前就是好的，钉住别回归）─────────────────
{
  st.navigateTo(DIR_A);
  await settle();
  st.toggleTabLock();
  await settle();
  st.navigateTo(DIR_B);
  await settle();
  const before = panelView();
  check("场景A 准备：活动标签页已锁定并导航走", before.row === "OF_" + DIR_B);

  const menu = await rightClickTab(0);
  await clickMenuItem(menu, "回到锁定位置");
  const after = panelView();
  check("场景A：活动标签页跳回后，文件行是锁定目录", after.row === "OF_" + DIR_A, [`实际行内容：${after.row}`]);
  check("场景A：面包屑也换回锁定目录", after.breadcrumb === "D:›BaiduNetdiskDownload", [`实际：${after.breadcrumb}`]);
  check("场景A：活动标签页仍是同一个", after.activeTabIndex === 0);
}

// ── 场景 B：后台标签页（本次修复的核心）───────────────────────────
{
  // 造一个后台的锁定标签页：新建 tab → 锁定 → 导航走 → 切回前一个。
  const t2 = st.createTab(DIR_B);
  st.toggleTabLock();          // 锁住新建的 tab（在 DIR_B）
  st.navigateTo(DIR_A);        // 导航到 DIR_A（≠ 锚点）
  await settle();
  st.switchTab(tabs[0].id);    // 切回前一个 → t2 退到后台
  await settle();

  check("场景B 准备：t2 是后台标签页", st.activeTabId !== t2.id);
  check("场景B 准备：t2 已锁定且不在锁定位置", !!t2.lockedPath && t2.path !== t2.lockedPath);
  const before = panelView();
  check("场景B 准备：面板显示的是前一个标签页", before.activeTabIndex === 0);

  const menu = await rightClickTab(1);
  const items = [...menu.querySelectorAll(".ctx-item")].map((e) => e.textContent.trim());
  check("场景B：菜单里有「回到锁定位置」", items.includes("回到锁定位置"), [`菜单项：${items.join(" / ")}`]);

  await clickMenuItem(menu, "回到锁定位置");
  const after = panelView();

  // 🚨 这才是「无效」与「有效」的分界线：用户**看到**的目录换了没有。
  check("场景B：面板跟到了被右击的后台标签页", after.activeTabIndex === 1, [`活动标签页下标：${after.activeTabIndex}`]);
  check("场景B：文件行显示的是锁定目录（用户可见的变化）", after.row === "OF_" + t2.lockedPath, [`实际行内容：${after.row}`]);
  check("场景B：面包屑显示的是锁定目录", after.breadcrumb === "D:›BaiduNetdiskDownload›子目录", [`实际：${after.breadcrumb}`]);
  check("场景B：t2.path 确实变成了锁定位置", t2.path === t2.lockedPath, [`实际：${t2.path} / 锚点 ${t2.lockedPath}`]);
}

// ── 场景 B2：后台标签页**已经在**锁定位置（same 分支）─────────────
// 路径没变，但面板仍要跟过去 —— 否则这次点击依然「什么也没发生」。
{
  const t2 = tabs[1];
  // 场景 B 结束时 t2 已经跳回锁定位置了；先把它退回后台。
  st.switchTab(tabs[0].id);
  await settle();
  check("场景B2 准备：t2 在后台", st.activeTabId !== t2.id);
  check("场景B2 准备：t2 已在锁定位置", t2.path === t2.lockedPath);

  const menu = await rightClickTab(1);
  await clickMenuItem(menu, "回到锁定位置");
  const after = panelView();
  check("场景B2：面板跟到了那个后台标签页", after.activeTabIndex === 1, [`活动标签页下标：${after.activeTabIndex}`]);
  check("场景B2：显示的是它的锁定位置", after.row === "OF_" + t2.lockedPath, [`实际行内容：${after.row}`]);
}

// ── 场景 C：菜单里那几项不能被改坏 ────────────────────────────────
{
  // 「解除锁定」作用在后台标签页上：锁定标记要消失，且不能把面板切走
  // （切走是「跳回」的语义，不是「解锁」的语义）。
  // ⚠️ 前提要先摆正：场景 B/B2 结束时活动标签页已经是 t2 了 —— 先切回前一个，
  // 让 t2 真正退到后台，否则这个断言是在断言一个错误的前提。
  const t2 = tabs[1];
  st.switchTab(tabs[0].id);
  await settle();
  check("场景C 准备：t2 已在后台", st.activeTabId !== t2.id);

  const before = st.activeTabId;
  const menu = await rightClickTab(1);
  await clickMenuItem(menu, "解除锁定");
  check("场景C：后台标签页的锁定被解除", t2.lockedPath === "");
  check("场景C：解除锁定不切活动标签页（不该有的副作用）", st.activeTabId === before);
}

check("端到端：全程没有 jsdom 异常", jsdomErrors.length === 0, jsdomErrors.map((e) => String(e)));

// ══════════════ 4. 静态断言 ══════════════

section("4. 静态断言：落地点真的用了生产判据并切了活动标签页");

{
  const raw = fs.readFileSync(PANEL, "utf8");
  const code = stripComments(raw);

  check(
    "FilePanel.vue 从 ../tabLock.js 导入 planLockedJump",
    /import\s*\{[^}]*\bplanLockedJump\b[^}]*\}\s*from\s*["']\.\.\/tabLock\.js["']/.test(code)
  );

  // jumpToLocked 的函数体：必须调生产判据，并在 follow 时切活动标签页。
  const at = code.indexOf("function jumpToLocked(");
  check("找得到 jumpToLocked", at !== -1);
  const body = at === -1 ? "" : code.slice(at, code.indexOf("\nfunction ", at + 10));
  check("jumpToLocked 体内非空", body.length > 0);
  check("jumpToLocked 调了生产判据 planLockedJump", /planLockedJump\s*\(/.test(body));
  check("jumpToLocked 按 plan.follow 切活动标签页", /plan\.follow/.test(body) && /switchTab\s*\(/.test(body));
  check(
    "jumpToLocked 不再自己判断 lockedPath（判据只在 tabLock.js 一处）",
    !/tab\.lockedPath\s*===/.test(body)
  );

  // 菜单分支：jump-locked 必须走 jumpToLocked（唯一入口）。
  const menuAt = code.indexOf("function handleTabMenuSelect(");
  const menuBody = menuAt === -1 ? "" : code.slice(menuAt, code.indexOf("\nfunction ", menuAt + 10));
  check("handleTabMenuSelect 体内非空", menuBody.length > 0);
  const jumpCase = menuBody.slice(menuBody.indexOf('case "jump-locked"'));
  check("jump-locked 分支存在", jumpCase !== "");
  check(
    "jump-locked 分支走 jumpToLocked（唯一入口）",
    /jump-locked[\s\S]{0,200}jumpToLocked\s*\(/.test(menuBody)
  );

  // 生产判据只有一个实现：别让第二个副本藏在 .vue 里。
  const otherImpls = [];
  const srcFiles = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const stt = fs.statSync(p);
      if (stt.isDirectory()) walk(p);
      else if (/\.(vue|js)$/.test(name)) srcFiles.push(p);
    }
  })(path.join(ROOT, "src"));
  for (const f of srcFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "src/tabLock.js") continue;
    const s = stripComments(fs.readFileSync(f, "utf8"));
    if (/function\s+planLockedJump\s*\(/.test(s)) otherImpls.push(rel);
  }
  check(`除 tabLock.js 外无 planLockedJump 副本（实际 ${otherImpls.length}）`, otherImpls.length === 0);
  if (otherImpls.length) console.log(`       ${otherImpls.join(", ")}`);

  // 判据本身在生产模块里导出（lint-imports 之外的第二道）。
  const lockSrc = stripComments(fs.readFileSync(LOCK, "utf8"));
  check("tabLock.js 导出 planLockedJump", /export\s+function\s+planLockedJump\s*\(/.test(lockSrc));
  check(
    "tabLock.js 是 plain node 可加载的（无 vue / IPC 依赖）",
    !/from\s+["']vue["']/.test(lockSrc) && !/invoke\s*\(/.test(lockSrc)
  );
}

// ══════════════ report ══════════════

// 清理临时编译产物（不留在仓库里）。
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
