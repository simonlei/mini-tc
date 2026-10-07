<template>
  <div class="file-preview">
    <!-- Header -->
    <div class="preview-header">
      <span class="preview-icon">{{ headerIcon }}</span>
      <span class="preview-title" :title="fileName">{{ fileName }}</span>
      <span class="preview-type-badge">{{ typeLabel }}</span>
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
      <!-- Animated HEIC plays on a canvas. Swapping an <img> src per frame
           flashes (and leaks an objectURL per frame); a canvas just gets a
           drawImage per frame, which is also cheaper than a JPEG round-trip
           through an <img>. -->
      <canvas
        v-if="frameState.count > 1"
        ref="frameCanvasRef"
        class="preview-image"
        :width="frameState.width"
        :height="frameState.height"
      ></canvas>
      <img v-else :src="previewContent" class="preview-image" @load="onImageLoad" @error="onImageError" />
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
      <pre class="preview-text"><code>{{ previewContent }}</code></pre>
    </div>

    <!-- Word (.docx) preview: rendered HTML from mammoth (v-html, sanitized) -->
    <div class="preview-body doc-body" v-else-if="previewType === 'docx'">
      <div class="preview-doc" v-html="previewContent"></div>
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
import { ref, watch, computed, onBeforeUnmount, nextTick } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFilePreview } from "../api.js";
import { decodeHeic, decodeHeicFrame, pixelsToBlob } from "../heicDecoder.js";
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
  // When true, force a plain-text read even for non-built-in extensions
  // (user-added "preview as text" extensions from ~/.minitc config).
  asText: { type: Boolean, default: false },
});

defineEmits(["close"]);

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"];
// HEIC family. Kept OUT of IMAGE_EXTENSIONS on purpose: WebView2 has no
// built-in HEIC decoder, so these must go through the wasm decode path
// instead of being handed straight to <img src>.
const HEIC_EXTENSIONS = ["heic", "heif", "hif", "avci"];

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
});

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

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function getExtension(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function onImageLoad(e) {
  const img = e.target;
  imageInfo.value = `${img.naturalWidth}x${img.naturalHeight}`;
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
// mammoth reads the raw OOXML and emits a limited, safe subset of HTML
// (headings, paragraphs, lists, tables, bold/italic, hyperlinks, images).
// Even so, we run a defensive sanitizer because the source is user-supplied
// and parsed XML could carry <script>/on*=/javascript: payloads.
const MAX_DOCX_BYTES = 25 * 1024 * 1024; // 25 MB cap (mammoth loads the whole file)

// Strip anything that could execute or escape the preview: <script>/<style>/
// <iframe>/<object>/<embed>/<link>/<meta>, all event-handler attributes, and
// javascript: URLs in href/src. Returns sanitized HTML string.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script, style, iframe, object, embed, link, meta")
    .forEach((el) => el.remove());
  const walk = (node) => {
    if (node.nodeType === 1) {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on")) {
          node.removeAttribute(attr.name);
        } else if (
          (name === "href" || name === "src") &&
          value.startsWith("javascript:")
        ) {
          node.removeAttribute(attr.name);
        }
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

async function loadDocxPreview() {
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
    const html = sanitizeHtml(result.value || "");
    previewContent.value = html;
    previewType.value = "docx";
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    // Character count of the visible text (proxy for 字数; works for CJK too).
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s/g, "");
    charCount.value = text.length;
  } catch (e) {
    error.value = `无法预览此 Word 文档：${String(e)}\n（若为 .doc 旧格式，请另存为 .docx 后再预览）`;
  } finally {
    loading.value = false;
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
async function loadHeicPreview() {
  releaseHeicUrl();
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
    // paint has to wait for Vue to render it.
    await nextTick();
    paintFrame(pixels, width, height);
    heicMark("ready", `frame 1/${result.frameCount} on canvas`);
    heicReport();
    togglePlayback();
    return;
  }

  const { blob, putMs, encodeMs } = await pixelsToBlob(pixels, width, height);
  heicMark("encoded", `putImageData ${putMs.toFixed(0)}ms + jpeg ${encodeMs.toFixed(0)}ms -> ${(blob.size / 1024).toFixed(0)} KB`);

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

  const ext = getExtension(props.fileName);

  // Image: use convertFileSrc to load directly via asset protocol (bypasses IPC entirely)
  if (IMAGE_EXTENSIONS.includes(ext)) {
    previewType.value = "image";
    previewContent.value = convertFileSrc(props.filePath);
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  // HEIC family: must NOT fall through to the <img> branch above (WebView2
  // can't decode it), so it gets its own wasm transcode path.
  if (HEIC_EXTENSIONS.includes(ext)) {
    try {
      await loadHeicPreview();
    } catch (e) {
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

  // PDF: 同图片一样用 convertFileSrc 直连本地文件，不经过 IPC 文本读取。
  // 依赖系统 WebView 内置 PDF 查看器（Windows WebView2 支持；macOS WKWebView 不支持，走降级提示）。
  if (ext === "pdf") {
    previewType.value = "pdf";
    previewContent.value = convertFileSrc(props.filePath);
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  // Word documents: .docx is OOXML (zip + xml) — convert to HTML in the
  // frontend via mammoth (reads file bytes through the asset protocol, no
  // backend change). .doc is the legacy binary format mammoth can't read, so
  // we show a friendly prompt to re-save as .docx instead of failing silently.
  if (ext === "docx") {
    await loadDocxPreview();
    return;
  }
  if (ext === "doc") {
    previewType.value = "doc";
    docMessage.value =
      "不支持预览旧版 .doc 格式（二进制 OLE）。请用 Word / WPS 另存为 .docx 后再预览。";
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  // Text (incl. JSON): use IPC to read content. `asText` forces a text read
  // for extensions the user opted into via the "按文本预览" action.
  try {
    const result = await readFilePreview(props.filePath, props.asText);
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
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.filePath,
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
    if (props.filePath) loadPreview();
  },
  { immediate: true }
);
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
  overflow: auto;
  background: var(--bg);
  padding: 12px;
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

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  margin: auto;
  border-radius: 2px;
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
