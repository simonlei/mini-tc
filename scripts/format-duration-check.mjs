// 验证「时长 / 码率」的格式化在全项目只有一份实现，且语义与搬走之前一致。
// 直接 `node scripts/format-duration-check.mjs` 跑；`-- --mutate` 跑变异臂。
//
// ── 为什么要有这个脚本 ────────────────────────────────────────────────
// 时长格式化原先是 VideoPreview.vue 里的一个本地 `fmtTime`。属性窗口要显示
// 视频时长，如果在那里再抄一份，就会出现「同一个视频，预览里显示 01:30、
// 属性里显示 1:30」这种漂移 —— 与当初 formatBytes 有 8 份副本、同一文件在
// 两处显示不同字符串，是同一类问题。所以把语义原样搬进 src/format.js，
// 两个调用点都从那里取。
//
// 搬动最容易出的错是**语义悄悄变了**（小时位没了、负数不再归零、码率用
// 1024 而不是 1000），而这类改动在屏幕上不报错、编译也过得去。所以这里：
//   ① 纯函数表：钉住每一档的输出；
//   ② 对照臂：把搬走之前的 `fmtTime` 逐字复刻下来，逐个输入比对 ——
//      「行为逐字不变」这句话必须有证据，不能只是注释里写着；
//   ③ 静态断言：两个调用点确实从 format.js 导入，且没有把本地实现粘回来；
//   ④ 变异臂：证明上面的断言不是恒真的。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatDuration, formatBitrate } from "../src/format.js";
import stripCommentsModule from "./stripComments.cjs";

const { stripComments } = stripCommentsModule;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT = path.join(ROOT, "src", "format.js");
const DIALOG = path.join(ROOT, "src", "components", "FilePropertiesDialog.vue");
const PREVIEW = path.join(ROOT, "src", "components", "VideoPreview.vue");

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

// ── 对照臂：搬走之前的 fmtTime，逐字复刻 ──
// 复刻写错了的话，② 里的「行为逐字不变」就失去意义，所以 ② 里先断言
// 复刻本身与新实现在一批输入上一致 —— 那是本次搬动的目标。
const oldFmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

console.log("① 纯函数表：时长");
{
  check("0 → 00:00", formatDuration(0) === "00:00");
  check("1 → 00:01", formatDuration(1) === "00:01");
  check("59 → 00:59", formatDuration(59) === "00:59");
  check("60 → 01:00", formatDuration(60) === "01:00");
  check("90 → 01:30", formatDuration(90) === "01:30");
  check("599 → 09:59", formatDuration(599) === "09:59");
  check("3599 → 59:59（不到一小时不带小时位）", formatDuration(3599) === "59:59");
  check("3600 → 1:00:00（小时位不补零，与原实现一致）", formatDuration(3600) === "1:00:00");
  check("3661 → 1:01:01", formatDuration(3661) === "1:01:01");
  check("7322 → 2:02:02", formatDuration(7322) === "2:02:02");
  check("小数向下取整（90.9 → 01:30）", formatDuration(90.9) === "01:30");
}

console.log("\n② 非法输入：与搬走之前的 fmtTime 逐字一致");
{
  // 这一组是「行为逐字不变」的核心证据：新实现必须与旧实现一模一样，
  // 连非法输入怎么处理都一样。
  const INPUTS = [
    0, 1, 59, 60, 90, 599, 3599, 3600, 3661, 7322, 86399, 86400,
    90.9, 0.4,
    undefined, null, NaN, -1, -3600, Infinity, -Infinity, "", "90",
  ];
  let allSame = true;
  for (const v of INPUTS) {
    if (formatDuration(v) !== oldFmtTime(v)) {
      allSame = false;
      console.log(`     不一致：${String(v)} → 新 "${formatDuration(v)}" / 旧 "${oldFmtTime(v)}"`);
    }
  }
  check(`全部 ${INPUTS.length} 个输入上与旧 fmtTime 逐字一致`, allSame);

  // 单独再钉几条，免得「一致」是因为两边一起坏了。
  check("undefined → 00:00", formatDuration(undefined) === "00:00");
  check("null → 00:00", formatDuration(null) === "00:00");
  check("NaN → 00:00", formatDuration(NaN) === "00:00");
  check("负数 → 00:00（不是 -01:00）", formatDuration(-5) === "00:00");
  check("Infinity → 00:00", formatDuration(Infinity) === "00:00");
  check("输出里永远没有 'NaN' 或 'undefined'", !/NaN|undefined/.test(formatDuration(NaN)));
}

console.log("\n③ 纯函数表：码率");
{
  check("0 → 占位符", formatBitrate(0) === "—");
  check("undefined → 占位符", formatBitrate(undefined) === "—");
  check("负数 → 占位符", formatBitrate(-1) === "—");
  check("NaN → 占位符", formatBitrate(NaN) === "—");
  check("800 bps（不到 1000，不补一位小数）", formatBitrate(800) === "800 bps");
  check("1.5 kbps（十进制，不是 1024）", formatBitrate(1500) === "1.5 kbps");
  check("1.5 Mbps", formatBitrate(1500000) === "1.5 Mbps");
  check("2.5 Gbps", formatBitrate(2500000000) === "2.5 Gbps");
  check("1 Tbps", formatBitrate(1000000000000) === "1.0 Tbps");
  check("自定义占位符", formatBitrate(undefined, "未知") === "未知");
  check("占位符不吞正常值", formatBitrate(1500000, "未知") === "1.5 Mbps");
  // 十进制 vs 二进制：码率用的是 1000，1.5 Mbps 若按 1024 算会变成
  // "1.4 Mbps"，这个差别用户能看出来。
  check("码率按 1000 换算（不是 1024）", formatBitrate(1024 * 1000) === "1.0 Mbps");
}

console.log("\n④ 静态断言：两个调用点都从 format.js 取，没有第二份实现");
{
  const fmtSrc = stripComments(fs.readFileSync(FORMAT, "utf8"));
  check("format.js 导出 formatDuration", /export\s+function\s+formatDuration\b/.test(fmtSrc));
  check("format.js 导出 formatBitrate", /export\s+function\s+formatBitrate\b/.test(fmtSrc));

  const importSpecifiers = (file) => {
    const src = fs.readFileSync(file, "utf8");
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/format\.js["']/);
    return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  };

  const dialogSpec = importSpecifiers(DIALOG);
  check(
    "FilePropertiesDialog 从 format.js 导入 formatDuration",
    dialogSpec.includes("formatDuration")
  );
  check(
    "FilePropertiesDialog 从 format.js 导入 formatBitrate",
    dialogSpec.includes("formatBitrate")
  );

  const previewSpec = importSpecifiers(PREVIEW);
  check(
    "VideoPreview 从 format.js 导入 formatDuration（可能改名）",
    previewSpec.some((s) => s === "formatDuration" || s.endsWith("as fmtTime"))
  );

  // 本地实现没被粘回来：VideoPreview 里不该再有一个自己算时长的函数。
  const previewSrc = stripComments(fs.readFileSync(PREVIEW, "utf8"));
  check(
    "VideoPreview 不再定义本地 fmtTime 函数",
    !/function\s+fmtTime\s*\(/.test(previewSrc)
  );
  check(
    "VideoPreview 不再自己算小时（没有 Math.floor(s / 3600)）",
    !/Math\.floor\([^)]*\/\s*3600/.test(previewSrc)
  );

  // 属性窗口也不许自己造一份。
  // 判据不能是「没有 padStart」—— 它自己的 `formatDate`（年月日时分秒）
  // 合法地用了 padStart。要抓的是**时长**的那套：小时位（3600）、分钟位
  // （/ 60）除法、以及 "mm:ss" 的拼接。
  const dialogSrc = stripComments(fs.readFileSync(DIALOG, "utf8"));
  check(
    "属性窗口不自造时长格式化（没有自己算小时位 3600）",
    !/\b3600\b/.test(dialogSrc)
  );
  check(
    "属性窗口不自造时长格式化（没有自己算分钟位 / 60）",
    !/\/\s*60\b/.test(dialogSrc)
  );
  check(
    "属性窗口不自造码率换算（没有 1000 / 1024 的除法链）",
    !/\/\s*1000\b/.test(dialogSrc) && !/\/\s*1024\b/.test(dialogSrc)
  );

  // 「改实现不改调用点」的变体：导入还在但调用没了。
  check("属性窗口确实在调用 formatDuration", /formatDuration\(/.test(dialogSrc));
  check("属性窗口确实在调用 formatBitrate", /formatBitrate\(/.test(dialogSrc));
  check("VideoPreview 确实在调用 fmtTime", /fmtTime\(/.test(previewSrc));
}

// ── report ──

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log("全部通过");
}

// ── 变异臂 ──

if (process.argv.includes("--mutate")) {
  console.log(`\n${"═".repeat(50)}\n变异测试（每个都应 FAIL）\n${"═".repeat(50)}`);
  const { execFileSync } = await import("node:child_process");

  const nlFor = (file, s) =>
    (fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s);

  const mutations = [
    {
      name: "① 时长丢掉小时位（两小时的文件显示成 120:00）",
      file: FORMAT,
      from: 'return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;',
      to: 'return `${mm}:${ss}`;',
    },
    {
      name: "② 时长不再把负数归零（-5 显示成 00:-5）",
      file: FORMAT,
      from: "if (!Number.isFinite(s) || s < 0) s = 0;",
      to: "if (!Number.isFinite(s)) s = 0;",
    },
    {
      name: "③ 时长改成四舍五入（90.4 秒显示成 01:30 但 59.6 秒变 01:00）",
      file: FORMAT,
      from: "s = Math.floor(s);",
      to: "s = Math.round(s);",
    },
    {
      name: "④ 码率按 1024 换算（1.5 Mbps 显示成 1.4 Mbps）",
      file: FORMAT,
      from: "while (v >= 1000 && i < BITRATE_UNITS.length - 1) {",
      to: "while (v >= 1024 && i < BITRATE_UNITS.length - 1) {",
    },
    {
      name: "⑤ 码率的空值语义变了（缺失时显示 0 bps 而不是占位符）",
      file: FORMAT,
      from: 'export function formatBitrate(bitsPerSecond, empty = "—") {',
      to: 'export function formatBitrate(bitsPerSecond, empty = "0 bps") {',
    },
    {
      name: "⑥ VideoPreview 把本地 fmtTime 粘回来（时长出现第二份实现）",
      file: PREVIEW,
      from: "// ── Playback controls ──",
      to: `function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? \`\${h}:\${mm}:\${ss}\` : \`\${mm}:\${ss}\`;
}
// ── Playback controls ──`,
    },
    {
      name: "⑦ 属性窗口不再用 formatDuration（自己那套算不出来）",
      file: DIALOG,
      from: "import { formatBytes, formatDuration, formatBitrate } from \"../format.js\";",
      to: "import { formatBytes, formatBitrate } from \"../format.js\";",
    },
    {
      name: "⑧ 属性窗口不再用 formatBitrate（码率显示原始数字）",
      file: DIALOG,
      from: "import { formatBytes, formatDuration, formatBitrate } from \"../format.js\";",
      to: "import { formatBytes, formatDuration } from \"../format.js\";",
    },
  ];

  for (const mu of mutations) {
    const original = fs.readFileSync(mu.file, "utf8");
    const from = nlFor(mu.file, mu.from);
    const to = nlFor(mu.file, mu.to);
    const count = original.split(from).length - 1;
    console.log(`\n▶ ${mu.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      failures.push(`变异目标未唯一命中：${mu.name}`);
      continue;
    }
    let failedNow = 0;
    let out = "";
    try {
      fs.writeFileSync(mu.file, original.split(from).join(to), "utf8");
      try {
        execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
      } catch (e) {
        failedNow = 1;
        out = (e.stdout || "") + (e.stderr || "");
      }
    } finally {
      fs.writeFileSync(mu.file, original, "utf8");
    }
    if (failedNow) {
      passed++;
      const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
      console.log(`  ok   变异被断言抓到（FAIL 如预期）${firstFail ? " | " + firstFail.trim() : ""}`);
    } else {
      failures.push(`变异未被抓到：${mu.name}`);
      console.log("  FAIL 变异未被抓到 —— 该断言是恒真的");
    }
  }
  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
}

if (failures.length) process.exitCode = 1;
