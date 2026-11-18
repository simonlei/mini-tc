// 校验「模板里的 ref= 名字必须和 <script setup> 里声明的变量名一致」。
//
// 直接 `node scripts/template-ref-check.mjs` 跑；
// `node scripts/template-ref-check.mjs -- --mutate` 跑变异臂（每个都应 FAIL）。
//
// ── 这个 bug 的形状 ──────────────────────────────────────────────────
// Vue 3 的 <script setup> 里，模板的 `ref="foo"` 是**按变量名**绑定到 setup
// 作用域里那个 `const foo = ref(null)` 的 —— 不是按引用顺序，也不是按
// 「最近声明的那个」。名字对不上时：
//
//   · 模板 ref 永远是 null；
//   · **不报任何错**（没有 warning，没有异常，控制台干干净净）；
//   · 依赖它的代码全部静默退化。
//
// 实际踩过的坑：FilePreview.vue 模板写 `ref="imageScrollRef"`，脚本里声明的
// 却是 `imgScrollRef`。后果是滚动容器的 ref 恒为 null，于是：
//   · measureView() 量不到容器 → 视图尺寸永远是 {0,0}；
//   · 尺寸算不出来 → 图片没有显式宽高、没有居中 margin → 图片贴左上角；
//   · fitScale 退化成 1 → 「1:1」按钮永远处于已激活态，点击无反应；
//   · 滚轮处理里 `if (!el) return` → Ctrl+滚轮完全没反应。
// 三个症状、一个根因，而且全是静默的 —— 没有红字，没有报错框。
//
// 所以这条判据的价值不在「缩放」，而在**这一整类静默失效**：模板 ref 名字
// 写错，编译能过、类型检查能过、单测能过，只有真机点一下才发现不对。
//
// ── 为什么不用 Vue 编译器来做这件事 ──────────────────────────────────
// @vue/compiler-sfc 能编译通过不代表 ref 能绑上：模板 ref 的绑定是**运行时**
// 行为（setup 返回的 scope 上按 key 查找），编译期不校验。所以只能静态比对
// 两边的名字。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse, compileScript } from "@vue/compiler-sfc";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

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

// ── 收集所有 .vue ─────────────────────────────────────────────────────

function vueFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...vueFiles(p));
    else if (name.endsWith(".vue")) out.push(p);
  }
  return out;
}

// 模板部分：<template> 到 </template>。SFC 里 template 只会有一个顶层块。
function templateOf(src) {
  const start = src.indexOf("<template>");
  if (start < 0) return "";
  const end = src.indexOf("</template>", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

// 静态 ref="name"：**排除** :ref="..." （那是函数 ref / 动态绑定，
// 绑定的是个函数或表达式，名字对不上是正常的 —— 比如 FileList 的
// :ref="setRenameInput"）。用否定式前瞻把 `ref=` 前面不是冒号/连字符的
// 情况排除掉，避免把 `v-bind:ref` 和 `-ref` 一起算进来。
function staticRefs(tpl) {
  const out = [];
  const re = /(?<![:\-\w])ref="([^"]+)"/g;
  let m;
  while ((m = re.exec(tpl))) out.push(m[1]);
  return out;
}

// script setup 里声明的 ref 变量名。
function declaredRefs(src) {
  const out = new Set();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|shallowRef|computed)\s*\(/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

const files = vueFiles(SRC);
check(`扫描到 .vue 文件（${files.length} 个）`, files.length > 0);

// ══════════════ 1. 静态 ref 必须有同名声明 ══════════════

section("1. 模板里的 ref= 必须在 <script setup> 里声明同名变量");

{
  const problems = [];
  let totalRefs = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const raw = fs.readFileSync(f, "utf8");
    const tpl = templateOf(raw);
    if (!tpl) continue;
    // 声明只看 script 部分（避免模板里出现的同名字符串混进来）。
    const script = raw.slice(raw.indexOf("<script") >= 0 ? raw.indexOf("<script") : 0);
    const declared = declaredRefs(script);
    const refs = staticRefs(tpl);
    totalRefs += refs.length;
    for (const r of refs) {
      if (!declared.has(r)) {
        problems.push(`${rel}: 模板 ref="${r}"，但 script 里没有同名 ref 变量`);
      }
    }
  }
  check(
    `所有静态模板 ref 都有同名声明（共 ${totalRefs} 处 ref）`,
    problems.length === 0,
    problems
  );
  check("确实扫到了模板 ref（不是空跑）", totalRefs > 0);
}

section("2. 反向：script 里声明的 ref 不应只在 script 里出现（拼错名字的信号）");

{
  // 反向检查会误报「纯脚本状态 ref」（如 viewSize / zoomMode），所以只做
  // **提示级**统计，不作为失败判据 —— 正向检查已经能抓住真正的 bug。
  // 这里统计的是「script 里有 ref 变量、模板里完全没有同名出现」的数量，
  // 用来在报告里提醒：如果这个数字突然变大，多半是有人在改名字。
  const orphans = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const raw = fs.readFileSync(f, "utf8");
    const tpl = templateOf(raw);
    const script = raw.slice(raw.indexOf("<script") >= 0 ? raw.indexOf("<script") : 0);
    for (const name of declaredRefs(script)) {
      if (!new RegExp(`\\b${name}\\b`).test(tpl)) orphans.push(`${rel}: ${name}`);
    }
  }
  console.log(`  info  仅在 script 出现的 ref 变量 ${orphans.length} 个（纯脚本状态，正常）`);
  check("反向扫描能跑通（未抛异常）", true);
}

section("3. 编译器层面：模板 ref 必须编出 ref_key（否则运行时静默不绑）");

{
  // 上面第 1 节是「正则扫源码」，这一节是**用 Vue 自己的编译器**复核。
  // 编译器把 `<div ref="foo">` 编成两种形态：
  //
  //   脚本里有同名变量： { ref_key: "foo", ref: foo }   ← 绑上了
  //   脚本里没有同名变量： { ref: "foo" }               ← **只剩一个字符串**
  //
  // 后者是关键：Vue 运行时拿这个字符串回 setup 作用域里找 `foo`，找不到就
  // 静默留 null —— 编译不报错、运行不报错、控制台干净。
  //
  // 实测（用本仓库的 compiler-sfc 编译同一份 SFC 的两个版本）：
  //   修复后  → class: "image-scroll", ref_key: "imageScrollRef", ref: imageScrollRef
  //   事故版  → class: "image-scroll", ref: "imageScrollRef"
  //
  // 所以判据就是：**编译产物里每个模板 ref 都必须带 ref_key，且 ref_key 的
  // 字符串与它指向的变量是同一个标识符。** 少了 ref_key = 没绑上。
  const PREVIEW = path.join(SRC, "components", "FilePreview.vue");
  const raw = fs.readFileSync(PREVIEW, "utf8");
  const { descriptor } = parse(raw, { filename: "FilePreview.vue" });
  const compiled = compileScript(descriptor, { id: "refcheck", inlineTemplate: true }).content;

  // 编译产物里形如  ref_key: "xxx",  ref: xxx,
  const pairs = [...compiled.matchAll(/ref_key:\s*"([^"]+)"\s*,\s*ref:\s*([A-Za-z_$][\w$]*)/g)];
  check(
    `编译产物里解析出了模板 ref 绑定（${pairs.length} 处）`,
    pairs.length > 0
  );
  const bad = pairs.filter((m) => m[1] !== m[2]).map((m) => `ref_key="${m[1]}" 但 ref 指向 ${m[2]}`);
  check(
    "每个 ref_key 的字符串与它指向的变量是同一个名字",
    bad.length === 0,
    bad
  );
  check(
    "FilePreview.vue 的滚动容器编译出 ref_key=\"imageScrollRef\"",
    pairs.some((m) => m[1] === "imageScrollRef" && m[2] === "imageScrollRef")
  );

  // 反向：模板里出现但编译产物里**没有** ref_key 的 ref —— 说明编译器
  // 没能在 setup 作用域里找到同名变量（名字写错了）。
  const bareRefs = [...compiled.matchAll(/class:\s*"[^"]+"\s*,\s*ref:\s*"([^"]+)"/g)].map((m) => m[1]);
  check(
    "编译产物里没有「只有 ref 字符串、没有 ref_key」的裸 ref（那种就是没绑上）",
    bareRefs.length === 0,
    bareRefs.map((r) => `ref: "${r}"（缺 ref_key → 运行时静默为 null）`)
  );

  // 再钉一次事故现场：把脚本变量改回旧名，编译产物就**不该**再有 ref_key。
  {
    const broken = raw
      .replace("const imageScrollRef = ref(null);", "const imgScrollRef = ref(null);")
      .replace(/imageScrollRef\.value/g, "imgScrollRef.value");
    let brokenCode = "";
    try {
      const bd = parse(broken, { filename: "FilePreview.vue" });
      brokenCode = compileScript(bd.descriptor, { id: "refcheck", inlineTemplate: true }).content;
    } catch {
      brokenCode = "";
    }
    check(
      "对照臂：脚本变量改成旧名后，编译产物确实不再有 ref_key（证明这条判据有分辨力）",
      brokenCode.length > 0 && !/ref_key:\s*"imageScrollRef"/.test(brokenCode)
    );
  }
}

section("4. 本次事故的具体现场（防回归钉子）");

{
  const preview = fs.readFileSync(path.join(SRC, "components", "FilePreview.vue"), "utf8");
  const tpl = templateOf(preview);
  const script = preview.slice(preview.indexOf("<script"));

  check(
    "FilePreview.vue 模板绑定的是 ref=\"imageScrollRef\"",
    /(?<![:\-\w])ref="imageScrollRef"/.test(tpl)
  );
  check(
    "FilePreview.vue 声明了 const imageScrollRef = ref(null)",
    /const\s+imageScrollRef\s*=\s*ref\(/.test(script)
  );
  check(
    "不再有旧的错名 imgScrollRef（模板曾写 imageScrollRef、脚本却是 imgScrollRef）",
    !/\bimgScrollRef\b/.test(preview)
  );
  // 滚动容器是缩放的命脉：量不到它，尺寸算不出来，居中/缩放/滚轮全废。
  check(
    "measureView() 用的正是模板绑定的那个 ref",
    /function measureView\(\)[\s\S]{0,200}?imageScrollRef\.value/.test(script)
  );
  check(
    "applyZoom() 用的正是模板绑定的那个 ref",
    /function applyZoom\([\s\S]{0,300}?imageScrollRef\.value/.test(script)
  );
  check(
    "onImageWheel() 用的正是模板绑定的那个 ref",
    /function onImageWheel\([\s\S]{0,200}?imageScrollRef\.value/.test(script)
  );
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
  const PREVIEW = path.join(SRC, "components", "FilePreview.vue");
  const LIST = path.join(SRC, "components", "FileList.vue");
  const originals = {
    [PREVIEW]: fs.readFileSync(PREVIEW, "utf8"),
    [LIST]: fs.readFileSync(LIST, "utf8"),
  };

  // ⚠️ 方法论（见 METHODOLOGY.md）：锚点必须按目标文件的换行符归一化，
  // 否则 count == 0 → 变异没注入 → 套件全绿被误读成「断言瞎」。
  const nlFor = (file, s) =>
    fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

  const MUTANTS = [
    {
      // ⚠️ 锚点必须唯一：`ref="imageScrollRef"` 这个字符串在注释里也出现过
      // （注释里正好解释了这次事故），只匹配它会命中 2 处 → 变异没注入。
      // 所以带上模板元素本身。
      name: "① 模板 ref 改名，脚本声明不动（本次事故的原始形状）",
      file: PREVIEW,
      from: nlFor(PREVIEW, '<div class="image-scroll" ref="imageScrollRef"'),
      to: nlFor(PREVIEW, '<div class="image-scroll" ref="imageScrollRenamed"'),
    },
    {
      name: "② 脚本变量改名，模板不动（同一个 bug 的镜像形状）",
      file: PREVIEW,
      from: nlFor(PREVIEW, "const imageScrollRef = ref(null);"),
      to: nlFor(PREVIEW, "const imgScrollRef = ref(null);"),
    },
    {
      name: "③ 删掉脚本里的 ref 声明（模板 ref 彻底无源）",
      file: PREVIEW,
      from: nlFor(PREVIEW, "const imageScrollRef = ref(null);"),
      to: "",
    },
  ];

  for (const mu of MUTANTS) {
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
      failures.push(`变异未被被抓到：${mu.name}`);
      console.log("  FAIL 变异未被断言抓到 —— 该断言是恒真的");
    }
  }

  fs.writeFileSync(PREVIEW, originals[PREVIEW], "utf8");
  fs.writeFileSync(LIST, originals[LIST], "utf8");

  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
  if (failures.length) process.exitCode = 1;
}
