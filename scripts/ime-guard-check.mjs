// 验证「IME composition 期间的 keydown 不被任何快捷键处理器认领」。
//
// 直接 `node scripts/ime-guard-check.mjs`；`-- --mutate` 跑变异臂。
//
// ── 这个 bug 的形状 ────────────────────────────────────────────────
// `matches()`（shortcuts.js）用 `eventCombo(e)` 从 `e.code` 拼组合键，
// **完全不看 composition 状态**。所以「keydown 属于输入法」这件事对
// shortcuts.js 是不可见的，只要处理器忘了守卫就会照常认领。
// FileList.vue 的三个 keydown 处理器里，`onSearchKeydown` /`onRenameKeydown`
// 写了守卫，唯独主处理器 `onKeydown`（认领全部 18 个 list.* 绑定）没写。
//
// ── ⚠️ TODO 原文的因果被实测推翻了一半 ─────────────────────────────
// 原文说「首个拼音字母的 keydown 带 keyCode 229，matches() 照常命中」。
// 实测**拼音字母不命中**：字母的 `e.code` 是 `KeyN` → 事件组合是 "N"，
// 而没有任何 list.* 命令绑定到单个字母。真正泄漏的是**功能键**：
// IME 在选词/上屏时按下的 Space / Enter / Backspace 等，webview 报
// keyCode 229 而 e.code 仍是 Space / Enter / Backspace —— 这些
// **全部命中**。实测 18 个默认绑定**无一幸免**（18/18）。
// 修法不变（补守卫），但「首个拼音字母」这个说法是错的，别照它推理。
//
// ── 三层断言 ───────────────────────────────────────────────────────
//   1. 纯逻辑：import 生产 `isImeKeydown` + 生产 `matches()`，用真实
//      KeyboardEvent 形状跑全表 → 对照臂是「去掉守卫后同一个事件会命中」。
//   2. 静态断言：守卫必须在**每个** keydown 处理器的**第一个 matches() 之前**
//      （位置错了就是死代码 —— 方法论记着「顺序断言比 indexOf 更难糊弄」，
//      但也记着「判据自引用」；下面用的是配平函数体 + 比位置，且已剥注释）。
//      另外钉住「唯一入口」：不得再有内联的 `e.keyCode === 229` 副本。
//   3. 变异臂：每个变异都应 FAIL，且脚本打印 `anchor found: N` 要求恰好 1。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mod from "./stripComments.cjs";
import { isImeKeydown } from "../src/keyboardText.js";
import { matches, COMMANDS } from "../src/shortcuts.js";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILELIST = path.join(ROOT, "src", "components", "FileList.vue");
const DIALOG = path.join(ROOT, "src", "components", "ShortcutsDialog.vue");

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

// ── fixtures：真实 KeyboardEvent 的形状 ─────────────────────────────
// 只取 KeyboardEvent 里 shortcuts.js 真正读到的字段（见 eventKeyName /
// eventCombo）：code / key / 四种 modifier / keyCode / isComposing。
function ev(o = {}) {
  return {
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    isComposing: false, keyCode: 0, key: "", code: "",
    ...o,
  };
}

// `list.*` 的全部默认绑定 → [combo, 事件形状]。
// ⚠️ 期望值是**实测**出来的，不是照 COMMANDS 反推的：变异臂③ 会让探针自己
// 打印真实命中结果，两边必须一致，否则说明我的事件形状建模错了。
const LIST_CMBIOS = [
  { cmd: "Space", code: "Space", key: " ", label: "空格（选词）" },
  { cmd: "Enter", code: "Enter", key: "Enter", label: "回车（上屏）" },
  { cmd: "Backspace", code: "Backspace", key: "Backspace", label: "退格" },
  { cmd: "/", code: "Slash", key: "/", label: "斜杠" },
  { cmd: "ArrowUp", code: "ArrowUp", key: "ArrowUp", label: "↑" },
  { cmd: "ArrowDown", code: "ArrowDown", key: "ArrowDown", label: "↓" },
  { cmd: "Shift+ArrowUp", code: "ArrowUp", key: "ArrowUp", shiftKey: true, label: "Shift+↑" },
  { cmd: "Shift+ArrowDown", code: "ArrowDown", key: "ArrowDown", shiftKey: true, label: "Shift+↓" },
  { cmd: "PageUp", code: "PageUp", key: "PageUp", label: "PgUp" },
  { cmd: "PageDown", code: "PageDown", key: "PageDown", label: "PgDn" },
  { cmd: "Shift+PageUp", code: "PageUp", key: "PageUp", shiftKey: true, label: "Shift+PgUp" },
  { cmd: "Shift+PageDown", code: "PageDown", key: "PageDown", shiftKey: true, label: "Shift+PgDn" },
  { cmd: "Home", code: "Home", key: "Home", label: "Home" },
  { cmd: "End", code: "End", key: "End", label: "End" },
  { cmd: "Shift+Home", code: "Home", key: "Home", shiftKey: true, label: "Shift+Home" },
  { cmd: "Shift+End", code: "End", key: "End", shiftKey: true, label: "Shift+End" },
  { cmd: "Delete", code: "Delete", key: "Delete", label: "Delete" },
  { cmd: "F2", code: "F2", key: "F2", label: "F2" },
];

const LIST_IDS = COMMANDS.filter((c) => c.scope === "fileList").map((c) => c.id);

function composingEvent(spec, extra = {}) {
  return ev({
    code: spec.code,
    key: spec.key,
    shiftKey: !!spec.shiftKey,
    keyCode: 229,
    ...extra,
  });
}

// ══════════════ 1. 纯逻辑 ══════════════

section("1. isImeKeydown 的真值表（import 生产函数）");

check("无参数 → false", isImeKeydown(undefined) === false);
check("null → false", isImeKeydown(null) === false);
check("普通事件（无 composition）→ false", isImeKeydown(ev({ code: "Space", key: " ", keyCode: 32 })) === false);
check("isComposing=true → true", isImeKeydown(ev({ isComposing: true })) === true);
check("keyCode=229 → true（启动 composition 的那个键）", isImeKeydown(ev({ keyCode: 229 })) === true);
check(
  "isComposing=undefined 且 keyCode=0 → false（不能把 undefined 当 true）",
  isImeKeydown(ev({ isComposing: undefined, keyCode: 0 })) === false
);
check(
  "isComposing=0（某些 webview 给数字）→ false，不是真",
  isImeKeydown(ev({ isComposing: 0, keyCode: 0 })) === false
);
check(
  "Ctrl+V 且 keyCode=229 → 仍然 true（修饰键不改变 composition 事实）",
  isImeKeydown(ev({ keyCode: 229, ctrlKey: true })) === true
);
check(
  "keyCode=229 但 isComposing=false → true（两个信号各自都足够）",
  isImeKeydown(ev({ keyCode: 229, isComposing: false })) === true
);

section("2. 守卫存在时：composition 事件一个都认领不了（真实 matches()）");

for (const spec of LIST_CMBIOS) {
  const e = composingEvent(spec);
  // 守卫的语义：有守卫就 return，一个命令都不该命中。
  const hit = isImeKeydown(e) ? [] : LIST_IDS.filter((id) => matches(id, e));
  check(
    `kc=229 时 ${spec.label.padEnd(14)} （${spec.cmd}）不被认领`,
    hit.length === 0
  );
}

section("3. 对照臂 —— 去掉守卫，同一批事件真的会被认领（否则上面全是恒真）");

// ⚠️ 这一组是本套件的分辨力来源。若哪天 matches() 自己学会了看
// composition（那 bug 就从根上没了），第2 组会照样全绿 —— 只有这组会 FAIL。
{
  const leaks = [];
  for (const spec of LIST_CMBIOS) {
    const e = composingEvent(spec);
    const hit = LIST_IDS.filter((id) => matches(id, e));
    if (hit.length) leaks.push(`${spec.cmd}->${hit.join("+")}`);
  }
  check(
    `无守卫时 18 个绑定键全部泄漏（实测 ${leaks.length} 个）`,
    leaks.length === LIST_CMBIOS.length
  );
  console.log(`       泄漏清单：${leaks.join("  ")}`);
  // 钉住具体的三条：它们是用户真正常按的（选词 / 上屏 / 退格）。
  const leakSet = new Set(leaks);
  check("对照臂含 Space -> list.dirSize（选词时触发算目录大小）", leakSet.has("Space->list.dirSize"));
  check("对照臂含 Enter -> list.open（选词时直接打开文件）", leakSet.has("Enter->list.open"));
  check("对照臂含 Backspace -> list.parent（选词时跳回上级）", leakSet.has("Backspace->list.parent"));
  check(
    "TODO 原文的「首个拼音字母会命中」实测为假 —— 别照它推理",
    !leakSet.has("K->list.open") && !LIST_IDS.some((id) => matches(id, ev({ code: "KeyN", key: "n", keyCode: 229 })))
  );
}

section("4. 反向：非 composition 的普通按键仍然正常命中（守卫不能过度拦截）");

{
  const plain = {
    Space: ["Space", " "], Enter: ["Enter", "Enter"], Backspace: ["Backspace", "Backspace"],
  };
  for (const [cmd, [code, key]] of Object.entries(plain)) {
    const e = ev({ code, key, keyCode: code === "Space" ? 32 : 0 });
    check(`普通 ${cmd} 不被守卫拦截`, isImeKeydown(e) === false);
  }
  // 真命中一次，确认对照组本身有效（不是「谁都不命中」的假对照）。
  const space = ev({ code: "Space", key: " ", keyCode: 32 });
  check(
    "对照组有效：普通 Space 确实命中 list.dirSize",
    matches("list.dirSize", space) === true
  );
}

// ══════════════ 5. 静态断言 ══════════════

const listSrc = stripComments(fs.readFileSync(FILELIST, "utf8"));
const dialogSrc = stripComments(fs.readFileSync(DIALOG, "utf8"));

// 从 `function <name>(` 起配平花括号抽函数体。
// ⚠️ 方法论记着：起点必须先跳过参数列表再找 `{`，否则默认参数里的花括号
// 会让配平错位（onDelete(targets, opts = {}) 就是那个案例）。
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

section("5. 每个 keydown 处理器都在第一个 matches() 之前有 IME 守卫");

const HANDLERS = [
  { file: "FileList.vue", src: listSrc, decl: "function onKeydown(e) {", claims: true },
  { file: "FileList.vue", src: listSrc, decl: "function onSearchKeydown(e) {", claims: false },
  { file: "FileList.vue", src: listSrc, decl: "function onRenameKeydown(e) {", claims: false },
  { file: "ShortcutsDialog.vue", src: dialogSrc, decl: "function onRecordKeydown(e) {", claims: false },
];

for (const h of HANDLERS) {
  const body = bodyOf(h.src, h.decl);
  check(`${h.file} ${h.decl} 抽到函数体`, body !== null && body.length > 0);
  if (!body) continue;

  check(`${h.file} ${h.decl} 体内有 IME 守卫`, /isImeKeydown\s*\(\s*e\s*\)/.test(body));

  // 只有认领命令的处理器才需要「守卫早于 matches()」这条。
  // ⚠️ 变异② 靠的就是它：把守卫挪到所有 matches() 之后，顺序断言必须 FAIL。
  const guardAt = body.indexOf("isImeKeydown(e)");
  const firstMatch = body.indexOf("matches(");
  if (h.claims && firstMatch >= 0) {
    check(
      `${h.file} ${h.decl} 的守卫早于第一个 matches()（位置错了就是死代码）`,
      guardAt >= 0 && guardAt < firstMatch
    );
  }
}

section("6. 唯一入口：没有内联的 `e.keyCode === 229` 副本");

{
  const files = [
    ["FileList.vue", listSrc],
    ["ShortcutsDialog.vue", dialogSrc],
  ];
  for (const [name, src] of files) {
    // 剥注释后再扫，否则守卫上方那段解释性注释本身就会让判据恒绿。
    // 判据文本用 concat 拼，避免「断言 needle 出现在本文件的注释/失败消息里」。
    const inline = src.match(/e\s*\.\s*isComposing\s*\|\|\s*e\s*\.\s*keyCode\s*===\s*229/g) || [];
    check(`${name} 没有内联 isComposing||keyCode===229 副本（实际 ${inline.length}）`, inline.length === 0);
  }
  // 全仓扫一遍（除 keyboardText.js 这个唯一入口本身）。
  const srcFiles = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(vue|js)$/.test(name)) srcFiles.push(p);
    }
  })(path.join(ROOT, "src"));
  const others = [];
  for (const f of srcFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "src/keyboardText.js") continue;
    const src = stripComments(fs.readFileSync(f, "utf8"));
    if (/keyCode\s*===\s*229/.test(src)) others.push(rel);
  }
  check(
    `除 keyboardText.js 外全仓无 keyCode===229 内联副本（实际 ${others.length}）`,
    others.length === 0
  );
  if (others.length) console.log(`       ${others.join(", ")}`);

  // onRenameBlur 用的是 `e.isComposing`（blur 事件没有 keyCode 可言），
  // 它不是 keydown 守卫，不该被这次收敛顺手改掉。
  const blurBody = bodyOf(listSrc, "function onRenameBlur(e) {");
  check(
    "onRenameBlur 保持只查 isComposing（blur 事件语义不同，不被收敛波及）",
    blurBody !== null && /e\s*\.\s*isComposing/.test(blurBody) && !/isImeKeydown/.test(blurBody)
  );
}

section("7. SFC 仍然编译得过（守卫是新增调用，得确认 import 没写错）");

{
  const { parse, compileScript } = await import("@vue/compiler-sfc");
  for (const [label, file] of [["FileList.vue", FILELIST], ["ShortcutsDialog.vue", DIALOG]]) {
    const src = fs.readFileSync(file, "utf8");
    const filename = "src/components/" + path.basename(file);
    try {
      const { descriptor, errors } = parse(src, { filename });
      check(`${label} parse() 无错`, !errors || errors.length === 0);
      compileScript(descriptor, { id: filename });
      check(`${label} compileScript() 通过（isImeKeydown 已正确导入）`, true);
    } catch (e) {
      check(`${label} 编译通过`, false);
      console.log(`       ${e.message}`);
    }
  }
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
  const origDialog = fs.readFileSync(DIALOG, "utf8");

  // ⚠️ 方法论：.vue 的换行符按目标文件归一化，否则锚点 count==0 →
// 变异没注入却被读成「断言瞎」。
  const nl = (s) => (fs.readFileSync(FILELIST, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s);
  const nlD = (s) => (origDialog.includes("\r\n") ? s.replace(/\n/g, "\r\n") : s);

  const GUARD_LINE = nl("  if (isImeKeydown(e)) return;\n");
  // ⚠️ `GUARD_LINE` 在 FileList.vue 里有**3 处**（onKeydown / onSearchKeydown /
  // onRenameKeydown），直接拿它当锚点会 count==3 → 变异没注入却读成「断言瞎」。
  // 方法论记着这条（「变异脚本必须打印 anchor found: N 并 assert N==1」）。
  // → 涉及 onKeydown 的变异一律用**带上文**的长锚点锚到唯一那处。
  // ⚠️ 双引号嵌套：用单引号字符串持有含 "INPUT" 的那行，否则字符串提前闭合
  // （真实踩过：SyntaxError: Unexpected token 'return'）。
  const INPUT_GUARD_LINE = '  if (e.target && e.target.tagName === "INPUT") return;\n';
  const ONKEYDOWN_GUARD = nl("  if (isImeKeydown(e)) return;\n\n  // If focus is inside the search input, let it handle keys itself.\n" + INPUT_GUARD_LINE);
  // 去掉上面那行守卫时，保留后面的 INPUT 守卫（那不是本次要动的东西）——
  // 用「守卫 + 空行 + INPUT 守卫」这一段做锚点，它在 FileList.vue 里唯一。
  const ONKEYDOWN_GUARD_REMOVED = nl("  // If focus is inside the search input, let it handle keys itself.\n" + INPUT_GUARD_LINE);
  const mutations = [
    {
      name: "① 删掉 onKeydown 的守卫（就是原 bug 的形状）",
      file: FILELIST, orig: origList,
      from: ONKEYDOWN_GUARD,
      to: ONKEYDOWN_GUARD_REMOVED,
    },
    {
      // ⚠️ 这一条换过一次：初版是「把守卫挪到第一个 matches() 之前的那一行之后」，
      // 实测 0 FAIL —— 但那是**等价变异**：守卫与首个 matches() 之间只有一条
      // `e.target.tagName === "INPUT"` 的 early-return，没有任何副作用，
      // 挪过去行为完全一样（方法论：0 FAIL 先判「等价变异」还是「测试盲区」，
      // 别硬凑断言去制造 FAIL）。换成真盲点：守卫挪到**函数末尾**，
      // 此时 Space/Enter 在 kc=229 下已经走过 matches()，行为真的变了。
      name: "② 把守卫挪到 onKeydown 末尾（在所有 matches() 之后）",
      file: FILELIST, orig: origList,
      from: ONKEYDOWN_GUARD,
      to: ONKEYDOWN_GUARD_REMOVED,
      appendAt: nl("    }\n  }\n}\n\nfunction formatDate(ts) {"),
      appendText: nl("    }\n  }\n  if (isImeKeydown(e)) return;\n}\n\nfunction formatDate(ts) {"),
    },
    {
      name: "③ 守卫只留一半：只查 isComposing，丢掉 keyCode===229（漏启动 composition 的那个键）",
      file: null, orig: null, srcFile: path.join(ROOT, "src", "keyboardText.js"),
      from: "return e.isComposing === true || e.keyCode === 229;",
      to: "return e.isComposing === true;",
    },
    {
      name: "④ 反过来只查 keyCode===229，丢掉 isComposing（另一种 IME 形状就漏了）",
      file: null, orig: null, srcFile: path.join(ROOT, "src", "keyboardText.js"),
      from: "return e.isComposing === true || e.keyCode === 229;",
      to: "return e.keyCode === 229;",
    },
    {
      name: "⑤ 在 FileList 里另写一份内联副本（违反唯一入口）",
      file: FILELIST, orig: origList,
      from: ONKEYDOWN_GUARD,
      to: nl(
        "  if (e.isComposing || e.keyCode === 229) return;\n\n" +
        "  // If focus is inside the search input, let it handle keys itself.\n" +
        INPUT_GUARD_LINE
      ),
    },
    {
      name: "⑥ 把 onRenameBlur 也改成 isImeKeydown（blur 语义不同，属误改）",
      file: FILELIST, orig: origList,
      from: nl("  if (e && e.isComposing) return;\n"),
      to: nl("  if (isImeKeydown(e)) return;\n"),
    },
  ];

  const { execFileSync } = await import("node:child_process");
  for (const mu of mutations) {
    const target = mu.file || mu.srcFile;
    const original = mu.file ? mu.orig : fs.readFileSync(target, "utf8");
    const count = original.split(mu.from).length - 1;
    console.log(`\n▶ ${mu.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      failures.push(`变异目标未唯一命中：${mu.name}`);
      process.exitCode = 1;
      continue;
    }

    let patched = original.split(mu.from).join(mu.to);
    if (mu.appendAt) {
      // ②：守卫挪到 onKeydown 末尾。锚点取「onKeydown 函数体的收尾」——
      // 用文件里唯一的收尾形状（全文件只有 onKeydown 以 `    }\n  }\n}\n`
      // 结束，后面紧跟 formatDate），所以 count 必须恰好 1。
      const at = patched.split(mu.appendAt).length - 1;
      console.log(`  tail anchor found: ${at}`);
      if (at !== 1) {
        console.log("  ⚠️ 收尾锚点不是恰好 1 处，变异没注入");
        failures.push(`变异②收尾锚点未唯一命中`);
        process.exitCode = 1;
        continue;
      }
      patched = patched.split(mu.appendAt).join(mu.appendText);
    }

    fs.writeFileSync(target, patched, "utf8");
    let failedNow = 0;
    let out = "";
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
    } catch (e) {
      failedNow = 1;
      out = (e.stdout || "") + (e.stderr || "");
    }
    fs.writeFileSync(target, original, "utf8");

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
  fs.writeFileSync(DIALOG, origDialog, "utf8");

  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
  if (failures.length) process.exitCode = 1;
}