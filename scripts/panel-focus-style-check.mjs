// 断言「当前有焦点的那一栏」与「另一栏」在视觉上必须能区分。
//
// 直接 `node scripts/panel-focus-style-check.mjs` 跑；变异臂在
// scripts/panel-focus-style-mutation.mjs。
//
// ── 这个 bug 的形状 ────────────────────────────────────────────────
// 2026-11-10：应用一打开，用户看不出焦点在左栏还是右栏。
// 根因：焦点信号只有一条 —— `.file-panel.active { border-color: var(--accent) }`，
// 1px 强调色边框贴在深色底上。四套主题里有三套（石墨/霓虹/墨竹）这层
// 蓝边和普通边框（--border）几乎一个观感；就算看见了边框，「哪一栏是
// 活的」这个信息也只挂在一个通道上，任何主题的对比度一调就废。
//
// ── 最终设计（三条互相独立的通道）──────────────────────────────────
//   ① 描边：`.file-panel.active` 用 outline 画在边框内侧（offset 为负），
//      不占布局 —— 切换焦点时内容不抖 1px；配合强调色边框共 2px 视觉厚度。
//   ② 底色：焦点栏面板底色往强调色偏（--panel-active-bg）—— 面积最大的
//      通道，整片文件列表区都带着这个色偏。
//   ③ 路径栏：焦点栏的路径栏染成强调色底 + 实线强调色下边。
// 另有非焦点栏的边框压暗（--panel-idle-border），与焦点栏拉开距离。
//
// ── 为什么断言要落到「数值」上 ─────────────────────────────────────
// 只断言「CSS 里存在 .file-panel.active 规则」是恒真的（谁都写得出来）。
// 真正的判据是**用户能不能分辨**：焦点栏与非焦点栏的底色差 ΔE 要够大、
// 描边色与底色的 ΔE 要够大（不然等于没描边）、染色后文字对比度仍要达标。
// 这些都能从真实 CSS 变量算出来 —— 解析 style.css 的四套主题 +
// FilePanel.vue 的规则，把 color-mix() 真的算一遍。
//
// ── 判据分层 ────────────────────────────────────────────────────────
//   1. 前提：四套主题的变量都能解析；--panel-active-bg 在每套主题下算出不透明色。
//   2. 数值：焦点栏 vs 非焦点栏底色 ΔE ≥ 6；描边色 vs 底色 ΔE ≥ 12；
//      路径栏染色 vs 原路径栏底色 ΔE ≥ 12；染色后文字对比度 ≥ 4.5 (WCAG AA)。
//   3. 静态：焦点栏至少要有 3 条独立通道；描边必须画在内侧（offset < 0）；
//      非焦点栏不得用 opacity/filter 压暗内容（那会把「看出焦点」换成
//      「另一栏看不清字」）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const STYLE = path.join(ROOT, "src", "style.css");

// ── 阈值（依据见文件头；改这里等于改判据，不是改实现）──────────────
const MIN_DELTA_E_PANEL = 6;   // 焦点栏底色 vs 非焦点栏底色
const MIN_DELTA_E_FRAME = 12;  // 描边色 vs 面板底色（描边本身要看得出来）
const MIN_DELTA_E_HEADER = 12; // 焦点栏路径栏底色 vs 普通路径栏底色
const MIN_DELTA_E_IDLE = 3;    // 非焦点栏边框 vs 原 --border（确实被压暗了）
const MIN_CONTRAST = 4.5;      // WCAG AA 正文对比度
const MIN_CHANNELS = 3;        // 焦点栏至少要有几条独立通道

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
 *  关键字（outline / .active）会让「规则里有没有某声明」判错。 */
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

const panelSrc = fs.readFileSync(PANEL, "utf8");
const styleSrc = fs.readFileSync(STYLE, "utf8");

const styleOpen = panelSrc.indexOf("<style");
const styleClose = panelSrc.lastIndexOf("</style>");
if (styleOpen < 0 || styleClose < 0) {
  console.error("FilePanel.vue 里找不到 <style> 块 —— 判据无法执行");
  process.exit(1);
}
// 去掉 <style scoped> 这个标签本身，否则第一条规则的选择器会粘上标签文本。
const panelCss = panelSrc.slice(styleOpen, styleClose).replace(/<style[^>]*>/i, "");
const panelRules = parseRules(panelCss);
const styleRules = parseRules(styleSrc);

// ── 前提：规则确实解析出来了（否则下面的断言会因错误的理由失败）────
section("0. 前提：CSS 真的解析出来了");
check("FilePanel.vue 的 <style> 解析出足够多的规则", panelRules.length >= 5, [`实际 ${panelRules.length} 条`]);
check("style.css 解析出 4 个以上主题块", styleRules.length >= 4, [`实际 ${styleRules.length} 条`]);

// ══════════════ 1. 主题变量解析 ══════════════

section("1. 四套主题的变量解析");

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

function varsFor(theme) {
  const own = themeRules[theme] ? themeRules[theme].vars : {};
  return { ...baseVars, ...own };
}

const THEMES = ["graphite", "neon", "latte", "forest"];
const themeData = {};

for (const t of THEMES) {
  const vars = varsFor(t);
  const accent = resolveColor(vars["--accent"], vars);
  const panelBg = resolveColor(vars["--panel-bg"], vars);
  const headerBg = resolveColor(vars["--header-bg"], vars);
  const border = resolveColor(vars["--border"], vars);
  const text = resolveColor(vars["--text"], vars);
  const activeBg = resolveColor(vars["--panel-active-bg"], vars);
  const activeHeaderBg = resolveColor(vars["--panel-active-header-bg"], vars);
  const idleBorder = resolveColor(vars["--panel-idle-border"], vars);
  check(
    `${t}：焦点栏相关的变量都能解析`,
    !!(accent && panelBg && headerBg && border && text && activeBg && activeHeaderBg && idleBorder),
    [`实际：accent=${!!accent} panelBg=${!!panelBg} headerBg=${!!headerBg} border=${!!border} text=${!!text} activeBg=${!!activeBg} activeHeaderBg=${!!activeHeaderBg} idleBorder=${!!idleBorder}`]
  );
  check(`${t}：--panel-active-bg 解析成不透明色`, !!activeBg && activeBg.a >= 0.999, [`实际：${JSON.stringify(activeBg)}`]);
  themeData[t] = { vars, accent, panelBg, headerBg, border, text, activeBg, activeHeaderBg, idleBorder };
}

// ══════════════ 2. 数值判据：用户能不能分辨 ══════════════

section("2. 数值判据（焦点栏 vs 另一栏）");

const report = [];
for (const t of THEMES) {
  const td = themeData[t];
  const { accent, panelBg, headerBg, border, text, activeBg, activeHeaderBg, idleBorder } = td;
  if (!accent || !panelBg || !activeBg || !activeHeaderBg || !idleBorder || !text || !headerBg || !border) continue;

  const dEbg = deltaE(activeBg, panelBg);
  const dEframe = deltaE(accent, panelBg);
  const dEhdr = deltaE(activeHeaderBg, headerBg);
  const dEidle = deltaE(idleBorder, border);
  const dEidleVsAccent = deltaE(idleBorder, accent);
  const crBody = contrast(text, activeBg);
  const crHdr = contrast(text, activeHeaderBg);

  report.push({ theme: t, dEbg, dEframe, dEhdr, crBody, crHdr, activeBg, panelBg });

  check(
    `${t}：焦点栏底色 vs 另一栏底色 ΔE ≥ ${MIN_DELTA_E_PANEL}`,
    dEbg >= MIN_DELTA_E_PANEL,
    [`实际 ΔE=${dEbg.toFixed(1)}`]
  );
  check(
    `${t}：描边色（--accent）与面板底色 ΔE ≥ ${MIN_DELTA_E_FRAME}（描边本身要看得出来）`,
    dEframe >= MIN_DELTA_E_FRAME,
    [`实际 ΔE=${dEframe.toFixed(1)}`]
  );
  check(
    `${t}：焦点栏路径栏底色 vs 普通路径栏底色 ΔE ≥ ${MIN_DELTA_E_HEADER}`,
    dEhdr >= MIN_DELTA_E_HEADER,
    [`实际 ΔE=${dEhdr.toFixed(1)}`]
  );
  check(
    `${t}：焦点栏底色上的文字对比度 ≥ ${MIN_CONTRAST}`,
    crBody >= MIN_CONTRAST,
    [`实际对比度=${crBody.toFixed(2)}`]
  );
  check(
    `${t}：焦点栏路径栏上的文字对比度 ≥ ${MIN_CONTRAST}`,
    crHdr >= MIN_CONTRAST,
    [`实际对比度=${crHdr.toFixed(2)}`]
  );
  check(
    `${t}：非焦点栏边框确实被压暗（与原 --border 的 ΔE ≥ ${MIN_DELTA_E_IDLE}）`,
    dEidle >= MIN_DELTA_E_IDLE,
    [`实际 ΔE=${dEidle.toFixed(1)}`]
  );
  check(
    `${t}：非焦点栏边框不会被误读成强调色（与 --accent 的 ΔE ≥ ${MIN_DELTA_E_FRAME}）`,
    dEidleVsAccent >= MIN_DELTA_E_FRAME,
    [`实际 ΔE=${dEidleVsAccent.toFixed(1)}`]
  );
}

// ══════════════ 3. 静态断言：结构与通道数 ══════════════

section("3. 静态断言：焦点信号的结构");

const baseBody = ruleBody(panelRules, ".file-panel");
const activeBody = ruleBody(panelRules, ".file-panel.active");
const idleBody = ruleBody(panelRules, ".file-panel:not(.active)");
const headerRule = panelRules.find((r) => r.selector.includes(":deep(.path-bar)"));
const crumbRule = panelRules.find((r) => r.selector.includes(":deep(.breadcrumb)"));

check("存在 .file-panel 基础规则", !!baseBody);
check("存在 .file-panel.active 规则", !!activeBody, ["未找到焦点栏规则"]);
check("存在 .file-panel:not(.active) 规则", !!idleBody, ["未找到非焦点栏规则"]);
check("存在焦点栏路径栏规则（:deep(.path-bar)）", !!headerRule, [
  `实际选择器：${panelRules.filter((r) => r.selector.includes("path-bar")).map((r) => r.selector).join(", ") || "无"}`,
]);
check("存在焦点栏面包屑染色规则（:deep(.breadcrumb)）", !!crumbRule, [
  `实际选择器：${panelRules.filter((r) => r.selector.includes("breadcrumb")).map((r) => r.selector).join(", ") || "无"}`,
]);

// 通道①：描边。必须画在内侧（offset < 0），画在外侧会被 wrapper 的
// overflow:hidden 裁掉 —— 那样等于没描边。
const outline = decl(activeBody, "outline");
const outlineOffset = decl(activeBody, "outline-offset");
check(
  "焦点栏有强调色描边（outline，≥1px 实线 var(--accent)）",
  !!outline && /solid/i.test(outline) && /var\(--accent\)/.test(outline) && parseFloat(outline) >= 1,
  [`实际：${outline}`]
);
check(
  "描边画在边框内侧（outline-offset 为负）",
  !!outlineOffset && parseFloat(outlineOffset) < 0,
  [`实际：${outlineOffset}`]
);

// 通道②：底色。焦点栏用 --panel-active-bg，另一栏用 --panel-bg。
check(
  "焦点栏底色走 --panel-active-bg（不是原样 --panel-bg）",
  decl(activeBody, "background") === "var(--panel-active-bg)",
  [`实际：${decl(activeBody, "background")}`]
);
check(
  "焦点栏边框用强调色",
  decl(activeBody, "border-color") === "var(--accent)",
  [`实际：${decl(activeBody, "border-color")}`]
);
check(
  "非焦点栏底色保持 --panel-bg（不被染色）",
  decl(idleBody, "background") === "var(--panel-bg)",
  [`实际：${decl(idleBody, "background")}`]
);
check(
  "非焦点栏边框走 --panel-idle-border（压暗，与焦点栏拉开距离）",
  decl(idleBody, "border-color") === "var(--panel-idle-border)",
  [`实际：${decl(idleBody, "border-color")}`]
);

// 通道③：路径栏染色 + 强调色下边。
check(
  "焦点栏路径栏底色走 --panel-active-header-bg",
  !!headerRule && decl(headerRule.body, "background") === "var(--panel-active-header-bg)",
  [`实际：${headerRule ? decl(headerRule.body, "background") : "无规则"}`]
);
check(
  "焦点栏路径栏有实线强调色下边",
  !!headerRule && /var\(--accent\)/.test(decl(headerRule.body, "border-bottom-color") || ""),
  [`实际：${headerRule ? decl(headerRule.body, "border-bottom-color") : "无规则"}`]
);
// 面包屑自己带底色（--bg），不单独染的话整条路径栏只有按钮之间的几条缝
// 发亮 —— 等于没信号（实测截图：路径栏看起来和另一栏一模一样）。
check(
  "焦点栏面包屑底色走 --panel-active-header-bg",
  !!crumbRule && decl(crumbRule.body, "background") === "var(--panel-active-header-bg)",
  [`实际：${crumbRule ? decl(crumbRule.body, "background") : "无规则"}`]
);
check(
  "焦点栏面包屑边框用强调色",
  !!crumbRule && decl(crumbRule.body, "border-color") === "var(--accent)",
  [`实际：${crumbRule ? decl(crumbRule.body, "border-color") : "无规则"}`]
);

// 通道数：焦点栏至少要有 3 条独立通道，任何一条被拿掉都还有别的顶着。
const channels = [
  ["描边", !!outline],
  ["边框色", decl(activeBody, "border-color") === "var(--accent)"],
  ["面板底色", decl(activeBody, "background") === "var(--panel-active-bg)"],
  ["路径栏染色", !!headerRule && decl(headerRule.body, "background") === "var(--panel-active-header-bg)"],
  ["面包屑染色", !!crumbRule && decl(crumbRule.body, "background") === "var(--panel-active-header-bg)"],
].filter(([, on]) => on);
check(
  `焦点栏至少有 ${MIN_CHANNELS} 条独立视觉通道（现在 ${channels.length} 条：${channels.map((c) => c[0]).join("、")}）`,
  channels.length >= MIN_CHANNELS,
  [`实际：${channels.length} 条`]
);

// 可读性：非焦点栏不得靠压暗内容来「退居二线」—— 那会把
// 「一眼看出焦点」换成「另一栏看不清字」。
check(
  "非焦点栏不用 opacity / filter 压暗内容（可读性不能牺牲）",
  !decl(idleBody, "opacity") && !decl(idleBody, "filter") && !decl(idleBody, "backdrop-filter"),
  [`实际：opacity=${decl(idleBody, "opacity")} filter=${decl(idleBody, "filter")}`]
);
check(
  "焦点栏规则里不出现 opacity（面板本身不该被整体压暗）",
  !decl(activeBody, "opacity"),
  [`实际：${decl(activeBody, "opacity")}`]
);

// 状态必须真的挂到根元素上（否则样式写了也不生效）。
const tmplClean = stripComments(panelSrc).replace(/<!--[\s\S]*?-->/g, "");
check(
  "模板把 isActive 绑成 .file-panel 上的 active 类",
  /class="file-panel"[^>]*:class="\{[^}]*active[^}]*\}"/.test(tmplClean) ||
    /:class="\{[^}]*active[^}]*\}"[^>]*class="file-panel"/.test(tmplClean),
  ["实际模板里没找到 active 类绑定"]
);
check(
  "面板声明了 isActive prop",
  /isActive\s*:\s*\{\s*type\s*:\s*Boolean/.test(tmplClean),
  ["未找到 isActive prop 声明"]
);

// ══════════════ 4. scoped 编译后的真实命中性 ══════════════
//
// 这一节防的是最隐蔽的一类回归：上面所有断言读的都是**源码里的选择器**，
// 但浏览器认的是 Vue scoped 编译**之后**的产物。`FilePanel.vue` 是
// `<style scoped>`，而 `.path-bar` / `.breadcrumb` 住在子组件 PathBar.vue 里 ——
// 它们身上带的是 PathBar 的 scope id，不是 FilePanel 的。
//
// 所以 `FilePanel.vue` 里必须写 `:deep(.path-bar)`。若漏写 `:deep`，编译出来
// 是 `.file-panel.active[data-v-x] .path-bar[data-v-x]`，而 PathBar 的根节点
// 只带 PathBar 自己的 scope id —— 永远不命中，样式静默失效，源码层面
// 的断言却全都还「通过」。
//
// 这里直接调 vue/compiler-sfc 把两边的 scoped 样式都编译一遍，比对
// 编译后选择器的特异性：父组件的 :deep 规则必须压得住子组件自己的规则。

section("4. scoped 编译后仍能命中子组件（:deep 不能漏写）");

let sfcOk = true;
let compiledPanelCss = "";
let compiledPathCss = "";
try {
  const { parse, compileStyle } = await import("vue/compiler-sfc");
  const SCOPE = "data-v-probe";

  const compileScoped = (file) => {
    const src = fs.readFileSync(file, "utf8");
    const { descriptor, errors } = parse(src, { filename: file });
    if (errors.length) throw new Error(`${path.basename(file)} 解析失败：${errors[0].message}`);
    const out = compileStyle({
      source: descriptor.styles[0].content,
      filename: file,
      id: SCOPE,
      scoped: true,
    });
    if (out.errors.length) throw new Error(`${path.basename(file)} 编译失败：${out.errors[0].message}`);
    return out.code;
  };

  compiledPanelCss = compileScoped(PANEL);
  compiledPathCss = compileScoped(path.join(ROOT, "src", "components", "PathBar.vue"));
} catch (e) {
  sfcOk = false;
  check("能用 vue/compiler-sfc 编译 FilePanel.vue 与 PathBar.vue 的 scoped 样式", false, [
    `实际：${e && e.message ? e.message : String(e)}`,
  ]);
}

if (sfcOk) {
  // 选择器特异性：ID(1) > class/attr/pseudo-class(10) > 元素(1)。
  // 只数 class / attribute / 伪类，够这两条规则用。
  const specificity = (sel) => {
    const s = sel.replace(/::?[a-z-]+(\([^)]*\))?/gi, (m) => m); // 保留伪类本身
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+/g) || []).length;
    const attrs = (s.match(/\[[^\]]+\]/g) || []).length;
    const pseudos = (s.match(/::?[\w-]+(\([^)]*\))?/g) || []).filter((p) => !p.startsWith("::")).length;
    const elements = (s.replace(/[.#][\w-]+/g, " ").replace(/\[[^\]]+\]/g, " ").replace(/::?[\w-]+(\([^)]*\))?/g, " ").match(/[a-z][\w-]*/gi) || []).length;
    return ids * 10000 + (classes + attrs + pseudos) * 100 + elements;
  };

  // 取编译产物里的规则：选择器 + 声明体
  const compiledRules = (css) => {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sels = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      for (const sel of sels) out.push({ selector: sel, body: m[2], spec: specificity(sel) });
    }
    return out;
  };

  const panelRulesC = compiledRules(compiledPanelCss);
  const pathRulesC = compiledRules(compiledPathCss);

  // 焦点栏的 :deep 规则，编译后必须仍然是「后代选择器」—— 即编译产物里
  // 出现 `.path-bar` / `.breadcrumb`，而不是被 scope id 钉在最后一段。
  const findCompiled = (rules, cls) => rules.find((r) => r.selector.includes(cls));

  const activePath = findCompiled(panelRulesC, ".path-bar");
  const activeCrumb = findCompiled(panelRulesC, ".breadcrumb");

  check(
    "scoped 编译后焦点栏路径栏规则仍命中 .path-bar",
    !!activePath && /background:\s*var\(--panel-active-header-bg\)/.test(activePath.body),
    [`实际：${activePath ? activePath.selector + " => " + activePath.body.trim().slice(0, 80) : "编译产物里没有 .path-bar 规则"}`]
  );
  check(
    "scoped 编译后焦点栏面包屑规则仍命中 .breadcrumb",
    !!activeCrumb && /background:\s*var\(--panel-active-header-bg\)/.test(activeCrumb.body),
    [`实际：${activeCrumb ? activeCrumb.selector + " => " + activeCrumb.body.trim().slice(0, 80) : "编译产物里没有 .breadcrumb 规则"}`]
  );

  // 编译产物里，:deep 的最后一段不能带 scope id（带了就打不中子组件内部）。
  const deepTailHasScope = (rule) => {
    if (!rule) return false;
    const last = rule.selector.split(/\s+|>/).filter(Boolean).pop() || "";
    return /\[data-v-[0-9a-f]+\]/.test(last);
  };
  check(
    "焦点栏 :deep 规则编译后末段不带 scope id（带了就打不中子组件内部）",
    !deepTailHasScope(activePath) && !deepTailHasScope(activeCrumb),
    [
      `实际：path-bar 末段 = ${activePath ? activePath.selector.split(/\s+|>/).filter(Boolean).pop() : "无"}`,
      `实际：breadcrumb 末段 = ${activeCrumb ? activeCrumb.selector.split(/\s+|>/).filter(Boolean).pop() : "无"}`,
    ]
  );

  // 特异性必须压过子组件自己的规则，否则编译后是「子组件规则胜出」。
  const childPath = findCompiled(pathRulesC, ".path-bar");
  const childCrumb = findCompiled(pathRulesC, ".breadcrumb");
  check(
    "焦点栏路径栏规则的特异性压过 PathBar 自身的 .path-bar 规则",
    !!activePath && !!childPath && activePath.spec > childPath.spec,
    [
      `实际：父 = ${activePath ? activePath.selector + " (spec " + activePath.spec + ")" : "无"}`,
      `实际：子 = ${childPath ? childPath.selector + " (spec " + childPath.spec + ")" : "无"}`,
    ]
  );
  check(
    "焦点栏面包屑规则的特异性压过 PathBar 自身的 .breadcrumb 规则",
    !!activeCrumb && !!childCrumb && activeCrumb.spec > childCrumb.spec,
    [
      `实际：父 = ${activeCrumb ? activeCrumb.selector + " (spec " + activeCrumb.spec + ")" : "无"}`,
      `实际：子 = ${childCrumb ? childCrumb.selector + " (spec " + childCrumb.spec + ")" : "无"}`,
    ]
  );

  // !important 直接无视特异性 —— 子组件一旦给自己的底色加了 !important，
  // 父组件的焦点染色就被抢回去（哪怕特异性更高也没用）。
  const childImportant = pathRulesC.filter(
    (r) => (r.selector.includes(".path-bar") || r.selector.includes(".breadcrumb")) && /!important/.test(r.body)
  );
  check(
    "PathBar 自身的路径栏/面包屑底色没有用 !important（否则会抢回焦点染色）",
    childImportant.length === 0,
    childImportant.map((r) => `实际：${r.selector} => ${r.body.trim().slice(0, 80)}`)
  );

  // 兜底：整段编译产物里，焦点栏的染色声明必须真的带 --panel-active-header-bg。
  check(
    "编译产物中存在焦点栏染色声明（--panel-active-header-bg）",
    /--panel-active-header-bg/.test(compiledPanelCss),
    ["编译后的 FilePanel 样式里找不到 --panel-active-header-bg"]
  );

  // ── 跨文件契约：:deep() 指向的类名必须真的存在于 PathBar 的模板里 ──
  //
  // 这一条独立于第 3 节：第 3 节读的是 FilePanel 源码里的选择器，而
  // `.path-bar` / `.breadcrumb` 这两个类名**住在 PathBar.vue 的模板里**。
  // 若哪天 PathBar 把根节点的 class 改了（重构常见），FilePanel 的
  // `:deep(.path-bar)` 会立刻失效 —— 编译得过、不报错、源码断言全绿，
  // 但焦点栏的路径栏就是不再染色。靠读两边源码对不上号来防。
  //
  // 匹配要按 class **token** 精确比：不能用 \b —— `path-bar-v2` 里
  // `\bpath-bar\b` 同样成立（`-` 是非单词字符），改名会被误判成命中。
  const pathTemplate = fs.readFileSync(path.join(ROOT, "src", "components", "PathBar.vue"), "utf8");
  const pathTemplateOnly = pathTemplate.slice(0, pathTemplate.indexOf("<script"));
  const templateClassTokens = (() => {
    const set = new Set();
    const re = /class\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(pathTemplateOnly))) {
      for (const t of m[1].split(/\s+/)) if (t) set.add(t);
    }
    return set;
  })();

  for (const cls of [".path-bar", ".breadcrumb", ".virtual-display"]) {
    const bare = cls.slice(1);
    check(
      `PathBar 模板里仍存在类名 ${cls}（FilePanel 的 :deep(${cls}) 要有落点）`,
      templateClassTokens.has(bare),
      [`实际：PathBar.vue 模板的 class 里没有 token "${bare}" —— FilePanel 的 :deep(${cls}) 会落空`]
    );
  }

  // ── 焦点栏专属：:deep 规则必须以 .active 为前提 ─────────────────
  //
  // 若写成 `.file-panel :deep(.path-bar)`（少了 .active），两栏的路径栏
  // 都会被染色 —— 焦点信号直接失效，而且第 3 节的源码级断言（只看
  // 「有没有这条规则、声明对不对」）察觉不到。
  for (const [label, rule] of [["路径栏", activePath], ["面包屑", activeCrumb]]) {
    check(
      `焦点栏${label}规则以 .active 为前提（否则两栏都染色）`,
      !!rule && /\.active\b/.test(rule.selector),
      [`实际编译后选择器：${rule ? rule.selector : "无"}`]
    );
  }
}

// ══════════════ 5. 报告 ══════════════

if (report.length) {
  console.log(`\n── 数值总览（ΔE：焦点栏 vs 另一栏）`);
  console.log(
    `  ${"主题".padEnd(10)}${"焦点栏底色".padEnd(12)}${"另一栏底色".padEnd(12)}${"底色ΔE".padStart(7)}${"描边ΔE".padStart(8)}${"路径栏ΔE".padStart(9)}${"文字CR".padStart(8)}`
  );
  for (const r of report) {
    const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    console.log(
      `  ${r.theme.padEnd(10)}${hex(r.activeBg).padEnd(12)}${hex(r.panelBg).padEnd(12)}${r.dEbg.toFixed(1).padStart(7)}${r.dEframe.toFixed(1).padStart(8)}${r.dEhdr.toFixed(1).padStart(9)}${r.crBody.toFixed(2).padStart(8)}`
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
