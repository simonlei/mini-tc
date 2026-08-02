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
      <img :src="previewContent" class="preview-image" @load="onImageLoad" @error="onImageError" />
    </div>

    <!-- Text / JSON preview -->
    <div class="preview-body text-body" v-else-if="previewType === 'text' || previewType === 'json' || previewType === 'log'">
      <div class="json-warn" v-if="jsonWarn">{{ jsonWarn }}</div>
      <pre class="preview-text"><code>{{ previewContent }}</code></pre>
    </div>

    <!-- Footer -->
    <div class="preview-footer" v-if="!loading && !error">
      <span>{{ fileSize }}</span>
      <span v-if="(previewType === 'text' || previewType === 'log') && lineCount !== null">{{ lineCount }} lines</span>
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
import { ref, watch, computed } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFilePreview } from "../api.js";

const props = defineProps({
  filePath: { type: String, required: true },
  fileName: { type: String, required: true },
  fileBytes: { type: Number, default: 0 },
});

defineEmits(["close"]);

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"];

const loading = ref(false);
const error = ref("");
const previewType = ref("");
const previewContent = ref("");
const fileSize = ref("");
const lineCount = ref(null);
const imageInfo = ref("");
const jsonWarn = ref("");
const copyAllDone = ref(false);

const headerIcon = computed(() => {
  if (previewType.value === "image") return "🖼️";
  if (previewType.value === "json") return "🔧";
  if (previewType.value === "log") return "📜";
  if (previewType.value === "text") return "📄";
  return "👁️";
});

const typeLabel = computed(() => {
  if (previewType.value === "image") return "IMAGE";
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
}

function onImageError() {
  error.value = "无法加载图片，文件可能已损坏";
  previewType.value = "";
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

async function loadPreview() {
  loading.value = true;
  error.value = "";
  previewType.value = "";
  previewContent.value = "";
  lineCount.value = null;
  imageInfo.value = "";
  jsonWarn.value = "";

  const ext = getExtension(props.fileName);

  // Image: use convertFileSrc to load directly via asset protocol (bypasses IPC entirely)
  if (IMAGE_EXTENSIONS.includes(ext)) {
    previewType.value = "image";
    previewContent.value = convertFileSrc(props.filePath);
    fileSize.value = props.fileBytes ? formatSize(props.fileBytes) : "";
    loading.value = false;
    return;
  }

  // Text (incl. JSON): use IPC to read content
  try {
    const result = await readFilePreview(props.filePath);
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

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  margin: auto;
  border-radius: 2px;
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
