// 验证「人类可读体积」在全项目只有一份实现，且这份实现对每个调用点成立。
// 直接 `node scripts/format-size-check.mjs` 跑。
//
// 背景：这个格式化函数曾有 8 份近似的本地实现（App.vue、FileList.vue、
// FilePanel.vue、FilePreview.vue、PathBar.vue、SearchDialog.vue、
// VideoPreview.vue 的 fmtSize，以及一处更早的副本），并且**已经漂移到屏幕上**：
//
//   ① FilePreview.vue 的 units 只有 4 项且**没有 clamp 索引** —— 2TB 文件
//      渲染成 `2048.0 undefined`（`units[4]` 是 undefined 参与字符串拼接）。
//      同期 SearchDialog 有 clamp，同一个文件在两处显示不同。
//   ② FileList.vue 的零值守卫是 `bytes === 0`，`undefined` 会一路走到
//      `Math.log(undefined) = NaN` → `NaN undefined`。
//   ③ PathBar 的空值语义是 `—` 而其余各处是 `0 B`：容量未知时显示
//      「0 B 可用」是谎话，显示 `—` 才对。这是**唯一值得保留的差异**。
//
// 这里分三层测，因为这三层各自能抓住不同类型的回归：
//   ① 纯函数表（锚定 src/format.js 本身的行为，含各调用点的空值语义）；
//   ② 静态断言：7 个调用点确实**从 format.js 导入**，且文件里不再有本地的
//      units 字面量 —— 纯函数表在这一层全绿时仍能抓住「有人把副本粘回来」；
//   ③ 对照臂：把 TODO 里描述的真实 bug 输入（2TB / undefined）喂给一份
//      逐字复刻的旧实现，证明这些断言真的有分辨力，而不是恒真。
//
// 不测的部分：模板里的实际渲染（需要真跑 Vue），以及 i18n/单位本地化。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatBytes } from "../src/format.js";
// Same helper `lint-imports.js` uses — imported rather than copied, because a
// second copy is a second thing that can drift (and this assertion's whole
// point is that documentation text must not be able to satisfy it).
import stripCommentsModule from "./stripComments.cjs";

const { stripComments } = stripCommentsModule;

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

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;

// ── 对照臂：把两份旧实现逐字复刻 ──
// 不是摆设：它们证明后面的断言真的有分辨力。若哪天改 test 让它恒绿，
// 这两个函数也会跟着一起"通过"，所以断言里要显式对比两者的不同。
//
// FilePreview.vue 旧版：units 只有 4 项，无索引钳制，守卫只判 === 0。
const oldFilePreview = (bytes) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + " " + units[i];
};

// FileList.vue 旧版：units 5 项，同样无钳制。
const oldFileList = (bytes) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + " " + units[i];
};

console.log("① 纯函数表：普通量级");
{
  check("0 → 占位符", formatBytes(0) === "0 B");
  check("1 B 不带小数", formatBytes(1) === "1 B");
  check("512 B 原样（不是 512.0）", formatBytes(512) === "512 B");
  check("1023 B 仍是 B", formatBytes(1023) === "1023 B");
  check("1024 B → 1.0 KB", formatBytes(KB) === "1.0 KB");
  check("1536 B → 1.5 KB", formatBytes(1536) === "1.5 KB");
  check("1 MB", formatBytes(MB) === "1.0 MB");
  check("1 GB", formatBytes(GB) === "1.0 GB");
  check("1 TB", formatBytes(TB) === "1.0 TB");
}

console.log("\n② 上界 clamp：TODO 记录的 `2.0 undefined`");
{
  check("2 TB 被钳到 TB（不是第 4 个不存在的单位）", formatBytes(2 * TB) === "2.0 TB");
  // 上界钳制的意义要选对输入：2 TB 在 5 级 units 的旧实现里本来就正常，
  // 越界的是 1 PB（i = 5）以及 4 级 units 的 2 TB（i = 4）。
  check("1023.9 TB 保持 TB 且带一位小数", formatBytes(1023.9 * TB) === "1023.9 TB");
  check("1 PB（5 级 units 的越界点）被钳到 PB", formatBytes(1024 * TB) === "1.0 PB");
  // 更大就该停在 PB，而不是掉进 undefined。
  check("1 EB 停在 PB 而非 undefined", formatBytes(1024 * TB * 1024) === "1024.0 PB");
  check("任何输入都不含 'undefined'", !/undefined/.test(formatBytes(1e300)));
  // 已知且接受的边界：索引钳了但量级不钳。u64 上限是 2^64-1 ≈ 16 EB，
  // 所以后端永远给不出更大的数 —— 这里如实记录现状，不假装是修好了。
  check("超出 u64 的值钳住单位但不截断数字（如实记录）",
    formatBytes(1e30) === "888178419700125.3 PB");
}

console.log("\n③ 下界 clamp：负索引读出 `units[-1]`");
{
  // 这是与上界**独立**的第二种越界，只钳上界抓不到。
  check("0.5 B 是 B 级，不会读出 units[-1]", /^[\d.]+ B$/.test(formatBytes(0.5)));
  check("0.5 B 原样保留（String 而非 toFixed(0)）", formatBytes(0.5) === "0.5 B");
  check("0.001 B 仍是 B 级", / B$/.test(formatBytes(0.001)));
  check("0.5 B 与旧实现结果不同（旧实现给 512.0 undefined）",
    formatBytes(0.5) !== oldFilePreview(0.5));
}

console.log("\n④ 非法输入：不许漏出 NaN");
{
  check("undefined → 占位符", formatBytes(undefined) === "0 B");
  check("null → 占位符", formatBytes(null) === "0 B");
  check("NaN → 占位符（旧实现在这里显示 NaN undefined）", formatBytes(NaN) === "0 B");
  check("负数 → 占位符（Math.log(负数) 是 NaN）", formatBytes(-1) === "0 B");
  check("-5 GB → 占位符", formatBytes(-5 * GB) === "0 B");
  check("Infinity → 占位符", formatBytes(Infinity) === "0 B");
  check("-Infinity → 占位符", formatBytes(-Infinity) === "0 B");
  check("字符串 '1024' → 占位符（不做隐式转换）", formatBytes("1024") === "0 B");
  check("空串 → 占位符", formatBytes("") === "0 B");
}

console.log("\n⑤ 每个调用点的空值语义（PathBar 是唯一合法的例外）");
{
  check("文件列表语义：缺 size → '0 B'", formatBytes(undefined, "0 B") === "0 B");
  check("路径栏语义：容量未知 → '—'", formatBytes(undefined, "—") === "—");
  check("视频预览语义：无体积 → 空串", formatBytes(undefined, "") === "");
  check("容量未知时负值同样走占位符", formatBytes(-1, "—") === "—");
  // 占位符只作用于非法输入，正常值不能被吞掉。
  check("占位符不吞正常值", formatBytes(2 * GB, "—") === "2.0 GB");
}

console.log("\n⑥ 对照臂实测：旧实现在同一批输入上确实坏，且与新实现不同");
{
  // 先确认复刻是忠实的 —— 对照臂本身写错了的话，后面所有"有分辨力"的说法都作废。
  check("对照臂复刻正确：旧 FilePreview 对 2TB 给 '2.0 undefined'",
    oldFilePreview(2 * TB) === "2.0 undefined");
  check("对照臂复刻正确：旧 FilePreview 对 0.5 B 给 '512.0 undefined'（负索引）",
    oldFilePreview(0.5) === "512.0 undefined");
  check("对照臂复刻正确：旧 FilePreview 对 undefined 给 'NaN undefined'",
    oldFilePreview(undefined) === "NaN undefined");
  check("对照臂复刻正确：旧 FileList 对 1 PB 给 '1.0 undefined'",
    oldFileList(1024 * TB) === "1.0 undefined");

  // 有分辨力的证据 —— 但必须**精确**：漂移是逐副本的，不是全局的。
  // 2 TB 在 5 级 units 的 FileList 上本来正确，只在 4 级 units 的 FilePreview
  // 上坏掉。所以「每个旧实现在每个输入上都不同」是错的断言，
  // 那样写会逼我把正确的对照也改成错的。
  const DIVERGES = [
    ["2 TB", 2 * TB, oldFilePreview],   // i=4，越过 4 级 units 的末尾
    ["0.5 B", 0.5, oldFilePreview],     // i=-1，两份副本都中招
    ["0.5 B", 0.5, oldFileList],
    ["1 PB", 1024 * TB, oldFileList],   // i=5，越过 5 级 units 的末尾
    ["undefined", undefined, oldFilePreview], // 守卫只判 ===0
    ["undefined", undefined, oldFileList],
  ];
  for (const [label, bytes, oldFn] of DIVERGES) {
    const name = oldFn === oldFilePreview ? "旧 FilePreview" : "旧 FileList";
    check(`${label} vs ${name}：新旧结果不同`, formatBytes(bytes) !== oldFn(bytes));
  }

  // 反向确认：旧实现在**本来就没坏**的输入上与新实现一致 ——
  // 说明收敛不是顺手改了既有正确的显示格式。
  for (const [label, bytes, oldFn] of [
    ["2 TB", 2 * TB, oldFileList],
    ["512 B", 512, oldFileList],
    ["1 MB", MB, oldFileList],
    ["2 GB", 2 * GB, oldFileList],
  ]) {
    check(`${label} vs 旧 FileList：新旧一致（没改本就正确的格式）`,
      formatBytes(bytes) === oldFn(bytes));
  }

  // 两份旧实现在 2 TB 上不同（同一个文件在预览面板和搜索对话框显示不同
  // 字符串，是既成事实）。注意别顺手断言「0.5 B 上两者也不同」——
  // 实测它们都是 "512.0 undefined"，负索引那一位恰好越过了同一处。
  check("两份旧实现对 2 TB 结果不同（这正是用户可见的漂移）",
    oldFilePreview(2 * TB) !== oldFileList(2 * TB));

  // 反向确认：新实现在正常量级上没有被 over-engineering 改变语义。
  // 2 TB 应当与「有钳制的旧版本」一致，而不是自创一个新格式。
  const oldClamped = (bytes) => {
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return (i === 0 ? String(bytes) : v.toFixed(1)) + " " + units[i];
  };
  for (const bytes of [1, 512, KB, 1536, MB, GB, TB, 2 * TB, 1024 * TB]) {
    check(`${bytes} 与「有钳制的旧版本」逐字一致（没改既有正确格式）`,
      formatBytes(bytes) === oldClamped(bytes));
  }
}

console.log("\n⑦ 静态断言：7 个调用点都从 format.js 导入，且副本没被粘回来");
{
  // [文件, 本地名, 是否需要显式 empty 参数]
  const CALLERS = [
    ["src/App.vue", "formatBytes", null],
    ["src/components/FileList.vue", "formatSize", null],
    ["src/components/FilePanel.vue", "formatBytes", null],
    ["src/components/FilePreview.vue", "formatSize", null],
    ["src/components/PathBar.vue", "formatBytes", "—"],
    ["src/components/SearchDialog.vue", "formatSize", null],
    ["src/components/VideoPreview.vue", "fmtSize", ""],
  ];

  for (const [rel, local, emptyArg] of CALLERS) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const base = path.basename(rel);

    // 导入形式有两种：`import { formatBytes }`（同名）与
    // `import { formatBytes as formatSize }`（改名以匹配旧本地名）。
    const importM = src.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/format\.js["']/);
    const specifiers = importM
      ? importM[1].split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    check(`${base}: 从 format.js 具名导入 ${local}`,
      specifiers.includes(local) || specifiers.includes(`formatBytes as ${local}`));

    // 副本被粘回来的信号：文件里又出现单位的字面量数组。
    // 同样要剥注释 —— 讨论这个 bug 的说明文字里就写着这些单位名。
    check(`${base}: 不含本地单位数组（副本没回来）`,
      !/["']B["'],\s*["']KB["']/.test(stripComments(src)));

    // 「改实现不改调用点」的变体：导入还在但调用没了。
    check(`${base}: 仍在调用 ${local}(...)`, src.includes(`${local}(`));

    // 需要 empty 参数的调用点：**每一个**都得带上参数。
    // 只检查「文件里有某处带参」是不够的 —— 变异测试实测过：把 PathBar
    // 两处调用中的一处参数删掉，那种写法依然全绿。
    if (emptyArg !== null) {
      // 剥掉注释再数调用点：PathBar 的 import 上方有一句
      // `formatBytes(…)` 的说明文字，不剥就会把文档当成第三个调用点，
      // 断言就会在"看起来对"的情况下数错（变异测试时才发现的）。
      const code = stripComments(src);
      const calls = [...code.matchAll(new RegExp(`${local}\\s*\\(([^()]*)\\)`, "g"))]
        .map((m) => m[1]);
      check(`${base}: 至少有一处 ${local} 调用`, calls.length > 0);
      const withArg = calls.filter((a) => a.includes(","));
      check(
        `${base}: 全部 ${calls.length} 处 ${local} 调用都显式传了 empty 参数（否则语义会变）`,
        withArg.length === calls.length
      );
    }
  }

  // 反向确认：format.js 自己确实 export 了 formatBytes。
  const fmtSrc = fs.readFileSync(path.join(ROOT, "src/format.js"), "utf8");
  check("format.js 导出 formatBytes", /export\s+function\s+formatBytes\b/.test(fmtSrc));

  // 上界钳制存在（对应 units[4] / units[5] 越界）。
  check("format.js 对索引做了上界钳制", /Math\.min\(\s*LAST/.test(fmtSrc));
  // 下界钳制独立存在 —— 只钳上界时 0.5 B 仍会读出 units[-1]。
  check("format.js 对索引做了下界钳制（只钳上界抓不到负索引）",
    /Math\.max\(\s*0,/.test(fmtSrc));

  // 「守卫在取对数之前」是顺序约束，而注释里也大量出现 Math.log ——
  // 所以必须先剥注释再比位置，否则文档里的字面量会自己判自己过。
  const fmtCode = stripComments(fmtSrc);
  check("format.js 在取对数前就过滤了非法输入",
    fmtCode.indexOf("Number.isFinite") !== -1 &&
    fmtCode.indexOf("Number.isFinite") < fmtCode.indexOf("Math.log"));
  check("format.js 的守卫在同一个函数体内（不是别处的死代码）",
    /export function formatBytes[\s\S]*Number\.isFinite[\s\S]*Math\.log/.test(fmtCode));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
