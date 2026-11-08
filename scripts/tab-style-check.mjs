// 断言「当前标签页」与「锁定标签页」在视觉上必须能区分。
//
// 直接 `node scripts/tab-style-check.mjs` 跑；`-- --mutate` 跑变异臂。
//
// ── 这个 bug 的形状 ────────────────────────────────────────────────
// 2026-11-08：标签页里「当前页」和「锁定页」长得一样，用户看不出哪个是当前页。
// 两处根因：
//   ① 锁定页染了底色 `color-mix(in srgb, var(--tab-active) 70%, var(--accent) 12%)`
//      —— 实测叠在 --header-bg 上之后，与当前页底色的 ΔE 只有 4.6~9.1
//      （forest 最惨，4.6），肉眼根本分不开；
//   ② `.tab.locked` 写在 `.tab.active` 之后且同优先级 → 「既当前又锁定」的
//      标签页，底色被锁定规则覆盖掉，反而丢了当前页的高亮。
//
// ── 为什么断言要落到「数值」上 ──────────────────────────────────────
// 只断言「CSS 里存在 .tab.active 规则」是恒真的（谁都写得出来）。
// 真正的判据是**用户能不能分辨**：当前页底色与锁定页底色的感知差异 ΔE
// 必须够大，且当前页上的文字必须读得清。这两条都能从真实 CSS 变量算出来 ——
// 解析 style.css 的四套主题 + TabBar.vue 的规则，把 color-mix() 真的算一遍。
//
// ── 三层判据 ────────────────────────────────────────────────────────
//   1. 前提：四套主题的变量都能解析；--tab-active 在每套主题下算出不透明色。
//   2. 数值：当前页 vs 锁定页的 ΔE ≥ 12；当前页上的文字对比度 ≥ 4.5 (WCAG AA)。
//   3. 静态：锁定态规则不得声明 background（根因①），且必须排除 .active（根因②）。
//
// 变异臂在 scripts/tab-style-mutation.mjs。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABBAR = path.join(ROOT, "src", "components", "TabBar.vue");
const STYLE = path.join(ROOT, "src", "style.css");

// ── 阈值（依据见文件头；改这里等于改判据，不是改实现）──────────────
const MIN_DELTA_E = 12;      // 当前页 vs 锁定页的最小感知差异
const MIN_CONTRAST = 4.5;    // WCAG AA 正文对比度

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

// ══════════════ 颜色计算 ══════════════

function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 把 color-mix() 的参数按顶层逗号拆开（不拆函数内的逗号）。 */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 解析一个颜色值 → { r, g, b, a }。
 * 支持：#hex、var(--x)、color-mix(in srgb, A p%, B)。
 * 只覆盖本仓库真实用到的语法；解析不了就返回 null（调用方会报错而不是猜）。
 */
function resolveColor(value, vars, depth = 0) {
  if (value == null || depth > 8) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.startsWith("#")) {
    const rgb = hexToRgb(v);
    return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 } : null;
  }
  if (v.startsWith("var(")) {
    const close = v.indexOf(")");
    if (close < 0) return null;
    const name = v.slice(4, close).trim();
    if (!vars || !(name in vars)) return null;
    return resolveColor(vars[name], vars, depth + 1);
  }
  const mix = /^color-mix\(\s*in\s+srgb\s*,(.*)\)$/i.exec(v);
  if (mix) {
    const parts = splitTop(mix[1]).map((p) => p.trim());
    if (parts.length !== 2) return null;
    const parsePart = (p) => {
      const m = /^(.*?)\s*([\d.]+)%\s*$/.exec(p);
      return m
        ? { color: resolveColor(m[1], vars, depth + 1), pct: parseFloat(m[2]) }
        : { color: resolveColor(p, vars, depth + 1), pct: null };
    };
    const a = parsePart(parts[0]);
    const b = parsePart(parts[1]);
    if (!a.color || !b.color) return null;
    const p1 = a.pct == null ? null : a.pct;
    const p2 = b.pct == null ? null : b.pct;
    // 百分比不足 100% 时：颜色按占比归一化混合，alpha 降为占比之和。
    // 这是 CSS Color 5 对 color-mix() 的规定（旧锁定页那个 70%+12% 的
    // 混色之所以叠在 header-bg 上变淡，就是 alpha 只有 0.82）。
    let w1, w2, alpha;
    if (p1 == null && p2 == null) {
      w1 = 0.5;
      w2 = 0.5;
    } else if (p1 == null) {
      w1 = (100 - p2) / 100;
      w2 = p2 / 100;
    } else if (p2 == null) {
      w1 = p1 / 100;
      w2 = (100 - p1) / 100;
    } else {
      const sum = p1 + p2;
      if (sum === 0) return null;
      w1 = p1 / sum;
      w2 = p2 / sum;
      alpha = sum / 100;
    }
    if (alpha == null) alpha = 1;
    return {
      r: a.color.r * w1 + b.color.r * w2,
      g: a.color.g * w1 + b.color.g * w2,
      b: a.color.b * w1 + b.color.b * w2,
      a: a.color.a * w1 * alpha + b.color.a * w2 * alpha,
    };
  }
  return null;
}

function srgbToLab({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = f(r);
  const G = f(g);
  const B = f(b);
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const g2 = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = g2(X / 0.95047);
  const fy = g2(Y / 1.0);
  const fz = g2(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 色差：≈2.3 是「刚好可辨」，>10 是一眼可分。 */
function deltaE(c1, c2) {
  const a = srgbToLab(c1);
  const b = srgbToLab(c2);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function relativeLuminance({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度；fg 带 alpha 时先叠到 bg 上。 */
function contrast(fg, bg) {
  const c = fg.a < 1 ? composite(fg, bg) : fg;
  const l1 = relativeLuminance(c);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function composite(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

// ══════════════ CSS 解析 ══════════════

/** 把一段 CSS 拆成 [{ selector, body }]。注释先剥掉 —— 注释里出现的
 *  关键字（background / .active）会让「规则里有没有某声明」判错。 */
function parseRules(css) {
  const clean = stripComments(css);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2].trim() });
  }
  return rules;
}

function parseVars(body) {
  const vars = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    // 键保留 "--" 前缀：resolveColor 里的 var(--x) 查表用的就是带前缀的名字
    vars[`--${m[1]}`] = m[2].trim();
  }
  return vars;
}

/** 从一组 CSS 规则里取出某个选择器的声明体（多个同名选择器时合并，后写的赢）。 */
function ruleBody(rules, selector) {
  const hits = rules.filter((r) => r.selector === selector);
  if (hits.length === 0) return null;
  return hits[hits.length - 1].body;
}

/** 取出声明体里某个属性的值（最后一次出现）。 */
function decl(body, prop) {
  if (!body) return null;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "gi");
  let last = null;
  let m;
  while ((m = re.exec(body)) !== null) last = m[1].trim();
  return last;
}

const tabbarSrc = fs.readFileSync(TABBAR, "utf8");
const styleSrc = fs.readFileSync(STYLE, "utf8");

// TabBar.vue 的 <style scoped> 块
const styleOpen = tabbarSrc.indexOf("<style");
const styleClose = tabbarSrc.lastIndexOf("</style>");
if (styleOpen < 0 || styleClose < 0) {
  console.error("TabBar.vue 里找不到 <style> 块 —— 判据无法执行");
  process.exit(1);
}
const tabRules = parseRules(tabbarSrc.slice(styleOpen, styleClose));
const styleRules = parseRules(styleSrc);

// ── 前提：规则确实解析出来了（否则下面的断言会因错误的理由失败）────
section("0. 前提：CSS 真的解析出来了");
check("TabBar.vue 的 <style> 解析出足够多的规则", tabRules.length >= 10, [`实际 ${tabRules.length} 条`]);
check("style.css 解析出 4 个以上主题块", styleRules.length >= 4, [`实际 ${styleRules.length} 条`]);

// ══════════════ 1. 主题变量解析 ══════════════

section("1. 四套主题的变量解析");

// :root 块是基础，各 [data-theme="x"] 块覆盖它
const baseRule = styleRules.find((r) => r.selector.includes(":root"));
const baseVars = baseRule ? parseVars(baseRule.body) : {};
const themeRules = {};
for (const r of styleRules) {
  const m = /\[data-theme="([a-z]+)"\]/.exec(r.selector);
  if (m) themeRules[m[1]] = { rule: r, vars: parseVars(r.body) };
}

check("找得到 :root 基础变量块", !!baseRule);
check("四套主题都在（graphite/neon/latte/forest）", ["graphite", "neon", "latte", "forest"].every((t) => !!themeRules[t]), [
  `实际主题：${Object.keys(themeRules).join(", ")}`,
]);

/** 某主题下最终生效的变量：基础 + 主题覆盖。 */
function varsFor(theme) {
  const own = themeRules[theme] ? themeRules[theme].vars : {};
  return { ...baseVars, ...own };
}

const THEMES = ["graphite", "neon", "latte", "forest"];
const themeData = {};

for (const t of THEMES) {
  const vars = varsFor(t);
  const accent = resolveColor(vars["--accent"], vars);
  const tabBg = resolveColor(vars["--tab-bg"], vars);
  const text = resolveColor(vars["--text"], vars);
  const headerBg = resolveColor(vars["--header-bg"], vars);
  const tabActive = resolveColor(vars["--tab-active"], vars);
  check(`${t}：--accent / --tab-bg / --text / --header-bg 都能解析`, !!(accent && tabBg && text && headerBg));
  check(
    `${t}：--tab-active 解析成不透明色`,
    !!tabActive && tabActive.a >= 0.999,
    [`实际：${JSON.stringify(tabActive)}`]
  );
  themeData[t] = { vars, accent, tabBg, text, headerBg, tabActive };
}

// ══════════════ 2. 锁定页底色从真实规则里取 ══════════════

section("2. 从 TabBar.vue 的真实规则里解析各状态的底色");

const baseTabBody = ruleBody(tabRules, ".tab");
const activeBody = ruleBody(tabRules, ".tab.active");
const lockedRules = tabRules.filter((r) => r.selector.includes(".tab.locked"));

check("存在 .tab 基础规则", !!baseTabBody);
check("存在 .tab.active 规则", !!activeBody);
check("存在 .tab.locked 规则", lockedRules.length >= 1, [`实际 ${lockedRules.length} 条`]);

// 锁定态底色：有 background 就用（那是 bug），否则继承 .tab 的底色
function lockedBackground(theme) {
  const td = themeData[theme];
  let bg = null;
  for (const r of lockedRules) {
    const v = decl(r.body, "background");
    if (v) {
      const c = resolveColor(v, td.vars);
      if (c) bg = c;
    }
  }
  if (bg) return { color: bg, tinted: true, from: lockedRules.map((r) => r.selector).join(", ") };
  const v = decl(baseTabBody, "background");
  const c = v ? resolveColor(v, td.vars) : null;
  return { color: c, tinted: false, from: ".tab" };
}

// 当前页底色
function activeBackground(theme) {
  const td = themeData[theme];
  const v = decl(activeBody, "background");
  return v ? resolveColor(v, td.vars) : null;
}

const report = [];
for (const t of THEMES) {
  const td = themeData[t];
  const a = activeBackground(t);
  const l = lockedBackground(t);
  check(`${t}：当前页底色可解析`, !!a, [`实际：${JSON.stringify(a)}`]);
  check(`${t}：锁定页底色可解析`, !!l.color, [`实际：${JSON.stringify(l)}`]);
  if (!a || !l.color) continue;
  const dE = deltaE(a, l.color);
  const cr = contrast(td.text, a);
  report.push({ theme: t, active: a, locked: l.color, tinted: l.tinted, dE, cr });
  check(
    `${t}：当前页与锁定页底色的 ΔE ≥ ${MIN_DELTA_E}（锁定页${l.tinted ? "染了底色" : "没染底色"}）`,
    dE >= MIN_DELTA_E,
    [`实际 ΔE=${dE.toFixed(1)}`]
  );
  check(
    `${t}：当前页上的文字对比度 ≥ ${MIN_CONTRAST}`,
    cr >= MIN_CONTRAST,
    [`实际对比度=${cr.toFixed(2)}`]
  );
}

// 旧方案留个对照数字（只报告，不参与判据）
{
  const oldLocked = {};
  for (const t of THEMES) {
    const td = themeData[t];
    const c = resolveColor("color-mix(in srgb, var(--tab-active) 70%, var(--accent) 12%)", {
      ...td.vars,
      "--tab-active": td.vars["--tab-active"],
    });
    if (c) oldLocked[t] = composite(c, td.headerBg);
  }
  if (oldLocked.graphite) {
    const before = deltaE(themeData.graphite.tabActive, oldLocked.graphite);
    console.log(`  info  旧方案对照：graphite 当前页 vs 旧锁定页 ΔE=${before.toFixed(1)}（修复前实测 4.6~9.1，肉眼分不开）`);
  }
}

// ══════════════ 3. 静态断言：锁定态不得与当前态抢通道 ══════════════

section("3. 静态断言：根因①（锁定态染底色）与根因②（锁定态盖住当前态）");

for (const r of lockedRules) {
  check(
    `锁定态规则「${r.selector}」不声明 background（染底色＝看起来像被选中）`,
    !decl(r.body, "background"),
    [`实际声明：${decl(r.body, "background")}`]
  );
  check(
    `锁定态规则「${r.selector}」排除 .active（否则会盖掉当前页的高亮）`,
    r.selector.includes(":not(.active)"),
    [`实际选择器：${r.selector}`]
  );
  const bb = decl(r.body, "border-bottom");
  check(
    `锁定态规则「${r.selector}」的底边是虚线（与当前页的实线是两条不同通道）`,
    !!bb && /dashed/i.test(bb),
    [`实际：${bb}`]
  );
}

const activeBorder = decl(activeBody, "border-bottom");
check("当前页底边是实线强调色", !!activeBorder && /solid/i.test(activeBorder) && activeBorder.includes("var(--accent)"), [
  `实际：${activeBorder}`,
]);
check(
  "所有标签都预留了同样宽的透明底边（切换当前页时文字不抖 1px）",
  !!decl(baseTabBody, "border-bottom") && /2px\s+solid\s+transparent/i.test(decl(baseTabBody, "border-bottom")),
  [`实际：${decl(baseTabBody, "border-bottom")}`]
);

// ══════════════ 4. 报告 ══════════════

if (report.length) {
  console.log(`\n── 数值总览（ΔE：当前页 vs 锁定页底色）`);
  console.log(`  ${"主题".padEnd(10)}${"当前页底色".padEnd(18)}${"锁定页底色".padEnd(18)}${"ΔE".padStart(6)}${"文字CR".padStart(8)}`);
  for (const r of report) {
    const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    console.log(
      `  ${r.theme.padEnd(10)}${hex(r.active).padEnd(18)}${hex(r.locked).padEnd(18)}${r.dE.toFixed(1).padStart(6)}${r.cr.toFixed(2).padStart(8)}`
    );
  }
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
