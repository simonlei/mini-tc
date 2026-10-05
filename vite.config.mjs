import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  optimizeDeps: {
    // FilePreview.vue dynamically imports mammoth (500 kB) so it stays out of
    // the startup bundle. Pre-bundling it here keeps dev honest: without this,
    // Vite only discovers it when the first .docx is previewed and forces a
    // "new dependencies optimized, reloading" full page reload mid-session.
    //
    // libheif-js is the same story with more at stake: its wasm build is 2 MB
    // and lives in heicDecode.worker.js. The worker is reached through Vite's
    // `?worker` suffix, but the import inside it still needs pre-bundling or
    // the first HEIC preview costs a full page reload.
    //
    // Note the explicit file: the package's `main` points at the **asm.js**
    // build (2.5x slower). See heicDecoder.js.
    include: [
      "mammoth/mammoth.browser.js",
      "libheif-js/libheif-wasm/libheif-bundle.mjs",
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
