// HEIC/HEIF decoding worker. Runs off the UI thread because a 12 MP colour
// conversion is ~400 ms of solid CPU — on the main thread that would freeze
// arrow-key navigation in the file list for a third of a second per file.
//
// The wasm build is imported statically here (rather than dynamically) so
// Vite can see the dependency and emit it into this worker's chunk. The Worker
// is created with Vite's `?worker` suffix (see heicDecoder.js), which means the
// bundler handles the module graph — no blob URLs, no manual chunk wiring.

// This is libheif compiled to WebAssembly. NOT to asm.js: the asm.js build
// runs the per-pixel YUV→RGBA conversion on the JS interpreter and is ~2.5x
// slower (measured 1047 ms vs 422 ms on 3024x4032 phone photos).
//
// Note the entry point. libheif-js's package.json `main` points at
// `libheif/libheif.js`, which IS the asm.js build — importing the package by
// name silently gets the slow engine. The wasm build must be named explicitly.
import factory from "libheif-js/libheif-wasm/libheif-bundle.mjs";

// The factory is synchronous (the wasm bytes are embedded as base64 in the
// bundle, nothing is fetched), but it is expensive, so instantiate lazily on
// the first message rather than at module load.
let libheif = null;

// Floor for an embedded preview, in pixels. Below ~256x256 the "preview" is
// too small to recognise the image, so a file offering only that is treated as
// having no usable fallback.
const MIN_PREVIEW_PIXELS = 64 * 1024;

// Upper bound on how many container items we will inspect while looking for an
// embedded preview. Scanning is O(item count), and a pathological file could
// declare tens of thousands of items; the fallback is a nice-to-have, so give
// up rather than stall the preview.
const MAX_ITEMS_SCANNED = 2048;

// Find a smaller image already embedded in the container and matching the
// primary's aspect ratio, so an oversized primary can still be previewed.
//
// This is not a rare curiosity. HEIC allows a "grid" derived image: the primary
// is a mosaic of N x M tiles, each stored as its own hidden item, which the
// decoder stitches together on demand. A 12240x16320 grid built from 768 tiles
// of 512x512 is a 3.4 MB file that expands to 762 MB of RGBA — useless to
// decode just to look at it. Encoders typically embed a downscaled copy of the
// same picture alongside the grid, which is exactly what we want here.
//
// Returns a HeifImage, or null. The caller must not treat null as fatal on its
// own: it just means "no fallback", and the oversized primary still gets the
// normal refuse-with-a-reason path.
function findEmbeddedPreview(decoder, fullW, fullH, maxPixels) {
  if (!libheif || !decoder) return null;
  const ctx = decoder.decoder; // libheif-js keeps the heif_context here
  if (!ctx) return null;

  // Top-level items are the "real" images; skip them so we never mistake a
  // second full-size image (a burst, a depth map, an alpha variant) for a
  // preview of the first.
  let topIds;
  try {
    topIds = new Set(libheif.heif_js_context_get_list_of_top_level_image_IDs(ctx) || []);
  } catch {
    topIds = new Set();
  }

  const aspect = fullW / fullH;
  let best = null;
  let count = 0;
  try {
    count = libheif.heif_context_get_number_of_items(ctx);
  } catch {
    return null;
  }

  const limit = Math.min(count, MAX_ITEMS_SCANNED);
  for (let id = 1; id <= limit; id++) {
    if (topIds.has(id)) continue;

    let type;
    try {
      type = libheif.heif_item_get_item_type(ctx, id);
    } catch {
      continue;
    }
    // 'Exif' / 'mime' / 'uri ' items are metadata, not pixels. Exif items in
    // particular fail outright when asked for an image handle.
    if (!type || type === "Exif" || type === "mime" || type === "uri ") continue;

    let hidden = false;
    try {
      hidden = !!libheif.heif_item_is_item_hidden(ctx, id);
    } catch {
      continue;
    }
    // Hidden items are the grid's own tiles: right size, but decoding one
    // shows a fragment of the mosaic, not the picture.
    if (hidden) continue;

    let handle;
    try {
      handle = libheif.heif_js_context_get_image_handle(ctx, id);
    } catch {
      continue;
    }
    if (!handle) continue;

    let w = 0;
    let h = 0;
    try {
      w = libheif.heif_image_handle_get_width(handle);
      h = libheif.heif_image_handle_get_height(handle);
    } catch {
      w = 0;
      h = 0;
    }
    const px = w * h;

    // Aspect must match: an embedded depth map or alpha plane shares the pixel
    // budget but is a different image entirely.
    const ok =
      px >= MIN_PREVIEW_PIXELS &&
      px <= maxPixels &&
      Math.abs(w / h - aspect) <= aspect * 0.02;

    if (ok && (!best || px > best.px)) {
      if (best) libheif.heif_image_handle_release(best.handle);
      best = { handle, px };
    } else {
      libheif.heif_image_handle_release(handle);
    }
  }

  return best ? new libheif.HeifImage(best.handle) : null;
}

// Frames of an animated HEIC, in play order.
//
// Two container shapes carry more than one playable image, and they are NOT
// the same thing:
//
//   - `moov`/`trak` sequences (libheif's "sequence" API). These carry real
//     timing: each image has a duration in timescale units, so playback speed
//     is known rather than guessed.
//   - several top-level images with no timing at all (bursts, and the paired
//     still + depth/gain-map images iPhone writes). These have no frame rate
//     anywhere in the file, so any playback rate would be invented.
//
// libheif-js's HeifDecoder.decode() returns one HeifImage per top-level image,
// which covers the second case; the first needs the track API. Either way we
// end up with the same shape here: pixels plus a per-frame duration.
//
// Returns [] for a plain single-image file, which is the overwhelmingly common
// case and must stay on the cheap single-decode path.
function collectFrames(images, maxPixels) {
  const frames = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const w = img.get_width();
    const h = img.get_height();
    // A frame we cannot afford to decode is not a frame: playing it would
    // stall the loop on every pass. Better to show the affordable prefix than
    // to promise animation and then hang.
    if (maxPixels && w * h > maxPixels) break;
    let durationMs = 0;
    try {
      // Units are 1/timescale seconds; 1000 is the near-universal default and
      // libheif reports 0 when the file carries no timing at all.
      const raw = libheif.heif_image_get_duration(img.handle);
      if (raw > 0) durationMs = raw;
    } catch {
      durationMs = 0;
    }
    frames.push({ img, width: w, height: h, durationMs });
  }
  return frames;
}

// The parsed container, kept between messages so paging through frames of an
// animated file does not re-parse it every time (measured ~19 ms per parse on
// a 3.4 MB file). Dropped when a different file starts.
let session = null;

// Decode one image handle into transferable RGBA and post it back.
function emitPixels(id, img, extra) {
  const width = img.get_width();
  const height = img.get_height();
  const t1 = performance.now();
  const out = { data: new Uint8Array(width * height * 4), width, height };
  img.display(out, (filled) => {
    if (!filled) {
      self.postMessage({ id, error: "ERR_LIBHEIF 颜色转换失败" });
      return;
    }
    self.postMessage(
      { id, pixels: out.data, width, height, displayMs: performance.now() - t1, ...extra },
      // Transfer the pixel buffer instead of copying 46 MB across threads.
      [out.data.buffer]
    );
  });
}

function handleFrameRequest(msg) {
  const { id, index } = msg;
  if (!session || !session.frames.length) {
    self.postMessage({ id, error: "ERR_LIBHEIF 没有可解码的帧" });
    return;
  }
  const frame = session.frames[index];
  if (!frame) {
    self.postMessage({ id, error: "ERR_LIBHEIF 帧序号越界" });
    return;
  }
  emitPixels(id, frame.img, { index, durationMs: frame.durationMs });
}

self.onmessage = (e) => {
  const msg = e.data;

  // Frame requests reuse the container parsed by the initial decode.
  if (msg.frameRequest) {
    try {
      if (!libheif) libheif = factory();
      handleFrameRequest(msg);
    } catch (err) {
      self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
    }
    return;
  }

  const { id, buffer, maxPixels } = msg;
  try {
    if (!libheif) {
      libheif = factory();
      if (!libheif || typeof libheif.HeifDecoder !== "function") {
        throw new Error("libheif wasm 初始化失败");
      }
    }

    // A new file: release the previous one's handles before parsing this one.
    session = null;

    const t0 = performance.now();
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(new Uint8Array(buffer));
    if (!images || !images.length) {
      throw new Error("ERR_LIBHEIF 格式不支持或文件损坏");
    }

    // More than one top-level image means an animated/burst HEIC. Report the
    // frame count and timing up front, and decode frame 1 immediately so
    // something appears without waiting for the whole animation to load.
    if (images.length > 1) {
      const frames = collectFrames(images, maxPixels);
      if (frames.length > 1) {
        session = { decoder, frames };
        emitPixels(id, frames[0].img, {
          animated: true,
          frameCount: frames.length,
          // A file with no timing anywhere: fall back to a rate that reads as
          // ordinary animation rather than a slideshow.
          defaultFrameMs: frames.every((f) => !f.durationMs) ? 100 : 0,
          index: 0,
          durationMs: frames[0].durationMs,
          decodeMs: performance.now() - t0,
        });
        return;
      }
    }

    // Take only the primary image. (heic2any maps over every image in the
    // container; for the single-image files that matters not, but a
    // multi-image HEIC would pay a full colour conversion per frame just to
    // discard all but the first.)
    let img = images[0];
    const fullW = img.get_width();
    const fullH = img.get_height();
    let downscaled = false;

    // The pixel budget has to be enforced HERE, before display() — not after.
    // display() allocates width*height*4 and runs the whole YUV420 -> RGBA
    // pass first, so checking on the far side means an oversized image has
    // already cost 4.4 s and ~800 MB (measured, 12240x16320 grid) before the
    // refusal ever appears.
    if (maxPixels && fullW * fullH > maxPixels) {
      const alt = findEmbeddedPreview(decoder, fullW, fullH, maxPixels);
      if (!alt) {
        self.postMessage({ id, tooLarge: { width: fullW, height: fullH } });
        return;
      }
      img = alt;
      downscaled = true;
    }

    // libheif writes the converted pixels into the buffer we hand it, via the
    // callback. A plain {data,width,height} object is used rather than an
    // ImageData: ImageData is not structured-cloneable in every webview, and
    // buys us nothing here.
    emitPixels(id, img, {
      fullWidth: fullW,
      fullHeight: fullH,
      downscaled,
      decodeMs: performance.now() - t0,
    });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};