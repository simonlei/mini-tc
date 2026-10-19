// 验证 App.vue 的全局 keydown 监听器是「具名 + 对称增删」，而不是 onMounted 里的匿名箭头。
// 直接 `node scripts/global-keydown-check.mjs` 跑；`-- --mutate` 跑变异臂。
//
// 判据（为什么静态断言在这里是唯一可行的形态）：
//   这个 bug 的形状是**注册与移除不对称**。匿名箭头一旦交给 addEventListener，
//   onUnmounted 手里就没有可传给 removeEventListener 的引用 —— DOM 上那份注册
//   永远留着，且闭包钉住整个组件作用域。
//   纯逻辑断言管不了它：`onGlobalKeydown` 的函数体搬前搬后完全一样，行为一模一样。
//   所以只能断言**注册与移除引用同一个具名标识符**（下面第 2 组）。
//
// ⚠️ METHODOLOGY.md 的两条纪律在这里都适用，且都实测踩过：
//   1. **静态断言会自引用**：判据是「文件里出现 onGlobalKeydown 这个名字」，而本文件
//      的注释里就写着它 → 剥注释后再扫（scripts/stripComments.cjs）。但注意：即使剥了
//      注释，本文件自己的注释被剥掉后 App.vue 里那个名字仍在，判据仍然是自指的 ——
//      所以下面刻意不用「名字存在」当判据，而是用**配对关系**：add 与 remove 必须
//      引用同一个标识符，且这个标识符必须是有声明的具名函数。
//   2. **「存在即可」型断言恒绿**：只查「App.vue 里有 addEventListener("keydown")」
//      改回匿名也照样过。→ 第 1 组逐个列出所有 keydown 注册点并要求它们全部具名，
//      第 3 组数出 add/remove 的数量并要求相等。
//
// 变异臂在文件末尾 MUTATIONS：每个都应导致 FAIL，且脚本打印 `anchor found: N`
// 并要求恰好 1 —— 否则「0 FAIL」分不清「断言瞎」与「变异没进去」。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stripCommentsMod from "./stripComments.cjs";

const stripComments = stripCommentsMod.stripComments || stripCommentsMod;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "src", "App.vue");

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

const raw = fs.readFileSync(APP, "utf8");
const app = stripComments(raw);

// ─────────────── 1. 每一个 keydown 注册点都必须具名 ───────────────

section("1. keydown 注册点逐个检查（不是「存在即可」）");

// 匹配形如  <target>.addEventListener("keydown", <second arg>) 的调用，跨行也行
// （第二个参数若换行书写，靠这个 [\s\S]*? 仍然能取到）。刻意不剥引号内容之外的字符。
const KEYDOWN_ADD =
  /([A-Za-z_$][\w$.]*)\s*\.\s*addEventListener\s*\(\s*(["'])keydown\2\s*,\s*([\s\S]*?)\)\s*;/g;

const addSites = [];
let m;
while ((m = KEYDOWN_ADD.exec(app)) !== null) {
  addSites.push({ target: m[1], handler: m[3].trim(), index: m.index, raw: m[0] });
}

check(
  `App.vue 里有 ${addSites.length} 处 keydown 注册（期望 1；>1 说明新增了注册点，需同步核对移除）`,
  addSites.length >= 1
);

// 匿名形式：第二个参数不是裸标识符（`=>`、`function`、或任何表达式）。
// 判据是「handler 就是一个标识符」，而不是「handler 里没有箭头」——
// 后者会被 `onGlobalKeydown && guard()` 这种写法骗过。
const IDENT = /^[A-Za-z_$][\w$]*$/;
for (const site of addSites) {
  check(
    `注册点 ${site.target}.addEventListener("keydown", …) 传入的是具名标识符而非匿名函数`,
    IDENT.test(site.handler)
  );
  check(
    `注册点 ${site.target}.addEventListener("keydown", …) 传的不是 function 表达式`,
    !/^(function\b|\(?[^)]*\)?\s*=>)/.test(site.handler)
  );
}

// ─────────────── 2. 移除点必须与注册点引用同一标识符 ───────────────

section("2. 注册与移除的引用必须配对");

const KEYDOWN_REMOVE =
  /([A-Za-z_$][\w$.]*)\s*\.\s*removeEventListener\s*\(\s*(["'])keydown\2\s*,\s*([\s\S]*?)\)\s*;/g;

const remSites = [];
while ((m = KEYDOWN_REMOVE.exec(app)) !== null) {
  remSites.push({ target: m[1], handler: m[3].trim(), index: m.index, raw: m[0] });
}

check(
  `keydown 移除点 ${remSites.length} 处、注册点 ${addSites.length} 处（期望相等 —— 少一个就是这条 TODO 的 bug）`,
  remSites.length === addSites.length
);

for (const a of addSites) {
  const partners = remSites.filter((r) => r.handler === a.handler);
  check(
    `注册用的标识符在移除处原样出现（${a.target} / ${a.handler}）`,
    partners.length === 1
  );
}

// ─────────────── 3. 移除必须发生在 onUnmounted 里 ───────────────

section("3. 移除点在 onUnmounted 内（不是在别处顺手移除）");

// 取 onUnmounted 的调用块：从 `onUnmounted(` 起，配平到对应的 `});`。
// METHODOLOGY.md 记着一次教训：抽函数体用 indexOf("{") 会在**默认参数的花括号**上
// 配平错位。这里 onUnmounted 是无参的，但仍按「先跳到 body 的 `{` 再配平」写，
// 避免同一个坑以另一种形式回来。
const unmountIdx = app.indexOf("onUnmounted(");
check("App.vue 存在 onUnmounted 调用", unmountIdx >= 0);

let unmountBody = "";
if (unmountIdx >= 0) {
  const braceAt = app.indexOf("{", unmountIdx + "onUnmounted(".length);
  let depth = 0;
  let i = braceAt;
  for (; i < app.length; i++) {
    const ch = app[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  unmountBody = app.slice(braceAt, i + 1);
  check("onUnmounted 的花括号成功配平（抽到了完整的调用块）", depth === 0 && unmountBody.length > 0);
}

for (const r of remSites) {
  check(
    `移除 ${r.target}.removeEventListener("keydown", ${r.handler}) 在 onUnmounted 内`,
    unmountBody.includes(r.raw.replace(/\s+/g, " ")) ||
      unmountBody.includes(`removeEventListener("keydown", ${r.handler})`)
  );
}

// ─────────────── 4. 具名函数必须真的被声明（不是只被引用） ───────────────

section("4. 被注册的标识符是一个已声明的具名函数（不是 undefined）");

const declaredNames = new Set(
  [...app.matchAll(/(?:^|[^\w$.])(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g)].map(
    (mm) => mm[1] || mm[2]
  )
);

for (const a of addSites) {
  check(
    `注册时用的标识符 ${a.handler} 有声明（否则 addEventListener 收到 undefined，静默无操作）`,
    declaredNames.has(a.handler)
  );
}

// onGlobalKeydown 应声明为 function（可被 removeEventListener 引用同一个引用）；
// 若改成 `const onGlobalKeydown = (e) => {...}` 仍可配对，但那条路径容易在
// HMR 下重新赋值 —— 这里不禁止，只要求「声明存在且有且只有一处」。
{
  const declCount = (app.match(/function\s+onGlobalKeydown\s*\(/g) || []).length;
  check(`onGlobalKeydown 只声明了一次（期望 1，实际 ${declCount}）`, declCount === 1);
}

// ─────────────── 5. 定位：handler 体真的还在（搬移没把逻辑弄丢） ───────────────

section("5. 搬移后 handler 体完整（旧实现的判据一个没少）");

// 这些是全局快捷键的判据行，逐个钉住。取样覆盖不同分支：模态闸门、Esc、
// Ctrl+Q、Ctrl+A、剪贴板、撤销、F5/Shift+F5、Alt+←/→、书签、隐藏文件、面板切换。
{
  const anchors = [
    ["isHandled 前置守卫", "if (isHandled(e)) return;"],
    ["搜索对话框闸门", "if (searchVisible.value) return;"],
    ["批量改名闸门", "if (batchRenameVisible.value) return;"],
    ["confirm 闸门", "if (confirmDialog.value.visible) return;"],
    ["Esc 关预览", 'matches("preview.close", e)'],
    ["Ctrl+Q", 'matches("preview.toggle", e)'],
    ["Ctrl+F/Alt+F7", 'matches("search.open", e)'],
    ["Ctrl+A", 'matches("edit.selectAll", e)'],
    ["剪贴板三分支", 'const isPaste = matches("edit.paste", e);'],
    ["撤销删除", 'matches("edit.undoDelete", e)'],
    ["F5 复制到对面", 'matches("edit.copyToOther", e)'],
    ["Shift+F5 移动到对面", 'matches("edit.moveToOther", e)'],
    ["历史后退", 'matches("nav.back", e)'],
    ["书签", 'matches("bookmark.toggle", e)'],
    ["隐藏文件", 'matches("view.toggleHidden", e)'],
    ["面板切换", 'matches("panel.switch", e)'],
  ];
  for (const [label, needle] of anchors) {
    check(`分支仍在：${label}`, app.includes(needle));
    // ⚠️ 「存在即可」在这里是恒绿的：`false && matches("preview.toggle", e)`
    // 同样包含这段文本，但分支已成死代码（变异⑤ 实测 0 FAIL 逃过）。
    // → 判据必须是**该分支的条件**不含恒假前缀，而不只是那段字面量还在。
    const cond = conditionOf(app, needle);
    check(
      `分支不是死代码：${label}`,
      cond !== null &&
        !/^\s*(false\s*&&|0\s*&&|true\s*\|\||1\s*\|\||""\s*&&)\s/.test(cond)
    );
    check(
      `分支的条件可定位（判据自身有效）：${label}`,
      cond !== null
    );
  }
}

// 返回 needle 所在分支的 `if (...)` 条件文本（不含 `if (` 与右括号）。
// 从 needle 处向前找最近的 `if (`，再从那里配平圆括号取条件。
//
// ⚠️ METHODOLOGY.md 记着两个坑，这里都规避：
//   · 「抽函数体用 indexOf("{", at)」会在默认参数的花括号上配平错位 —— 本函数只配平
//     圆括号，且起点固定在 `if (` 之后，不跨 `{}`。
//   · 「静态断言会自引用」—— `app` 已剥注释，否则注释里写的 if 语句会被当代码。
// 取不到时返回 null（调用方据此断言「判据自身有效」，而不是悄悄跳过）。
function conditionOf(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const head = src.lastIndexOf("if (", at);
  if (head < 0) return null;
  const open = head + "if ".length; // 指向 '('
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

// handler 体必须落在 onGlobalKeydown 的声明之后（即它确实是这个函数的体，
// 而不是碰巧存在于文件别处）。
{
  const fnAt = app.indexOf("function onGlobalKeydown(e) {");
  check("onGlobalKeydown 声明存在", fnAt >= 0);
  check(
    "handler 体的分支都在声明之后（不是文件别处的另一个函数）",
    fnAt >= 0 && app.indexOf('matches("panel.switch", e)') > fnAt
  );
  check(
    "onMounted 的注册发生在函数声明之前（function 声明会提升，调用顺序安全）",
    fnAt >= 0 && app.indexOf('addEventListener("keydown", onGlobalKeydown)') < fnAt
  );
}

// ─────────────── 6. 对照臂：旧写法确实会被判据抓到 ───────────────

section("6. 对照臂 —— 匿名写法在本判据下必须失败");

{
  // 旧实现的样子：注册一个匿名箭头，onUnmounted 里无法成对移除。
  const oldStyle =
    'onMounted(() => {\n  document.addEventListener("keydown", (e) => {\n    void e;\n  });\n});\n' +
    'onUnmounted(() => {\n  appUnmounted = true;\n});\n';
  const oldAdd = [];
  const re = new RegExp(KEYDOWN_ADD.source, "g");
  let mm2;
  while ((mm2 = re.exec(oldStyle)) !== null) oldAdd.push({ target: mm2[1], handler: mm2[3].trim() });
  check(
    `对照臂：旧实现被识别为 1 处注册（实际 ${oldAdd.length}）`,
    oldAdd.length === 1
  );
  check(
    "对照臂：旧实现的 handler 不是裸标识符 → 判据会 FAIL（断言有分辨力）",
    !IDENT.test(oldAdd[0]?.handler ?? "")
  );
  const oldRemove = [];
  const re2 = new RegExp(KEYDOWN_REMOVE.source, "g");
  while ((mm2 = re2.exec(oldStyle)) !== null) oldRemove.push(mm2[3].trim());
  check(
    `对照臂：旧实现 0 处 keydown 移除，与注册数不等 → 数量断言会 FAIL（实际 ${oldRemove.length}）`,
    oldRemove.length === 0
  );
}

// ─────────────── report ───────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}

// ─────────────── MUTATIONS ───────────────
//   node scripts/global-keydown-check.mjs --mutate
// 每个变异都应导致 FAIL。

if (process.argv.includes("--mutate")) {
  console.log(`\n${"═".repeat(50)}\n变异测试（每个都应 FAIL）\n${"═".repeat(50)}`);
  const original = fs.readFileSync(APP, "utf8");

  const mutations = [
    {
      name: "① 改回匿名箭头注册（原 bug 的形状）",
      from: 'document.addEventListener("keydown", onGlobalKeydown);',
      to: 'document.addEventListener("keydown", (e) => {\n    void e;\n  });',
    },
    {
      name: "② 删掉 onUnmounted 里的 removeEventListener（只加不删）",
      from: '  document.removeEventListener("keydown", onGlobalKeydown);\n',
      to: "",
    },
    {
      name: "③ 移除时引用另一个名字（看起来成对，实则不是同一个引用）",
      from: 'document.removeEventListener("keydown", onGlobalKeydown);',
      to: 'document.removeEventListener("keydown", onGlobalKeydown2);',
    },
    {
      name: "④ 把具名函数删掉（注册一个未声明的标识符 → addEventListener 收到 undefined）",
      from: "function onGlobalKeydown(e) {",
      to: "function onGlobalKeydownTypo(e) {",
    },
    {
      name: "⑤ 注册点存在但 handler 体被掏空（搬移时把逻辑弄丢）",
      from: 'if (matches("preview.toggle", e)) {',
      to: 'if (false && matches("preview.toggle", e)) {',
    },
  ];

  const { execFileSync } = await import("node:child_process");
  for (const mu of mutations) {
    const count = original.split(mu.from).length - 1;
    console.log(`\n▶ ${mu.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      failures.push(`变异目标未唯一命中：${mu.name}`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(APP, original.split(mu.from).join(mu.to), "utf8");
    let failedNow = 0;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
    } catch {
      failedNow = 1;
    }
    fs.writeFileSync(APP, original, "utf8");
    if (failedNow) {
      passed++;
      console.log("  ok   变异被断言抓到（FAIL 如预期）");
    } else {
      failures.push(`变异未被抓到：${mu.name}`);
      console.log("  FAIL 变异未被断言抓到 —— 该断言是恒真的");
    }
  }

  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
  if (failures.length) process.exitCode = 1;
}
