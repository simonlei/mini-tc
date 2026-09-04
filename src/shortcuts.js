// ── Keyboard shortcut registry & runtime store ──
//
// Every keyboard shortcut in the app is declared here as a "command" with a
// scope and a list of default key combos. Users can rebind (add / remove /
// replace) any of them from the 配置 → 快捷键设置 dialog; overrides are
// persisted to ~/.minitc/shortcuts.json through the generic backend config
// commands.
//
// Combo syntax: `Ctrl+Alt+Shift+Meta+Key`, e.g. `Ctrl+Q`, `Shift+ArrowDown`,
// `Ctrl+Backspace`, `/`, `Space`. Modifiers are stored in the canonical order
// Ctrl → Alt → Shift → Meta; `Meta` is the Windows key on Windows and Command
// on macOS.
//
// Scopes decide WHERE a combo is active:
//   global   → anywhere in the app window
//   fileList → while the file list has keyboard focus
//   video    → while the video preview is open
// A command only ever consumes a key inside its own scope, and the more
// specific scope wins (fileList / video handlers run before the global one and
// mark the event handled).

import { ref } from "vue";
import { loadConfig, saveConfig } from "./api.js";

/// Config file name → ~/.minitc/shortcuts.json
const CONFIG_KEY = "shortcuts";

/// Scope metadata. `key` matches each command's `scope` field.
export const SCOPES = [
  { key: "global", label: "全局", hint: "应用窗口任意位置生效" },
  { key: "fileList", label: "文件列表", hint: "焦点在文件列表时生效" },
  { key: "video", label: "视频播放", hint: "视频预览打开时生效" },
];

/// Every configurable shortcut in the app.
/// `defaults` is used until (and unless) the user overrides the command — the
/// persisted file only stores deltas, so new defaults ship automatically.
export const COMMANDS = [
  // ── 全局 ──
  { id: "preview.toggle", scope: "global", label: "切换文件预览", desc: "在另一侧面板预览选中文件", defaults: ["Ctrl+Q"] },
  { id: "edit.copy", scope: "global", label: "复制", desc: "复制所选项目到系统剪贴板", defaults: ["Ctrl+C"] },
  { id: "edit.cut", scope: "global", label: "剪切", desc: "剪切所选项目到系统剪贴板", defaults: ["Ctrl+X"] },
  { id: "edit.paste", scope: "global", label: "粘贴", desc: "把系统剪贴板内容粘贴到当前目录", defaults: ["Ctrl+V"] },
  { id: "edit.selectAll", scope: "global", label: "全选", desc: "选中当前面板所有项目", defaults: ["Ctrl+A"] },
  { id: "panel.switch", scope: "global", label: "切换左右面板", desc: "在左栏 / 右栏之间移动焦点", defaults: ["Ctrl+Tab"] },
  { id: "preview.close", scope: "global", label: "关闭预览", desc: "关闭图片 / 文本 / 视频预览", defaults: ["Escape"] },

  // ── 文件列表 ──
  { id: "list.filter", scope: "fileList", label: "过滤当前目录", desc: "按文件名增量过滤", defaults: ["/"] },
  { id: "list.open", scope: "fileList", label: "打开 / 进入", desc: "打开文件或进入目录", defaults: ["Enter"] },
  { id: "list.parent", scope: "fileList", label: "返回上一级", defaults: ["Backspace"] },
  { id: "list.up", scope: "fileList", label: "上一项", defaults: ["ArrowUp"] },
  { id: "list.down", scope: "fileList", label: "下一项", defaults: ["ArrowDown"] },
  { id: "list.extendUp", scope: "fileList", label: "向上扩展选择", defaults: ["Shift+ArrowUp"] },
  { id: "list.extendDown", scope: "fileList", label: "向下扩展选择", defaults: ["Shift+ArrowDown"] },
  { id: "list.pageUp", scope: "fileList", label: "上一页", defaults: ["PageUp"] },
  { id: "list.pageDown", scope: "fileList", label: "下一页", defaults: ["PageDown"] },
  { id: "list.extendPageUp", scope: "fileList", label: "向上扩展一页", defaults: ["Shift+PageUp"] },
  { id: "list.extendPageDown", scope: "fileList", label: "向下扩展一页", defaults: ["Shift+PageDown"] },
  { id: "list.first", scope: "fileList", label: "跳到首项", defaults: ["Home"] },
  { id: "list.last", scope: "fileList", label: "跳到末项", defaults: ["End"] },
  { id: "list.extendFirst", scope: "fileList", label: "扩展到首项", defaults: ["Shift+Home"] },
  { id: "list.extendLast", scope: "fileList", label: "扩展到末项", defaults: ["Shift+End"] },
  { id: "list.dirSize", scope: "fileList", label: "计算目录大小", desc: "对选中的目录统计占用空间", defaults: ["Space"] },
  { id: "list.delete", scope: "fileList", label: "删除", desc: "移入回收站", defaults: ["Delete", "Ctrl+Backspace", "Meta+Backspace"] },
  // Combos are stored in canonical form: Ctrl, Alt, Shift, Meta — so the
  // Meta (Cmd) variant is "Shift+Meta+Backspace", not "Meta+Shift+Backspace".
  { id: "list.deletePermanent", scope: "fileList", label: "永久删除", desc: "不经过回收站，直接抹除（不可恢复）", defaults: ["Shift+Delete", "Ctrl+Shift+Backspace", "Shift+Meta+Backspace"] },
  { id: "list.rename", scope: "fileList", label: "重命名", defaults: ["F2"] },

  // ── 视频播放 ──
  { id: "video.playPause", scope: "video", label: "播放 / 暂停", defaults: ["Space", "K"] },
  { id: "video.back5", scope: "video", label: "快退 5 秒", defaults: ["ArrowLeft"] },
  { id: "video.forward5", scope: "video", label: "快进 5 秒", defaults: ["ArrowRight"] },
  { id: "video.back30", scope: "video", label: "快退 30 秒", defaults: ["Shift+ArrowLeft"] },
  { id: "video.forward30", scope: "video", label: "快进 30 秒", defaults: ["Shift+ArrowRight"] },
  { id: "video.prevFile", scope: "video", label: "上一个文件", defaults: ["ArrowUp"] },
  { id: "video.nextFile", scope: "video", label: "下一个文件", defaults: ["ArrowDown"] },
  { id: "video.fullscreen", scope: "video", label: "全屏", defaults: ["F"] },
  { id: "video.subtitle", scope: "video", label: "切换字幕", desc: "在已加载的字幕轨之间开关", defaults: ["C"] },
  { id: "video.mute", scope: "video", label: "静音", defaults: ["M"] },
];

export const COMMAND_MAP = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

// ── Platform / display helpers ──

const UA = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || "" : "";
export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(UA) || /Mac/.test(PLATFORM);
const IS_WIN = /Windows|Win32|Win64/.test(UA);

// Canonical modifier order — combos are always stored / compared in this order.
const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

const MOD_ALIASES = {
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt", option: "Alt",
  shift: "Shift",
  meta: "Meta", cmd: "Meta", command: "Meta", super: "Meta", win: "Meta", windows: "Meta",
};

const MOD_LABELS = IS_MAC
  ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
  : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: IS_WIN ? "Win" : "Meta" };

/// Display name of the Meta key on this platform (Cmd / Win / Meta).
export const META_LABEL = MOD_LABELS.Meta;

const KEY_LABELS = {
  Space: "Space", Escape: "Esc", Enter: "Enter", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  PageUp: "PgUp", PageDown: "PgDn", Home: "Home", End: "End",
};

// Keys that must never be used as the "main" key of a combo (pressing them on
// their own is just a modifier / lock key, not a shortcut).
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock"]);

// `KeyboardEvent.code` → canonical key name. Code is preferred over `key`
// because it is layout- and Shift-independent (Shift+/ reports key "?" but code
// "Slash"). Anything not listed here falls back to `event.key`.
const CODE_KEYS = {
  Space: "Space", Escape: "Escape", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
  Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
  Minus: "-", Equal: "=", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Backquote: "`",
};

// Canonical key spellings, matched case-insensitively so a persisted/imported
// combo like "BACKSPACE" or "arrowdown" still resolves to the same combo the
// keyboard produces.
const KNOWN_KEYS = {
  space: "Space",
  escape: "Escape", esc: "Escape",
  enter: "Enter", return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete", del: "Delete",
  insert: "Insert",
  arrowup: "ArrowUp", up: "ArrowUp",
  arrowdown: "ArrowDown", down: "ArrowDown",
  arrowleft: "ArrowLeft", left: "ArrowLeft",
  arrowright: "ArrowRight", right: "ArrowRight",
  pageup: "PageUp", pgup: "PageUp",
  pagedown: "PageDown", pgdn: "PageDown", pgdown: "PageDown",
  home: "Home", end: "End",
};
for (let i = 1; i <= 24; i++) KNOWN_KEYS["f" + i] = "F" + i;

function normalizeKeyName(raw) {
  let k = String(raw).trim();
  if (k === "") return "";
  if (k === " ") return "Space";
  const hit = KNOWN_KEYS[k.toLowerCase()];
  if (hit) return hit;
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/// Turn any user/serialised combo spelling into the canonical form.
/// Returns "" when the combo has no usable main key.
export function normalizeCombo(input) {
  if (!input) return "";
  const raw = String(input);
  const parts = raw.split("+").map((s) => s.trim()).filter(Boolean);
  const mods = new Set();
  let key = "";
  for (const p of parts) {
    const mod = MOD_ALIASES[p.toLowerCase()];
    if (mod && p !== "+") mods.add(mod);
    else key = normalizeKeyName(p);
  }
  // Trailing "+" (e.g. `Ctrl++`) is the literal "+" key — split() eats it.
  if (!key && /\+\s*$/.test(raw)) key = "+";
  if (!key) return "";
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/// Canonical combo for a KeyboardEvent, or "" for a modifier-only press.
export function eventCombo(e) {
  const key = eventKeyName(e);
  if (!key) return "";
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, key].join("+");
}

function eventKeyName(e) {
  const code = e.code || "";
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  const k = e.key;
  if (!k || MODIFIER_KEYS.has(k)) return "";
  return normalizeKeyName(k);
}

/// Human-readable rendering of a canonical combo ("Ctrl+Shift+Q" / "⌃⇧Q").
export function displayCombo(combo) {
  if (!combo) return "";
  const parts = combo.split("+");
  let key = parts.pop();
  if (!key) key = "+";
  const mods = parts.filter(Boolean).map((m) => MOD_LABELS[m] || m);
  const label = KEY_LABELS[key] || key;
  return IS_MAC ? [...mods, label].join("") : [...mods, label].join("+");
}

// ── Runtime state ──

/// User overrides: { [commandId]: [combo, …] }. Only deltas are persisted;
/// a command missing here (or bound to exactly its defaults) uses the default.
const overrides = ref({});

/// True while the shortcut-settings dialog is open. Handlers bail out so the
/// dialog can record raw keystrokes without triggering the app commands.
export const shortcutsEditing = ref(false);

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/// Current bindings for a command (defaults when the user hasn't overridden it).
export function bindingsOf(id) {
  const cmd = COMMAND_MAP[id];
  if (!cmd) return [];
  const ov = overrides.value[id];
  if (ov && Array.isArray(ov)) return dedupe(ov.map(normalizeCombo));
  return [...cmd.defaults];
}

/// Replace a command's bindings. Passing the defaults clears the override so
/// future default changes still reach the user.
export function setBindings(id, combos) {
  const cmd = COMMAND_MAP[id];
  if (!cmd) return;
  const list = dedupe((combos || []).map(normalizeCombo));
  const next = { ...overrides.value };
  if (sameList(list, cmd.defaults)) delete next[id];
  else next[id] = list;
  overrides.value = next;
}

export async function loadShortcuts() {
  try {
    const raw = await loadConfig(CONFIG_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const next = {};
    for (const [id, list] of Object.entries(parsed)) {
      if (!COMMAND_MAP[id]) continue; // drop bindings for removed commands
      next[id] = Array.isArray(list) ? dedupe(list.map(normalizeCombo)) : [];
    }
    overrides.value = next;
  } catch (e) {
    console.error("Failed to load shortcuts:", e);
  }
}

export async function saveShortcuts() {
  try {
    await saveConfig(CONFIG_KEY, JSON.stringify(overrides.value));
  } catch (e) {
    console.error("Failed to save shortcuts:", e);
  }
}

// ── Event dispatch ──

// Events already consumed by a more specific scope. The file-list and video
// handlers run BEFORE the global document handler (element-bubble and window-
// capture respectively), so they can claim a combo and stop the global command
// from firing a second time for the same keystroke.
const handledEvents = new WeakSet();

export function markHandled(e) {
  handledEvents.add(e);
}
export function isHandled(e) {
  return handledEvents.has(e);
}

/// True when `e` should trigger `commandId`. Modifiers must match exactly
/// (Shift+ArrowDown does not match ArrowDown) and the event must not already
/// have been consumed by another command.
export function matches(commandId, e) {
  if (shortcutsEditing.value) return false;
  if (isHandled(e)) return false;
  const combo = eventCombo(e);
  if (!combo) return false;
  return bindingsOf(commandId).includes(combo);
}

// ── Conflict detection ──

/// Build a Map of commandId → { errors, hints } for the given binding source.
/// `getBindings` is `(commandId) => string[]`, so the live store and the
/// settings dialog's unsaved draft can share this logic.
///
/// errors: two commands in the SAME scope share a combo → only one can win,
///         and which one depends on handler order (a genuine bug for the user).
/// hints:  a scoped combo duplicates a GLOBAL one → no ambiguity (the scoped
///         command wins inside its scope), but worth surfacing.
export function computeConflicts(getBindings) {
  const result = new Map();
  for (const c of COMMANDS) result.set(c.id, { errors: [], hints: [] });

  const byCombo = new Map();
  for (const c of COMMANDS) {
    for (const combo of getBindings(c.id) || []) {
      if (!byCombo.has(combo)) byCombo.set(combo, []);
      byCombo.get(combo).push(c);
    }
  }

  for (const [combo, list] of byCombo) {
    if (list.length < 2) continue;

    const byScope = new Map();
    for (const c of list) {
      if (!byScope.has(c.scope)) byScope.set(c.scope, []);
      byScope.get(c.scope).push(c.id);
    }
    for (const ids of byScope.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        result.get(id).errors.push({ combo, others: ids.filter((x) => x !== id) });
      }
    }

    for (const c of list) {
      for (const other of list) {
        if (other === c) continue;
        if (c.scope !== "global" && other.scope !== "global") continue;
        result.get(c.id).hints.push({ combo, others: [other.id] });
      }
    }
  }
  return result;
}

/// "复制 / 删除" — labels of other commands sharing a combo.
export function commandLabels(ids) {
  return (ids || []).map((id) => COMMAND_MAP[id]?.label || id).join(" / ");
}

/// Append `combo` to a binding list, or overwrite the slot at `index` when the
/// user re-records an existing chip in place.
///
/// Returns `{ list, duplicate }`. `duplicate` is true when `combo` is already
/// taken by ANOTHER slot of the same command — the caller then keeps the list
/// untouched and shows a message (one command must never hold the same combo
/// twice). A non-integer / out-of-range `index` degrades to a plain append.
export function applyBindingTo(list, combo, index) {
  const cur = list ? [...list] : [];
  const replace = Number.isInteger(index) && index >= 0 && index < cur.length;
  if (!replace) {
    if (cur.includes(combo)) return { list: cur, duplicate: true };
    return { list: [...cur, combo], duplicate: false };
  }
  if (cur.some((c, i) => c === combo && i !== index)) {
    return { list: cur, duplicate: true };
  }
  cur[index] = combo;
  return { list: cur, duplicate: false };
}

/// Commands matching a free-text query, grouped by scope key.
///
/// Only USER-VISIBLE text is searched: the command label, its description, the
/// scope name, and its bound combos (both the canonical spelling and the
/// rendered one, so "pgup" and "pageup" both find PageUp).
///
/// The internal command `id` is deliberately NOT searchable — ids like
/// `list.extendPageUp` / `list.extendDown` are implementation details the user
/// never sees, and including them makes a stray letter such as "x" match every
/// `list.extend*` command.
export function filterCommands(query, getBindings) {
  const q = String(query || "").trim().toLowerCase();
  const groups = {};
  for (const s of SCOPES) {
    let list = COMMANDS.filter((c) => c.scope === s.key);
    if (q) {
      list = list.filter((c) => {
        const combos = getBindings(c.id) || [];
        const hay = [c.label, c.desc || "", s.label, ...combos, ...combos.map(displayCombo)]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    groups[s.key] = list;
  }
  return groups;
}
