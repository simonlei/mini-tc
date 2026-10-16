// 验证「Ctrl+A 到底该由谁处理」以及三处 typing-target 守卫是否真的收敛到了唯一入口。
//
// 这个 bug 的形状：TODO 原文的修法是「三处统一调 isTypingTarget」。那条修法**不够** ——
// `.preview-text` 是 `<pre>`，既不是 INPUT/TEXTAREA 也不是 contenteditable，isTypingTarget
// 对它恒为false，所以只收敛守卫的话预览文本全选照样失效（这正是改错版本时的样子）。
// 因此断言必须钉住**判据本身**，而不是"某处调用了 isTypingTarget"。
//
// 两层：
//   1. 纯逻辑 —— import 生产模块 ../src/keyboardText.js，用真实 DOM 元素（jsdom）跑
//      classifySelectAll 的完整分支表 + selectAllPreviewText 的真实 Range 行为。
//   2. 静态断言 —— 剥注释后扫 App.vue，确认：(a) 不再有内联副本，(b) 每一个需要
//      typing 守卫的落地点都调了 isTypingTarget，(c) Ctrl+A 分支真的查了 classifySelectAll。
//      纯逻辑改不动这些（判据被换掉而调用点不变时纯逻辑仍全绿），所以这层不能省。
//
// 变异验证见文件末尾 MUTATIONS。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import {
  isTypingTarget,
  previewTextRoot,
  selectionPreviewRoot,
  classifySelectAll,
  selectAllPreviewText,
  PREVIEW_TEXT_SELECTOR,
} from "../src/keyboardText.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}

function section(t) {
  console.log(`\n── ${t}`);
}

// ─────────────────────────── fixtures ───────────────────────────

const dom = new JSDOM(
  `<!doctype html><html><body>
     <input class="addr" />
     <textarea class="notes"></textarea>
     <div class="ce" contenteditable="true"></div>
     <div class="plain"></div>
     <div class="file-list"><div class="row">a.txt</div></div>
     <div class="file-preview">
       <pre class="preview-text"><code>hello preview</code></pre>
       <div class="preview-doc"><p>hello docx</p></div>
     </div>
   </body></html>`
);
const document = dom.window.document;
const $ = (sel) => document.querySelector(sel);

const INPUT = $(".addr");
const TEXTAREA = $(".notes");
const CE = $(".ce");
// ⚠️ jsdom does not implement `isContentEditable` — it returns undefined on a
// real contenteditable element. Chromium (and therefore the Tauri WebView2 the
// app actually runs in) does implement it. Seed it explicitly so the assertion
// below tests OUR predicate rather than jsdom's gap; without this the
// contenteditable branch would be silently unreachable in the suite and the
// "contenteditable is a typing target" rule would go untested.
Object.defineProperty(CE, "isContentEditable", { value: true, configurable: true });
const PLAIN = $(".plain");
const ROW = $(".row");
const PRE = $(".preview-text");
const CODE = $(".preview-text code");
const DOC = $(".preview-doc");
const DOC_P = $(".preview-doc p");

// A Selection stub: jsdom implements Range but has no window.getSelection, so
// the selection is injected. `anchorNode` is what selectionPreviewRoot reads.
function fakeSelection(anchorNode, opts = {}) {
  return {
    anchorNode,
    isCollapsed: opts.isCollapsed !== false,
    removeAllRanges() {
      this.removed = true;
    },
    addRange(r) {
      this.added = r;
    },
  };
}

// ─────────────────────── 1. isTypingTarget ───────────────────────

section("isTypingTarget —— 判定输入类元素");

check("INPUT 为 true", isTypingTarget(INPUT) === true);
check("TEXTAREA 为 true", isTypingTarget(TEXTAREA) === true);
check("contenteditable 为 true", isTypingTarget(CE) === true);
check("普通 div 为 false", isTypingTarget(PLAIN) === false);
check("文件行为 false", isTypingTarget(ROW) === false);
check("预览 <pre> 为 false（它不是输入类）", isTypingTarget(PRE) === false);
check("预览 .preview-doc 为 false", isTypingTarget(DOC) === false);
check("null 为 false", isTypingTarget(null) === false);
check("undefined 为 false", isTypingTarget(undefined) === false);
check("body 为 false", isTypingTarget(document.body) === false);

// 这是本次修复的核心前提：如果 <pre> 变成 true，下面的 previewText 分支永远走不到。
check("前置条件：<pre> 不是输入类（否则 previewText 分支恒不可达）", isTypingTarget(PRE) === false);

// ─────────────────── 2. previewTextRoot ───────────────────

section("previewTextRoot —— 预览文本面识别");

check("自身命中 .preview-text", previewTextRoot(PRE) === PRE);
check("子节点命中 .preview-text（closest 向上走）", previewTextRoot(CODE) === PRE);
check("自身命中 .preview-doc", previewTextRoot(DOC) === DOC);
check(".preview-doc 内的 p 命中", previewTextRoot(DOC_P) === DOC);
check("文件行不在预览面内", previewTextRoot(ROW) === null);
check("body 不在预览面内", previewTextRoot(document.body) === null);
check("null 安全", previewTextRoot(null) === null);
check("无 closest 方法的对象安全", previewTextRoot({}) === null);
check("选择器同时含两种面", PREVIEW_TEXT_SELECTOR.includes(".preview-text"));
check("选择器同时含 docx 面", PREVIEW_TEXT_SELECTOR.includes(".preview-doc"));

// ─────────────────── 3. selectionPreviewRoot ───────────────────

section("selectionPreviewRoot —— 选区锚点判定");

check("锚点在 preview 文本里", selectionPreviewRoot(fakeSelection(CODE)) === PRE);
check("锚点是文本节点（nodeType 3）也认", selectionPreviewRoot(fakeSelection(CODE.firstChild)) === PRE);
check("锚点在 docx 里", selectionPreviewRoot(fakeSelection(DOC_P.firstChild)) === DOC);
check("锚点在文件行上 → null", selectionPreviewRoot(fakeSelection(ROW)) === null);
check("折叠选区（纯点击）也算 —— 用户正是要select all", selectionPreviewRoot(fakeSelection(CODE, { isCollapsed: true })) === PRE);
check("无 anchorNode → null", selectionPreviewRoot(fakeSelection(null)) === null);
check("undefined selection → null", selectionPreviewRoot(undefined) === null);

// ─────────────────── 4. classifySelectAll ───────────────────

section("classifySelectAll —— Ctrl+A 的三态判据");

check("焦点在 INPUT → native（交给浏览器）", classifySelectAll(INPUT, fakeSelection(null)) === "native");
check("焦点在 TEXTAREA → native", classifySelectAll(TEXTAREA, fakeSelection(null)) === "native");
check("焦点在 contenteditable → native", classifySelectAll(CE, fakeSelection(null)) === "native");

check("焦点在 preview <pre> → previewText", classifySelectAll(PRE, fakeSelection(null)) === "previewText");
check("焦点在 preview-doc → previewText", classifySelectAll(DOC, fakeSelection(null)) === "previewText");

// 鼠标划选后焦点仍在别处（点击 <pre> 不产生焦点）—— 这正是原 bug 的形状。
check(
  "焦点在文件行但选区在预览文本里 → previewText（原 bug 的形状）",
  classifySelectAll(ROW, fakeSelection(CODE)) === "previewText"
);
check(
  "target 是 body、选区在 docx 里 → previewText",
  classifySelectAll(document.body, fakeSelection(DOC_P.firstChild)) === "previewText"
);

check("焦点在文件行、无选区 → fileGrid", classifySelectAll(ROW, fakeSelection(null)) === "fileGrid");
check("target 是 body、无选区 → fileGrid", classifySelectAll(document.body, fakeSelection(null)) === "fileGrid");
check("无 selection 对象 → fileGrid（不吞键）", classifySelectAll(ROW, undefined) === "fileGrid");
check("无 target → fileGrid", classifySelectAll(null, fakeSelection(null)) === "fileGrid");

// 三态互斥：native 与 previewText 不得同时成立（INPUT 优先于选区）。
check("INPUT 优先于预览选区", classifySelectAll(INPUT, fakeSelection(CODE)) === "native");

// ─────────────────── 5. selectAllPreviewText ───────────────────

section("selectAllPreviewText —— 真实 Range 行为");

{
  const sel = fakeSelection(null);
  const ok = selectAllPreviewText(PRE, document, { getSelection: () => sel });
  check("返回 true", ok === true);
  check("调用了 removeAllRanges（先清旧选区）", sel.removed === true);
  check("调用了 addRange", sel.added !== undefined);
  check(
    "Range 覆盖整个 <pre> 的内容",
    sel.added && sel.added.toString() === "hello preview",
    sel.added ? sel.added.toString() : "(no range)"
  );
  check(
    "Range 是 document 造的（可用于 selectNodeContents）",
    sel.added && typeof sel.added.selectNodeContents === "function"
  );
}

{
  const sel = fakeSelection(null);
  selectAllPreviewText(DOC, document, { getSelection: () => sel });
  check("docx 面同样全选", sel.added && sel.added.toString() === "hello docx", sel.added ? sel.added.toString() : "(no range)");
}

check("root 为 null → false（调用方可回落文件网格）", selectAllPreviewText(null, document, { getSelection: () => fakeSelection(null) }) === false);
check("document 缺失 → false", selectAllPreviewText(PRE, null, { getSelection: () => fakeSelection(null) }) === false);
check("view 无 getSelection → false", selectAllPreviewText(PRE, document, {}) === false);
check("view 为 null → false", selectAllPreviewText(PRE, document, null) === false);
{
  // getSelection 返回 null 的 webview 也要能回落。
  check("getSelection 返 null → false", selectAllPreviewText(PRE, document, { getSelection: () => null }) === false);
}

// 端到端：判据 + 执行，验证「预览文本全选」这个用户可见行为。
{
  const sel = fakeSelection(null);
  const intent = classifySelectAll(ROW, fakeSelection(CODE));
  const root = selectionPreviewRoot(fakeSelection(CODE));
  selectAllPreviewText(root, document, { getSelection: () => sel });
  check(
    "端到端：文件行焦点 + 预览选区 → 选中文本而非文件",
    intent === "previewText" && sel.added.toString() === "hello preview"
  );
}
{
  // 对照臂：同一场景下旧行为（只判 INPUT）会走 fileGrid。
  const oldGuard = (t) => !!(t && t.tagName === "INPUT");
  check("对照臂：旧守卫在该场景下判false → 会误选文件列表", oldGuard(ROW) === false);
  check("对照臂：旧守卫对 TEXTAREA/contenteditable 也判false（漏项）", oldGuard(TEXTAREA) === false && oldGuard(CE) === false);
}

// ─────────────────── 6. 静态断言（落地点） ───────────────────

section("静态断言 —— App.vue / FilePreview.vue 的落地点");

const appSrc = stripComments(fs.readFileSync(path.join(ROOT, "src/App.vue"), "utf8"));
const fpSrc = stripComments(fs.readFileSync(path.join(ROOT, "src/components/FilePreview.vue"), "utf8"));

// 6a. 本地副本已删除，只剩导入。
check(
  "App.vue 不再定义本地 isTypingTarget",
  !/function\s+isTypingTarget\s*\(/.test(appSrc)
);
check(
  "App.vue 从 ./keyboardText.js 导入 isTypingTarget",
  /import\s*\{[^}]*\bisTypingTarget\b[^}]*\}\s*from\s*["']\.\/keyboardText\.js["']/.test(appSrc)
);

// 6b. 内联的 INPUT/TEXTAREA/contenteditable 副本已全部消失。
//     ⚠️ 反面也成立：rename-input 那两处（F5 / Ctrl+M）**必须还是窄守卫** —— 它们
//     只避让改名框，让F5 继续在地址栏/筛选框里生效。把它改成 isTypingTarget 是
//     行为变更而非收敛，两条都要钉住。
check(
  "App.vue 不再有裸的 INPUT/TEXTAREA/contenteditable 内联副本",
  !/tagName\s*===\s*["']INPUT["'][\s\S]{0,120}tagName\s*===\s*["']TEXTAREA["']/.test(appSrc)
);
check(
  "App.vue 不再有裸的 isContentEditable 内联判定",
  !/tagName\s*===\s*["']INPUT["'][\s\S]{0,120}isContentEditable/.test(appSrc)
);
{
  const narrow = appSrc.match(/tagName\s*===\s*["']INPUT["']\s*&&\s*\w+\.classList\.contains\(["']rename-input["']\)/g) || [];
  check(
    `rename-input 窄守卫仍是 ${narrow.length} 处（期望 2：F5 与 Ctrl+M，未被误改为 isTypingTarget）`,
    narrow.length === 2
  );
}

// 6c. 三个落地点都调了唯一入口。数出全部调用点逐个检查，而不是"某处存在"。
{
  const sites = appSrc.match(/\bisTypingTarget\s*\(/g) || [];
  // 文件当前有 7 处调用，逐个核对（行号会随编辑漂移，判据是数量+语义）：
  //   restoreActiveListFocus / Esc 守卫 / Ctrl+C·X·V 守卫 / Ctrl+Z 撤销 /
  //   bookmark.toggle / view.toggleHidden / bare-Tab 守卫
  // 另有两处 `t.tagName === "INPUT" && classList.contains("rename-input")`
  // 是**有意**的窄语义（F5 / Ctrl+M 只避让改名框，不避让其它输入框），
  // 不走 isTypingTarget，也不该被这里的断言当成副本。
  check(
    `isTypingTarget 调用点共 ${sites.length} 处（期望 7，逐个核对）`,
    sites.length === 7
  );
  // 每个落地点都真的判了 —— 不只看数量。
  for (const [label, needle] of [
    ["restoreActiveListFocus", "if (isTypingTarget(el)) return;"],
    ["Esc 守卫", "if (!isTypingTarget(e.target)) {"],
    ["Ctrl+C/X/V 守卫", "if (isTypingTarget(e.target)) {"],
    ["bookmark.toggle", "if (isTypingTarget(e.target)) {"],
    ["bare-Tab 守卫", "if (isTypingTarget(t)) return;"],
  ]) {
    check(`落地点存在：${label}`, appSrc.includes(needle));
  }
  check(
    "bookmark.toggle 与 view.toggleHidden 两处都已收敛",
    (appSrc.match(/if \(isTypingTarget\(e\.target\)\) \{\s*return;/g) || []).length === 3
  );
}

// 6d. Ctrl+A 分支真的查了 classifySelectAll，且两条落地路径都在。
check(
  "App.vue 调用了 classifySelectAll",
  /\bclassifySelectAll\s*\(/.test(appSrc)
);
check(
  "App.vue 调用了 selectAllPreviewText",
  /\bselectAllPreviewText\s*\(/.test(appSrc)
);
check(
  "Ctrl+A 分支在 preventDefault 之前先判意图",
  /const intent = classifySelectAll\(e\.target, window\.getSelection\(\)\);[\s\S]{0,80}if \(intent === "native"\) return;/.test(appSrc)
);
{
  // native 分支必须「不消费事件」，否则 Ctrl+A 在输入框里会既 preventDefault 又 return。
  const branch = appSrc.slice(appSrc.indexOf('if (intent === "native") return;'));
  check(
    'native 分支之后紧跟 preventDefault（native 自身不 preventDefault）',
    branch.slice(0, 200).indexOf("e.preventDefault()") > 0
  );
}
{
  // previewText 分支必须能回落 fileGrid（没有 Selection 时不能吞键）。
  const branch = appSrc.slice(appSrc.indexOf('if (intent === "previewText")'));
  check(
    "previewText 分支在 selectAllPreviewText 失败时回落文件网格",
    /selectAllPreviewText\(root, document, window\)\) return;[\s\S]{0,200}getActivePanelRef\(\)\?\.selectAll\?\.\(\)/.test(branch.slice(0, 500))
  );
}

// 6e. 两个预览面都可聚焦（否则键盘用户根本到不了，判据只对鼠标划选生效）。
check(".preview-text 有 tabindex", /class="preview-text"[^>]*tabindex="0"/.test(fpSrc) || /tabindex="0"[^>]*class="preview-text"/.test(fpSrc));
check(".preview-doc 有 tabindex", /class="preview-doc"[^>]*tabindex="0"/.test(fpSrc) || /tabindex="0"[^>]*class="preview-doc"/.test(fpSrc));

// ─────────────────────── report ───────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}

// ─────────────────────── MUTATIONS ───────────────────────
// 想验证断言有分辨力，跑：
//   node scripts/keyboard-text-check.mjs --mutate
// 每个变异都应导致 FAIL。变异注入后会打印 `anchor found: N` 并 assert N == 1，
// 否则「0 FAIL」无法区分「断言瞎」与「变异没进去」（METHODOLOGY.md）。

if (process.argv.includes("--mutate")) {
  console.log(`\n${"═".repeat(50)}\n变异测试（每个都应 FAIL）\n${"═".repeat(50)}`);
  const KB = path.join(ROOT, "src/keyboardText.js");
  const APP = path.join(ROOT, "src/App.vue");
  const FP = path.join(ROOT, "src/components/FilePreview.vue");
  const originals = new Map(
    [KB, APP, FP].map((f) => [f, fs.readFileSync(f, "utf8")])
  );
  const originalKb = originals.get(KB);
  const originalApp = originals.get(APP);

  const mutations = [
    {
      name: "① previewTextRoot 的选择器漏掉 .preview-doc（docx 面不再被识别）",
      file: KB,
      from: 'export const PREVIEW_TEXT_SELECTOR = ".preview-text, .preview-doc";',
      to: 'export const PREVIEW_TEXT_SELECTOR = ".preview-text";',
    },
    {
      name: "② isTypingTarget 漏掉 TEXTAREA（回到旧守卫的漏项）",
      file: KB,
      from: 'if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;',
      to: 'if (el.tagName === "INPUT") return true;',
    },
    {
      name: "③ classifySelectAll 去掉选区判定（回到原 bug：只看焦点）",
      file: KB,
      from: "  if (previewTextRoot(target)) return \"previewText\";\n  if (selectionPreviewRoot(selection)) return \"previewText\";",
      to: "  if (previewTextRoot(target)) return \"previewText\";",
    },
    {
      name: "④ selectAllPreviewText 不再清旧选区（选区会叠加）",
      file: KB,
      from: "  selection.removeAllRanges();\n  selection.addRange(range);",
      to: "  selection.addRange(range);",
    },
    {
      name: "⑤ selectionPreviewRoot 要求非折叠选区（纯点击时判据失效）",
      file: KB,
      from: "  if (!selection || !selection.anchorNode) return null;",
      to: "  if (!selection || !selection.anchorNode || selection.isCollapsed) return null;",
    },
    {
      name: "⑥ App.vue 的 Ctrl+A 分支不再判意图（守卫被摘掉）",
      file: APP,
      from: 'const intent = classifySelectAll(e.target, window.getSelection());\n      if (intent === "native") return;',
      to: 'const intent = "fileGrid";',
    },
    {
      name: "⑦ App.vue 重新引入本地 isTypingTarget 副本（收敛被破坏）",
      file: APP,
      from: "  if (isHandled(e)) return;",
      to: "  if (isHandled(e)) return;\n  function isTypingTarget(el) { return el && el.tagName === \"INPUT\"; }",
    },
    {
      name: "⑧ 把 rename-input 窄守卫误改为 isTypingTarget（F5 在筛选框里失效）",
      file: APP,
      from: '      if (t && t.tagName === "INPUT" && t.classList.contains("rename-input")) return;\n      // Resolve BOTH bindings',
      to: "      if (isTypingTarget(t)) return;\n      // Resolve BOTH bindings",
    },
    {
      name: "⑨ 把一个落地点换回内联三段判定（收敛被破坏）",
      file: APP,
      from: "      if (isTypingTarget(e.target)) {\n        return;\n      }\n      const panelId = activePanel.value;",
      to: '      const t = e.target;\n      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {\n        return;\n      }\n      const panelId = activePanel.value;',
    },
    {
      name: "⑩ FilePreview 的 .preview-text 去掉 tabindex（键盘用户到不了预览文本）",
      file: path.join(ROOT, "src/components/FilePreview.vue"),
      from: 'class="preview-text" tabindex="0"',
      to: 'class="preview-text"',
    },
  ];

  for (const m of mutations) {
    const src = originals.get(m.file);
    if (src === undefined) {
      console.log(`\n▶ ${m.name}\n  ⚠️ 未知文件 ${m.file}，跳过`);
      failures.push(`变异目标文件未知：${m.file}`);
      continue;
    }
    const count = src.split(m.from).length - 1;
    console.log(`\n▶ ${m.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(m.file, src.replace(m.from, m.to), "utf8");
    // 用子进程重跑本脚本的断言部分。
    const { execFileSync } = await import("node:child_process");
    let failedNow = 0;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
    } catch (err) {
      failedNow = 1;
    }
    fs.writeFileSync(m.file, src, "utf8");
    if (failedNow) {
      passed++;
      console.log("  ok   变异被断言抓到（FAIL 如预期）");
    } else {
      failures.push(`变异未被抓到：${m.name}`);
      console.log("  FAIL 变异未被断言抓到 —— 该断言是恒真的");
    }
  }

  console.log(`\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`);
  if (failures.length) process.exitCode = 1;
}