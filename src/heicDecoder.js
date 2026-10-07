// HEIC/HEIF decoding, isolated from FilePreview.vue so the engine details (wasm
// worker plumbing, canvas encoding) stay out of the UI component.
//
// ── Why not heic2any ──────────────────────────────────────────────────────
// heic2any is the obvious pick (MIT, self-contained) but it embeds an **asm.js**
// build of libheif, so the per-pixel YUV→RGBA conversion runs on the JS
// interpreter. Measured on 12 MP phone photos (3024x4032, 10 files, median):
//
//   heic2any's asm.js     ~1047 ms
//   libheif-js WASM       ~422 ms     (2.5x)   <-- what we use
//   libheif-wasm (ISC)    ~571 ms              — real wasm, but slower still
//
// The cost splits as decode()≈3 ms (HEVC bitstream) vs display()≈440 ms
// (YUV420→RGBA), so the engine *is* the whole cost. 422 ms is still slow, but
// it is the cheap half of a fix — the expensive half is downscaling, which
// libheif-js's high-level API does not expose (see the notes in
// heicDecode.worker.js). Tracked separately; do not assume this is final.
//
// Licence note: libheif is LGPL-3.0, unlike heic2any's MIT. Fine for personal
// use; worth knowing before redistributing.

import HeicWorker from "./heicDecode.worker.js?worker";

// One worker for the app's lifetime: it owns the wasm instance (a
// WebAssembly instance is expensive to create and cannot be shared across
// threads), and reusing it avoids re-instantiating on every preview.
let worker = null;
let nextReqId = 1;
const pending = new Map();

// Decoded-pixel budget. libheif hands back uncompressed RGBA, so the cost is
// width*height*4 bytes of wasm heap *before* anything is encoded: a 12 MP
// phone photo needs ~49 MB, a 48 MP one ~200 MB. Past this we refuse rather
// than let the tab die.
//
// The number is enforced inside the worker, before display() runs — see the
// comment there. It used to be checked in the UI after the decode returned,
// which meant an oversized file had already paid the full cost (measured: 4.4 s
// and ~800 MB for a 12240x16320 grid) before the error appeared.
export const MAX_HEIC_PIXELS = 50e6;

function ensureWorker() {
  if (worker) return worker;
  worker = new HeicWorker();

  worker.onmessage = (e) => {
    const { id, pixels, width, height, fullWidth, fullHeight, downscaled, animated, frameCount, defaultFrameMs, index, durationMs, tooLarge, error, decodeMs, displayMs } = e.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error));
    // Not an exception: the UI wants to phrase this itself, with the real
    // dimensions in the message.
    else if (tooLarge) entry.resolve({ tooLarge });
    else {
      entry.resolve({
        pixels, width, height, decodeMs, displayMs,
        ...(fullWidth ? { fullWidth, fullHeight, downscaled } : null),
        ...(animated ? { animated, frameCount, defaultFrameMs, index, durationMs } : null),
      });
    }
  };

  worker.onerror = (e) => {
    const msg = (e && e.message) || "HEIC 解码 Worker 崩溃";
    for (const [, entry] of pending) entry.reject(new Error(msg));
    pending.clear();
  };

  return worker;
}

/// Decode a HEIC/HEIF buffer to RGBA pixels, off the UI thread.
///
/// If the primary image is over `MAX_HEIC_PIXELS`, the worker first looks for a
/// downscaled copy embedded in the same container (HEIC "grid" mosaics embed
/// one) and decodes that instead — `downscaled` then comes back true. Failing
/// that it resolves `{tooLarge}` rather than decoding something that would
/// exhaust memory.
///
/// @param {ArrayBuffer} arrayBuffer raw file bytes
/// @returns {Promise<{pixels: Uint8Array, width: number, height: number,
///                    fullWidth?: number, fullHeight?: number,
///                    downscaled?: boolean,
///                    decodeMs: number, displayMs: number}
///                  | {tooLarge: {width: number, height: number}}>}
export function decodeHeic(arrayBuffer) {
  const w = ensureWorker();
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      // Copy rather than transfer: the caller may hold a view we must not
      // detach, and the copy is ~1 ms against a ~400 ms decode.
      w.postMessage({ id, buffer: arrayBuffer.slice(0), maxPixels: MAX_HEIC_PIXELS });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/// Decode one frame of an animated HEIC, by index.
///
/// Only valid after `decodeHeic` has reported `animated: true` — the worker
/// keeps the parsed container from that call, so this skips the ~19 ms reparse
/// a fresh decode would cost. The index is 0-based and wraps: pass
/// `frameCount - 1` to loop back to the first frame.
///
/// @param {number} index frame position
/// @returns {Promise<{pixels: Uint8Array, width: number, height: number,
///                    index: number, durationMs: number, displayMs: number}>}
export function decodeHeicFrame(index) {
  const w = ensureWorker();
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, frameRequest: true, index });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/// RGBA pixels -> a JPEG Blob the webview can display in <img>.
///
/// WebView2 has no native HEIC support, so the pixels must be re-encoded. JPEG
/// because these are photographs; PNG would be lossless but far slower to
/// encode and much larger.
///
/// Resolves with the sub-timings as well as the blob: `putMs` is synchronous
/// main-thread work (a full copy of the RGBA buffer into the canvas) and
/// `encodeMs` is the async JPEG encode. They need different fixes, so they are
/// measured separately rather than lumped into one "encode" number.
export function pixelsToBlob(pixels, width, height, type = "image/jpeg", quality = 0.92) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("无法创建画布上下文"));
      return;
    }
    // ImageData needs a Uint8ClampedArray; a structured clone preserves the
    // Uint8Array type, not the clamped view, so wrap without copying.
    const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    // Split the two costs, because they need different fixes. `putImageData`
    // is a synchronous main-thread copy of the whole RGBA buffer (measured
    // ~150 ms for 12 MP), while `toBlob` offloads the JPEG encode but still
    // costs wall time we are waiting on. Reporting them together (as one
    // "encoded" figure) hid the fact that half of it is a main-thread stall.
    const tPut = performance.now();
    ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    const putMs = performance.now() - tPut;

    const tBlob = performance.now();
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("画布编码失败"));
        return;
      }
      resolve({ blob, putMs, encodeMs: performance.now() - tBlob });
    }, type, quality);
  });
}
