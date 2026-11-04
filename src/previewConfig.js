// Live preview-extension mapping, shared by every consumer.
//
// Module singleton (same convention as viewState.js / bookmarks.js): App.vue,
// FilePreview.vue, FileList.vue and SearchDialog.vue all read this one reactive
// object. That is what makes a save in the settings dialog take effect
// everywhere without prop-drilling through FilePanel.
//
// The config blob is an opaque JSON string as far as the Rust backend is
// concerned; the schema lives in previewExtensions.js (pure, unit-tested).

import { reactive } from "vue";
import { loadConfig, saveConfig } from "./api.js";
import {
  PREVIEW_TYPES,
  defaultMapping,
  findConflicts,
  normalizeExt,
  normalizeMapping,
  parseMapping,
  serializeMapping,
  classifyExt,
} from "./previewExtensions.js";

export const PREVIEW_EXT_CONFIG = "preview-extensions";
export const LEGACY_TEXT_PREVIEW_CONFIG = "text-preview-extensions";

export const previewMapping = reactive(defaultMapping());

// null = not previewable; otherwise one of PREVIEW_TYPES[].key.
export function previewKindOf(ext) {
  return classifyExt(ext, previewMapping);
}

function assignMapping(next) {
  for (const t of PREVIEW_TYPES) previewMapping[t.key] = next[t.key];
}

export async function loadPreviewExtConfig() {
  const [raw, legacy] = await Promise.all([
    loadConfig(PREVIEW_EXT_CONFIG).catch((e) => {
      console.error("Failed to load preview extensions:", e);
      return null;
    }),
    loadConfig(LEGACY_TEXT_PREVIEW_CONFIG).catch(() => null),
  ]);
  assignMapping(parseMapping(raw, legacy));
}

// Returns false (and leaves the live mapping untouched) on a conflicting
// snapshot — the dialog should already have prevented it, but never trust a
// caller with the one invariant this whole feature rests on.
export function applyPreviewMapping(next) {
  const conflicts = findConflicts(next);
  if (conflicts.length) {
    console.error("Refusing preview mapping with conflicting extensions:", conflicts);
    return false;
  }
  assignMapping(normalizeMapping(next));
  return true;
}

export async function savePreviewExtConfig() {
  const conflicts = findConflicts(previewMapping);
  if (conflicts.length) {
    console.error("Refusing to persist conflicting preview extensions:", conflicts);
    return;
  }
  await saveConfig(PREVIEW_EXT_CONFIG, serializeMapping(previewMapping)).catch((e) =>
    console.error("Failed to persist preview extensions:", e)
  );
}

// "按文本预览" on an unsupported file: claim its extension for the text type.
// "" is the sentinel for extension-less files and is a legitimate value here.
export function claimTextPreviewExt(raw) {
  const ext = normalizeExt(raw);
  if (previewMapping.text.includes(ext)) return;
  // The unsupported placeholder is only shown for unclaimed extensions, but
  // remove from any other type anyway so this can never create a second owner.
  for (const t of PREVIEW_TYPES) {
    if (t.key !== "text") {
      previewMapping[t.key] = previewMapping[t.key].filter((e) => e !== ext);
    }
  }
  previewMapping.text = [...previewMapping.text, ext];
}
