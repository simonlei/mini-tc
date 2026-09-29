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
    include: ["mammoth/mammoth.browser.js"],
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
