<template>
  <div class="vp-panel">
    <!-- Header -->
    <div class="vp-header">
      <span class="vp-icon">🎬</span>
      <span class="vp-title" :title="fileName">{{ fileName }}</span>
      <span class="vp-meta" v-if="!isExternalOnly && !externalFallback">
        <template v-if="resW && resH">{{ resW }}×{{ resH }} · </template>{{ fmtTime(duration) }}<template v-if="fileBytes"> · {{ fmtSize(fileBytes) }}</template>
      </span>
      <button class="vp-btn icon" @click="toggleFullscreen" title="全屏 (F)">⛶</button>
      <button class="vp-btn icon" @click="$emit('close')" title="关闭 (Esc)">✕</button>
    </div>

      <!-- Unsupported-format / load-error fallback -->
      <div class="vp-fallback" v-if="isExternalOnly || externalFallback">
        <div class="vp-fallback-icon">🎞️</div>
        <div class="vp-fallback-msg">{{ isExternalOnly ? "该视频格式 WebView 无法直接解码" : (loadError || "无法播放此视频") }}</div>
        <div class="vp-fallback-hint">可用系统默认播放器打开，或转换为 MP4 / WebM 后预览。</div>
        <button class="vp-btn primary" @click="openExternal">用系统播放器打开</button>
      </div>

      <!-- Player -->
      <div
        class="vp-stage"
        v-else
        @mousemove="showControlsTmp"
        @wheel.prevent="onWheel"
      >
        <video
          ref="videoEl"
          class="vp-video"
          :src="videoSrc"
          preload="metadata"
          playsinline
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="onTimeUpdate"
          @play="onPlay"
          @pause="onPause"
          @ended="onEnded"
          @error="onError"
          @click="togglePlay"
        ></video>

        <!-- Center play button -->
        <div class="vp-center" v-if="!playing" @click="togglePlay">
          <div class="vp-bigplay">▶</div>
        </div>

        <!-- Subtitle overlay -->
        <div class="vp-subtitle" v-if="subtitleText">{{ subtitleText }}</div>

        <!-- Controls -->
        <div class="vp-controls" :class="{ hidden: !showCtrls && playing }" @click.stop>
          <div class="vp-progress">
            <span class="vp-time">{{ fmtTime(videoTime) }}</span>
            <input
              class="vp-seek"
              type="range"
              min="0"
              :max="duration || 0"
              step="0.1"
              :value="videoTime"
              @input="seekTo(+$event.target.value)"
            />
            <span class="vp-time">{{ fmtTime(duration) }}</span>
          </div>

          <div class="vp-buttons">
            <button class="vp-btn" @click="togglePlay" :title="playing ? '暂停 (Space)' : '播放 (Space)'">{{ playing ? "⏸" : "▶" }}</button>
            <button class="vp-btn" @click="skip(-10)" title="快退 10s (←)">⏪</button>
            <button class="vp-btn" @click="skip(10)" title="快进 10s (→)">⏩</button>
            <button class="vp-btn" @click="skip(-30)" title="快退 30s (Shift+←)">«30</button>
            <button class="vp-btn" @click="skip(30)" title="快进 30s (Shift+→)">30»</button>

            <div class="vp-vol">
              <button class="vp-btn" @click="toggleMute" :title="(muted || volume === 0) ? '取消静音 (M)' : '静音 (M)'">{{ (muted || volume === 0) ? "🔇" : "🔊" }}</button>
              <input
                class="vp-vol-range"
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="muted ? 0 : volume"
                @input="setVolume(+$event.target.value)"
              />
            </div>

            <select class="vp-select" :value="rate" @change="setRate(+$event.target.value)" title="播放速度 (快进/慢放)">
              <option :value="0.25">0.25x</option>
              <option :value="0.5">0.5x</option>
              <option :value="0.75">0.75x</option>
              <option :value="1">1x</option>
              <option :value="1.25">1.25x</option>
              <option :value="1.5">1.5x</option>
              <option :value="2">2x</option>
            </select>

            <div class="vp-sub">
              <select
                class="vp-select"
                :value="selectedTrackId === null ? '' : selectedTrackId"
                @change="selectTrack($event.target.value === '' ? null : +$event.target.value)"
                title="字幕轨道"
              >
                <option value="">无字幕</option>
                <option v-for="t in subtitleTracks" :key="t.id" :value="t.id">{{ t.label }}</option>
              </select>
              <button class="vp-btn" @click="adjustOffset(-0.5)" title="字幕延后 0.5s">-0.5s</button>
              <button class="vp-btn" @click="adjustOffset(0.5)" title="字幕提前 0.5s">+0.5s</button>
              <button class="vp-btn" @click="triggerFilePick" title="选择本地字幕文件">📄字幕</button>
              <input ref="fileInput" type="file" accept=".srt,.vtt,.ass,.ssa" style="display:none" @change="onFilePicked" />
            </div>

            <span class="vp-offset" v-if="subtitleOffset !== 0">偏移 {{ subtitleOffset > 0 ? "+" : "" }}{{ subtitleOffset }}s</span>
          </div>
        </div>
      </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { loadConfig, saveConfig } from "../api.js";
import { listDirectory, getParentDir, joinPath, openFile } from "../api.js";

const props = defineProps({
  filePath: { type: String, required: true },
  fileName: { type: String, required: true },
  fileBytes: { type: Number, default: 0 },
});
const emit = defineEmits(["close", "open-video", "navigate-list", "open-next"]);

// ── Persisted player configuration ──
// Speed / volume / mute are remembered across ALL video previews. The config is
// stored in ~/.minitc/video-config.json (user home dir) via backend commands, so
// it is shared regardless of where the binary runs (dev vs bundled) or cwd.
async function loadPlayerConfig() {
  try {
    const raw = await loadConfig("video-config");
    if (typeof raw !== "string" || !raw) return null;
    const c = JSON.parse(raw);
    return {
      rate: typeof c.rate === "number" ? c.rate : 1,
      volume: typeof c.volume === "number" ? Math.max(0, Math.min(1, c.volume)) : 1,
      muted: !!c.muted,
    };
  } catch {
    return null;
  }
}
async function savePlayerConfig() {
  try {
    await saveConfig(
      "video-config",
      JSON.stringify({ rate: rate.value, volume: volume.value, muted: muted.value })
    );
  } catch {
    /* ignore persistence errors */
  }
}

// ── Format classification ──
// Containers the webview (WebView2 / Chromium) can demux & decode natively.
const NATIVE_OK = ["mp4", "webm", "ogv", "ogg", "mov", "m4v", "3gp"];
// Containers Chromium cannot decode in-browser → require external player.
const EXTERNAL_ONLY = ["mkv", "avi", "flv", "wmv", "rm", "rmvb", "asf", "vob", "ts", "m2ts", "m3u8", "mpg", "mpeg", "divx", "f4v"];
const SUB_EXTS = ["srt", "vtt", "ass", "ssa"];

const ext = computed(() => props.fileName.split(".").pop()?.toLowerCase() || "");
const isExternalOnly = computed(() => EXTERNAL_ONLY.includes(ext.value));
const canPlayNative = computed(() => NATIVE_OK.includes(ext.value));

const videoSrc = ref("");
const externalFallback = ref(false);
const loadError = ref("");

const videoEl = ref(null);
const fileInput = ref(null);

const videoTime = ref(0);
const duration = ref(0);
const playing = ref(false);
const volume = ref(1);
const muted = ref(false);
const rate = ref(1);
const resW = ref(0);
const resH = ref(0);
const showCtrls = ref(true);
let ctrlsTimer = null;

// Set when the current clip ended and we're auto-advancing to the next one, so
// that loadVideo() actually starts playback (instead of stopping on a paused
// frame). Cleared once the next clip's metadata has loaded (or on error).
const pendingAutoplay = ref(false);

// ── Up / Down navigation is delegated to the file list (App handles it) ──

// ── Subtitles ──
const subtitleTracks = ref([]); // { id, label, cues: [{start, end, text}] }
const selectedTrackId = ref(null);
const subtitleOffset = ref(0);
let trackCounter = 0;

const selectedTrack = computed(() => subtitleTracks.value.find((t) => t.id === selectedTrackId.value) || null);
const subtitleText = computed(() => {
  const tr = selectedTrack.value;
  if (!tr) return "";
  const t = videoTime.value + subtitleOffset.value;
  const cue = tr.cues.find((c) => t >= c.start && t <= c.end);
  return cue ? cue.text : "";
});

function getExt(name) {
  const p = name.split(".");
  return p.length > 1 ? p.pop().toLowerCase() : "";
}

// ── Formatting helpers ──
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtSize(bytes) {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

// ── Playback controls ──
function togglePlay() {
  const v = videoEl.value;
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}
function onPlay() { playing.value = true; }
function onPause() { playing.value = false; }
function seekTo(val) {
  const v = videoEl.value;
  if (!v) return;
  const max = duration.value || v.duration || 0;
  v.currentTime = Math.max(0, Math.min(val, max));
}
function skip(delta) {
  const v = videoEl.value;
  if (!v) return;
  seekTo((v.currentTime || 0) + delta);
}
function setRate(r) {
  rate.value = r;
  if (videoEl.value) videoEl.value.playbackRate = r;
}
function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  volume.value = v;
  if (videoEl.value) {
    videoEl.value.volume = v;
    videoEl.value.muted = v === 0;
  }
  muted.value = v === 0;
}
function toggleMute() {
  muted.value = !muted.value;
  if (videoEl.value) videoEl.value.muted = muted.value;
}
function onLoadedMetadata() {
  const v = videoEl.value;
  if (!v) return;
  duration.value = v.duration || 0;
  resW.value = v.videoWidth;
  resH.value = v.videoHeight;
  v.volume = volume.value;
  v.muted = muted.value;
  v.playbackRate = rate.value;
  // Autoplay the next clip if we're advancing from a finished one. The new
  // source has just loaded, so playback is safe to start now.
  if (pendingAutoplay.value) {
    pendingAutoplay.value = false;
    v.play().catch(() => {});
  }
}

// Persist player config (speed / volume / mute) whenever any of them changes.
watch([volume, muted, rate], savePlayerConfig);
function onTimeUpdate() { if (videoEl.value) videoTime.value = videoEl.value.currentTime; }
// All video containers the player can hand off to (native webview OR external
// player). Used to find "the next video" in the same directory on autoplay.
const VIDEO_OK = [...NATIVE_OK, ...EXTERNAL_ONLY];

// Autoplay the next video in the SAME directory (by current sort order) when
// the current one ends. Emits `open-next` with the next video's path/name/bytes
// so the parent can keep playing in the same preview panel; if there is no next
// video, playback simply stops (no loop).
async function onEnded() {
  playing.value = false;
  // Only native-or-external-capable videos participate; skip if the current
  // file isn't actually in the playable set (defensive — onEnded only fires for
  // a real <video> element).
  if (!VIDEO_OK.includes(ext.value)) return;
  try {
    const dir = await getParentDir(props.filePath);
    if (!dir) return;
    const list = (await listDirectory(dir)).entries;
    // Mirror FileList's ordering: directories always first, then name asc.
    const sorted = [...list].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    const videos = sorted.filter(
      (e) => !e.is_dir && VIDEO_OK.includes((e.name.split(".").pop() || "").toLowerCase())
    );
    const idx = videos.findIndex((e) => e.name === props.fileName);
    if (idx < 0 || idx >= videos.length - 1) return; // last video → stop
    const next = videos[idx + 1];
    const nextPath = await joinPath(dir, next.name);
    // Flag the upcoming reload to auto-start playback once the new source is ready.
    pendingAutoplay.value = true;
    emit("open-next", {
      path: nextPath,
      name: next.name,
      bytes: next.size || 0,
    });
  } catch (err) {
    console.error("autoplay next video failed:", err);
  }
}
function onError() {
  // Native-capable container but actual codec/stream failed to decode.
  pendingAutoplay.value = false;
  externalFallback.value = true;
  if (canPlayNative.value) loadError.value = "当前编码格式 WebView 无法直接解码，请用系统播放器打开。";
}
function onWheel(e) {
  const step = e.deltaY < 0 ? 0.05 : -0.05;
  setVolume(volume.value + step);
}

// ── Subtitle parsers ──
function toSec(t, isAss) {
  if (isAss) {
    const m = t.match(/(\d+):(\d+):(\d+)\.(\d+)/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
  }
  const m = t.match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}
function splitBlocks(text) {
  return text.replace(/\r+/g, "").replace(/^﻿/, "").trim().split(/\n\s*\n/);
}
function findTiming(lines) {
  for (let i = 0; i < lines.length; i++) if (/-->/.test(lines[i])) return i;
  return -1;
}
function parseSRT(text) {
  const cues = [];
  for (const b of splitBlocks(text)) {
    const lines = b.split("\n");
    const ti = findTiming(lines);
    if (ti < 0) continue;
    const parts = lines[ti].split("-->");
    if (parts.length < 2) continue;
    const start = toSec(parts[0].trim(), false);
    const end = toSec(parts[1].trim().split(/\s+/)[0], false);
    const txt = lines.slice(ti + 1).join("\n").trim();
    if (txt) cues.push({ start, end, text: txt });
  }
  return cues;
}
function parseVTT(text) {
  const cues = [];
  const cleaned = text.replace(/\r+/g, "").replace(/^﻿/, "");
  const body = cleaned.replace(/^WEBVTT.*?(\n\n|$)/s, "");
  for (const b of splitBlocks(body)) {
    const lines = b.split("\n");
    const ti = findTiming(lines);
    if (ti < 0) continue;
    const parts = lines[ti].split("-->");
    if (parts.length < 2) continue;
    const start = toSec(parts[0].trim(), false);
    const end = toSec(parts[1].trim().split(/\s+/)[0], false);
    const txt = lines.slice(ti + 1).join("\n").trim();
    if (txt) cues.push({ start, end, text: txt });
  }
  return cues;
}
function parseASS(text) {
  const cues = [];
  const lines = text.replace(/\r+/g, "").replace(/^﻿/, "").split("\n");
  let inEvents = false;
  let fmt = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inEvents = /^\[Events\]/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      fmt = line.slice(7).split(",").map((s) => s.trim());
      continue;
    }
    if (/^Dialogue:/i.test(line) && fmt) {
      const parts = line.slice(9).split(",");
      const si = fmt.indexOf("Start");
      const ei = fmt.indexOf("End");
      const ti = fmt.indexOf("Text");
      if (si < 0 || ei < 0 || ti < 0) continue;
      const start = toSec(parts[si].trim(), true);
      const end = toSec(parts[ei].trim(), true);
      let txt = parts.slice(ti).join(",").trim();
      txt = txt.replace(/\{[^}]*\}/g, ""); // strip style overrides
      if (txt) cues.push({ start, end, text: txt });
    }
  }
  return cues;
}
function parseSubtitle(text, e) {
  if (e === "srt") return parseSRT(text);
  if (e === "vtt") return parseVTT(text);
  if (e === "ass" || e === "ssa") return parseASS(text);
  return parseSRT(text);
}

async function addTrack(label, text, e, autoSelect) {
  const cues = parseSubtitle(text, e);
  if (!cues.length) return false;
  const id = ++trackCounter;
  subtitleTracks.value.push({ id, label, cues });
  if (autoSelect || selectedTrackId.value === null) selectedTrackId.value = id;
  return true;
}
async function loadSubtitleByPath(path, label, e, autoSelect) {
  try {
    const url = convertFileSrc(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    return await addTrack(label, text, e, autoSelect);
  } catch (err) {
    console.error("load subtitle failed:", err);
    return false;
  }
}
async function detectSubtitles() {
  try {
    const dir = await getParentDir(props.filePath);
    if (!dir) return;
    const list = (await listDirectory(dir)).entries;
    const base = props.fileName.replace(/\.[^.]+$/, "");
    const found = list.filter((e) => !e.is_dir && SUB_EXTS.includes(getExt(e.name)));
    const enriched = await Promise.all(
      found.map(async (e) => {
        const p = await joinPath(dir, e.name);
        const s = e.name.replace(/\.[^.]+$/, "");
        const matched = s === base || s.startsWith(base + ".");
        return { name: e.name, path: p, ext: getExt(e.name), matched };
      })
    );
    enriched.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0) || a.name.localeCompare(b.name));
    for (const c of enriched) await loadSubtitleByPath(c.path, c.name, c.ext, c.matched);
  } catch (err) {
    console.error(err);
  }
}
function triggerFilePick() { fileInput.value?.click(); }
function onFilePicked(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    addTrack(f.name, text, getExt(f.name), true);
  };
  reader.readAsText(f, "utf-8");
  e.target.value = "";
}
function selectTrack(id) { selectedTrackId.value = id; }
function adjustOffset(d) { subtitleOffset.value = +(subtitleOffset.value + d).toFixed(2); }

// ── Keyboard ──
function onKey(e) {
  const tag = (e.target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    if (e.key === "Escape") emit("close");
    return;
  }
  switch (e.key) {
    case " ":
    case "k":
      e.preventDefault(); togglePlay(); break;
    case "ArrowLeft":
      e.preventDefault(); skip(e.shiftKey ? -30 : -5); break;
    case "ArrowRight":
      e.preventDefault(); skip(e.shiftKey ? 30 : 5); break;
    case "ArrowUp":
      e.preventDefault(); e.stopPropagation(); emit("navigate-list", -1); break;
    case "ArrowDown":
      e.preventDefault(); e.stopPropagation(); emit("navigate-list", 1); break;
    case "f":
    case "F":
      e.preventDefault(); toggleFullscreen(); break;
    case "c":
    case "C":
      e.preventDefault(); selectTrack(subtitleText.value ? null : (subtitleTracks.value[0]?.id ?? null)); break;
    case "m":
    case "M":
      e.preventDefault(); toggleMute(); break;
    case "Escape":
      e.preventDefault(); emit("close"); break;
  }
}
function toggleFullscreen() {
  const v = videoEl.value;
  if (!v) return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    v.requestFullscreen?.();
  }
}
function openExternal() { openFile(props.filePath).catch((e) => { loadError.value = String(e); }); }
function showControlsTmp() {
  showCtrls.value = true;
  clearTimeout(ctrlsTimer);
  ctrlsTimer = setTimeout(() => { if (playing.value) showCtrls.value = false; }, 3000);
}

// Reload the video source (also re-detects subtitles). Up / Down navigation is
// handled by the parent via the file list, not here.
async function loadVideo() {
  videoSrc.value = "";
  externalFallback.value = false;
  loadError.value = "";
  subtitleTracks.value = [];
  selectedTrackId.value = null;
  subtitleOffset.value = 0;
  videoTime.value = 0;
  duration.value = 0;
  playing.value = false;
  if (!isExternalOnly.value) {
    videoSrc.value = convertFileSrc(props.filePath);
    await detectSubtitles();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  if (props.filePath) {
    // Load persisted config BEFORE loading the video, so that onLoadedMetadata
    // applies the saved speed/volume/mute to the first frames.
    const cfg = await loadPlayerConfig();
    if (cfg) {
      rate.value = cfg.rate;
      volume.value = cfg.volume;
      muted.value = cfg.muted;
    }
    await loadVideo();
  }
});

// Reload when the preview target changes (e.g. switching active panel or selection)
watch(
  () => props.filePath,
  () => {
    if (props.filePath) {
      loadVideo();
    }
  }
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  if (videoEl.value) videoEl.value.pause();
  clearTimeout(ctrlsTimer);
});
</script>

<style scoped>
.vp-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--panel-bg);
  border: 1px solid var(--accent);
  overflow: hidden;
}

/* Header */
.vp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  user-select: none;
}

.vp-icon { font-size: 15px; }
.vp-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-weight: 600;
}
.vp-meta {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}

/* Buttons */
.vp-btn {
  border: 1px solid var(--border);
  background: var(--panel-bg);
  color: var(--text);
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.15s;
}
.vp-btn:hover { background: var(--hover); }
.vp-btn.icon { padding: 3px 7px; font-size: 14px; }
.vp-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  padding: 7px 18px;
  font-size: 13px;
}
.vp-btn.primary:hover { opacity: 0.9; }

/* Stage */
.vp-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.vp-video {
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.vp-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.vp-bigplay {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  border: 2px solid rgba(255, 255, 255, 0.8);
  color: #fff;
  font-size: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 4px;
}

.vp-subtitle {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 72px;
  text-align: center;
  padding: 0 8%;
  pointer-events: none;
  color: #fff;
  font-size: 18px;
  line-height: 1.45;
  white-space: pre-wrap;
  text-shadow: 0 1px 3px #000, 0 0 4px #000;
}

/* Controls */
.vp-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 6px 10px 10px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.82));
  transition: opacity 0.2s;
}
.vp-controls.hidden { opacity: 0; pointer-events: none; }

.vp-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vp-time {
  color: #fff;
  font-size: 11px;
  min-width: 42px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.vp-seek {
  flex: 1;
  accent-color: var(--accent);
  cursor: pointer;
}

.vp-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.vp-vol {
  display: flex;
  align-items: center;
  gap: 4px;
}
.vp-vol-range {
  width: 84px;
  accent-color: var(--accent);
}

.vp-select {
  background: var(--panel-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 4px;
  font-size: 12px;
  max-width: 160px;
}

.vp-sub {
  display: flex;
  align-items: center;
  gap: 4px;
}

.vp-offset {
  font-size: 11px;
  color: #fff;
  margin-left: auto;
}

/* Fallback */
.vp-fallback {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px;
  text-align: center;
}
.vp-fallback-icon { font-size: 48px; }
.vp-fallback-msg { color: var(--text); font-size: 14px; }
.vp-fallback-hint { color: var(--text-dim); font-size: 12px; }
</style>
