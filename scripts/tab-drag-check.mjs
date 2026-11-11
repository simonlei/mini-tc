// 验证「拖动标签页调整顺序」真的生效（2026-11 新增）。
//
// 直接 `node scripts/tab-drag-check.mjs` 跑。
//
// ── 这个功能的形状 ──────────────────────────────────────────────────
// 标签页的顺序以前**只能靠破坏来改**：想把手边的目录挪到最前面，唯一办法是
// 把后面每一个标签页都关掉再重开 —— 历史、锁定锚点、排序方式全丢。
// 所以判据不能只看「数组顺序变了」（那是实现细节），要看**用户看到的标签条**
// 是不是真的换了顺序，以及换完之后：
//   · 活动标签页没被换掉（重排不是导航，目录不该跳）；
//   · 标签页一个不多一个不少（拖一次不能凭空多出一个标签页）；
//   · 顺序被写进了配置（重启后还在）。
//
// ── 四层断言 ────────────────────────────────────────────────────────
//   1. 纯逻辑：import 生产 `planDropIndex` / `reorderTabs`（src/tabDrag.js），
//      跑真值表。
//   2. 对照臂：三个退化实现（忘了排除被拖的那个 / 永远插到末尾 / 中线归左），
//      必须在同一批场景下给出**不同的最终顺序** —— 答案相同 = 断言瞎。
//   3. 端到端：真挂载 FilePanel + TabBar（jsdom），用真的 pointer 事件拖一个
//      标签页，断言**标签条上看得见的顺序**变了，且活动标签页没变。
//   4. 静态断言：落地点真的调了生产判据、判据没有第二份副本、拖拽走的是
//      Pointer Events 而不是被弃用的 HTML5 拖放通道。
//
// 变异臂在 scripts/tab-drag-mutation.mjs。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import mod from "./stripComments.cjs";
import {
  planDropIndex,
  reorderTabs,
  sameTabOrder,
  TAB_DRAG_START_THRESHOLD,
} from "../src/tabDrag.js";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABBAR = path.join(ROOT, "src", "components", "TabBar.vue");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const DRAG = path.join(ROOT, "src", "tabDrag.js");

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

section("1. planDropIndex / reorderTabs 真值表（import 生产 src/tabDrag.js）");

// 三个标签页，各宽 100px：1 在 [0,100]，2 在 [100,200]，3 在 [200,300]。
const R3 = [
  { id: 1, left: 0, right: 100 },
  { id: 2, left: 100, right: 200 },
  { id: 3, left: 200, right: 300 },
];

// ── planDropIndex：下标语义是「去掉被拖的那个之后」的列表 ──
{
  const at = (x, dragId = 1, rects = R3) => planDropIndex({ rects, dragId, pointerX: x });

  check("拖 id=1，指针在最左（x=10）→ 插到最前", at(10) === 0, [`实际 ${at(10)}`]);
  check("拖 id=1，指针在 tab2 左半边（x=120）→ 插到 tab2 前面", at(120) === 0, [`实际 ${at(120)}`]);
  check("拖 id=1，指针在 tab2 中线（x=150）→ 中线归右半边，插到 tab2 后面", at(150) === 1, [`实际 ${at(150)}`]);
  check("拖 id=1，指针在 tab2 右半边（x=170）→ 插到 tab2 后面", at(170) === 1, [`实际 ${at(170)}`]);
  check("拖 id=1，指针在 tab3 中线（x=250）→ 插到 tab3 后面", at(250) === 2, [`实际 ${at(250)}`]);
  check("拖 id=1，指针在最右（x=290）→ 插到最末", at(290) === 2, [`实际 ${at(290)}`]);
  check("拖 id=1，指针跑到标签栏外（x=1000）→ 仍然插到最末（不能越界）", at(1000) === 2, [`实际 ${at(1000)}`]);

  // 被拖的那个自己不能参与落点判定。
  check(
    "被拖的标签页自己不算落点（rects 里带它，结果也一样）",
    planDropIndex({ rects: R3, dragId: 1, pointerX: 10 }) === 0 &&
      planDropIndex({ rects: R3, dragId: 1, pointerX: 170 }) === 1
  );

  // 拖 id=3 时，落点下标是「去掉 3 之后」的列表里的下标。
  check("拖 id=3，指针在 tab1 左半边（x=10）→ 插到最前", at(10, 3) === 0, [`实际 ${at(10, 3)}`]);
  check("拖 id=3，指针在 tab2 左半边（x=120）→ 插到 tab2 前面（下标 1）", at(120, 3) === 1, [`实际 ${at(120, 3)}`]);
  check("拖 id=3，指针在最右（x=290）→ 插到最末（下标 2）", at(290, 3) === 2, [`实际 ${at(290, 3)}`]);

  // dragId 不在 rects 里（标签刚被换掉等边缘情况）→ 退化成「按全部标签算」。
  check("dragId 不在 rects 里也不报错", at(60, 99) === 1, [`实际 ${at(60, 99)}`]);
  check("rects 为空 → 落点 0", planDropIndex({ rects: [], dragId: 1, pointerX: 50 }) === 0);
}

// ── reorderTabs：把落点变成真正的顺序 ──
{
  const ids = (arr) => arr.map((t) => t.id);
  const T = [{ id: 1 }, { id: 2 }, { id: 3 }];

  check("拖 1 到末尾 → [2,3,1]", ids(reorderTabs(T, 1, 2)).join() === "2,3,1");
  check("拖 3 到最前 → [3,1,2]", ids(reorderTabs(T, 3, 0)).join() === "3,1,2");
  check("拖 2 插到 1 后面 → 顺序不变 [1,2,3]", ids(reorderTabs(T, 2, 1)).join() === "1,2,3");
  check("未知 id → 原样返回（不改任何东西）", ids(reorderTabs(T, 99, 0)).join() === "1,2,3");
  check("下标越界（99）→ 夹到末尾", ids(reorderTabs(T, 1, 99)).join() === "2,3,1");
  check("下标为负（-5）→ 夹到最前", ids(reorderTabs(T, 3, -5)).join() === "3,1,2");
  check("下标非法（NaN）→ 落到最前而不是崩掉", ids(reorderTabs(T, 3, NaN)).join() === "3,1,2");

  // 元素必须是同一批对象（不能复制标签页 —— 复制 = 路径/锁定锚点全丢）。
  const objs = [{ id: 1, path: "a" }, { id: 2, path: "b" }, { id: 3, path: "c" }];
  const moved = reorderTabs(objs, 3, 0);
  check("重排后元素还是同一批对象（不是副本）", moved[0] === objs[2] && moved[1] === objs[0]);
  check("重排不改变标签页总数", moved.length === objs.length);
}

// ── sameTabOrder ──
{
  check("顺序相同 → true", sameTabOrder([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }]) === true);
  check("顺序不同 → false", sameTabOrder([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]) === false);
  check("长度不同 → false", sameTabOrder([{ id: 1 }], [{ id: 1 }, { id: 2 }]) === false);
}

check("拖动阈值是个正数（几像素内不算拖动）", Number.isFinite(TAB_DRAG_START_THRESHOLD) && TAB_DRAG_START_THRESHOLD > 0);

// ══════════════ 2. 对照臂 ══════════════

section("2. 对照臂 —— 退化实现必须给出不同的最终顺序");

// 场景：3 个标签页（1/2/3，各宽 100），拖某一个到某个 x。
const SCENARIOS = [
  { name: "拖 1 到最左", dragId: 1, x: 10, want: "1,2,3" },
  { name: "拖 1 到 tab2 中线", dragId: 1, x: 150, want: "2,1,3" },
  { name: "拖 1 到 tab2 右半边", dragId: 1, x: 170, want: "2,1,3" },
  { name: "拖 1 到最右", dragId: 1, x: 290, want: "2,3,1" },
  { name: "拖 3 到最左", dragId: 3, x: 10, want: "3,1,2" },
  { name: "拖 3 到 tab2 左半边", dragId: 3, x: 120, want: "1,3,2" },
  { name: "拖 2 到最右", dragId: 2, x: 290, want: "1,3,2" },
];

// 生产实现在这批场景上的最终顺序（先钉死，后面所有断言都拿它当基准）。
{
  const T = [{ id: 1 }, { id: 2 }, { id: 3 }];
  let ok = true;
  for (const s of SCENARIOS) {
    const plan = planDropIndex({ rects: R3, dragId: s.dragId, pointerX: s.x });
    const got = reorderTabs(T, s.dragId, plan).map((t) => t.id).join();
    if (got !== s.want) {
      ok = false;
      console.log(`         （${s.name}：期望 ${s.want}，实际 ${got}）`);
    }
  }
  check(`生产实现在全部 ${SCENARIOS.length} 个场景上给出预期的最终顺序`, ok);
}

const BROKEN = [
  {
    name: "忘了把被拖的那个从候选里排除（落点下标算进了自己）",
    plan: ({ rects, dragId, pointerX }) => {
      const list = rects.filter((r) => r);
      for (let i = 0; i < list.length; i++) {
        const mid = (list[i].left + list[i].right) / 2;
        if (pointerX < mid) return i;
      }
      return list.length;
    },
  },
  {
    name: "永远插到最末尾（不看指针位置）",
    plan: ({ rects, dragId }) => {
      const list = rects.filter((r) => r && r.id !== dragId);
      return list.length;
    },
  },
  {
    name: "中线归左半边（<= mid）—— 与「右半边 → 插到后面」的约定相反",
    plan: ({ rects, dragId, pointerX }) => {
      const list = rects.filter((r) => r && r.id !== dragId);
      for (let i = 0; i < list.length; i++) {
        const mid = (list[i].left + list[i].right) / 2;
        if (pointerX <= mid) return i;
      }
      return list.length;
    },
  },
];

for (const b of BROKEN) {
  const T = [{ id: 1 }, { id: 2 }, { id: 3 }];
  let diverged = 0;
  const same = [];
  for (const s of SCENARIOS) {
    const good = reorderTabs(T, s.dragId, planDropIndex({ rects: R3, dragId: s.dragId, pointerX: s.x }))
      .map((t) => t.id)
      .join();
    const bad = reorderTabs(T, s.dragId, b.plan({ rects: R3, dragId: s.dragId, pointerX: s.x }))
      .map((t) => t.id)
      .join();
    if (good !== bad) diverged += 1;
    else same.push(s.name);
  }
  check(
    `退化实现「${b.name}」与生产实现在 ${SCENARIOS.length} 个场景中至少一个上不同（实测 ${diverged} 个）`,
    diverged > 0,
    [`这些场景上答案相同（无分辨力）：${same.join("、")}`]
  );
}

// ══════════════ 3. 端到端（真挂载组件，断言用户看得见的标签条）══════════════

section("3. 端到端：真的拖一个标签页 → 标签条上的顺序真的变了");

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

// jsdom 的 getBoundingClientRect 永远是 0 —— 那算不出落点。给标签页一个
// 确定的假布局：每个标签页宽 100px，按显示顺序排开。
const REAL_RECT = w.Element.prototype.getBoundingClientRect;
w.Element.prototype.getBoundingClientRect = function () {
  if (this.classList && this.classList.contains("tab")) {
    const all = this.parentElement ? [...this.parentElement.querySelectorAll(".tab")] : [];
    const i = all.indexOf(this);
    const left = i * 100;
    return {
      left, right: left + 100, top: 0, bottom: 30,
      width: 100, height: 30, x: left, y: 0,
      toJSON() { return {}; },
    };
  }
  return REAL_RECT.call(this);
};

const { parse, compileScript, compileTemplate } = await import("@vue/compiler-sfc");
const { createApp, nextTick } = await import("vue");

// ── 编译真组件（不是复制品）──────────────────────────────────────────
// API 层换成桩。saveConfig 把写盘的内容记下来 —— 「顺序被持久化了」是用户
// 重启后还能看到新顺序的前提，必须断言。
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
  'export const saveConfig = async (k, v) => { (globalThis.__cfg = globalThis.__cfg || []).push([k, v]); };',
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "minitc-tabdrag-"));
fs.writeFileSync(path.join(TMP, "stubs.mjs"), stubs);

const LOCAL = (name) => pathToFileURL(path.join(ROOT, "src", name + ".js")).href;
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

async function settle() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 80));
  await nextTick();
}
function tabEls() {
  return [...document.querySelectorAll(".tab")];
}
function tabTitles() {
  return tabEls().map((e) => {
    const n = e.querySelector(".tab-name");
    return n ? n.textContent.trim() : "";
  });
}
function activeTabIndex() {
  return tabEls().findIndex((e) => e.classList.contains("active"));
}
function markerState() {
  return {
    before: tabEls().findIndex((e) => e.classList.contains("drop-before")),
    after: tabEls().findIndex((e) => e.classList.contains("drop-after")),
  };
}

/** 真的拖一次：按下 → 移动 → 看指示线 → 松手。返回拖动期间的指示线位置。 */
async function dragTab(fromIndex, toX) {
  const els = tabEls();
  const el = els[fromIndex];
  if (!el) throw new Error("tab #" + fromIndex + " missing");
  const startX = fromIndex * 100 + 50;
  el.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: startX, clientY: 10, button: 0 }));
  w.dispatchEvent(new w.MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: toX, clientY: 10, button: 0 }));
  await nextTick();
  const marker = markerState();
  w.dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: toX, clientY: 10, button: 0 }));
  await settle();
  return marker;
}

/** 一次完整的点击手势（pointerdown → pointerup → click），跟浏览器一致。 */
async function clickTab(index) {
  const el = tabEls()[index];
  if (!el) throw new Error("tab #" + index + " missing");
  const x = index * 100 + 50;
  el.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0 }));
  el.dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0 }));
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0 }));
  await settle();
}

/**
 * 拖完那个手势之后浏览器补的 click：**同一个手势**，所以没有新的 pointerdown。
 * （真实浏览器里 pointerup 之后紧跟着就补一个 click —— 那是拖动的余波，
 *   不是「切换标签页」。）
 */
async function trailingClick(index) {
  const el = tabEls()[index];
  if (!el) throw new Error("tab #" + index + " missing");
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, clientX: index * 100 + 50, clientY: 10, button: 0 }));
  await settle();
}

// ── 准备：初始标签页（home）+ 三个新标签页 ───────────────────────────
st.createTab("D:\\aaa");
st.createTab("D:\\bbb");
st.createTab("D:\\ccc");
await settle();

const TITLES = tabTitles();
check("准备：标签条上有 4 个标签页", TITLES.length === 4, [`实际 ${TITLES.length} 个：${TITLES.join(", ")}`]);
const ORDER0 = TITLES.slice();
// 最初的打开顺序（写盘断言要拿它当「没重排过」的基准）。
const PATH_ORDER0 = st.tabs.map((t) => t.path);
const ID_ORDER0 = st.tabs.map((t) => t.id);
const activeBefore = st.activeTabId;
const activeIdxBefore = activeTabIndex();
check("准备：活动标签页是最后创建的那个", activeIdxBefore === 3, [`实际下标 ${activeIdxBefore}`]);

// ── 场景 1：把第一个标签页拖到最右 ──────────────────────────────────
{
  const marker = await dragTab(0, 350);
  check(
    "场景1：拖动期间有一条插入指示线（用户看得见会落在哪）",
    marker.before >= 0 || marker.after >= 0,
    [`drop-before=${marker.before} drop-after=${marker.after}`]
  );
  check(
    "场景1：指示线落在最后一个标签页的右边（= 插到最末）",
    marker.after === 3 && marker.before === -1,
    [`drop-before=${marker.before} drop-after=${marker.after}`]
  );
  const after = tabTitles();
  check(
    "场景1：标签条上的顺序真的变了（第一个跑到最后）",
    after.join() === [ORDER0[1], ORDER0[2], ORDER0[3], ORDER0[0]].join(),
    [`实际：${after.join(", ")}`]
  );
  check("场景1：活动标签页没被换掉（重排不是导航）", st.activeTabId === activeBefore, [`实际 ${st.activeTabId} ≠ ${activeBefore}`]);
  check("场景1：标签页数量没变", st.tabs.length === 4, [`实际 ${st.tabs.length}`]);
  check(
    "场景1：每个标签页的路径都还在（重排不是复制）",
    st.tabs.map((t) => t.path).sort().join() === PATH_ORDER0.slice().sort().join(),
    [`实际：${st.tabs.map((t) => t.path).join(", ")} / 原本：${PATH_ORDER0.join(", ")}`]
  );
  check(
    "场景1：标签页 id 集合没变（没凭空多出标签页）",
    st.tabs.map((t) => t.id).sort().join() === ID_ORDER0.slice().sort().join(),
    [`实际：${st.tabs.map((t) => t.id).join(", ")}`]
  );
  check(
    "场景1：活动标签页还在活动状态（只是位置变了）",
    tabTitles()[activeTabIndex()] === ORDER0[3],
    [`活动下标 ${activeTabIndex()}，标题 ${tabTitles()[activeTabIndex()]}`]
  );
}

// ── 场景 2：把最后一个标签页拖回最左 ────────────────────────────────
{
  await dragTab(3, 10);
  const after = tabTitles();
  check(
    "场景2：拖回最左后顺序复原",
    after.join() === ORDER0.join(),
    [`实际：${after.join(", ")}`]
  );
  check("场景2：活动标签页仍然没变", st.activeTabId === activeBefore);
}

// ── 场景 3：拖到中间（不是首尾）─────────────────────────────────────
{
  await dragTab(0, 170);
  const after = tabTitles();
  check(
    "场景3：拖到中间 → 插到第 2 个后面",
    after.join() === [ORDER0[1], ORDER0[0], ORDER0[2], ORDER0[3]].join(),
    [`实际：${after.join(", ")}`]
  );
  check("场景3：活动标签页仍然没变", st.activeTabId === activeBefore);
  check("场景3：标签页数量仍然是 4", st.tabs.length === 4);
}

// ── 场景 4：普通点击仍然切标签页（别把点击吃掉了）──────────────────
{
  const before = st.activeTabId;
  const wantTitle = tabTitles()[0];
  await clickTab(0);
  check("场景4：普通点击仍然切换标签页", st.activeTabId !== before, [`活动标签页没变：${before}`]);
  check(
    "场景4：切到的是被点的那个",
    tabTitles()[activeTabIndex()] === wantTitle,
    [`活动：${tabTitles()[activeTabIndex()]}，点的：${wantTitle}`]
  );
}

// ── 场景 5：拖完之后的那个 click 不能切标签页 ──────────────────────
{
  const before = st.activeTabId;
  // 拖一个**不是当前页**的标签页 —— 这样「点击有没有被吃掉」才有分辨力。
  await dragTab(1, 350);
  const draggedId = st.tabs[3].id;
  check("场景5 准备：被拖的标签页不是当前页（否则点击本来就不会改变什么）", draggedId !== before);

  await trailingClick(3);
  check("场景5：拖完之后的 click 没有切标签页", st.activeTabId === before, [`活动标签页被改成了 ${st.activeTabId}`]);

  // 再来一次**完整的新手势**（pointerdown + pointerup + click）→ 应该正常切换。
  await clickTab(3);
  check(
    "场景5：再点一次就正常切换（没有把后续点击一起吃掉）",
    st.activeTabId === draggedId,
    [`活动标签页 ${st.activeTabId} ≠ ${draggedId}`]
  );
  check("场景5：切到的确实是刚拖的那个标签页", tabTitles()[activeTabIndex()] === tabTitles()[3]);
}

// ── 场景 6：新顺序被写进配置（重启后还在）───────────────────────────
{
  // scheduleSave() 有 200ms 防抖，等它落盘。
  await new Promise((r) => setTimeout(r, 400));
  const saves = (globalThis.__cfg || []).filter(([k]) => k === "tabs-left");
  check("场景6：拖动后写盘了", saves.length > 0, [`写盘次数 ${saves.length}`]);
  if (saves.length) {
    const state = JSON.parse(saves[saves.length - 1][1]);
    const persisted = state.tabs.map((t) => t.path);
    const current = st.tabs.map((t) => t.path);
    check(
      "场景6：写盘顺序 === 当前标签条顺序",
      persisted.join() === current.join(),
      [`写盘：${persisted.join(", ")} / 当前：${current.join(", ")}`]
    );
    check(
      "场景6：写盘顺序不是最初的打开顺序（重排真的落盘了）",
      persisted.join() !== PATH_ORDER0.join(),
      [`写盘：${persisted.join(", ")} / 最初：${PATH_ORDER0.join(", ")}`]
    );
    check("场景6：写盘的标签页数量没变", state.tabs.length === current.length, [`写盘 ${state.tabs.length} / 当前 ${current.length}`]);
  }
}

check("端到端：全程没有 jsdom 异常", jsdomErrors.length === 0, jsdomErrors.map((e) => String(e)));

// ══════════════ 4. 静态断言 ══════════════

section("4. 静态断言：落地点真的用了生产判据，且判据只有一份");

{
  const barRaw = fs.readFileSync(TABBAR, "utf8");
  const barCode = stripComments(barRaw);
  const barTmpl = barCode.replace(/<!--[\s\S]*?-->/g, "");
  const panelRaw = fs.readFileSync(PANEL, "utf8");
  const panelCode = stripComments(panelRaw);
  const dragRaw = fs.readFileSync(DRAG, "utf8");
  const dragCode = stripComments(dragRaw);

  // ── 生产判据本身 ──
  check("src/tabDrag.js 存在", fs.existsSync(DRAG));
  check("tabDrag.js 导出 planDropIndex", /export\s+function\s+planDropIndex\s*\(/.test(dragCode));
  check("tabDrag.js 导出 reorderTabs", /export\s+function\s+reorderTabs\s*\(/.test(dragCode));
  check("tabDrag.js 导出 sameTabOrder", /export\s+function\s+sameTabOrder\s*\(/.test(dragCode));
  check(
    "tabDrag.js 是 plain node 可加载的（不依赖 vue / IPC）",
    !/from\s+["']vue["']/.test(dragCode) && !/invoke\s*\(/.test(dragCode)
  );

  // ── TabBar 的落点 ──
  check(
    "TabBar.vue 从 ../tabDrag.js 导入 planDropIndex",
    /import\s*\{[^}]*\bplanDropIndex\b[^}]*\}\s*from\s*["']\.\.\/tabDrag\.js["']/.test(barCode)
  );
  check("TabBar.vue 真的调了生产判据", /planDropIndex\s*\(/.test(barCode));
  check(
    "TabBar.vue 用的是共享阈值常量（不是自己写的魔数）",
    /TAB_DRAG_START_THRESHOLD/.test(barCode)
  );
  check(
    "TabBar.vue 没有自己算中点（落点判定只在 tabDrag.js 一处）",
    !/\(\s*[^)]*left[^)]*\+\s*[^)]*right\s*\)\s*\/\s*2/.test(barCode)
  );

  // ── 拖拽通道：必须是 Pointer Events，不是被弃用的 HTML5 拖放 ──
  check("TabBar.vue 用 pointerdown 起手", /@pointerdown\s*=/.test(barTmpl));
  check("TabBar.vue 监听 pointermove", /pointermove/.test(barCode));
  check("TabBar.vue 监听 pointerup", /pointerup/.test(barCode));
  check("TabBar.vue 监听 pointercancel", /pointercancel/.test(barCode));
  check(
    "TabBar.vue 没有用 HTML5 的 dragover/drop（那条通道已被 tauri://drag-* 取代）",
    !/@dragover/.test(barTmpl) && !/@drop\b/.test(barTmpl)
  );

  // ── 事件契约 ──
  check("TabBar.vue 声明了 reorder-tab 事件", /reorder-tab/.test(barCode));
  check("TabBar.vue 真的 emit 了 reorder-tab", /emit\(\s*["']reorder-tab["']/.test(barCode));
  check("FilePanel.vue 接了 @reorder-tab", /@reorder-tab\s*=/.test(panelRaw));

  // ── FilePanel 的落点 ──
  check(
    "FilePanel.vue 从 ../tabDrag.js 导入 reorderTabs / sameTabOrder",
    /import\s*\{[^}]*\breorderTabs\b[^}]*\}\s*from\s*["']\.\.\/tabDrag\.js["']/.test(panelCode) &&
      /import\s*\{[^}]*\bsameTabOrder\b[^}]*\}\s*from\s*["']\.\.\/tabDrag\.js["']/.test(panelCode)
  );
  const at = panelCode.indexOf("function reorderTab(");
  check("找得到 reorderTab", at !== -1);
  const body = at === -1 ? "" : panelCode.slice(at, panelCode.indexOf("\nfunction ", at + 10));
  check("reorderTab 体内非空", body.length > 0);
  check("reorderTab 调了生产判据 reorderTabs", /reorderTabs\s*\(/.test(body));
  check("reorderTab 用了 sameTabOrder（没变就不该动数组）", /sameTabOrder\s*\(/.test(body));
  check(
    "reorderTab 不碰 activeTabId（重排不是导航，目录不该跳）",
    !/activeTabId\.value\s*=/.test(body)
  );
  check(
    "reorderTab 就地改数组（不替换 tabs.value，标签页对象保持同一批）",
    /tabs\.value\.splice\s*\(/.test(body)
  );

  // ── 判据只有一份 ──
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
    if (rel === "src/tabDrag.js") continue;
    const s = stripComments(fs.readFileSync(f, "utf8"));
    if (/function\s+planDropIndex\s*\(/.test(s) || /function\s+reorderTabs\s*\(/.test(s)) otherImpls.push(rel);
  }
  check(`除 tabDrag.js 外无 planDropIndex / reorderTabs 副本（实际 ${otherImpls.length}）`, otherImpls.length === 0);
  if (otherImpls.length) console.log(`       ${otherImpls.join(", ")}`);
}

// ══════════════ report ══════════════

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
