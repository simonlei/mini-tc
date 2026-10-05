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

self.onmessage = (e) => {
  const { id, buffer } = e.data;
  try {
    if (!libheif) {
      libheif = factory();
      if (!libheif || typeof libheif.HeifDecoder !== "function") {
        throw new Error("libheif wasm 初始化失败");
      }
    }

    const t0 = performance.now();
    const images = new libheif.HeifDecoder().decode(new Uint8Array(buffer));
    if (!images || !images.length) {
      throw new Error("ERR_LIBHEIF 格式不支持或文件损坏");
    }

    // Take only the primary image. (heic2any maps over every image in the
    // container; for the single-image files that matters not, but a
    // multi-image HEIC would pay a full colour conversion per frame just to
    // discard all but the first.)
    const img = images[0];
    const width = img.get_width();
    const height = img.get_height();
    const decodeMs = performance.now() - t0;

    // libheif writes the converted pixels into the buffer we hand it, via the
    // callback. A plain {data,width,height} object is used rather than an
    // ImageData: ImageData is not structured-cloneable in every webview, and
    // buys us nothing here.
    const t1 = performance.now();
    const out = { data: new Uint8Array(width * height * 4), width, height };
    img.display(out, (filled) => {
      if (!filled) {
        self.postMessage({ id, error: "ERR_LIBHEIF 颜色转换失败" });
        return;
      }
      self.postMessage(
        {
          id,
          pixels: out.data,
          width,
          height,
          decodeMs,
          displayMs: performance.now() - t1,
        },
        // Transfer the pixel buffer instead of copying 46 MB across threads.
        [out.data.buffer]
      );
    });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
