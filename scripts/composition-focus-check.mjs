// 验证「IME 合成开始时焦点该去哪」。
//
// 直接 `node scripts/composition-focus-check.mjs` 跑；`-- --mutate` 跑变异臂。
//
// ── 这个 bug 的形状 ────────────────────────────────────────────────
// FileList.vue 的 `onCompositionStart` 被绑在**改名输入框**上，而它的实现是
// 「焦点不在搜索框 → 把焦点抢到搜索框」。中文输入法下每敲一个字母都会启动
// 一次合成 → 焦点被抢走 →
//   ① 字母进了那个**隐藏的**过滤输入框（v-model 绑着 searchQuery），
//      列表于是开始「过滤」——用户看到的就是「按 F2 改名，一打字就变成搜索」；
//   ② 改名框失焦 → onRenameBlur → commitRename → 改名框当场消失，
//      而且 renameValue 里还留着合成的拼音残片，可能把文件真的改成半个拼音。
//
// ── 修法 ──────────────────────────────────────────────────────────
// 判据从「焦点现在在不在搜索框」换成「**合成从哪儿开始的**」：
// 合成起点是能存文字的元素（改名框 / 过滤框 / 任何 input）→ 焦点原地不动；
// 合成起点是列表 div 自己（存不住字）→ 才把焦点交给过滤框（这是原功能）。
// 判据函数 `compositionFocusTarget` 放在 src/keyboardText.js（plain node 可加载，
// 组件与测试共用同一份 —— 留在 .vue 里只能复制进测试，等于测自己的副本）。
//
// ── 四层断言 ───────────────────────────────────────────────────────
//   1. 纯逻辑：import 生产 `compositionFocusTarget`，跑真值表。
//   2. 端到端：从 FileList.vue **抽取真实的 onCompositionStart 源码**（不复制）
//      在 jsdom 里跑，断言 DOM 焦点真的没被抢走 / 该抢时真的抢到了。
//   3. 静态断言：落地点真的调了生产函数；旧的无条件抢焦点的写法已消失；
//      改名框 / 过滤框两个绑定点都还在（否则搜索功能整体坏掉）。
//   4. 变异臂：每个变异都应 FAIL，且脚本打印 `anchor found: N` 要求恰好 1。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import mod from "./stripComments.cjs";
import { compositionFocusTarget, isTypingTarget } from "../src/keyboardText.js";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILELIST = path.join(ROOT, "src", "components", "FileList.vue");
const KEYBOARD = path.join(ROOT, "src", "keyboardText.js");

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

// ══════════════ fixtures ══════════════

const dom = new JSDOM(`<!doctype html><html><body>
  <div class="file-list">
    <div class="search-bar hidden"><input class="search-input" /></div>
    <div class="file-entries">
      <div class="file-row"><input class="rename-input" value="folder" /></div>
    </div>
  </div>
</body></html>`);
const { document, Event } = dom.window;

const LIST = document.querySelector(".file-list");
const SEARCH = document.querySelector(".search-input");
const RENAME = document.querySelector(".rename-input");

// ══════════════ 1. 纯逻辑 ══════════════

section("1. compositionFocusTarget 真值表（import 生产函数）");

check("改名输入框是 typing target", isTypingTarget(RENAME) === true);
check("过滤输入框是 typing target", isTypingTarget(SEARCH) === true);
check("列表 div 不是 typing target", isTypingTarget(LIST) === false);

check(
  "合成起点是改名框 → 不抢焦点（本次 bug 的核心判据）",
  compositionFocusTarget(RENAME, SEARCH, RENAME) === null
);
check(
  "合成起点是过滤框 → 不抢焦点",
  compositionFocusTarget(SEARCH, SEARCH, SEARCH) === null
);
check(
  "合成起点是列表 div → 焦点交给过滤框（原功能必须保住）",
  compositionFocusTarget(LIST, SEARCH, LIST) === SEARCH
);
check(
  "没有过滤框 → 不动焦点",
  compositionFocusTarget(LIST, null, LIST) === null
);
check(
  "焦点已在过滤框 → 不动焦点",
  compositionFocusTarget(LIST, SEARCH, SEARCH) === null
);
check("target 为 null → 交给过滤框（无法判定起点时的兜底）", compositionFocusTarget(null, SEARCH, LIST) === SEARCH);
check("target 为 null 且无过滤框 → 不动焦点", compositionFocusTarget(null, null, LIST) === null);
check("activeElement 为 null 时也能给出目标", compositionFocusTarget(LIST, SEARCH, null) === SEARCH);

// 对照臂：旧判据（焦点不在搜索框就抢）在这个场景下真的会抢 —— 否则第 2 组是恒真。
{
  const oldJudge = (target, searchElement, activeElement) =>
    searchElement && activeElement !== searchElement ? searchElement : null;
  check(
    "对照臂：旧判据在「改名框里合成」时确实抢焦点（所以新判据有分辨力）",
    oldJudge(RENAME, SEARCH, RENAME) === SEARCH
  );
  check(
    "对照臂：旧判据在「列表 div 里合成」时也给搜索框（这一侧新旧一致）",
    oldJudge(LIST, SEARCH, LIST) === SEARCH
  );
}

// ══════════════ 2. 端到端（跑真实的 onCompositionStart 源码）══════════════

section("2. 端到端：抽取 FileList.vue 的真实 onCompositionStart，在 jsdom 里跑");

const listSrc = fs.readFileSync(FILELIST, "utf8");

// 抽函数体：从 `function onCompositionStart(` 起配平花括号。
// ⚠️ 方法论记着：起点必须先跳过参数列表再找 `{`（默认参数里的花括号会让配平错位）。
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const braceAt = src.indexOf("{", at + decl.length - 1);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceAt, i + 1);
    }
  }
  return null;
}

const fnSrc = bodyOf(listSrc, "function onCompositionStart(e) {");
check("从 FileList.vue 抽到 onCompositionStart 的函数体", fnSrc !== null && fnSrc.length > 0);

// 端到端那一层要跑**完整函数**（签名 + 体），签名里的参数 `e` 不能丢。
// bodyOf 只切出花括号部分，所以这里另取一份：从声明处到配平结束。
function fullFnOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const braceAt = src.indexOf("{", at + decl.length - 1);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}
const fnFull = fullFnOf(listSrc, "function onCompositionStart(e) {");
check("抽到完整的 onCompositionStart（含签名）", fnFull !== null && fnFull.startsWith("function onCompositionStart(e) {"));

// 把真实源码装进一个函数，注入生产判据 + jsdom 的 document。
// ⚠️ 这里跑的是**生产源码本身**，不是测试里重写的一份 —— 改实现不改调用点时
// 纯逻辑断言会全绿，这一层才会 FAIL。
function makeHandler(doc, search) {
  const factory = new Function(
    "searchInput",
    "document",
    "compositionFocusTarget",
    fnFull + "\nreturn onCompositionStart;"
  );
  return factory({ value: search }, doc, compositionFocusTarget);
}

function runScenario(focusSel, composeSel) {
  // ⚠️ jsdom 会**吞掉**事件监听器里抛出的异常：只把它报进 virtualConsole，
  // 进程退出码仍是 0。所以「调用方漏了判空 → 对 null 调 focus → 崩」这个
  // 变异在默认配置下**测不出来**（焦点没变，断言照样绿）。实测确认过：
  // dispatchEvent 正常返回、脚本跑到末尾、exit=0。
  // → 用 virtualConsole 把 jsdomError 接出来，让「崩了」成为可断言的事实。
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e));

  const d = new JSDOM(
    `<!doctype html><html><body>
    <div class="file-list">
      <div class="search-bar hidden"><input class="search-input" /></div>
      <div class="file-entries"><div class="file-row"><input class="rename-input" /></div></div>
    </div>
  </body></html>`,
    { virtualConsole: vc }
  );
  const doc = d.window.document;
  const list = doc.querySelector(".file-list");
  const search = doc.querySelector(".search-input");
  const rename = doc.querySelector(".rename-input");
  const handler = new Function(
    "searchInput",
    "document",
    "compositionFocusTarget",
    fnFull + "\nreturn onCompositionStart;"
  )({ value: search }, doc, compositionFocusTarget);
  list.addEventListener("compositionstart", handler);
  search.addEventListener("compositionstart", handler);
  rename.addEventListener("compositionstart", handler);

  const focusEl = focusSel === "rename" ? rename : focusSel === "search" ? search : list;
  const composeEl = composeSel === "rename" ? rename : composeSel === "search" ? search : list;
  focusEl.focus();
  const before = doc.activeElement;
  composeEl.dispatchEvent(new d.window.Event("compositionstart", { bubbles: true }));
  const after = doc.activeElement;
  return { before, after, rename, search, list, errors };
}

{
  const r = runScenario("rename", "rename");
  check(
    "改名框里合成 → 焦点留在改名框（本次修复的主判据）",
    r.after === r.rename,
    [`焦点跑到了：${r.after && r.after.className}`]
  );
  check("改名框里合成 → 没有被抢到过滤框", r.after !== r.search);
  check(
    "改名框里合成 → 处理器没有抛异常",
    r.errors.length === 0,
    r.errors.map((e) => String(e && e.message))
  );
}

{
  const r = runScenario("list", "list");
  check(
    "列表 div 里合成 → 焦点交给过滤框（原功能保住）",
    r.after === r.search,
    [`焦点跑到了：${r.after && r.after.className}`]
  );
  check(
    "列表 div 里合成 → 处理器没有抛异常",
    r.errors.length === 0,
    r.errors.map((e) => String(e && e.message))
  );
}

{
  const r = runScenario("search", "search");
  check("过滤框里合成 → 焦点留在过滤框", r.after === r.search, [
    `焦点跑到了：${r.after && r.after.className}`,
  ]);
}

// ══════════════ 3. 静态断言 ══════════════

section("3. 静态断言：落地点与旧写法");

const listStripped = stripComments(listSrc);
const kbStripped = stripComments(fs.readFileSync(KEYBOARD, "utf8"));

check(
  "FileList.vue 从 ../keyboardText.js 导入 compositionFocusTarget",
  /import\s*\{[^}]*\bcompositionFocusTarget\b[^}]*\}\s*from\s*["']\.\.\/keyboardText\.js["']/.test(listStripped)
);

{
  const body = bodyOf(listStripped, "function onCompositionStart(e) {");
  check("剥注释后仍抽得到 onCompositionStart", body !== null && body.length > 0);
  check("onCompositionStart 调了生产判据 compositionFocusTarget", /compositionFocusTarget\s*\(/.test(body));
  check(
    "onCompositionStart 不再有「焦点不在搜索框就抢」的无条件写法",
    !/activeElement\s*!==\s*searchInput\.value/.test(body)
  );
  check(
    "onCompositionStart 不再自己判断 isTypingTarget（判据只在 keyboardText.js 一处）",
    !/isTypingTarget\s*\(/.test(body)
  );
}

{
  // 生产判据必须落在 keyboardText.js（唯一入口），供组件与测试共用。
  check(
    "keyboardText.js 导出 compositionFocusTarget",
    /export\s+function\s+compositionFocusTarget\s*\(/.test(kbStripped)
  );
  check(
    "compositionFocusTarget 用 isTypingTarget 判「起点能否存字」",
    /compositionFocusTarget[\s\S]{0,600}isTypingTarget\s*\(/.test(kbStripped)
  );
  // 不得有第二份实现（同一语义两份实现必然分叉）。
  const otherImpls = [];
  const srcFiles = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(vue|js)$/.test(name)) srcFiles.push(p);
    }
  })(path.join(ROOT, "src"));
  for (const f of srcFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "src/keyboardText.js") continue;
    const s = stripComments(fs.readFileSync(f, "utf8"));
    if (/function\s+compositionFocusTarget\s*\(/.test(s)) otherImpls.push(rel);
  }
  check(`除 keyboardText.js 外无 compositionFocusTarget 副本（实际 ${otherImpls.length}）`, otherImpls.length === 0);
  if (otherImpls.length) console.log(`       ${otherImpls.join(", ")}`);
}

{
  // 两个绑定点都还在：容器（合成起点是 div 的场景）+ 过滤框自身。
  const binds = (listSrc.match(/@compositionstart="onCompositionStart"/g) || []).length;
  check(`@compositionstart 绑定点共 ${binds} 处（期望 3：列表容器 / 过滤框 / 改名框）`, binds === 3);
  check("列表容器上的绑定还在", /class="file-list"[\s\S]{0,400}@compositionstart="onCompositionStart"/.test(listSrc));
  check("过滤输入框上的绑定还在", /class="search-input"[\s\S]{0,300}@compositionstart="onCompositionStart"/.test(listSrc));
  check("改名输入框上的绑定还在", /class="rename-input"[\s\S]{0,300}@compositionstart="onCompositionStart"/.test(listSrc));
}

{
  // 改名的失焦提交路径仍在（它没有被这个 bug 顺带删掉）。
  check("onRenameBlur 仍在", /function\s+onRenameBlur\s*\(/.test(listSrc));
  check("commitRename 仍在", /function\s+commitRename\s*\(/.test(listSrc));
}

// ══════════════ report ══════════════

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}

// ══════════════ MUTATIONS ══════════════

if (process.argv.includes("--mutate")) {
  console.log(`\n${"═".repeat(50)}\n变异测试（每个都应 FAIL）\n${"═".repeat(50)}`);
  const origList = fs.readFileSync(FILELIST, "utf8");
  const origKb = fs.readFileSync(KEYBOARD, "utf8");

  // ⚠️ 方法论：.vue 与 .js 的换行符可能不同，锚点要按目标文件归一化，
  // 否则 count == 0 → 变异没注入 → 套件全绿被误读成「断言瞎」。
  const nlFor = (file, s) =>
    fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

  const mutations = [
    {
      name: "① FileList 改回旧写法（无条件把焦点抢到搜索框）—— 原 bug 的形状",
      file: FILELIST,
      from: nlFor(
        FILELIST,
        "  const target = compositionFocusTarget(e && e.target, searchInput.value, document.activeElement);\n  if (target) target.focus();\n"
      ),
      to: nlFor(
        FILELIST,
        "  if (searchInput.value && document.activeElement !== searchInput.value) {\n    searchInput.value.focus();\n  }\n"
      ),
    },
    {
      name: "② 生产判据删掉 isTypingTarget 分支（合成起点是输入框也不再放过）",
      file: KEYBOARD,
      from: "  if (isTypingTarget(target)) return null;\n",
      to: "",
    },
    {
      name: "③ 生产判据删掉「焦点已在过滤框就不动」分支",
      file: KEYBOARD,
      from: "  if (activeElement === searchElement) return null;\n",
      to: "",
    },
    {
      // ⚠️ 原先这里放的是「删掉生产判据的 `if (!searchElement) return null;`」——
      // 实测它 0 FAIL，但那是**等价变异**：删掉后走到 `return searchElement`，
      // 而 searchElement 本来就是 null，结果一模一样。方法论记着「0 FAIL 先判
      // 等价变异还是测试盲区，别硬凑断言去制造 FAIL」→ 如实记录，换成下面
      // 这个真盲点（调用方去掉判空 → 对 null 调 focus → 崩）。
      name: "④ 调用方去掉判空（target 为 null 时对 null 调 focus）",
      file: FILELIST,
      from: nlFor(FILELIST, "  if (target) target.focus();\n"),
      to: nlFor(FILELIST, "  target.focus();\n"),
    },
    {
      name: "⑤ FileList 落地点改调一个本地副本（违反唯一入口）",
      file: FILELIST,
      from: nlFor(
        FILELIST,
        "  const target = compositionFocusTarget(e && e.target, searchInput.value, document.activeElement);\n"
      ),
      to: nlFor(
        FILELIST,
        "  function compositionFocusTarget(t) { return t && t.tagName === \"INPUT\" ? null : searchInput.value; }\n  const target = compositionFocusTarget(e && e.target);\n"
      ),
    },
    {
      name: "⑥ 删掉改名框上的 @compositionstart 绑定（合成起点判据失效的兜底被摘掉）",
      file: FILELIST,
      from: nlFor(FILELIST, '            @compositionstart="onCompositionStart"\n'),
      to: "",
    },
  ];

  const { execFileSync } = await import("node:child_process");
  for (const mu of mutations) {
    const original = fs.readFileSync(mu.file, "utf8");
    const count = original.split(mu.from).length - 1;
    console.log(`\n▶ ${mu.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      failures.push(`变异目标未唯一命中：${mu.name}`);
      process.exitCode = 1;
      continue;
    }

    fs.writeFileSync(mu.file, original.split(mu.from).join(mu.to), "utf8");
    let failedNow = 0;
    let out = "";
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
    } catch (e) {
      failedNow = 1;
      out = (e.stdout || "") + (e.stderr || "");
    }
    fs.writeFileSync(mu.file, original, "utf8");

    if (failedNow) {
      passed++;
      const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
      console.log(`  ok   变异被断言抓到（FAIL 如预期）${firstFail ? " | " + firstFail.trim() : ""}`);
    } else {
      failures.push(`变异未被抓到：${mu.name}`);
      console.log("  FAIL 变异未被断言抓到 —— 该断言是恒真的");
    }
  }

  fs.writeFileSync(FILELIST, origList, "utf8");
  fs.writeFileSync(KEYBOARD, origKb, "utf8");

  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
  if (failures.length) process.exitCode = 1;
}
