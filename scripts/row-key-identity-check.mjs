// 验证 FileList 行循环的 `:key` 在虚拟目录下不会让行组件「串台」。
// 直接 `node scripts/row-key-identity-check.mjs` 跑。
//
// 这条测试是被一次**错误的结论**逼出来的。最初写 TODO 时断言：「key 撞车 →
// 内联改名输入框挂到错误的文件上，回车就把用户没输入的名字写到没选中的文件上」。
// 实测推翻了它 ——
//   输入框的位置只由 `renamingIndex` 这个**下标**决定。把下标正确搬运后，
//   `:key="entry.name"` 与 `:key="entry.path"` 的表现**完全一致**。
//   真正出错位的那个场景（删行/插入时 remap 没做）是 TODO 244，与 key 无关。
//
// 【key 撞车真正的后果】
// 行组件是「挂载时认领一次身份」的 —— FileList 行内的 renamingIndex、dirSizes 缓存、
// dirKey 都是这种闭包状态。Vue 的 keyed diff 靠一张 key -> 下标 的 map 决定复用谁，
// key 重复时后者覆盖前者，于是复用整体错位一格：
//
//     列表 [A,B,C,D]（四条都叫 r.zip，来自四个不同目录）
//       → D 从末尾挪到开头 → [D,A,B,C]
//     修复前：第 1 行的位置上是 D，组件却自称 A；第 2 行位置是 A，自称 B……
//     修复后：每一行的位置与自称完全一致。
//
// 落到 mini-tc 上：搜索结果页里一切「按行缓存」的东西都会读到隔壁那条的数据 ——
// 已算好的目录大小、已裁剪的缩略图、内联改名状态，都会贴在错误的行上。
//
// 【判据】
// 行组件在 setup 里把自己认领的 path 写进 DOM 文本（模拟真实行里那些闭包状态）。
// 每次列表变动后检查：「该位置的磁盘条目」==「该位置组件自称的身份」。
// 锚定的是**权威数据源**（列表本身），不是实现的副本。
//
// 【测什么 / 不测什么】
// 测：用真实 @vue/runtime-core 跑真实的 keyed diff。渲染层是它自带的**无 DOM
// test renderer**（不是 mock，是我们正要观察的那个复用决策本身）。
// 不测：`:key` 表达式本身对不对 —— 那是 `entry-key-check.mjs` 的活（含变异验证）。

import { createRenderer, h, ref, nextTick } from "@vue/runtime-core";

// ── 无 DOM 的 test renderer ──
// props 是靠 patchProp 逐个打到节点上的，createElement 只建壳；remove 必须真的
// 把节点从父级摘掉。第一版这两处都写漏了，DOM 只增不减、属性全丢，结果两种 key
// 都判成「正常」—— 断言全绿而问题还在。
let SEQ = 0;
function makeNode(t, p, c) {
  return { type: t, props: p || {}, children: c || [], parent: null };
}
function detach(ch) {
  const p = ch.parent;
  if (!p) return;
  const i = p.children.indexOf(ch);
  if (i >= 0) p.children.splice(i, 1);
  ch.parent = null;
}

const renderer = createRenderer({
  createElement: (t) => makeNode(t, {}, []),
  createText: (t) => ({ type: "#text", text: t, children: [], parent: null }),
  createComment: (t) => ({ type: "#comment", text: t, children: [], parent: null }),
  setText: (n, t) => { n.text = t; },
  setElementText: (n, t) => {
    for (const c of n.children.slice()) c.parent = null;
    n.children = [{ type: "#text", text: t, children: [], parent: n }];
  },
  insert: (ch, p, a) => {
    detach(ch);
    const i = a ? p.children.indexOf(a) : -1;
    if (i >= 0) p.children.splice(i, 0, ch); else p.children.push(ch);
    ch.parent = p;
  },
  remove: (ch) => detach(ch),
  parentNode: (n) => n.parent || null,
  nextSibling: (n) => {
    if (!n.parent) return null;
    const i = n.parent.children.indexOf(n);
    return n.parent.children[i + 1] || null;
  },
  patchProp: (el, k, _prev, next) => {
    if (next === null || next === undefined) delete el.props[k];
    else el.props[k] = next;
  },
  querySelector: () => null,
  setScopeId: () => {},
  cloneNode: (n) => makeNode(n.type, { ...n.props }, n.children.map((c) => ({ ...c, parent: null }))),
});

// ── 行组件：挂载时认领身份，之后永不改变 ──
const Row = {
  name: "Row",
  props: ["entry"],
  setup(props) {
    const owned = props.entry.path;
    return () => h("div", { class: "row" }, ["owner=" + owned]);
  },
};

function render(keyFn, seq) {
  const entries = ref(seq[0]);
  const app = renderer.createApp({
    setup() {
      return () => h("div", null, entries.value.map((e) => h(Row, { key: keyFn(e), entry: e })));
    },
  });
  const root = makeNode("root", {}, []);
  app.mount(root);
  return { entries, root, app };
}

function mismatchLines(root, list) {
  const rows = root.children[0].children;
  const bad = [];
  rows.forEach((row, i) => {
    const claimed = (row.children[0] && row.children[0].text) || "";
    const actual = list[i] && list[i].path;
    if (claimed !== "owner=" + actual) {
      bad.push(`第${i + 1}行 该位置是 ${actual}，组件却自称 ${claimed.replace("owner=", "")}`);
    }
  });
  return bad;
}

// 跑完整段序列，返回每一步的串台明细。
async function runSequence(keyFn, seq) {
  const { entries, root, app } = render(keyFn, seq);
  const all = [];
  for (let k = 0; k < seq.length; k++) {
    if (k > 0) { entries.value = seq[k]; await nextTick(); }
    const bad = mismatchLines(root, seq[k]);
    if (bad.length) all.push({ step: k + 1, list: seq[k], bad });
  }
  app.unmount();
  return all;
}

const mk = (p) => ({ path: p, name: p.split("\\").pop() });
const A = mk("D:\\proj\\alpha\\r.zip");
const B = mk("D:\\proj\\beta\\r.zip");
const C = mk("D:\\proj\\beta\\src\\r.zip");
const D = mk("E:\\backup\\r.zip");
const E = mk("E:\\backup\\2024\\r.zip");

// 全部场景的前置条件：列表里每一条都叫 r.zip，分处不同目录。
// 这不是构造出来的边缘用例 —— 一次内容搜索命中同名文件是搜索结果页的常态。
// ⚠️ 「修复组」必须调**生产代码里的那个函数**，不能在这里重写一遍 e.path ——
// 重写的话，entryKey 退化成 entry.name 时这套件照样全绿（已实测踩过：第一次写成
// byPath = e => e.path，变异后仍 11 passed，等于没测）。
// 对照组才用字面量 entry.name —— 它要证明的正是「按名字 key 会串台」。
const { entryKey } = await import("../src/paths.js");
const byName = (e) => e.name;
const byPath = entryKey;

const SEQS = {
  "同名项从末尾挪到开头": [[A, B, C, D], [D, A, B, C]],
  "删除中间一条": [[A, B, C, D], [A, C, D]],
  "删除最前一条": [[A, B, C, D], [B, C, D]],
  "开头插入新命中": [[A, B, C, D], [E, A, B, C, D]],
  "整体倒序（换排序列）": [[A, B, C, D], [D, C, B, A]],
  "末尾追加新命中": [[A, B, C, D], [A, B, C, D, E]],
  "两批结果拼接后重排": [[A, B, C, D], [C, A, E, B, D]],
  "删除后又被新批次顶回": [[A, B, C, D], [B, C, D], [B, E, C, D]],
};

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail) for (const d of detail) console.log(`         ${d}`);
  }
}

console.log("① 前置确认：造出来的数据确实是跨目录同名（否则后面全是空气）");
{
  const list = [A, B, C, D];
  const names = new Set(list.map((e) => e.name));
  check("四条都叫 r.zip", names.size === 1);
  check("四条来自四个不同目录", new Set(list.map((e) => e.path)).size === 4);
}

console.log("\n② 修复后的 entryKey（= entry.path）：任何变动下都不得串台");
for (const [label, seq] of Object.entries(SEQS)) {
  const bad = await runSequence(byPath, seq);
  check(`entryKey : ${label}`, bad.length === 0,
    bad.flatMap((b) => b.bad.map((d) => `第${b.step}次变动后 —— ${d}`)));
}

console.log("\n③ 对照臂：entry.name 必须真的会串台（否则 ② 没有鉴别力）");
let controlArms = 0;
for (const [label, seq] of Object.entries(SEQS)) {
  const bad = await runSequence(byName, seq);
  if (bad.length) controlArms++;
  else console.log(`  --   该场景下 entry.name 也不串台：${label}`);
}
check("至少一半场景能证明 entry.name 会串台", controlArms * 2 >= Object.keys(SEQS).length,
  [`只有 ${controlArms}/${Object.keys(SEQS).length} 个场景有鉴别力`]);

console.log("\n④ 串台样例（修复前，场景「同名项从末尾挪到开头」）");
{
  const bad = await runSequence(byName, [[A, B, C, D], [D, A, B, C]]);
  for (const d of bad[0].bad) console.log(`  ${d}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);