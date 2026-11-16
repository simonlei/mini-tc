// 验证「启动后键盘焦点落在上次活动面板（也就是上次选中的 tab）的文件列表」。
// 直接 `node scripts/startup-focus-check.mjs` 跑；变异臂在
// scripts/startup-focus-mutation.mjs。
//
// ── 这个 bug 的形状 ────────────────────────────────────────────────
// 冷启动后 document.activeElement 停在 <body>：唯一会主动把焦点交回文件列表
// 的地方是「窗口重新获得焦点」的处理器，以及「退出时开着预览」的恢复路径。
// 两者在「窗口本来就拿着焦点」的启动场景都不会跑，于是 ↑/↓ / Enter / Tab
// 全部失灵，直到用户手动点一行。更隐蔽的是活动面板本身没有持久化 ——
// 就算交了焦点，也会落在默认的左栏，而不是用户上次在用的右栏 tab。
//
// ── 判据分层 ──────────────────────────────────────────────────────
//   1. 纯逻辑：startupFocusDecision 的真值表（何时等 / 何时抢 / 何时收手）。
//   2. 时序模拟：jsdom 里跑一遍「配置还没到 → 窗口没系统焦点 → splash 移除
//      → 焦点落到右栏 .file-list → 收手」，验证结果真的是焦点落位。
//   3. 静态接线：main.js 派发 splash-removed 且淡出仍以两栏列完为门槛；
//      App.vue 真的监听、真的调用活动面板的 focusList、真的恢复/保存活动面板；
//      viewState.js 真的把 activePanel 写进盘并做合法性校验。
//   4. 变异臂：每个变异都必须让本套件 FAIL。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import modUtil from "./stripComments.cjs";
import {
  startupFocusDecision,
  isListFocused,
  isListFocusedInPanel,
  normalizeActivePanel,
  STARTUP_FOCUS_TIMEOUT_MS,
  STARTUP_FOCUS_MAX_FRAMES,
  STARTUP_FOCUS_MAX_ATTEMPTS,
} from "../src/startupFocus.js";
import { isTypingTarget } from "../src/keyboardText.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "src", "App.vue");
const MAIN = path.join(ROOT, "src", "main.js");
const VIEW = path.join(ROOT, "src", "viewState.js");
const MODULE = path.join(ROOT, "src", "startupFocus.js");

// 静态断言一律基于去注释后的源码：这个仓库的注释里会提到函数名与常量名，
// 直接搜原文会让「写了一句注释」就满足断言（方法论见 stripComments.cjs）。
const { stripComments } = modUtil;
const app = stripComments(fs.readFileSync(APP, "utf8"));
const main = stripComments(fs.readFileSync(MAIN, "utf8"));
const view = stripComments(fs.readFileSync(VIEW, "utf8"));
const mod = stripComments(fs.readFileSync(MODULE, "utf8"));

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

/// 抽取一个具名函数的完整源码（按大括号配平），这样静态断言检查的是
/// **真正的落地点**，而不是文件里碰巧出现的同名字符串。
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

const tick = extractFn(app, "startupFocusTick");

// ── 1. 纯逻辑真值表 ────────────────────────────────────────────────
section("1. startupFocusDecision 真值表");
const BASE = {
  stateReady: true,
  splashGone: true,
  timedOut: false,
  frames: 0,
  attempts: 0,
  hasSystemFocus: true,
};
const d = (over) => startupFocusDecision({ ...BASE, ...over });

check("保存的活动面板还没应用 → 等（否则会聚焦到默认左栏）",
  d({ stateReady: false }) === "wait");
check("splash 还没移除 → 等", d({ splashGone: false }) === "wait");
check("窗口没有系统焦点 → 等（focus() 会被静默丢弃）",
  d({ hasSystemFocus: false }) === "wait");
check("就绪 → 把焦点交给文件列表", d({}) === "focus");
check("焦点已在文件列表 → 收手（不重复抢）",
  d({ listFocused: true }) === "stop");
check("正在输入（地址栏/过滤框/改名）→ 收手",
  d({ typingTarget: true }) === "stop");
check("焦点在预览区 → 收手", d({ inPreviewSurface: true }) === "stop");
check("超时兜底：splash 事件没来也要给焦点",
  d({ splashGone: false, stateReady: false, timedOut: true }) === "focus");
check("超时也不能抢正在输入的焦点",
  d({ timedOut: true, typingTarget: true }) === "stop");
check("超时也不能抢预览区的焦点",
  d({ timedOut: true, inPreviewSurface: true }) === "stop");
check("超时不覆盖「窗口无系统焦点」",
  d({ timedOut: true, hasSystemFocus: false }) === "wait");
check(`帧数到上限 ${STARTUP_FOCUS_MAX_FRAMES} → 收手`,
  d({ frames: STARTUP_FOCUS_MAX_FRAMES }) === "stop");
check(`尝试次数到上限 ${STARTUP_FOCUS_MAX_ATTEMPTS} → 收手`,
  d({ attempts: STARTUP_FOCUS_MAX_ATTEMPTS }) === "stop");
check("超时常量覆盖 splash 的硬兜底（2500ms 淡出 + 250ms 过渡）",
  STARTUP_FOCUS_TIMEOUT_MS >= 2750);

section("isListFocused / normalizeActivePanel");
check("null 不算文件列表", !isListFocused(null));
check("body 不算文件列表", !isListFocused({ classList: { contains: () => false } }));
check(".file-list 算文件列表", isListFocused({ classList: { contains: (c) => c === "file-list" } }));
check("left/right 原样保留",
  normalizeActivePanel("left") === "left" && normalizeActivePanel("right") === "right");
for (const bad of [null, undefined, "", "LEFT", "middle", 0, 1, {}, ["left"]]) {
  check(`非法活动面板 ${JSON.stringify(bad)} 被丢弃`, normalizeActivePanel(bad) === null);
}
check("isTypingTarget(input) 为真（启动焦点复用同一判据）",
  isTypingTarget({ tagName: "INPUT", isContentEditable: false }) === true);

section("isListFocusedInPanel：只认活动面板自己的列表");
{
  const dom = new JSDOM(
    `<div class="file-panel" data-panel-id="left"><div class="file-list" tabindex="0"></div></div>
     <div class="file-panel" data-panel-id="right"><div class="file-list" tabindex="0"></div></div>`
  );
  const doc = dom.window.document;
  const left = doc.querySelector('[data-panel-id="left"] .file-list');
  const right = doc.querySelector('[data-panel-id="right"] .file-list');
  left.focus();
  check("左栏列表 + 活动面板左 → 已落位", isListFocusedInPanel(doc.activeElement, "left"));
  check("左栏列表 + 活动面板右 → 未落位（启动早期的窗口 focus 竞态）",
    !isListFocusedInPanel(doc.activeElement, "right"));
  right.focus();
  check("右栏列表 + 活动面板右 → 已落位", isListFocusedInPanel(doc.activeElement, "right"));
  check("右栏列表 + 活动面板左 → 未落位", !isListFocusedInPanel(doc.activeElement, "left"));
  check("body 不算任何面板的列表", !isListFocusedInPanel(doc.body, "left"));
}

// ── 2. 时序模拟（jsdom）───────────────────────────────────────────
section("2. 启动时序：焦点真的落到活动面板的 .file-list");
{
  const dom = new JSDOM(
    `<div class="file-panel left" data-panel-id="left"><div class="file-list" tabindex="0"></div></div>
     <div class="file-panel right" data-panel-id="right"><div class="file-list" tabindex="0"></div></div>
     <input class="address" />`,
    { pretendToBeVisual: true }
  );
  const doc = dom.window.document;
  const leftList = doc.querySelector(".left .file-list");
  const rightList = doc.querySelector(".right .file-list");
  const input = doc.querySelector(".address");
  // 上次退出时在右栏 —— App.vue 从 view-state 恢复出来的就是这个值。
  const activePanelId = "right";
  const focusList = () => (activePanelId === "left" ? leftList : rightList).focus();
  let stateReady = false;
  let splashGone = false;
  let hasSystemFocus = false;
  let frames = 0;
  let attempts = 0;
  let focusCalls = 0;

  for (let step = 0; step < STARTUP_FOCUS_MAX_FRAMES + 10; step++) {
    const el = doc.activeElement;
    const action = startupFocusDecision({
      stateReady,
      splashGone,
      timedOut: frames * 16 >= STARTUP_FOCUS_TIMEOUT_MS,
      frames,
      attempts,
      hasSystemFocus,
      typingTarget: isTypingTarget(el),
      inPreviewSurface: !!(el && el.closest && el.closest(".file-preview, iframe, video")),
      listFocused: isListFocusedInPanel(el, activePanelId),
    });
    frames++;
    if (action === "stop") break;
    if (action === "focus") {
      attempts++;
      focusCalls++;
      focusList();
    }
    // 真实启动顺序：配置先到、窗口随后拿到系统焦点、最后 splash 淡出。
    if (frames === 3) stateReady = true;
    if (frames === 6) hasSystemFocus = true;
    if (frames === 10) splashGone = true;
  }
  check("焦点落在右栏（上次活动的 tab）的文件列表", doc.activeElement === rightList);
  check("没有落到默认左栏", doc.activeElement !== leftList);
  check("focusList 只被调用一次", focusCalls === 1, [`实际 ${focusCalls} 次`]);

  // 用户抢先点进地址栏：启动循环不得把焦点抢走。
  input.focus();
  const whileTyping = startupFocusDecision({
    ...BASE,
    typingTarget: isTypingTarget(doc.activeElement),
    listFocused: isListFocusedInPanel(doc.activeElement, activePanelId),
  });
  check("用户已在地址栏输入时不再抢焦点", whileTyping === "stop");
  check("地址栏保持焦点", doc.activeElement === input);

  // 竞态回归：窗口 focus 事件在保存的活动面板恢复之前，把焦点放到了默认左栏。
  // 只判断「有某个 .file-list 聚焦」会在这里误判成功，右栏永远拿不到焦点。
  leftList.focus();
  check("焦点误落在默认左栏时不算已落位",
    startupFocusDecision({
      ...BASE,
      listFocused: isListFocusedInPanel(doc.activeElement, activePanelId),
    }) === "focus");
  rightList.focus();
  check("纠正到活动面板的列表后收手",
    startupFocusDecision({
      ...BASE,
      listFocused: isListFocusedInPanel(doc.activeElement, activePanelId),
    }) === "stop");
}

// ── 3. 静态接线 ────────────────────────────────────────────────────
section("3. main.js：splash 移除是「两栏就绪」的唯一信号");
check("淡出仍以两栏都列完为门槛",
  main.includes("const ready = elapsed >= SPLASH_MIN_SHOW_MS && panelsListed >= PANEL_COUNT;"));
check("淡出结束时派发 minitc:splash-removed",
  main.includes('window.dispatchEvent(new CustomEvent("minitc:splash-removed"))'));
check("transitionend 之外有兜底（合成帧缺失时也能发信号）",
  main.includes("setTimeout(finishSplash,"));
check("信号幂等（重复触发不会重复派发）", main.includes("if (splashDone) return;"));

section("3. App.vue：启动焦点循环接线");
check("startupFocusTick 存在且可抽取", tick.length > 200);
check("循环由 startupFocusDecision 驱动", tick.includes("startupFocusDecision({"));
check("接线：状态就绪 / splash / 超时 / 帧数 / 尝试次数都传给判据",
  tick.includes("stateReady: startupStateReady") &&
  tick.includes("splashGone: startupSplashGone") &&
  tick.includes("timedOut: performance.now() - startupStartedAt >= STARTUP_FOCUS_TIMEOUT_MS") &&
  tick.includes("frames: startupFrames++") &&
  tick.includes("attempts: startupAttempts"));
check("接线：hasSystemFocus 用的是 document.hasFocus()",
  tick.includes("hasSystemFocus: document.hasFocus()"));
check("接线：复用 isTypingTarget 守卫", tick.includes("typingTarget: isTypingTarget(el)"));
check("接线：预览区守卫", tick.includes('el.closest(".file-preview, iframe, video")'));
check("接线：listFocused 用 isListFocusedInPanel 按活动面板判定",
  tick.includes("listFocused: isListFocusedInPanel(el, activePanel.value)"));
check("接线：focus 分支调用活动面板的 focusList",
  tick.includes("panel?.focusList?.()") &&
  tick.includes('activePanel.value === "left" ? leftPanel.value : rightPanel.value'));
check("接线：循环继续 / 收手",
  tick.includes("requestAnimationFrame(startupFocusTick)") &&
  tick.includes("startupStopped = true"));
check("onMounted 监听 splash-removed 并从 DOM 兜底",
  app.includes('window.addEventListener("minitc:splash-removed", onStartupSplashRemoved)') &&
  app.includes('startupSplashGone = !document.getElementById("splash")'));
check("onMounted 启动 rAF 循环", app.includes("requestAnimationFrame(startupFocusTick)"));
check("onUnmounted 清理监听并中止循环",
  app.includes('window.removeEventListener("minitc:splash-removed", onStartupSplashRemoved)') &&
  app.includes("startupStopped = true"));

section("3. 活动面板持久化（上次选中的 tab 属于哪一栏）");
check("App.vue 从 view-state 恢复活动面板",
  app.includes("if (savedActivePanel.value) activePanel.value = savedActivePanel.value;"));
check("恢复完成后才允许启动焦点落位",
  app.includes("startupStateReady = true;"));
check("App.vue watch(activePanel) 写回",
  app.includes("watch(activePanel, (id) => setSavedActivePanel(id));"));
check("viewState.js 声明 savedActivePanel",
  view.includes("export const savedActivePanel = ref(null);"));
check("viewState.js 用 normalizeActivePanel 校验读入值",
  view.includes("const activePanel = normalizeActivePanel(raw.activePanel);"));
check("viewState.js 应用读入值",
  view.includes("if (s.activePanel) savedActivePanel.value = s.activePanel;"));
check("viewState.js 把活动面板写进配置文件",
  view.includes("activePanel: savedActivePanel.value,"));
check("viewState.js 保存时同样校验",
  view.includes("const id = normalizeActivePanel(panelId);"));
check("startupFocus.js 不依赖 DOM（可在 plain node 加载）",
  !mod.includes("document.") && !mod.includes("window."));

console.log(`\n通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log("失败项：" + failures.join("、"));
  process.exit(1);
}
