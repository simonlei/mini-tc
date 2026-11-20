<template>
  <div class="file-preview">
    <!-- Header -->
    <div class="preview-header">
      <span class="preview-icon">{{ headerIcon }}</span>
      <span class="preview-title" :title="fileName">{{ fileName }}</span>
      <span class="preview-type-badge">{{ typeLabel }}</span>
      <!-- 旋转只影响显示，不写文件。放在头部而不是缩放条里：缩放条已经
           有 5 个按钮，再塞两个会把它撑到面板宽度的一半。 -->
      <span class="rot-group" v-if="previewType === 'image' && naturalSize.w > 0">
        <button class="rot-btn" title="向左旋转 90° (Ctrl+←)" @click="rotateLeft">左转</button>
        <button class="rot-btn" title="向右旋转 90° (Ctrl+→)" @click="rotateRight">右转</button>
        <span class="rot-angle" v-if="rotation !== 0" :title="`已旋转 ${angleLabel(rotation)}（只影响显示，不改文件）`">{{ angleLabel(rotation) }}</span>
      </span>
      <button class="close-btn" @click="$emit('close')" title="关闭预览 (Ctrl+Q)">✕</button>
    </div>

    <!-- Loading -->
    <div class="preview-body" v-if="loading">
      <div class="preview-placeholder">
        <div class="spinner"></div>
        <span>正在加载...</span>
      </div>
    </div>

    <!-- Error -->
    <div class="preview-body" v-else-if="error">
      <div class="preview-placeholder error">
        <span class="placeholder-icon">⚠️</span>
        <span>{{ error }}</span>
      </div>
    </div>

    <!-- Image preview -->
    <div class="preview-body image-body" v-else-if="previewType === 'image'">
      <div class="heic-note" v-if="heicNote">{{ heicNote }}</div>
      <!-- The scroller is a separate element so the zoom toolbar (and the
           HEIC transport controls) stay put while the picture scrolls under
           them. The picture's own size is set by `frameStyle` (the frame is
           the picture's **rotated** footprint): in 适应窗口 mode the CSS
           (max-width/height:100%) keeps it inside the panel, once zoomed it
           gets an explicit px size — otherwise max-height:100% would squeeze
           a 572×7191 long image back down to a few pixels wide. -->
      <div
        class="image-scroll"
        :class="{ draggable: canDragImage, dragging }"
        ref="imageScrollRef"
        @wheel="onImageWheel"
        @pointerdown="onImagePointerDown"
      >
        <!-- The frame is the picture's footprint **after** rotation (90° /
             270° swap width and height). The picture inside keeps its own
             unrotated proportions and is turned with a transform, so the
             rotated image lands exactly on the frame — the frame is what
             the scroll container measures, so 适应窗口 / centering /
             scroll extents all describe what the user actually sees. -->
        <div class="image-frame" :style="frameStyle">
          <!-- Animated HEIC plays on a canvas. Swapping an <img> src per frame
               flashes (and leaks an objectURL per frame); a canvas just gets a
               drawImage per frame, which is also cheaper than a JPEG round-trip
               through an <img>. -->
          <canvas
            v-if="frameState.count > 1"
            ref="frameCanvasRef"
            class="preview-image"
            :style="pictureStyle"
            :width="frameState.width"
            :height="frameState.height"
          ></canvas>
          <img
            v-else
            ref="imageRef"
            :src="previewContent"
            class="preview-image"
            :style="pictureStyle"
            @load="onImageLoad"
            @error="onImageError"
          />
        </div>
      </div>
      <div class="zoom-bar" v-if="naturalSize.w > 0">
        <button class="zoom-btn" :disabled="!canZoomOut" title="缩小 (Ctrl+-)" @click="zoomOut">−</button>
        <span class="zoom-level" :title="zoomLevelTitle">{{ zoomLevelText }}</span>
        <button class="zoom-btn" :disabled="!canZoomIn" title="放大 (Ctrl+=)" @click="zoomIn">＋</button>
        <button class="zoom-btn wide" :class="{ active: isFit }" title="适应窗口，整图可见 (Ctrl+0)" @click="zoomFit">适应</button>
        <button class="zoom-btn wide" :class="{ active: isActual }" title="原始大小 1:1 (Ctrl+1)" @click="zoomActual">1:1</button>
      </div>
      <button
        v-if="frameState.count > 1"
        class="anim-toggle"
        :title="frameState.playing ? '暂停 (空格)' : '播放 (空格)'"
        @click="togglePlayback"
      >{{ frameState.playing ? "⏸" : "▶" }}</button>
      <span v-if="frameState.count > 1" class="anim-counter">{{ frameState.index + 1 }}/{{ frameState.count }}</span>
    </div>

    <!-- PDF preview -->
    <div class="preview-body pdf-body" v-else-if="previewType === 'pdf'">
      <iframe
        v-if="pdfSupported && !pdfLoadError"
        ref="pdfFrameRef"
        :key="props.filePath"
        :src="previewContent"
        class="preview-pdf-frame"
        title="PDF 预览"
        @error="onPdfError"
      ></iframe>
      <div class="preview-placeholder error" v-else-if="pdfLoadError">
        <span class="placeholder-icon">⚠️</span>
        <span>无法加载 PDF，文件可能已损坏或不存在</span>
      </div>
      <div class="preview-placeholder" v-else>
        <span class="placeholder-icon">📕</span>
        <span>当前平台不支持内联预览 PDF，请使用系统程序打开查看</span>
      </div>
    </div>

    <!-- Text / JSON preview -->
    <div class="preview-body text-body" v-else-if="previewType === 'text' || previewType === 'json' || previewType === 'log'">
      <div class="json-warn" v-if="jsonWarn">{{ jsonWarn }}</div>
      <!-- tabindex: these are non-editable, so without a focus stop the keyboard
           user can never reach them and Ctrl+A / screen readers skip the content.
           Focus alone grants no editing rights -- App.vue's guards key off the
           element type and the selection, not off focus. -->
      <pre class="preview-text" tabindex="0"><code>{{ previewContent }}</code></pre>
    </div>

    <!-- Word (.docx) preview: rendered HTML from mammoth (v-html, sanitized) -->
    <div class="preview-body doc-body" v-else-if="previewType === 'docx'">
      <div class="preview-doc" tabindex="0" v-html="previewContent"></div>
    </div>

    <!-- Legacy .doc: friendly notice to re-save as .docx -->
    <div class="preview-body" v-else-if="previewType === 'doc'">
      <div class="preview-placeholder">
        <span class="placeholder-icon">📘</span>
        <span>{{ docMessage }}</span>
      </div>
    </div>

    <!-- Footer -->
    <div class="preview-footer" v-if="!loading && !error">
      <span>{{ fileSize }}</span>
      <span v-if="(previewType === 'text' || previewType === 'log') && lineCount !== null">{{ lineCount }} lines</span>
      <span v-if="previewType === 'docx' && charCount !== null">{{ charCount }} 字</span>
      <span v-if="previewType === 'image'">{{ imageInfo }}</span>
      <button
        class="copy-all-btn"
        v-if="previewType === 'text' || previewType === 'json' || previewType === 'log'"
        @click="copyAll"
      >{{ copyAllDone ? '已复制 ✓' : '复制全部' }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFilePreview } from "../api.js";
import { previewLands } from "../previewGate.js";
import { decodeHeic, decodeHeicFrame, pixelsToBlob } from "../heicDecoder.js";
import { formatBytes as formatSize } from "../format.js";
import { sanitizeDocxHtml } from "../docxSanitize.js";
import { previewKindOf } from "../previewConfig.js";
import { HEIC_IMAGE_EXTENSIONS, MAMMOTH_DOC_EXTENSIONS } from "../previewExtensions.js";
import { matches, markHandled } from "../shortcuts.js";
import { isImeKeydown, isTypingTarget } from "../keyboardText.js";
import {
  fitScale as computeFitScale,
  zoomStep,
  wheelScale,
  zoomPercent,
  anchorScroll,
  MAX_SCALE,
} from "../imageZoom.js";
import { rotateStep, rotatedSize, angleLabel } from "../imageRotate.js";
import {
  dragStarted,
  dragScroll,
  canDrag,
  IMAGE_DRAG_START_THRESHOLD,
} from "../imageDrag.js";

// mammoth converts .docx (OOXML) into HTML. We load the self-contained browser
// bundle (NOT the Node entry, which requires `fs`/`path` and would break the
// Vite web build). The browser build is pure-JS (uses a browser jszip) and
// works inside the Tauri webview.
//
// It is ~700 KB, so it is imported on demand: a static import here pulled it
// into the main bundle and every launch paid the parse+eval cost even when no
// .docx was ever opened. Boot instrumentation measured the whole JS startup at
// ~505 ms; deferring mammoth takes a visible slice off `main.js:eval`.
let mammothPromise = null;
function loadMammoth() {
  if (!mammothPromise) {
    mammothPromise = import("mammoth/mammoth.browser.js").then((m) => m.default ?? m);
  }
  return mammothPromise;
}

// HEIC/HEIF decoding lives in ../heicDecoder.js. It must stay off the static
// import graph for the same reason as mammoth, plus one more: the wasm build is
// a 2 MB chunk, and the decoder lives inside a Worker (see heicDecoder.js for
// why swapping the engine was necessary and what the numbers were).

const props = defineProps({
  filePath: { type: String, required: true },
  fileName: { type: String, required: true },
  fileBytes: { type: Number, default: 0 },
  // When true, force a plain-text read regardless of the mapping. Used by the
  // "按文本预览" button on a just-registered suffix (one-shot override).
  asText: { type: Boolean, default: false },
});

defineEmits(["close"]);

// The suffix lists themselves live in previewExtensions.js / previewConfig.js —
// no local copy here. HEIC_IMAGE_EXTENSIONS and MAMMOTH_DOC_EXTENSIONS only
// pick a RENDERING STRATEGY within the image / doc type; they are not a second
// set of previewable extensions.

const loading = ref(false);
const error = ref("");
const previewType = ref("");
const previewContent = ref("");
const fileSize = ref("");
const lineCount = ref(null);
const imageInfo = ref("");
// One-line notice under the image when the bytes on disk aren't what the
// <img> actually shows (HEIC → JPEG transcode). Empty for native formats.
const heicNote = ref("");
const jsonWarn = ref("");
const copyAllDone = ref(false);

// Word-document preview state.
const docMessage = ref(""); // friendly notice for unsupported legacy .doc
const charCount = ref(null); // character count of the converted docx text

// PDF 加载失败标记（仅影响 PDF 渲染区，不冲击 header/footer 正常展示）
const pdfLoadError = ref(false);
// PDF iframe DOM 引用（供 App.vue 的 Ctrl+C 判定按 class 识别，也便于未来扩展）
const pdfFrameRef = ref(null);

// HEIC 解码后的 objectURL。必须在换文件/卸载时 revoke —— HEIC 原图常有几MB，
// 一次解码出的 PNG blob 若泄漏，反复浏览目录会迅速吃掉可观的内存。
let heicObjectUrl = "";
function releaseHeicUrl() {
  if (heicObjectUrl) {
    URL.revokeObjectURL(heicObjectUrl);
    heicObjectUrl = "";
  }
}
// Must be paired with releaseHeicUrl on unmount: a live timer outliving the
// component would call decodeHeicFrame() into a worker that outlives it too.
onBeforeUnmount(() => {
  releaseHeicUrl();
  stopAnimation();
  // The zoom observer watches a DOM node; leaving it attached after unmount
  // keeps the whole component closure alive (same leak class as the timer).
  if (viewObserver) {
    viewObserver.disconnect();
    viewObserver = null;
  }
  // Symmetric with the addEventListener below — a leaked listener would keep
  // this whole component scope (and its preview state) alive forever.
  window.removeEventListener("keydown", onPreviewKey, true);
  // Same for the drag listeners: a drag in flight at unmount would keep
  // listeners on window pointing at a dead component.
  endImageDrag();
});

// The image-zoom shortcuts are claimed on the capture phase, so they win over
// App.vue's global handler (which runs on the bubble phase at the document).
// Same pattern as the video preview's own key handling.
onMounted(() => {
  window.addEventListener("keydown", onPreviewKey, true);
});

// Concurrency guard for the async preview loaders. Every entry point snapshots
// the path it was asked about and re-checks `lands()` after each await: a HEIC
// decode + re-encode takes hundreds of ms, so arrow-key scrubbing through a
// folder guarantees the earlier file's result lands LAST and would otherwise
// overwrite the file the user is actually looking at (title says B, body is A).
// See src/previewGate.js for why the test is "is this still the wanted file"
// rather than a request counter.
function beginLoad() {
  const path = props.filePath;
  return {
    path,
    lands: () => previewLands(path, props.filePath),
  };
}

// ── 动画 HEIC 播放 ──
// A multi-frame HEIC (burst, sequence, Live Photo style) plays on a canvas.
// State is a plain ref so the template can bind it, but the *playhead* lives in
// non-reactive variables: nothing in the template depends on them, and making
// them reactive would re-render on every frame for no benefit.
const frameCanvasRef = ref(null);
const frameState = ref({ count: 0, index: 0, playing: false, width: 0, height: 0 });

let animTimer = 0;      // setTimeout handle for the next frame
let animToken = 0;      // bumped on every stop/file change; stale loops bail
let frameDurations = []; // ms per frame, 0 = use the default
let animDefaultMs = 100;

// Stop playback and drop per-frame data. MUST be called on every file change:
// a runaway timer that keeps calling decodeHeicFrame() would decode frames of
// a file the user has already navigated away from.
function stopAnimation() {
  if (animTimer) {
    clearTimeout(animTimer);
    animTimer = 0;
  }
  animToken++;
  frameDurations = [];
  animDefaultMs = 100;
  frameState.value = { count: 0, index: 0, playing: false, width: 0, height: 0 };
}

// Draw decoded RGBA into the visible canvas.
function paintFrame(pixels, width, height) {
  const canvas = frameCanvasRef.value;
  if (!canvas) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // putImageData ignores the canvas transform and composite ops but requires
  // the exact byte layout, so it is the right call for raw decoder output.
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height),
    0,
    0
  );
}

// Advance one frame. `token` pins this loop to the animation that started it,
// so a stop/restart mid-flight can never leave two loops fighting over the
// canvas.
function scheduleFrame(token) {
  if (token !== animToken || !frameState.value.playing) return;
  const { count, index } = frameState.value;
  const next = (index + 1) % count;
  const wait = frameDurations[next] || animDefaultMs || 100;

  animTimer = setTimeout(async () => {
    if (token !== animToken) return;
    try {
      const f = await decodeHeicFrame(next);
      if (token !== animToken) return;
      paintFrame(f.pixels, f.width, f.height);
      // Reassign rather than mutate: `frameState.value` is what the template
      // and toggle button read, and a same-object assignment would not
      // trigger the counter update.
      frameState.value = { ...frameState.value, index: next };
      if (f.durationMs) frameDurations[next] = f.durationMs;
    } catch {
      // A frame that will not decode ends the loop rather than spinning on
      // the error. Keep what is already on screen.
      frameState.value = { ...frameState.value, playing: false };
      return;
    }
    scheduleFrame(token);
  }, wait);
}

function startAnimation(token) {
  if (token !== animToken || !frameState.value.playing) return;
  scheduleFrame(token);
}

function togglePlayback() {
  if (!frameState.value.count) return;
  const token = ++animToken;
  if (frameState.value.playing) {
    frameState.value = { ...frameState.value, playing: false };
    return;
  }
  frameState.value = { ...frameState.value, playing: true };
  startAnimation(token);
}

// 平台检测：判断当前 WebView 是否支持内联 PDF 渲染。
// 项目未安装 @tauri-apps/plugin-os（后端无 tauri-plugin-os），按约束不新增依赖，
// 采用 UA 启发式：Windows WebView2（含 Edg/）内置 PDF 查看器，支持 iframe 内联；
// macOS WKWebView（AppleWebKit 但无 Chrome/Edg）不支持内联 PDF，走降级提示。
const pdfSupported = computed(() => {
  const ua = navigator.userAgent || '';
  const isWebKitOnly = /AppleWebKit/.test(ua) && !/Chrome|Edg/.test(ua);
  return !isWebKitOnly;
});

const headerIcon = computed(() => {
  if (previewType.value === "image") return "🖼️";
  if (previewType.value === "pdf") return "📕";
  if (previewType.value === "docx" || previewType.value === "doc") return "📘";
  if (previewType.value === "json") return "🔧";
  if (previewType.value === "log") return "📜";
  if (previewType.value === "text") return "📄";
  return "👁️";
});

const typeLabel = computed(() => {
  if (previewType.value === "image") return "IMAGE";
  if (previewType.value === "pdf") return "PDF";
  if (previewType.value === "docx") return "DOCX";
  if (previewType.value === "doc") return "DOC";
  if (previewType.value === "json") return "JSON";
  if (previewType.value === "log") return "LOG";
  if (previewType.value === "text") return "TEXT";
  return "PREVIEW";
});

function getExtension(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

// ───────────────────────── 图片缩放 ─────────────────────────
// 长图（微信截图动辄 572×7191）在「适应窗口」下只有几个像素宽，根本看不清。
// 这里给它一套完整的缩放：适应窗口 → 25% → 50% → 75% → 1:1 原始大小，
// 放大后容器可上下左右滚动，Ctrl+滚轮以光标为锚点连续缩放。
//
// 缩放比例一律相对**原始像素**：1 = 100% = 原始大小（上限，见 imageZoom.js
// 的 MAX_SCALE）。超过 100% 只是插值放大，看不到新信息，只有糊 —— 所以封顶。

// ⚠️ 这个变量名**必须**和模板里的 `ref="imageScrollRef"` 完全一致。
// Vue 3 的 <script setup> 是按变量名绑定模板 ref 的：名字对不上时
// ref 会一直是 null，而且**不报任何错** —— 后果是 measureView() 量不到
// 容器、fitScale 退化成 1、居中与缩放全部静默失效。
// scripts/template-ref-check.mjs 会守住这条。
const imageScrollRef = ref(null);
const imageRef = ref(null);
// <img> 的原始像素尺寸（onImageLoad 拿到 naturalWidth/Height）。
const imgNatural = ref({ w: 0, h: 0 });
// 缩放档：'fit' 跟随窗口，'manual' 由用户定（绝对比例，不随窗口变化）。
const zoomMode = ref("fit");
const zoomScale = ref(1);
// 旋转档：0 / 90 / 180 / 270。**只影响显示**，不写文件、不落盘。
// 正角度 = 顺时针（与 CSS 的 rotate() 一致），所以右转 +90°、左转 −90°。
const rotation = ref(0);
// 滚动容器的可用尺寸（去掉内边距），用于算「适应窗口」与居中偏移。
const viewSize = ref({ w: 0, h: 0 });

// 多帧 HEIC 走 <canvas>，它的原始尺寸就是帧尺寸。
const naturalSize = computed(() =>
  frameState.value.count > 1
    ? { w: frameState.value.width, h: frameState.value.height }
    : imgNatural.value
);

// 旋转后的**占位**自然尺寸：90°/270° 时宽高互换，0°/180° 时不变。
const rotatedNatural = computed(() =>
  rotatedSize(naturalSize.value.w, naturalSize.value.h, rotation.value)
);

// 「适应窗口」的比例。
//
// ⚠️ 按**旋转后**的占位算，不是原始尺寸：一张 572×7191 的竖图转 90° 之后
// 占位变成 7191×572，若还按竖图算，「适应窗口」出来的图会横着溢出面板。
const fitScale = computed(() =>
  computeFitScale(rotatedNatural.value.w, rotatedNatural.value.h, viewSize.value.w, viewSize.value.h)
);

// 当前生效的比例。
//
// ⚠️ 这里**不再**按 fitScale 动态夹一次：手动档是绝对比例（相对原始像素），
// 窗口一变，fitScale 会跟着动，若在这里夹，缩放档位就会在用户没操作时
// 自己跳一下。夹制只发生在「用户按下放大/缩小」的那一刻（见 zoomIn/zoomOut）。
const activeScale = computed(() =>
  zoomMode.value === "fit" ? fitScale.value : zoomScale.value
);

// 图片几何：给定一个缩放比例，算出画框与画面本体的尺寸、居中偏移。
//
// ⚠️ 这是**唯一**一处几何计算 —— frameStyle（画框样式）、pictureStyle
// （画面本体样式）、contentSize（拖动时判断「能不能拖」的内容总尺寸）
// 和 applyZoom 的缩放锚点都从它派生。同一语义两份实现必然分叉：
// 曾经 contentSize 把这段抄了一遍，结果 image-zoom 的变异臂
// 「居中偏移算错」那个变异命中 2 处、注入不进去。
//
// ⚠️ 居中**不用** flex 的 margin:auto —— 那套在内容溢出容器时会让溢出的
// 那一侧滚不到（长图的顶部/左侧够不着，这是 flex 居中的经典坑）。
// 这里自己算：显示尺寸比可视区小就居中，大了就贴边（0 偏移），两头都够得着。
//
// ⚠️ 三个尺寸各司其职，别混：
//   · pw/ph —— 画面本体（未旋转）的显示尺寸，写在图片元素上；
//   · w/h   —— 旋转后的**占位**（用户看到的那个框），写在画框上；
//   · mx/my —— 占位在可视区里的居中偏移。
// 90°/270° 时 w/h 与 pw/ph 互换 —— 居中偏移要按占位算，否则转完的图会偏出面板。
function geometryFor(scale) {
  const nat = naturalSize.value;
  const avail = viewSize.value;
  if (!nat.w || !nat.h || !avail.w || !avail.h) {
    return { w: 0, h: 0, mx: 0, my: 0, pw: 0, ph: 0 };
  }
  // 画面本体（未旋转）的显示尺寸。
  const pw = Math.max(1, Math.floor(nat.w * scale));
  const ph = Math.max(1, Math.floor(nat.h * scale));
  // 旋转后的占位：90°/270° 时宽高互换，0°/180° 时不变。
  const foot = rotatedSize(pw, ph, rotation.value);
  const w = foot.w;
  const h = foot.h;
  const mx = Math.max(0, Math.floor((avail.w - w) / 2));
  const my = Math.max(0, Math.floor((avail.h - h) / 2));
  return { w, h, mx, my, pw, ph };
}

const imageGeometry = computed(() => geometryFor(activeScale.value));

// 画框的样式：尺寸 = 旋转后的画面占位，外加居中偏移。
//
// 画框是滚动容器里**唯一**参与布局的元素 —— 滚动范围、可视区大小、
// 「适应窗口」的兜底约束全都按它算，所以它必须等于用户看到的那块画面。
const frameStyle = computed(() => {
  const g = imageGeometry.value;
  if (!g.w || !g.h) return {};
  const fit = zoomMode.value === "fit";
  return {
    width: `${g.w}px`,
    height: `${g.h}px`,
    // 适应窗口档：保留 max-* 兜底 —— 万一测量晚了一帧，也不会溢出长出
    // 一条多余的滚动条（object-fit:contain 保证同时不会变形）。
    // 放大档：必须解除约束，否则 max-height:100% 会把 7191px 高的长图重新
    // 压回容器高度，缩放等于没做。
    maxWidth: fit ? "100%" : "none",
    maxHeight: fit ? "100%" : "none",
    marginLeft: `${g.mx}px`,
    marginRight: `${g.mx}px`,
    marginTop: `${g.my}px`,
    marginBottom: `${g.my}px`,
  };
});

// 画面本体的样式：按**未旋转**的原始比例算尺寸，再整体转起来。
//
// transform 的旋转中心是元素自身中心，而画框用 flex 居中把它摆在正中
// —— 转完之后画面正好铺满画框，且仍然居中。
const pictureStyle = computed(() => {
  const g = imageGeometry.value;
  if (!g.pw || !g.ph) return {};
  return {
    width: `${g.pw}px`,
    height: `${g.ph}px`,
    transform: `translate(-50%, -50%) rotate(${rotation.value}deg)`,
  };
});

const isFit = computed(() => zoomMode.value === "fit");
const isActual = computed(() => activeScale.value >= MAX_SCALE - 1e-9);
const canZoomIn = computed(() => activeScale.value < MAX_SCALE - 1e-9);
// 「适应窗口」已经是最小可用比例（再小就没有意义了），所以那一档不能缩。
const canZoomOut = computed(
  () => !isFit.value && activeScale.value > fitScale.value + 1e-9
);
const zoomLevelText = computed(() => zoomPercent(activeScale.value));
const zoomLevelTitle = computed(() =>
  isFit.value
    ? `适应窗口（原始大小的 ${zoomPercent(fitScale.value)}）`
    : `原始大小的 ${zoomPercent(activeScale.value)}`
);

// ── 旋转 ──
//
// 只是**显示上**的旋转：不写文件、不改 EXIF、不落盘 —— 关掉预览就复原。
// 角度取值 0 / 90 / 180 / 270，正角度 = 顺时针（与 CSS 的 rotate() 一致）。
//
// ⚠️ 旋转改变的是「画面占位」：90°/270° 时宽高互换。所以「适应窗口」
// 按旋转后的占位算（rotatedNatural），居中偏移也按占位算（imageGeometry）。
// 缩放比例本身不变 —— 比例是相对原始像素的，转一下不该改变清晰度。
function rotateBy(dir) {
  if (!naturalSize.value.w) return;
  rotation.value = rotateStep(rotation.value, dir);
  // 画面占位变了，旧的滚动位置不再对应同一块内容 → 从头看起。
  endImageDrag();
  const el = imageScrollRef.value;
  if (el) {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }
}

function rotateLeft() {
  rotateBy(-1);
}

function rotateRight() {
  rotateBy(1);
}

// ── 拖动平移 ──
//
// 放大之后按住图片拖一下就能平移（Windows 照片查看器 / Photoshop 的手势）。
// 滚轮也能滚，但长图上「抓图拖动」顺手得多，触控板上更是同一套肌肉记忆。
//
// 状态放在**普通变量**里，不进响应式系统：被拖动的 DOM 元素一旦被
// reactive() 包成 Proxy，再调 getBoundingClientRect() 在部分引擎里会抛
// Illegal invocation（this 变成 Proxy 而不是元素）—— 与 TabBar 同一个坑。
let drag = null;

// 内容是否溢出了可视区（决定了能不能拖、以及光标要不要变 grab）。
// 内容总尺寸 = 图片显示尺寸 + 它的外边距（居中偏移也是内容的一部分）。
//
// ⚠️ 从 imageGeometry 派生，不自己再算一遍 —— 同一语义两份实现必然分叉。
const contentSize = computed(() => {
  const g = imageGeometry.value;
  if (!g.w || !g.h) return { w: 0, h: 0 };
  return { w: g.w + g.mx * 2, h: g.h + g.my * 2 };
});

// 能不能拖：内容比可视区大才拖得动。适应窗口时图片整张都在视野里，
// 拖了也没地方去 —— 这时不该抢走「点一下」的行为。
const canDragImage = computed(() =>
  canDrag({
    contentW: contentSize.value.w,
    contentH: contentSize.value.h,
    viewW: viewSize.value.w,
    viewH: viewSize.value.h,
  })
);

// 拖动中（模板要据此换光标，所以是 ref）。
const dragging = ref(false);

function onImagePointerDown(e) {
  // 只有主键：中键是粘贴到目录，右键是菜单。
  if (e.button !== 0) return;
  // 拖不动的时候不接管 —— 让「点一下图片」这类行为照常。
  if (!canDragImage.value) return;
  // 一次只拖一个。
  if (drag) return;
  const el = imageScrollRef.value;
  if (!el) return;
  drag = {
    el,
    pointerId: e.pointerId == null ? 1 : e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    startLeft: el.scrollLeft,
    startTop: el.scrollTop,
    active: false,
  };
  // 抓住指针：拖出面板再松手也能收到 pointerup。
  try {
    if (typeof el.setPointerCapture === "function") {
      el.setPointerCapture(drag.pointerId);
    }
  } catch {
    /* 抓不住也能拖：window 上的监听器照样收得到事件 */
  }
  window.addEventListener("pointermove", onImagePointerMove);
  window.addEventListener("pointerup", onImagePointerUp);
  window.addEventListener("pointercancel", onImagePointerUp);
}

function onImagePointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.active) {
    // 移动超过阈值才算「在拖」：否则一次普通的点击会被吃掉。
    if (!dragStarted(dx, dy, IMAGE_DRAG_START_THRESHOLD)) return;
    drag.active = true;
    dragging.value = true;
  }
  // 拖动中要吃掉默认行为，否则浏览器会同时做「选中图片」并冒出一圈选中框。
  if (typeof e.preventDefault === "function") e.preventDefault();
  const next = dragScroll({
    startX: drag.startX,
    startY: drag.startY,
    curX: e.clientX,
    curY: e.clientY,
    startLeft: drag.startLeft,
    startTop: drag.startTop,
  });
  // ⚠️ 滚动量交给浏览器去夹（它天然被夹在 [0, maxScroll] 内），
  // 自己再夹一遍就要维护第二份「最大值怎么算」的判断。
  drag.el.scrollLeft = next.left;
  drag.el.scrollTop = next.top;
}

function onImagePointerUp() {
  if (!drag) return;
  endImageDrag();
}

function endImageDrag() {
  const d = drag;
  drag = null;
  if (d && d.el && typeof d.el.releasePointerCapture === "function") {
    try {
      d.el.releasePointerCapture(d.pointerId);
    } catch {
      /* 释放失败无所谓：状态已经清干净了 */
    }
  }
  window.removeEventListener("pointermove", onImagePointerMove);
  window.removeEventListener("pointerup", onImagePointerUp);
  window.removeEventListener("pointercancel", onImagePointerUp);
  dragging.value = false;
}

// 测量滚动容器的可用尺寸（去掉内边距）。
//
// ⚠️ 用 clientWidth/clientHeight：它**不含滚动条占位**，正是图片实际能看到的
// 那块。「适应窗口」按它算，图片才不会比可视区大出一截（多出一条滚动条）。
function measureView() {
  const el = imageScrollRef.value;
  if (!el) return;
  const cs = getComputedStyle(el);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  viewSize.value = {
    w: Math.max(0, el.clientWidth - padX),
    h: Math.max(0, el.clientHeight - padY),
  };
}

let viewObserver = null;
// .image-scroll 只在预览类型是图片时才存在（模板里是 v-else-if），
// 所以观察器跟着它出生和销毁。
function observeView() {
  if (viewObserver) {
    viewObserver.disconnect();
    viewObserver = null;
  }
  const el = imageScrollRef.value;
  if (!el) return;
  measureView();
  if (typeof ResizeObserver === "undefined") return;
  viewObserver = new ResizeObserver(measureView);
  viewObserver.observe(el);
}

// 换文件后重置缩放（长图 ↔ 短图的比例完全不同）。
function resetZoom() {
  zoomMode.value = "fit";
  zoomScale.value = 1;
  imgNatural.value = { w: 0, h: 0 };
  // 换文件时如果正在拖，那次拖动作废（起点与新图片无关）。
  endImageDrag();
}

// 换文件后重置旋转。
//
// ⚠️ 旋转是**每个文件各自的状态**：上一张图竖着放，下一张可能横着放，
// 带着上一张的角度会让人以为新图本身就是歪的。与缩放一起复位。
function resetRotation() {
  rotation.value = 0;
}

// 取当前的图片元素（<img> 或 HEIC 画布）——缩放锚点计算要量它的矩形。
function currentMediaEl() {
  return imageRef.value || frameCanvasRef.value;
}

// 缩放到指定比例，并把 cursor（视口坐标）下的那一点内容留在原地。
// cursor 为 null 时以视口中心为锚。
async function applyZoom(nextScale, cursor) {
  const el = imageScrollRef.value;
  const media = currentMediaEl();
  if (!el || !media) return;
  // 缩放会改内容尺寸与滚动量 —— 正在拖的话，那次拖的基准（起点滚动量）
  // 就对不上了，直接结束它（TabBar 同款：手势与状态变更不并行）。
  endImageDrag();
  const before = media.getBoundingClientRect();
  const anchor =
    cursor || {
      x: el.getBoundingClientRect().left + el.clientWidth / 2,
      y: el.getBoundingClientRect().top + el.clientHeight / 2,
    };

  zoomMode.value = "manual";
  zoomScale.value = nextScale;
  // 等 DOM 真的按新尺寸重排完，才能量到「之后」的矩形与滚动量
  // （内容尺寸变了，浏览器可能已把滚动量夹到新范围内 —— 必须用那一刻的值）。
  await nextTick();
  const after = media.getBoundingClientRect();
  const next = anchorScroll({
    before: { left: before.left, top: before.top, width: before.width, height: before.height },
    after: { left: after.left, top: after.top, width: after.width, height: after.height },
    cursor: anchor,
    scroll: { left: el.scrollLeft, top: el.scrollTop },
  });
  el.scrollLeft = next.left;
  el.scrollTop = next.top;
}

function zoomIn() {
  if (!canZoomIn.value) return;
  const next = zoomStep(activeScale.value, 1, fitScale.value);
  if (next <= activeScale.value + 1e-9) return;
  applyZoom(next, null);
}

function zoomOut() {
  if (!canZoomOut.value) return;
  const next = zoomStep(activeScale.value, -1, fitScale.value);
  // 缩到「适应窗口」以下没有意义 —— 直接回到适应窗口档。
  if (next <= fitScale.value + 1e-9) {
    zoomFit();
    return;
  }
  applyZoom(next, null);
}

function zoomFit() {
  zoomMode.value = "fit";
  // 适应窗口会把滚动量归零 —— 正在拖的话基准同样失效。
  endImageDrag();
  const el = imageScrollRef.value;
  if (el) {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }
}

function zoomActual() {
  if (isActual.value) return;
  applyZoom(MAX_SCALE, null);
}

// Ctrl+滚轮：以光标为锚点连续缩放（Windows 照片查看器的习惯）。
// 不按 Ctrl 的滚轮留给浏览器自己滚动 —— 图片放大后要能上下左右看。
// Shift+滚轮 = 左右滚动（各平台的原生行为不一致，这里自己做）。
function onImageWheel(e) {
  const el = imageScrollRef.value;
  if (!el) return;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    el.scrollLeft += e.deltaY;
    return;
  }
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  if (!naturalSize.value.w) return;
  const base = activeScale.value;
  const next = wheelScale(base, e.deltaY, fitScale.value, MAX_SCALE);
  if (Math.abs(next - base) < 1e-9) return;
  applyZoom(next, { x: e.clientX, y: e.clientY });
}

// ── 图片缩放的键盘快捷键 ──
// 与视频预览同一套做法：window 捕获阶段监听 + markHandled()，
// 这样全局 handler（App.vue）不会在同一个按键上再动作一次。
//
// ⚠️ 只在**图片**预览时认领：这个组件同时渲染文本 / PDF / Word，
// 那些预览打开时按 Ctrl+= 不该有任何反应。
//
// ⚠️ IME 守卫必须在 matches() 之前（与 FileList / ShortcutsDialog 同一规矩）：
// matches() 用 e.code 拼组合键、完全不看合成状态，忘了守卫就会在
// 中文选词时误触发缩放。
function onPreviewKey(e) {
  if (previewType.value !== "image") return;
  if (isImeKeydown(e)) return;
  // 焦点在输入框里（比如过滤框）时不抢按键。
  if (isTypingTarget(e.target)) return;
  if (matches("image.zoomIn", e)) {
    e.preventDefault();
    e.stopPropagation();
    markHandled(e);
    zoomIn();
    return;
  }
  if (matches("image.zoomOut", e)) {
    e.preventDefault();
    e.stopPropagation();
    markHandled(e);
    zoomOut();
    return;
  }
  if (matches("image.zoomFit", e)) {
    e.preventDefault();
    e.stopPropagation();
    markHandled(e);
    zoomFit();
    return;
  }
  if (matches("image.zoomActual", e)) {
    e.preventDefault();
    e.stopPropagation();
    markHandled(e);
    zoomActual();
    return;
  }
  if (matches("image.rotateLeft", e)) {
    e.preventDefault();
    e.stopPropagation();
    markHandled(e);
    rotateLeft();
    return;
  }
  if (matches("image.rotateRight", e)) {
    e.preventDefault();
    e.stopPropagation();
    markHandled(e);
    rotateRight();
  }
}

function onImageLoad(e) {
  const img = e.target;
  imageInfo.value = `${img.naturalWidth}x${img.naturalHeight}`;
  imgNatural.value = { w: img.naturalWidth, h: img.naturalHeight };
  // The container may not have been measured yet (or the window may have
  // been resized while this image was decoding) — re-measure now that the
  // natural size is known, so 「适应窗口」 has a real basis.
  nextTick(measureView);
  // Close the HEIC timeline: everything before this point was producing the
  // blob, this row is the webview's own JPEG decode + first paint. If the
  // "ready -> painted" gap is large, the blob is the wrong size.
  if (heicPhaseStart) {
    heicMark("painted", `${img.naturalWidth}x${img.naturalHeight}`);
    heicReport();
  }
}

function onImageError() {
  error.value = "无法加载图片，文件可能已损坏";
  previewType.value = "";
}

// PDF iframe 加载失败时设置局部错误标记（不使用组件级 error，以保留 header/footer 展示）
function onPdfError() {
  pdfLoadError.value = true;
}

// Copy the entire preview text to the OS clipboard (for the "复制全部" button).
// Falls back to a hidden-textarea + execCommand when the async clipboard API
// is unavailable (some webviews / insecure contexts).
async function copyAll() {
  const text = previewContent.value;
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      ok = true;
    } catch {
      ok = false;
    }
  }
  copyAllDone.value = ok;
  if (ok) setTimeout(() => { copyAllDone.value = false; }, 1500);
}

// ── Word (.docx) preview ──
// mammoth reads the raw OOXML and emits a limited subset of HTML (headings,
// paragraphs, lists, tables, bold/italic, hyperlinks, images). It still needs
// sanitizing: the .docx is user-supplied, so its XML is attacker-chosen, and
// the result lands in the webview via v-html. See ../docxSanitize.js for why
// this is an allowlist (and why a blacklist was not enough here).
const MAX_DOCX_BYTES = 25 * 1024 * 1024; // 25 MB cap (mammoth loads the whole file)

async function loadDocxPreview(load) {
  docMessage.value = "";
  // Guard against previewing huge documents (keeps the webview responsive).
  if (props.fileBytes && props.fileBytes > MAX_DOCX_BYTES) {
    error.value = `文件过大，无法预览（最大 ${MAX_DOCX_BYTES / 1024 / 1024} MB）`;
    loading.value = false;
    return;
  }
  try {
    // Reuse the asset protocol (same mechanism as images/PDF): the webview
    // fetches the local file bytes directly — no backend command needed.
    const url = convertFileSrc(props.filePath);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`无法读取文件 (HTTP ${resp.status})`);
    const arrayBuffer = await resp.arrayBuffer();
    const mammoth = await loadMammoth();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    // A 25 MB docx takes seconds to convert; without this the document the
    // user paged away from lands last and replaces the one they are reading.
    if (!load.lands()) return;
    const html = sanitizeDocxHtml(result.value || "");
    previewContent.value = html;
    previewType.value = "docx";
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    // Character count of the visible text (proxy for 字数; works for CJK too).
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s/g, "");
    charCount.value = text.length;
  } catch (e) {
    if (load.lands()) {
      error.value = `无法预览此 Word 文档：${String(e)}\n（若为 .doc 旧格式，请另存为 .docx 后再预览）`;
    }
  } finally {
    if (load.lands()) loading.value = false;
  }
}

// ── HEIC / HEIF preview ──
// These formats are HEVC-coded in an ISOBMFF container; no mainstream webview
// decodes them natively. libheif runs in a dedicated Worker (heicDecoder.js)
// and hands back raw pixels, which we re-encode to a JPEG Blob, turn into an
// objectURL, and feed to the normal <img> path.
//
// Size cap: libheif decodes into an uncompressed RGBA buffer —
// width*height*4 bytes, so a 48 MP phone photo needs ~200 MB before any
// encoding. Refuse anything past the cap rather than let the tab die. Measured
// on a 12 MP file: 48.8 MB per decode.
//
// The pixel cap itself lives in heicDecoder.js (MAX_HEIC_PIXELS) because it has
// to be applied INSIDE the worker, before display() allocates — only the file
// on disk is capped here, since that we can know without decoding.
const MAX_HEIC_BYTES = 60 * 1024 * 1024; // 60 MB on-disk cap

// Per-phase timing for the HEIC path. This is the one preview that routinely
// takes hundreds of ms, and the cost is very unevenly distributed (see the
// bench notes below), so a single "load" number tells you nothing about *why*
// it was slow. Each step is recorded separately and flushed as its own console
// table once the image is on screen.
//
// Why not reuse bootLog's report(): it fires exactly once per session (the
// `reported` guard), which is right for startup but useless here -- paging
// through HEICs is exactly the case where you want the per-file numbers for
// every file, compared against each other.
const heicMarks = [];
let heicPhaseStart = 0;

function heicMark(name, detail) {
  const at = performance.now();
  heicMarks.push({ step: name, at: +at.toFixed(1), dur: +(at - heicPhaseStart).toFixed(1), note: detail || "" });
  heicPhaseStart = at;
}

function heicReport() {
  if (heicMarks.length < 2) return;
  const total = heicMarks[heicMarks.length - 1].at - heicMarks[0].at;
  console.groupCollapsed(
    `%c[heic] ${props.fileName} ${total.toFixed(0)} ms`,
    "color:#d29922;font-weight:600"
  );
  // Hand console.table a SNAPSHOT, not the live array. DevTools keeps the
  // reference and only materialises the rows when you expand the group, so
  // passing `heicMarks` directly shows an empty table: the reset below runs
  // long before you click it. bootLog.js avoids this for the same reason (it
  // passes a fresh array from .map()).
  console.table([...heicMarks]);
  console.groupEnd();
  heicMarks.length = 0;
  heicPhaseStart = 0;
}

// Benchmarked on the user's own 48-file set (12 MP phone photos, 3024x4032):
// libheif decode() (HEVC bitstream) is ~3 ms; display() (YUV420 -> RGBA) is the
// entire cost. The engine matters, so this path uses libheif-js's real WASM
// build directly instead of heic2any's asm.js one (2.5x, see heicDecoder.js).
// The remaining cost is downscaling, which libheif-js does not expose.
async function loadHeicPreview(load) {
  stopAnimation();
  heicPhaseStart = performance.now();
  heicMarks.length = 0;
  heicMark("start", `${props.fileName} ${(props.fileBytes / 1024).toFixed(0)} KB`);

  if (props.fileBytes && props.fileBytes > MAX_HEIC_BYTES) {
    error.value = `HEIC 文件过大，无法预览（最大 ${MAX_HEIC_BYTES / 1024 / 1024} MB）`;
    loading.value = false;
    return;
  }

  const resp = await fetch(convertFileSrc(props.filePath));
  if (!resp.ok) throw new Error(`无法读取文件 (HTTP ${resp.status})`);
  const arrayBuffer = await resp.arrayBuffer();
  heicMark("file-read", `${(arrayBuffer.byteLength / 1024).toFixed(0)} KB`);

  // The Worker does decode + colour conversion off the UI thread; we only
  // re-encode the returned pixels. These are now separate calls with separate
  // timings -- heic2any hid both behind one await across two threads.
  const result = await decodeHeic(arrayBuffer);
  // Past this point the decode cost is already sunk — bail out before touching
  // any state, so the slow file cannot overwrite the one now on screen.
  if (!load.lands()) return;

  // The pixel budget is enforced in the worker, before it commits the RGBA
  // allocation. Reaching here means the primary either fitted, or the file
  // carried an embedded downscaled copy the worker fell back to.
  if (result.tooLarge) {
    const { width, height } = result.tooLarge;
    error.value = `图片分辨率过高（${width}x${height}），已跳过预览以避免内存耗尽`;
    loading.value = false;
    heicMark("aborted", `${width}x${height} over budget, no embedded preview`);
    heicReport();
    return;
  }

  const { pixels, width, height, decodeMs, displayMs } = result;
  heicMark("worker-decode", `hevc ${decodeMs.toFixed(0)}ms + rgba ${displayMs.toFixed(0)}ms -> ${width}x${height}`);

  // Animated: the first frame is already decoded and in `pixels`. Paint it on
  // a canvas and let the loop fetch the rest on demand — decoding every frame
  // up front would cost frames * width * height * 4 bytes all at once.
  if (result.animated) {
    previewType.value = "image";
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    frameState.value = { count: result.frameCount, index: 0, playing: false, width, height };
    frameDurations = new Array(result.frameCount).fill(0);
    if (result.durationMs) frameDurations[0] = result.durationMs;
    animDefaultMs = result.defaultFrameMs || 100;
    heicNote.value = `HEIC 动画，共 ${result.frameCount} 帧`;
    loading.value = false;
    // The canvas only exists after previewType flips to "image", so the first
    // paint has to wait for Vue to render it. The selection may have moved on
    // during that tick, and the loop this starts would otherwise keep decoding
    // frames of a file nobody is looking at.
    await nextTick();
    if (!load.lands()) {
      // Our frame bookkeeping was already written above; drop it so the file
      // now on screen doesn't inherit this one's frame count and durations.
      stopAnimation();
      return;
    }
    paintFrame(pixels, width, height);
    heicMark("ready", `frame 1/${result.frameCount} on canvas`);
    heicReport();
    togglePlayback();
    return;
  }

  const { blob, putMs, encodeMs } = await pixelsToBlob(pixels, width, height);
  heicMark("encoded", `putImageData ${putMs.toFixed(0)}ms + jpeg ${encodeMs.toFixed(0)}ms -> ${(blob.size / 1024).toFixed(0)} KB`);
  // The encode is the last await, and it is the one that produced an objectURL
  // — so a superseded load MUST drop the blob rather than just skip the writes
  // below. Leaking it here is exactly the bug: every fast page-through a folder
  // of HEICs would strand one more multi-MB JPEG for the life of the window.
  if (!load.lands()) return;

  heicObjectUrl = URL.createObjectURL(blob);
  previewContent.value = heicObjectUrl;
  previewType.value = "image";
  fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : formatSize(blob.size);
  // Say so when this is the embedded preview rather than the real image —
  // otherwise a 384x512 stand-in is indistinguishable from a genuinely small
  // photo, and the user has no idea what they're not seeing.
  heicNote.value = result.downscaled
    ? `原图 ${result.fullWidth}x${result.fullHeight} 过大，已显示内嵌预览图`
    : "HEIC 已转换为 JPEG 显示";
  heicMark("ready", `${(blob.size / 1024).toFixed(0)} KB JPEG`);
  loading.value = false;
}

async function loadPreview() {
  // Snapshot what we were asked about, and release the previous file's objectURL
  // HERE rather than inside loadHeicPreview: releasing it only on the HEIC path
  // meant that paging from a HEIC to a PNG/TXT/PDF left the decoded blob alive
  // for the rest of the session. `lands()` below is checked after every await.
  const load = beginLoad();
  releaseHeicUrl();
  loading.value = true;
  error.value = "";
  previewType.value = "";
  previewContent.value = "";
  lineCount.value = null;
  imageInfo.value = "";
  heicNote.value = "";
  jsonWarn.value = "";
  pdfLoadError.value = false;
  docMessage.value = "";
  charCount.value = null;
  // 每换一个文件，缩放档位回到「适应窗口」——上一张图的手动比例对下一张
  // （可能尺寸完全不同）没有意义。
  resetZoom();
  // 旋转同理：上一张图的角度对下一张没有意义。
  resetRotation();

  const ext = getExtension(props.fileName);
  // The shared mapping decides the preview type. `asText` is the one-shot
  // override used by "按文本预览" on a suffix that was just registered.
  const kind = props.asText ? "text" : previewKindOf(ext);

  if (kind === "image") {
    // HEIC family: WebView2 can't decode it, so it gets its own wasm transcode
    // path instead of being handed straight to <img src>.
    if (HEIC_IMAGE_EXTENSIONS.includes(ext)) {
      try {
        await loadHeicPreview(load);
      } catch (e) {
        // A decode failure from a file the user already paged away from must not
        // paint an error over the file they are actually looking at.
        if (!load.lands()) return;
        error.value = `无法解码此 HEIC 文件：${String(e?.message || e)}`;
        loading.value = false;
        // Flush the partial timeline — "where did it die" is exactly the
        // question a failed HEIC raises, and without this the table is dropped.
        if (heicPhaseStart) {
          heicMark("failed", String(e?.message || e));
          heicReport();
        }
      }
      return;
    }
    // Use convertFileSrc to load directly via asset protocol (bypasses IPC).
    previewType.value = "image";
    previewContent.value = convertFileSrc(props.filePath);
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  if (kind === "video") {
    // App.vue routes videos to VideoPreview. Reaching here means a stale
    // preview state; don't try to read a video as text.
    error.value = "视频请在视频预览中打开";
    loading.value = false;
    return;
  }

  // PDF: 同图片一样用 convertFileSrc 直连本地文件，不经过 IPC 文本读取。
  // 依赖系统 WebView 内置 PDF 查看器（Windows WebView2 支持；macOS WKWebView 不支持，走降级提示）。
  if (kind === "pdf") {
    previewType.value = "pdf";
    previewContent.value = convertFileSrc(props.filePath);
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  // Word documents: .docx is OOXML (zip + xml) — convert to HTML in the
  // frontend via mammoth (reads file bytes through the asset protocol). Any
  // other suffix the user added to this type gets the "convert to .docx" hint.
  if (kind === "doc") {
    if (MAMMOTH_DOC_EXTENSIONS.includes(ext)) {
      await loadDocxPreview(load);
      return;
    }
    previewType.value = "doc";
    docMessage.value =
      ext === "doc"
        ? "不支持预览旧版 .doc 格式（二进制 OLE）。请用 Word / WPS 另存为 .docx 后再预览。"
        : `暂不支持预览 .${ext} 格式。请用 Word / WPS 另存为 .docx 后再预览。`;
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  if (kind !== "text") {
    error.value = "暂不支持预览该格式";
    loading.value = false;
    return;
  }

  // Text (incl. JSON): use IPC to read content. Force a text read so user-added
  // suffixes work even though the backend's built-in TEXT_EXTENSIONS is fixed.
  try {
    const result = await readFilePreview(props.filePath, true);
    if (!load.lands()) return;
    previewType.value = result.preview_type;
    previewContent.value = result.content;
    fileSize.value = formatSize(result.size);
    if (result.preview_type === "text") {
      if (ext === "json") {
        // Pretty-print valid JSON with a 2-space indent. On parse failure
        // show a non-blocking warning and fall back to the raw text.
        try {
          const parsed = JSON.parse(result.content);
          previewContent.value = JSON.stringify(parsed, null, 2);
          jsonWarn.value = "";
        } catch {
          jsonWarn.value = "JSON 格式错误，以下为原始文本";
        }
        previewType.value = "json";
      } else if (ext === "log") {
        // Logs are shown as-is (raw text, no pretty-printing).
        previewType.value = "log";
      }
      lineCount.value = previewContent.value.split("\n").length;
    }
  } catch (e) {
    // Same reasoning as above: a read failure belonging to a file the user has
    // already paged away from says nothing about the one now on screen.
    if (load.lands()) error.value = String(e);
  } finally {
    if (load.lands()) loading.value = false;
  }
}

// Two things can change what should be rendered: a different file, or a save
// in 文件预览设置 that reclassifies the SAME file (e.g. removing its suffix
// from 图片). One watch over both avoids the double loadPreview() that two
// independent watches would fire on every file change.
// A STRING key, not an array: Vue compares a getter's return value by identity,
// so returning a fresh array would fire on every tracked dependency change
// (including unrelated mapping edits). Strings compare by value.
watch(
  () => `${props.filePath}\u0000${previewKindOf(getExtension(props.fileName))}`,
  () => {
    // A pending HEIC timeline is left hanging when the user pages away before
    // <img> fired `load` (fast arrow-key scrubbing through 48 files). Flush it
    // here so those runs still show up in the console.
    if (heicPhaseStart) {
      heicMark("interrupted", "selection changed before painted");
      heicReport();
    }
    // Kill any animation BEFORE the new file starts loading. Without this an
    // arrow-key run through an animated HEIC leaves a live timer calling
    // decodeHeicFrame() against a container the worker has already replaced,
    // and the canvas keeps painting frames nobody is looking at.
    stopAnimation();
    // Also release the previous file's decoded blob when the preview closes
    // entirely (filePath goes empty): nothing will call loadPreview in that
    // case, so this is the only place the HEIC objectURL gets freed.
    if (props.filePath) {
      loadPreview();
    } else {
      releaseHeicUrl();
      loading.value = false;
    }
  },
  { immediate: true }
);

// The zoom toolbar needs the scroll container's size, and that element only
// exists while an IMAGE preview is on screen (the template renders it under
// `v-else-if="previewType === 'image'"`). So the observer is attached when
// the preview type turns into "image" and dropped again when it doesn't —
// a watcher on the type, not on mount (at mount the element may not exist
// yet, and the HEIC path sets the type a tick later).
watch(previewType, async (t) => {
  if (t !== "image") {
    if (viewObserver) {
      viewObserver.disconnect();
      viewObserver = null;
    }
    return;
  }
  // The element is created by this very change — wait a tick for it.
  await nextTick();
  observeView();
});
</script>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--panel-bg);
  border: 1px solid var(--accent);
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  min-height: 26px;
  user-select: none;
}

.preview-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.preview-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-weight: 600;
}

.preview-type-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--accent-dim);
  color: #fff;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.close-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 3px;
}

.close-btn:hover {
  background: var(--danger);
  color: #fff;
}

/* 旋转按钮组（头部右侧）：左转 / 右转 90°。
   只改显示，不写文件 —— 所以按钮不做「保存」样式，也不放在底部缩放条里
   （缩放条已经有 5 个按钮，再塞两个会被撑到面板宽度的一半）。 */
.rot-group {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.rot-btn {
  font-size: 11px;
  line-height: 1.4;
  padding: 1px 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
}

.rot-btn:hover {
  background: var(--hover);
}

/* 当前角度标签（270° 显示成 -90°，因为那是「逆时针 90°」更符合直觉）。 */
.rot-angle {
  font-size: 10px;
  color: var(--text-dim);
  min-width: 28px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.preview-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  position: relative;
}

/* Loading & error states */
.preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  color: var(--text-dim);
  font-size: 13px;
}

.preview-placeholder.error {
  color: var(--danger);
}

.placeholder-icon {
  font-size: 32px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Image preview */
.image-body {
  overflow: hidden;
  background: var(--bg);
}

/* The scroll container. It is a separate element (not .image-body itself)
   so the zoom toolbar and the HEIC transport controls stay put while the
   picture scrolls underneath them.

   ⚠️ NOT a flex container: a flex/grid item that overflows its container
   gets clipped on the start side (the classic "can't scroll to the top of
   an oversized centered image" bug) — for a 572×7191 long image that means
   the top of the picture would be unreachable. Centering is done with
   explicit margins instead (see imageStyle in the script).

   ⚠️ flex-basis:0 — .preview-body is a ROW-direction flex container, so a
   basis of `auto` would size this box to its content (the image) and the
   panel would clip it; basis 0 makes it exactly as wide as the panel. */
.image-scroll {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

/* 放大后可以按住图片拖动平移（Windows 照片查看器 / Photoshop 的手势）。
   光标给出「可以抓」和「正在抓」的提示。
   ⚠️ 只有内容溢出可视区时才给 grab —— 适应窗口下图片整张都在视野里，
   拖了也没地方去，不该让用户以为能拖。 */
.image-scroll.draggable {
  cursor: grab;
}

.image-scroll.draggable.dragging {
  cursor: grabbing;
}

/* 图片本身不要被浏览器当成可拖拽对象：那会拖出一个半透明的图片副本，
   跟我们的平移手势打架（原生 drag 一旦启动，pointermove 就不归我们了）。
   user-select 同理 —— 拖动时别选出图片来。 */
.image-scroll img,
.image-scroll canvas {
  -webkit-user-drag: none;
  user-select: none;
}

/* Zoom toolbar: zoom out / level / zoom in / fit / 1:1.
   Pinned bottom-left — the bottom centre is the HEIC play button and the
   bottom right the frame counter, so the three never overlap. */
.zoom-bar {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--header-bg);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  user-select: none;
}

.zoom-btn {
  font-size: 11px;
  line-height: 1.4;
  padding: 1px 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
}

.zoom-btn:hover:not(:disabled) {
  background: var(--hover);
}

.zoom-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.zoom-btn.active {
  background: var(--accent-dim);
  color: #fff;
}

.zoom-level {
  min-width: 36px;
  text-align: center;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

/* Transcode notice, pinned above the image without stealing its space. */
.heic-note {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--header-bg);
  border: 1px solid var(--border);
  pointer-events: none;
  white-space: nowrap;
}

/* Animated HEIC transport. Both sit at the bottom so they never collide with
   the heic-note chip at the top, and they stay clear of the image because
   .preview-body is position:relative — which also makes them overlay rather
   than push the canvas around. */
.anim-toggle {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--header-bg);
  color: var(--text);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.75;
}

.anim-toggle:hover {
  opacity: 1;
  border-color: var(--accent);
}

.anim-counter {
  position: absolute;
  bottom: 16px;
  right: 12px;
  z-index: 2;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--header-bg);
  border: 1px solid var(--border);
  pointer-events: none;
  white-space: nowrap;
}

/* The picture itself.

   The size comes from `imageStyle` (natural pixels × zoom), NOT from
   max-width/max-height — a max-height:100% would squeeze a 572×7191
   screenshot back down to a few pixels wide, which is exactly what the
   zoom feature exists to fix. Centering is done with explicit margins
   (also from imageStyle) so that an oversized picture stays reachable
   from both ends.

   ⚠️ The fallback below is NOT a rough approximation — it is **exactly**
   what the "fit window" frame renders, so the picture never jumps:

   The box is the whole viewport (100% × 100%) and `object-fit: contain`
   puts the image inside it, scaled to fit and centered (contain does not
   upscale). That is precisely the fit-scale geometry `imageStyle`
   computes: floor(nat × min(avail/nat, 1)) at margin (avail − size)/2.
   So the frame before the size is known (image not decoded yet, or the
   panel not measured yet) already shows the picture centered at its
   final size — the user never sees it slide over from the top-left.

   ⚠️ It must be width/height:100%, NOT max-width/max-height:100%.
   With max-* the box shrinks to the image's own size (max-width:100%
   only caps it), the box sits in the top-left corner, and the picture
   ends up off-center — that was the "first left-aligned, then centered"
   the user reported. */
/* 画框：图片**旋转后**的画面占位。
   滚动容器量的是它 —— 所以滚动范围、居中偏移、「适应窗口」描述的都是
   用户真正看到的那块画面，而不是旋转前的盒子。 */
.image-frame {
  position: relative;
  /* 画面本体在里面是绝对定位 + translate(-50%,-50%) 居中的：转 90° 后
     它的盒子比画框大（盒子始终是未旋转的宽高），不裁掉就会溢出画框、
     把滚动区域撑大。裁掉的正好是旋转后露不出来的部分。 */
  overflow: hidden;
  width: 100%;
  height: 100%;
}

/* 图片本体。 */
.preview-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 2px;
  /* 绝对定位 + translate(-50%,-50%)：无论盒子比画框大还是小，都精确居中
     —— flex 的居中在盒子溢出时会把内容推到一边去。 */
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

/* PDF preview */
.pdf-body {
  background: var(--bg);
}

.preview-pdf-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

/* Word (.docx) preview */
.doc-body {
  overflow: auto;
  background: var(--bg);
  display: block;
}

.preview-doc {
  padding: 14px 20px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  user-select: text;
}

.preview-doc :deep(h1) {
  font-size: 1.5em;
  font-weight: 700;
  margin: 0.6em 0 0.3em;
}
.preview-doc :deep(h2) {
  font-size: 1.3em;
  font-weight: 700;
  margin: 0.6em 0 0.3em;
}
.preview-doc :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin: 0.5em 0 0.3em;
}
.preview-doc :deep(p) {
  margin: 0 0 0.6em;
}
.preview-doc :deep(ul),
.preview-doc :deep(ol) {
  padding-left: 1.5em;
  margin: 0 0 0.6em;
}
.preview-doc :deep(li) {
  margin: 0.15em 0;
}
.preview-doc :deep(table) {
  border-collapse: collapse;
  margin: 0.6em 0;
}
.preview-doc :deep(td),
.preview-doc :deep(th) {
  border: 1px solid var(--border);
  padding: 3px 8px;
  vertical-align: top;
}
.preview-doc :deep(a) {
  color: var(--accent);
}
.preview-doc :deep(img) {
  max-width: 100%;
  height: auto;
}
.preview-doc :deep(blockquote) {
  margin: 0.6em 0;
  padding-left: 0.8em;
  border-left: 3px solid var(--border);
  color: var(--text-dim);
}

/* Text preview */
.text-body {
  overflow: auto;
  background: var(--bg);
  display: block;
}

.json-warn {
  padding: 4px 12px;
  font-size: 12px;
  color: #1f1f1f;
  background: #f2c14e;
  border-bottom: 1px solid rgba(0, 0, 0, 0.2);
}

.preview-text {
  margin: 0;
  padding: 8px 12px;
  font-family: "Cascadia Code", "Consolas", "SF Mono", "Menlo", monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  tab-size: 4;
  width: 100%;
  user-select: text;
}

.preview-text code {
  font-family: inherit;
}

.copy-all-btn {
  margin-left: auto;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 3px;
  cursor: pointer;
}

.copy-all-btn:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

/* Footer */
.preview-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 8px;
  background: var(--header-bg);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  min-height: 22px;
}
</style>
