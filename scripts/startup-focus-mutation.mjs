// 变异测试：确认 startup-focus-check.mjs 的断言真能抓到「启动后焦点没落位」
// 的各类退化实现。
//
// 这个 bug 的失效是静默的：界面一切正常、目录也列出来了，只是 ↑/↓ 没反应，
// 或者焦点落在默认的左栏而不是上次在用的右栏。所以「测试全绿」和「bug 还在」
// 可以同时成立。这里每个变异都必须让套件 FAIL；漏掉一个即视为断言没分辨力。
//
// 还原只用内存原文写回（绝不 git checkout —— 那样会把本轮刚做好的修复一起回滚）。
//
// Run: node scripts/startup-focus-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "startup-focus-check.mjs");
const MODULE = path.join(ROOT, "src", "startupFocus.js");
const APP = path.join(ROOT, "src", "App.vue");
const MAIN = path.join(ROOT, "src", "main.js");
const VIEW = path.join(ROOT, "src", "viewState.js");

const files = [MODULE, APP, MAIN, VIEW];
const originals = Object.fromEntries(
  files.map((f) => [f, fs.readFileSync(f, "utf8")])
);

// ⚠️ 锚点的换行符必须按目标文件归一化（锚点 count==0 → 变异没注入 →
// 套件全绿 → 被误读成「断言瞎」）。本仓库都是 LF，但每轮仍按文件实测。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

const MUTANTS = [
  // ── 判据本身（src/startupFocus.js）──────────────────────────────
  {
    target: MODULE,
    name: "不等就绪就抢焦点（配置没到 / splash 还在 → 落到默认左栏）",
    from: "  const ready = timedOut || (stateReady && splashGone);",
    to: "  const ready = true;",
  },
  {
    target: MODULE,
    name: "去掉输入/预览守卫（抢用户正在打的字）",
    from: '  if (typingTarget || inPreviewSurface) return "stop";',
    to: '  if (false) return "stop";',
  },
  {
    target: MODULE,
    name: "去掉系统焦点等待（focus() 被静默丢弃且不再重试）",
    from: '  if (!hasSystemFocus) return "wait";',
    to: '  if (false) return "wait";',
  },
  {
    target: MODULE,
    name: "去掉「已在列表就收手」（无限重复 focus）",
    from: '  if (listFocused) return "stop";',
    to: '  if (false) return "stop";',
  },
  {
    target: MODULE,
    name: "去掉帧数上限（窗口永不聚焦时死循环）",
    from: '  if (frames >= maxFrames) return "stop";',
    to: "  // no frame cap",
  },
  {
    target: MODULE,
    name: "去掉尝试次数上限（focusList 永远失败时反复抢焦点）",
    from: '  if (attempts >= maxAttempts) return "stop";',
    to: "  // no attempt cap",
  },
  {
    target: MODULE,
    name: "活动面板校验失效（损坏的配置能指定不存在的面板）",
    from: '  return value === "left" || value === "right" ? value : null;',
    to: '  return "left";',
  },
  {
    target: MODULE,
    name: "「已聚焦」退化成只看任意列表（窗口 focus 竞态下停错面板）",
    from: 'export function isListFocusedInPanel(activeElement, panelId) {\n  if (!isListFocused(activeElement)) return false;\n  const panel =\n    typeof activeElement.closest === "function"\n      ? activeElement.closest(".file-panel")\n      : null;\n  return !!(panel && panel.dataset && panel.dataset.panelId === panelId);\n}',
    to: "export function isListFocusedInPanel(activeElement, panelId) {\n  return isListFocused(activeElement);\n}",
  },

  // ── 落地点（src/App.vue）────────────────────────────────────────
  {
    target: APP,
    name: "判据说 focus 但不调用 focusList（= 原 bug）",
    from: '    startupAttempts += 1;\n    const panel = activePanel.value === "left" ? leftPanel.value : rightPanel.value;\n    panel?.focusList?.();',
    to: '    startupAttempts += 1;\n    const panel = activePanel.value === "left" ? leftPanel.value : rightPanel.value;\n    void panel;',
  },
  {
    target: APP,
    name: "不把「已在活动面板的文件列表」传给判据（每帧重复抢焦点）",
    from: "    listFocused: isListFocusedInPanel(el, activePanel.value),",
    to: "    listFocused: false,",
  },
  {
    target: APP,
    name: "落位判定钉死在左栏（保存的活动面板是右栏时永远停不下来）",
    from: "    listFocused: isListFocusedInPanel(el, activePanel.value),",
    to: '    listFocused: isListFocusedInPanel(el, "left"),',
  },
  {
    target: APP,
    name: "不把系统焦点传给判据（窗口没聚焦时也白试一次）",
    from: "    hasSystemFocus: document.hasFocus(),",
    to: "    hasSystemFocus: true,",
  },
  {
    target: APP,
    name: "不监听 splash-removed（永远等不到就绪信号）",
    from: 'window.addEventListener("minitc:splash-removed", onStartupSplashRemoved)',
    to: 'window.addEventListener("minitc:never", onStartupSplashRemoved)',
  },
  {
    target: APP,
    name: "不恢复保存的活动面板（永远落回默认左栏）",
    from: "      if (savedActivePanel.value) activePanel.value = savedActivePanel.value;",
    to: "      // saved active panel ignored",
  },
  {
    target: APP,
    name: "不标记状态已就绪（判据会一直 wait）",
    from: "      startupStateReady = true;",
    to: "      startupStateReady = false;",
  },
  {
    target: APP,
    name: "不保存活动面板的切换（下次启动仍是旧栏）",
    from: "watch(activePanel, (id) => setSavedActivePanel(id));",
    to: "watch(activePanel, () => {});",
  },

  // ── 就绪信号（src/main.js）──────────────────────────────────────
  {
    target: MAIN,
    name: "不派发 splash-removed（启动焦点循环拿不到信号）",
    from: '    window.dispatchEvent(new CustomEvent("minitc:splash-removed"));',
    to: "    // no signal",
  },
  {
    target: MAIN,
    name: "淡出不再等两栏列完（信号提前，恢复的 tab 还没上屏）",
    from: "  const ready = elapsed >= SPLASH_MIN_SHOW_MS && panelsListed >= PANEL_COUNT;",
    to: "  const ready = elapsed >= SPLASH_MIN_SHOW_MS;",
  },
  {
    target: MAIN,
    name: "去掉 transitionend 兜底（无合成帧时永远不发信号）",
    from: "  setTimeout(finishSplash, SPLASH_FADE_MS + 100);",
    to: "  // no fallback",
  },

  // ── 持久化（src/viewState.js）───────────────────────────────────
  {
    target: VIEW,
    name: "不把 activePanel 写进配置文件",
    from: "      activePanel: savedActivePanel.value,",
    to: "      // activePanel not persisted",
  },
  {
    target: VIEW,
    name: "读入时不校验面板名",
    from: "    const activePanel = normalizeActivePanel(raw.activePanel);",
    to: "    const activePanel = raw.activePanel;",
  },
  {
    target: VIEW,
    name: "写回时不校验面板名",
    from: "  const id = normalizeActivePanel(panelId);",
    to: "  const id = panelId;",
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = fs.readFileSync(m.target, "utf8");
  const from = nlFor(m.target, m.from);
  const to = nlFor(m.target, m.to);
  const parts = before.split(from);
  console.log(`\n▶ ${m.name}`);
  console.log(`  anchor found: ${parts.length - 1}`);
  if (parts.length !== 2) {
    console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
    missed += 1;
    continue;
  }
  const mutated = parts.join(to);
  if (mutated === before) {
    console.log("  FAIL 变异产生了同样的内容 —— 变异无效");
    missed += 1;
    continue;
  }

  fs.writeFileSync(m.target, mutated, "utf8");
  let failed = false;
  let tail = "";
  try {
    const out = execFileSync(process.execPath, [SUITE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    tail = (out.match(/^通过 \d+ \/ \d+/m) || [""])[0];
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = (out.match(/^通过 \d+ \/ \d+/m) || [""])[0] || "threw";
    const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
    if (firstFail) tail += " | " + firstFail.trim();
  } finally {
    fs.writeFileSync(m.target, before, "utf8");
  }

  if (failed) {
    caught += 1;
    console.log(`  ok    caught: ${m.name}  (${tail})`);
  } else {
    missed += 1;
    console.log(`  FAIL  NOT CAUGHT: ${m.name}  (${tail})`);
  }
}

// 源文件必须逐字节还原。
console.log("");
let dirty = false;
for (const [file, src] of Object.entries(originals)) {
  const now = fs.readFileSync(file, "utf8");
  const same = now === src;
  console.log(`  source restored: ${path.basename(file)} = ${same}`);
  if (!same) {
    fs.writeFileSync(file, src, "utf8");
    dirty = true;
    console.log("    rewrote original");
  }
}
if (dirty) process.exit(1);

console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0) process.exit(1);
