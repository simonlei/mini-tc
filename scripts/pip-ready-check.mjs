// 画中画「视频未就绪时点击」的判据与组件调用点静态断言。
// 直接 `node scripts/pip-ready-check.mjs` 跑。
//
// 背景：requestPictureInPicture() 在 readyState=HAVE_NOTHING / 无视频轨时抛
// InvalidStateError，且要求 transient user activation（约 5 秒窗口）。所以等待
// 必须发生在同一次点击的 await 链里，并在 await 回来后核对目的地。
// 另有一组反向断言钉住「实测无效的 document.title / mediaSession 代码已清理」。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  videoReadyForPip, pipIntentLands, waitForVideoReady,
} from "../src/pipReady.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}
function count(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}
// 从函数签名切到下一个顶层函数；切片前必须证明非空（见 METHODOLOGY）。
function fnBody(src, name) {
  const s = src.indexOf(`function ${name}(`);
  if (s < 0) return "";
  const re = /^(?:async )?function /gm;
  re.lastIndex = s + 1;
  const m = re.exec(src);
  return src.slice(s, m ? m.index : src.length);
}

// ── 纯判据 ──
check("HAVE_NOTHING 不允许请求 PiP", videoReadyForPip(0, 0) === false);
check("有 metadata 但无画面不允许", videoReadyForPip(1, 0) === false);
check("有 metadata 且有画面才允许", videoReadyForPip(1, 1920) === true);
check("HAVE_CURRENT_DATA 允许", videoReadyForPip(2, 1920) === true);
check("换片后等待意图作废", pipIntentLands("C:\\v\\a.mp4", "C:\\v\\b.mp4") === false);
check("同一文件的等待意图可落地", pipIntentLands("C:\\v\\a.mp4", "C:\\v\\a.mp4") === true);
check("未有意图时不落地", pipIntentLands(null, "C:\\v\\a.mp4") === false);
check("空意图与空路径也不落地", pipIntentLands(undefined, undefined) === false);

// ── 等待链行为 ──
class FakeVideo {
  constructor() { this.readyState = 0; this.videoWidth = 0; this.listeners = {}; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn);
  }
  fire(t) { (this.listeners[t] || []).slice().forEach((f) => f()); }
  ready() { this.readyState = 2; this.videoWidth = 1920; this.fire("canplay"); }
}
const opts = { timeoutMs: 500, pollMs: 10 };
const immediate = await waitForVideoReady(
  { readyState: 2, videoWidth: 1920 }, { cancelled: false }, opts);
check("已就绪时立即返回 ready", immediate.ok === true && immediate.reason === "ready");
const fv1 = new FakeVideo();
const p1 = waitForVideoReady(fv1, { cancelled: false }, opts);
fv1.ready();
const r1 = await p1;
check("等 canplay 后兑现", r1.ok === true && r1.reason === "ready");
check("兑现后监听器全部摘除",
  (fv1.listeners.canplay || []).length === 0 && (fv1.listeners.loadedmetadata || []).length === 0);
const fv2 = new FakeVideo();
const ctx2 = { cancelled: false };
const p2 = waitForVideoReady(fv2, ctx2, opts);
ctx2.cancelled = true;
fv2.fire("loadedmetadata");
const r2 = await p2;
check("用户取消等待立即结束", r2.ok === false && r2.reason === "cancelled");
const fv3 = new FakeVideo();
const r3 = await waitForVideoReady(fv3, { cancelled: false }, { timeoutMs: 30, pollMs: 10 });
check("超时返回 timeout 而非挂死", r3.ok === false && r3.reason === "timeout");
check("超时后监听器全部摘除", (fv3.listeners.canplay || []).length === 0);
// 对照臂：把「就绪判据」换成恒真，同批输入上就会放行未加载完的视频。
const naiveReady = () => true;
check("对照臂：恒真判据会放行 HAVE_NOTHING",
  naiveReady(0, 0) === true && videoReadyForPip(0, 0) === false);

// ── 静态断言：组件真的把等待接进了点击链 ──
const vuePath = path.join(ROOT, "src/components/VideoPreview.vue");
const vue = stripComments(fs.readFileSync(vuePath, "utf8"));
check("组件引入了 pipReady 模块", vue.includes('from "../pipReady.js"'));

const enterBody = fnBody(vue, "onEnterPip");
const leaveBody = fnBody(vue, "onLeavePip");
const requestBody = fnBody(vue, "requestPip");
const toggleBody = fnBody(vue, "togglePip");
const closeBody = fnBody(vue, "closePip");
check("五个 PiP 函数切片都非空",
  enterBody.length > 0 && leaveBody.length > 0 && requestBody.length > 0 &&
  toggleBody.length > 0 && closeBody.length > 0);
check("两条入口都维护 inPip 状态",
  enterBody.includes("inPip.value = true") && leaveBody.includes("inPip.value = false"));
check("requestPip 真的发起请求", requestBody.includes("await v.requestPictureInPicture()"));

const waitCall = "await waitForVideoReady(v, ctx)";
const landCall = "pipIntentLands(ctx.path, props.filePath)";
check("未就绪时先判就绪再等待",
  toggleBody.includes("!videoReadyForPip(v.readyState, v.videoWidth)") && toggleBody.includes(waitCall));
check("等待回来后必须查目的地判据", toggleBody.includes(landCall));
check("目的地判据确实在 await 之后", toggleBody.indexOf(landCall) > toggleBody.indexOf(waitCall));
check("等待成功后才发请求", toggleBody.includes("await requestPip(v)"));
check("等待中再点一次可取消", count(toggleBody, "cancelPipWait()") === 2);
const errorBody = fnBody(vue, "onError");
const loadStart = vue.indexOf("async function loadVideo()");
const loadEnd = vue.indexOf("const mountedPath", loadStart);
const loadBody = loadStart > 0 && loadEnd > loadStart ? vue.slice(loadStart, loadEnd) : "";
check("加载失败 / 换片 / 关闭都取消等待",
  errorBody.length > 0 && errorBody.includes("cancelPipWait()") &&
  loadBody.length > 0 && loadBody.includes("cancelPipWait()") &&
  closeBody.includes("cancelPipWait()"));
check("超时给用户可行动的提示", toggleBody.includes('wait.reason === "timeout"'));
check("模板反映等待状态", vue.includes('pipWaiting ? "等待加载…" : "画中画"'));
check("等待状态也进 tooltip", vue.includes("if (pipWaiting.value) return"));

// ── 反向断言：实测证伪的标题方案已清理，别让死代码回来 ──
check("已无 document.title / mediaSession 死代码",
  !vue.includes("syncPipTitleState") && !vue.includes("MediaMetadata") &&
  !vue.includes("document.title") && !vue.includes("pipTitle.js"));
const unmountAt = vue.indexOf("onBeforeUnmount(() => {");
const scriptEnd = vue.indexOf("</script>", unmountAt);
const unmountBody = unmountAt > 0 && scriptEnd > unmountAt ? vue.slice(unmountAt, scriptEnd) : "";
check("卸载时收回小窗", unmountBody.length > 0 && unmountBody.includes("closePip()"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
