// Single source of truth for "which extension is previewed how".
//
// Before this module the suffix lists lived in five places (App.vue,
// FilePreview.vue, FileList.vue, SearchDialog.vue, and the Rust backend), and
// only the text list was user-editable. Adding one suffix meant editing four
// files. Now every consumer reads the same mapping.
//
// Hard invariant: one extension belongs to AT MOST ONE preview type. It is
// enforced at four independent points so a stale/hand-edited config file can
// never make two renderers fight over the same file:
//   1. addExtToType() refuses a cross-type collision (UI feedback).
//   2. applyPreviewMapping() refuses to apply a conflicting snapshot.
//   3. savePreviewExtConfig() refuses to persist a conflicting mapping.
//   4. normalizeMapping()/classifyExt() resolve deterministically on load.
//
// Pure module: no Vue / Tauri imports, so the test suites can load it in plain
// node. See scripts/preview-extensions-check.mjs.

export const PREVIEW_TYPES = [
  {
    key: "text",
    label: "文本",
    hint: "按纯文本读取，可划选、复制",
    defaults: ["txt", "md", "json", "log"],
  },
  {
    key: "image",
    label: "图片",
    hint: "直接显示图片；HEIC 系列走 wasm 转码",
    defaults: [
      "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "svg", "avif",
      "heic", "heif", "hif", "avci",
    ],
  },
  {
    key: "video",
    label: "视频",
    hint: "在预览栏用内嵌播放器播放",
    defaults: [
      "mp4", "webm", "ogv", "ogg", "mov", "m4v", "3gp", "mkv", "avi",
      "flv", "wmv", "rm", "rmvb", "asf", "vob", "ts", "m2ts", "m3u8",
      "mpg", "mpeg", "divx", "f4v",
    ],
  },
  {
    key: "pdf",
    label: "PDF",
    hint: "用系统 WebView 内置 PDF 查看器打开",
    defaults: ["pdf"],
  },
  {
    key: "doc",
    label: "Word 文档",
    hint: ".docx 转 HTML 预览，旧版 .doc 给出转换提示",
    defaults: ["doc", "docx"],
  },
];

export const PREVIEW_TYPE_KEYS = PREVIEW_TYPES.map((t) => t.key);

// Rendering strategies WITHIN a type. These are not separate preview types:
// they only decide how a file of that type is loaded, so they stay fixed even
// when the user edits the suffix lists.
export const HEIC_IMAGE_EXTENSIONS = ["heic", "heif", "hif", "avci"];
export const MAMMOTH_DOC_EXTENSIONS = ["docx"];

export function typeLabel(key) {
  const t = PREVIEW_TYPES.find((x) => x.key === key);
  return t ? t.label : String(key);
}

export function defaultsFor(key) {
  const t = PREVIEW_TYPES.find((x) => x.key === key);
  return t ? [...t.defaults] : [];
}

export function defaultMapping() {
  const out = {};
  for (const t of PREVIEW_TYPES) out[t.key] = [...t.defaults];
  return out;
}

// "" is a real key: it is the sentinel for files with NO extension, registered
// by the "按文本预览" button on an unsupported file.
export function extLabel(ext) {
  return ext === "" ? "(无后缀)" : "." + ext;
}

export function normalizeExt(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[^a-z0-9]/g, "");
}

// Clean one suffix list. A literal "" is kept as the extension-less sentinel;
// any other value that normalises to empty is junk and dropped.
function cleanExtList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const sentinel = raw === "";
    const ext = sentinel ? "" : normalizeExt(raw);
    if (!sentinel && !ext) continue;
    if (seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

export function findConflicts(mapping) {
  const owner = new Map();
  const conflicts = [];
  for (const t of PREVIEW_TYPES) {
    const list = Array.isArray(mapping?.[t.key]) ? mapping[t.key] : [];
    for (const ext of list) {
      if (!owner.has(ext)) {
        owner.set(ext, t.key);
      } else if (owner.get(ext) !== t.key) {
        const hit = conflicts.find((c) => c.ext === ext);
        if (hit) {
          if (!hit.types.includes(t.key)) hit.types.push(t.key);
        } else {
          conflicts.push({ ext, types: [owner.get(ext), t.key] });
        }
      }
    }
  }
  return conflicts;
}

// Build a clean, plain-object copy. A missing / non-array type falls back to
// its defaults (forward-compatible when a new type is added). Cross-type
// collisions are resolved by keeping the FIRST type in PREVIEW_TYPES order —
// deterministic even for a hand-edited config file.
export function normalizeMapping(input) {
  const src = input && typeof input === "object" ? input : {};
  const claimed = new Set();
  const out = {};
  for (const t of PREVIEW_TYPES) {
    const raw = src[t.key];
    const list = Array.isArray(raw) ? cleanExtList(raw) : [...t.defaults];
    out[t.key] = list.filter((ext) => {
      if (claimed.has(ext)) return false;
      claimed.add(ext);
      return true;
    });
  }
  return out;
}

export function ownerOfExt(ext, mapping, excludeKey = null) {
  for (const t of PREVIEW_TYPES) {
    if (t.key === excludeKey) continue;
    const list = mapping?.[t.key];
    if (Array.isArray(list) && list.includes(ext)) return t.key;
  }
  return null;
}

// Returns { mapping, error, owner }. The input mapping is never mutated.
export function addExtToType(mapping, type, raw) {
  const meta = PREVIEW_TYPES.find((t) => t.key === type);
  if (!meta) return { mapping, error: "未知的预览方式", owner: null };
  const ext = normalizeExt(raw);
  if (!ext) return { mapping, error: "请输入有效的后缀（字母或数字）", owner: null };
  const list = Array.isArray(mapping[type]) ? mapping[type] : [];
  if (list.includes(ext)) {
    return {
      mapping,
      error: `后缀 ${extLabel(ext)} 已在「${meta.label}」列表中`,
      owner: type,
    };
  }
  const owner = ownerOfExt(ext, mapping, type);
  if (owner) {
    return {
      mapping,
      error: `后缀 ${extLabel(ext)} 已属于「${typeLabel(owner)}」预览，请先从那里移除`,
      owner,
    };
  }
  return { mapping: { ...mapping, [type]: [...list, ext] }, error: "", owner: null };
}

export function removeExtFromType(mapping, type, ext) {
  const list = Array.isArray(mapping[type]) ? mapping[type] : [];
  return { ...mapping, [type]: list.filter((e) => e !== ext) };
}

export function classifyExt(ext, mapping) {
  const needle = String(ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
  for (const t of PREVIEW_TYPES) {
    const list = mapping?.[t.key];
    if (Array.isArray(list) && list.includes(needle)) return t.key;
  }
  return null;
}

// Old config: ~/.minitc/text-preview-extensions.json held ONLY the text list,
// in one of two shapes — a bare delta array, or { ext: bool } full state.
export function parseLegacyTextConfig(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    return cleanExtList([...defaultsFor("text"), ...parsed.map((e) => String(e))]);
  }
  if (parsed && typeof parsed === "object") {
    return cleanExtList(
      Object.entries(parsed)
        .filter(([, on]) => !!on)
        .map(([k]) => k)
    );
  }
  return null;
}

// New config: ~/.minitc/preview-extensions.json =
//   { version: 2, types: { text: [...], image: [...], ... } }
// A bare { text: [...], ... } is also accepted for hand-edited files.
export function parseMapping(raw, legacyRaw) {
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const body =
        parsed.types && typeof parsed.types === "object" && !Array.isArray(parsed.types)
          ? parsed.types
          : parsed;
      if (PREVIEW_TYPE_KEYS.some((k) => Array.isArray(body[k]))) {
        return normalizeMapping(body);
      }
    }
  }
  const base = defaultMapping();
  const legacy = parseLegacyTextConfig(legacyRaw);
  if (legacy) base.text = legacy;
  return normalizeMapping(base);
}

export function serializeMapping(mapping) {
  return JSON.stringify({ version: 2, types: normalizeMapping(mapping) });
}
