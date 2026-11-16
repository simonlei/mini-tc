<template>
  <!--
    File properties (Ctrl+Enter / Alt+Enter, or the context menu's 「属性…」).

    Blocks, in the order Total Commander shows them:
      基本信息 — name / type / size / timestamps / attribute flags
      图像信息 — format, pixel dimensions, colour info (only for images)
      视频信息 — container, duration, resolution, codecs, bitrate (only for videos)
      GPS     — coordinates, altitude, bearing (only when the file carries them)
      EXIF    — every tag the backend could decode, verbatim
      视频标签 — container-level tags (title / encoder / device …)

    The backend never fails on "can't parse EXIF" — a missing block just means
    the file doesn't carry that information. Only a failed stat is an error.
  -->
  <div class="props-overlay" @click.self="requestClose">
    <div class="props-dialog">
      <div class="props-header">
        <span>文件属性</span>
        <span class="header-hint">{{ headerHint }}</span>
        <button class="close-btn" @click="requestClose" title="关闭">✕</button>
      </div>

      <div ref="bodyRef" class="props-body" :class="{ refreshing }">
        <div v-if="loading && !info" class="state-box">正在读取…</div>

        <div v-else-if="error && !info" class="state-box error">{{ error }}</div>

        <template v-else-if="info">
          <!-- ── 基本信息 ── -->
          <section class="block">
            <div class="block-title">基本信息</div>
            <div class="kv">
              <span class="k">名称</span>
              <span class="v strong">{{ info.name }}</span>
            </div>
            <div class="kv">
              <span class="k">类型</span>
              <span class="v">{{ typeLabel }}</span>
            </div>
            <div class="kv">
              <span class="k">大小</span>
              <span class="v">{{ sizeText }}</span>
            </div>
            <div class="kv">
              <span class="k">创建时间</span>
              <span class="v">{{ formatDate(info.created) }}</span>
            </div>
            <div class="kv">
              <span class="k">修改时间</span>
              <span class="v">{{ formatDate(info.modified) }}</span>
            </div>
            <div class="kv">
              <span class="k">访问时间</span>
              <span class="v">{{ formatDate(info.accessed) }}</span>
            </div>
            <div class="kv">
              <span class="k">属性</span>
              <span class="v">
                <template v-if="attrFlags.length">
                  <span v-for="f in attrFlags" :key="f" class="flag">{{ f }}</span>
                </template>
                <template v-else>无</template>
              </span>
            </div>
            <div class="kv">
              <span class="k">路径</span>
              <span class="v path" :title="info.path">{{ info.path }}</span>
            </div>
          </section>

          <!-- ── 图像信息 ── -->
          <section v-if="image" class="block">
            <div class="block-title">图像信息</div>
            <div class="kv">
              <span class="k">格式</span>
              <span class="v">{{ image.format || "未知" }}</span>
            </div>
            <div class="kv">
              <span class="k">尺寸</span>
              <span class="v">{{ dimensionText }}</span>
            </div>
            <div class="kv">
              <span class="k">像素总数</span>
              <span class="v">{{ pixelCountText }}</span>
            </div>
            <div v-if="image.bit_depth" class="kv">
              <span class="k">位深</span>
              <span class="v">{{ image.bit_depth }} bit{{ image.color_type ? ` · ${image.color_type}` : "" }}</span>
            </div>
            <div v-else-if="image.color_type" class="kv">
              <span class="k">色彩类型</span>
              <span class="v">{{ image.color_type }}</span>
            </div>
            <div v-if="image.has_alpha" class="kv">
              <span class="k">透明通道</span>
              <span class="v">有</span>
            </div>
            <div v-if="image.orientation" class="kv">
              <span class="k">方向</span>
              <span class="v">{{ image.orientation }}</span>
            </div>
          </section>

          <!-- ── 视频信息 ── -->
          <section v-if="video" class="block">
            <div class="block-title">视频信息</div>
            <div class="kv">
              <span class="k">格式</span>
              <span class="v">{{ video.format || "未知" }}</span>
            </div>
            <div class="kv">
              <span class="k">时长</span>
              <span class="v">{{ videoDurationText }}</span>
            </div>
            <div class="kv">
              <span class="k">分辨率</span>
              <span class="v">{{ videoDimensionText }}</span>
            </div>
            <div v-if="hasNumber(video.fps)" class="kv">
              <span class="k">帧率</span>
              <span class="v">{{ videoFpsText }}</span>
            </div>
            <div v-if="video.video_codec" class="kv">
              <span class="k">视频编码</span>
              <span class="v">{{ video.video_codec }}</span>
            </div>
            <div v-if="video.audio_codec" class="kv">
              <span class="k">音频编码</span>
              <span class="v">{{ video.audio_codec }}</span>
            </div>
            <div v-if="hasNumber(video.audio_channels)" class="kv">
              <span class="k">音频声道</span>
              <span class="v">{{ videoChannelsText }}</span>
            </div>
            <div v-if="hasNumber(video.audio_sample_rate)" class="kv">
              <span class="k">采样率</span>
              <span class="v">{{ videoSampleRateText }}</span>
            </div>
            <div v-if="hasNumber(video.bitrate)" class="kv">
              <span class="k">码率</span>
              <span class="v">{{ videoBitrateText }}</span>
            </div>
            <div v-if="video.created" class="kv">
              <span class="k">拍摄时间</span>
              <span class="v">{{ video.created }}</span>
            </div>
          </section>

          <!-- ── GPS ── -->
          <section v-if="gps" class="block">
            <div class="block-title">GPS</div>
            <div class="kv">
              <span class="k">纬度</span>
              <span class="v">{{ formatCoord(gps.latitude, "N", "S") }}</span>
            </div>
            <div class="kv">
              <span class="k">经度</span>
              <span class="v">{{ formatCoord(gps.longitude, "E", "W") }}</span>
            </div>
            <div v-if="gps.altitude !== null && gps.altitude !== undefined" class="kv">
              <span class="k">海拔</span>
              <span class="v">{{ gps.altitude.toFixed(1) }} m</span>
            </div>
            <div v-if="gps.direction !== null && gps.direction !== undefined" class="kv">
              <span class="k">方向</span>
              <span class="v">{{ gps.direction.toFixed(1) }}°</span>
            </div>
            <div v-if="gps.date || gps.timestamp" class="kv">
              <span class="k">拍摄时间</span>
              <span class="v">{{ [gps.date, gps.timestamp].filter(Boolean).join(" ") }}</span>
            </div>
          </section>

          <!-- ── EXIF ── -->
          <section v-if="image && image.exif && image.exif.length" class="block">
            <div class="block-title">EXIF（{{ image.exif.length }} 项）</div>
            <div class="exif-grid">
              <div v-for="(f, i) in image.exif" :key="i" class="exif-row">
                <span class="ek">{{ f.label }}</span>
                <span class="ev">{{ f.value }}</span>
              </div>
            </div>
          </section>

          <!-- ── 视频标签 ── -->
          <!-- 容器自带的标签（标题 / 编码器 / 拍摄设备 …）。手机录的 MOV
               会在这里显示设备型号、拍摄软件等。 -->
          <section v-if="video && video.tags && video.tags.length" class="block">
            <div class="block-title">视频标签（{{ video.tags.length }} 项）</div>
            <div class="exif-grid">
              <div v-for="(f, i) in video.tags" :key="i" class="exif-row">
                <span class="ek">{{ f.label }}</span>
                <span class="ev">{{ f.value }}</span>
              </div>
            </div>
          </section>

          <!-- 相机 / 手机录影时，容器里还会塞一份完整 EXIF（拍摄参数）。 -->
          <section v-if="video && video.exif && video.exif.length" class="block">
            <div class="block-title">视频 EXIF（{{ video.exif.length }} 项）</div>
            <div class="exif-grid">
              <div v-for="(f, i) in video.exif" :key="i" class="exif-row">
                <span class="ek">{{ f.label }}</span>
                <span class="ev">{{ f.value }}</span>
              </div>
            </div>
          </section>

          <!-- Not an image or a video (or the metadata couldn't be read): say
               so plainly instead of leaving the user wondering whether the
               file is broken. -->
          <section v-if="!image && !video" class="block">
            <div class="block-title">图像 / 视频信息</div>
            <div class="state-box inline">
              {{ info.is_dir ? "文件夹没有图像或视频元数据" : "这不是图像或视频文件（或不含可读元数据）" }}
            </div>
          </section>
        </template>
      </div>

      <div class="props-footer">
        <span class="footer-hint">↑ / ↓ 切换文件 · Esc 关闭</span>
        <button class="btn-secondary" @click="requestClose">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { getFileProperties } from "../api.js";
import { formatBytes, formatDuration, formatBitrate } from "../format.js";

const props = defineProps({
  // Absolute path of the file being inspected.
  path: { type: String, required: true },
  // Move the file-list selection while the window is open. The window is
  // modal, so it owns the arrow keys whenever the keyboard is not on a list.
  onNavigate: { type: Function, default: null },
});

const emit = defineEmits(["close"]);

const info = ref(null);
const loading = ref(true);
// A re-read (the selection moved) keeps the old content on screen and dims
// it slightly — swapping the whole body for a spinner on every arrow press
// would flicker far worse than a two-millisecond stat.
const refreshing = ref(false);
const error = ref("");
const bodyRef = ref(null);

// Every read carries a token and only the newest one may write its result:
// the user can keep arrowing through the list while a read is in flight, and
// a slow earlier read must not land after a newer one.
let loadToken = 0;

async function load() {
  const token = ++loadToken;
  loading.value = true;
  refreshing.value = !!info.value;
  error.value = "";
  // A different file starts at the top of its metadata list.
  if (bodyRef.value) bodyRef.value.scrollTop = 0;
  try {
    const data = await getFileProperties(props.path);
    if (token !== loadToken) return;
    info.value = data;
  } catch (e) {
    if (token !== loadToken) return;
    info.value = null;
    error.value = String(e || "读取文件属性失败");
  } finally {
    if (token === loadToken) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

// The inspected file changed (the user moved the selection with ↑/↓) — read
// the new one. `path` is the single source of truth for "which file".
watch(() => props.path, load);

const image = computed(() => info.value?.image || null);
const video = computed(() => info.value?.video || null);
// GPS can come from either side: a photo's EXIF, or a phone recording's
// container (ISO 6709 position / XMP). Image wins when a file somehow has
// both — a photo's own GPS is the more specific one.
const gps = computed(() => info.value?.image?.gps || info.value?.video?.gps || null);

// The path changes the moment the selection does, so the header follows the
// NEW file right away — the metadata behind it arrives a tick later.
const headerHint = computed(() => props.path.split(/[\\/]/).pop() || info.value?.name || "");

const typeLabel = computed(() => (info.value?.is_dir ? "文件夹" : "文件"));

const sizeText = computed(() => {
  if (!info.value) return "";
  if (info.value.is_dir) return "—";
  // `formatBytes` is the ONE byte formatter in the UI — reuse it rather than
  // adding a second copy that can drift.
  const text = formatBytes(info.value.size);
  // Show the exact byte count alongside the human-readable size: the rounded
  // form ("1.5 MB") loses information that matters when checking a file.
  return `${text}（${info.value.size.toLocaleString()} 字节）`;
});

const attrFlags = computed(() => {
  if (!info.value) return [];
  const out = [];
  if (info.value.readonly) out.push("只读");
  if (info.value.hidden) out.push("隐藏");
  if (info.value.system) out.push("系统");
  if (info.value.archive) out.push("归档");
  return out;
});

const dimensionText = computed(() => {
  const w = image.value?.width;
  const h = image.value?.height;
  if (!w || !h) return "未知";
  return `${w} × ${h} 像素`;
});

const pixelCountText = computed(() => {
  const w = image.value?.width;
  const h = image.value?.height;
  if (!w || !h) return "—";
  return `${(w * h).toLocaleString()} 像素`;
});

// ── 视频 ──

// The backend hands back `Option`s; a missing one means the container didn't
// record it, which is different from a recorded zero. `hasNumber` tells the
// two apart so a genuine 0 fps isn't hidden.
function hasNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

const videoDurationText = computed(() => {
  const d = video.value?.duration;
  if (!hasNumber(d)) return "—";
  return formatDuration(d);
});

const videoDimensionText = computed(() => {
  const w = video.value?.width;
  const h = video.value?.height;
  if (!hasNumber(w) || !hasNumber(h)) return "未知";
  return `${w} × ${h} 像素`;
});

const videoFpsText = computed(() => {
  const f = video.value?.fps;
  if (!hasNumber(f)) return "—";
  // 29.97 has to stay 29.97 — rounding it to 30 would misreport the file.
  return `${Number(f.toFixed(3))} fps`;
});

const videoChannelsText = computed(() => {
  const c = video.value?.audio_channels;
  if (!hasNumber(c)) return "—";
  if (c === 1) return "单声道";
  if (c === 2) return "立体声（2 声道）";
  return `${c} 声道`;
});

const videoSampleRateText = computed(() => {
  const r = video.value?.audio_sample_rate;
  if (!hasNumber(r)) return "—";
  return `${r.toLocaleString()} Hz`;
});

const videoBitrateText = computed(() => {
  const b = video.value?.bitrate;
  if (!hasNumber(b)) return "—";
  return formatBitrate(b);
});

function formatDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Decimal degrees plus the hemisphere letter. The backend hands back signed
// decimals (south / west already negated), so the sign picks the letter.
function formatCoord(value, positive, negative) {
  if (value === null || value === undefined) return "—";
  const letter = value < 0 ? negative : positive;
  return `${Math.abs(value).toFixed(6)}° ${letter}`;
}

function requestClose() {
  emit("close");
}

// Esc closes from anywhere inside. Capture phase so it also wins over App.vue's
// "Esc closes the preview" handler while this dialog is on top.
function onEscCapture(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  requestClose();
}

// ↑/↓ switch the inspected file. The file list owns those keys whenever the
// keyboard is on a list — it handles them on the element, before this
// capture-phase handler would ever see them — so this handler only steps in
// when the focus is elsewhere, e.g. after the user clicked inside this
// window, which takes the focus off the list underneath.
function onArrowCapture(e) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const t = e.target;
  // Text inputs keep their own arrow keys (address bar, rename box, filter).
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  // A file list under the overlay moves its own selection.
  if (t && t.closest && t.closest(".file-list")) return;
  if (!props.onNavigate) return;
  e.preventDefault();
  e.stopPropagation();
  props.onNavigate(e.key === "ArrowDown" ? 1 : -1);
}

onMounted(() => {
  document.addEventListener("keydown", onEscCapture, true);
  document.addEventListener("keydown", onArrowCapture, true);
  load();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onEscCapture, true);
  document.removeEventListener("keydown", onArrowCapture, true);
});
</script>

<style scoped>
.props-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.props-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 640px;
  max-width: 94vw;
  height: 620px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.props-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.header-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-btn {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
}

.close-btn:hover {
  background: var(--danger);
  color: #fff;
}

.props-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Re-reading the next file: keep the old content visible but dimmed, so the
   window doesn't flash an empty body on every arrow press. */
.props-body.refreshing {
  opacity: 0.55;
}

.state-box {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}

.state-box.error {
  color: var(--danger);
}

.state-box.inline {
  padding: 8px 0;
  text-align: left;
}

.block {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px 10px;
}

.block-title {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 6px;
  letter-spacing: 0.4px;
}

.kv {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
  padding: 2px 0;
}

.k {
  flex: none;
  width: 72px;
  color: var(--text-dim);
}

.v {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.v.strong {
  font-weight: 600;
}

.v.path {
  font-family: Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
}

.flag {
  display: inline-block;
  padding: 1px 6px;
  margin-right: 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-dim);
}

.exif-grid {
  display: flex;
  flex-direction: column;
}

.exif-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  color: var(--text);
  border-bottom: 1px solid var(--border);
}

.exif-row:last-child {
  border-bottom: none;
}

.ek {
  flex: none;
  width: 180px;
  color: var(--text-dim);
}

.ev {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  font-family: Consolas, monospace;
  font-size: 11px;
}

.props-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.footer-hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-dim);
}

.btn-secondary {
  flex: none;
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--hover);
}
</style>
