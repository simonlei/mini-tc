// ── Batch rename: pure name-transform logic ──
//
// Everything here is a pure function over strings — no IO, no Vue, no IPC — so
// the rules can be reasoned about (and unit-run) independently of the dialog
// that drives them. The dialog owns the *form*, this module owns the *answer*
// to "given these N names and these rules, what are the N new names, and which
// of them are illegal / collide".
//
// Design notes that the rest of the batch-rename feature depends on:
//
//  • The stem (everything before the last dot) and the extension are handled
//    SEPARATELY. Find/replace, case conversion and numbering all operate on
//    the stem; only the 「扩展名」 section touches the extension. A dotfile
//    (`.gitignore`) has no extension — `lastIndexOf(".") === 0` means the whole
//    name is the stem.
//
//  • Conflict detection is done PER DIRECTORY, never globally. A search-results
//    pseudo-directory holds rows from many folders, and two rows sharing a
//    target name in *different* folders is perfectly fine.
//
//  • Name comparison is CASE-INSENSITIVE throughout. Windows filesystems are,
//    so "a→B" and "c→b" really are a collision, and a naive case-sensitive
//    check would happily produce a rename the OS then rejects.
//
//  • A rename may legitimately target a name that another item in the same
//    batch is vacating (the `a→b, b→a` swap). That is legal and handled by
//    `planPhases`, which splits those moves into a temporary-name phase. What
//    is NOT legal is targeting a name held by an item that is staying put —
//    that's reported as a conflict.

/// Split a file name into `{ stem, ext }`, ext including the leading dot.
/// A name with no dot — or a dotfile like `.gitignore` — has an empty ext.
export function splitName(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  if (i <= 0) return { stem: s, ext: "" };
  return { stem: s.slice(0, i), ext: s.slice(i) };
}

/// Characters Windows forbids in a file name, plus the C0 control range.
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;

/// Reserved DOS device names. These still resolve to devices on Windows even
/// with an extension (`NUL.txt` opens the null device), so they are rejected
/// outright rather than left for the OS to fail on later.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/// Why `name` cannot be used as a file name, or `null` when it is fine.
export function validateName(name) {
  const s = String(name == null ? "" : name);
  if (s.trim() === "") return "名称为空";
  if (s.length > 255) return "名称过长（超过 255 个字符）";
  if (ILLEGAL_CHARS.test(s)) return '包含非法字符 < > : " / \\ | ? *';
  if (/[. ]$/.test(s)) return "不能以点或空格结尾";
  if (RESERVED_DEVICE.test(s)) return "Windows 保留设备名";
  return null;
}

/// Case-conversion modes offered by the dialog.
export const CASE_MODES = [
  { key: "none", label: "不转换" },
  { key: "lower", label: "全部小写" },
  { key: "upper", label: "全部大写" },
  { key: "title", label: "首字母大写 Title Case" },
  { key: "camel", label: "camelCase" },
  { key: "kebab", label: "kebab-case" },
  { key: "snake", label: "snake_case" },
];

/// Extension actions offered by the dialog.
export const EXT_MODES = [
  { key: "keep", label: "保留原扩展名" },
  { key: "lower", label: "转为小写" },
  { key: "replace", label: "替换为" },
  { key: "remove", label: "去掉扩展名" },
];

/// A fresh rules object with every field at its default. The dialog deep-copies
/// this so a reset never mutates a shared default.
export function defaultRules() {
  return {
    // ── 查找替换 ──
    find: "",
    replace: "",
    useRegex: false,
    caseSensitive: false,
    // ── 大小写 ──
    caseMode: "none",
    // ── 前后缀 ──
    prefix: "",
    suffix: "",
    // ── 序号 ──
    numbering: false,
    seqStart: 1,
    seqStep: 1,
    seqPad: 0,
    // "append"      → stem becomes `stem_N`
    // "placeholder" → only substituted for `[N]` tokens in the replace text /
    //                 prefix / suffix (nothing is appended when there is none)
    seqMode: "append",
    // ── 扩展名 ──
    extMode: "keep",
    newExt: "",
  };
}

const CASE_FNS = {
  none: (s) => s,
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  title: (s) =>
    s.replace(/(^|[\s\-_])([a-z])/gi, (m, sep, ch) => sep + ch.toUpperCase()),
  camel: (s) =>
    s
      .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(""),
  kebab: (s) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase(),
  snake: (s) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^\w\u4e00-\u9fa5]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase(),
};

/// Substitute every `[N]` token with the padded number.
function applyTokens(text, num) {
  return String(text == null ? "" : text).replace(/\[N\]/g, String(num));
}

/// The number for row `index` (0-based, in the order the list is displayed).
function sequenceNumber(index, rules) {
  const start = Number.isFinite(+rules.seqStart) ? +rules.seqStart : 1;
  const step = Number.isFinite(+rules.seqStep) ? +rules.seqStep : 1;
  const pad = Math.min(10, Math.max(0, parseInt(rules.seqPad, 10) || 0));
  const n = start + index * step;
  const s = String(n);
  return pad > s.length ? "0".repeat(pad - s.length) + s : s;
}

/// Compute the new name for entry `oldName` at position `index`.
///
/// Returns `{ name, seq, error }` — `error` is non-null when the rules
/// themselves are broken (an invalid regex, an extension replacement that is
/// empty); an illegal RESULT name is reported by `validateName` here too, since
/// both must surface as a red row in the dialog.
export function computeNewName(oldName, index, rules) {
  const r = { ...defaultRules(), ...(rules || {}) };
  const { stem, ext } = splitName(oldName);
  let seq = "";
  let error = null;

  // ── 1. Find / replace on the stem ──
  let work = stem;
  const find = String(r.find == null ? "" : r.find);
  if (find !== "") {
    if (r.useRegex) {
      let re;
      try {
        re = new RegExp(find, r.caseSensitive ? "" : "i");
      } catch (e) {
        return { name: oldName, seq, error: `正则无效：${e.message}` };
      }
      // `replace` on a /g-less regex still replaces the first match only, so
      // force global here — a rename rule that hits one occurrence out of five
      // is never what the user meant.
      work = work.replace(new RegExp(find, (r.caseSensitive ? "" : "i") + "g"), r.replace);
    } else if (r.caseSensitive) {
      work = work.split(find).join(r.replace);
    } else {
      const re = new RegExp(escapeRegExp(find), "gi");
      work = work.replace(re, r.replace);
    }
  }

  // ── 2. [N] placeholder inside the replacement text ──
  if (r.numbering) {
    seq = sequenceNumber(index, r);
    work = applyTokens(work, seq);
  }

  // ── 3. Case conversion ──
  work = (CASE_FNS[r.caseMode] || CASE_FNS.none)(work);

  // ── 4. Auto-appended number (`stem_1`, `stem_2`, …) ──
  if (r.numbering && r.seqMode === "append") work = `${work}_${seq}`;

  // ── 5. Prefix / suffix (their own [N] tokens resolve too) ──
  const prefix = r.numbering ? applyTokens(r.prefix, seq) : String(r.prefix || "");
  const suffix = r.numbering ? applyTokens(r.suffix, seq) : String(r.suffix || "");
  work = `${prefix}${work}${suffix}`;

  // ── 6. Extension ──
  let outExt = ext;
  if (r.extMode === "remove") outExt = "";
  else if (r.extMode === "lower") outExt = ext.toLowerCase();
  else if (r.extMode === "replace") {
    const ne = String(r.newExt || "").replace(/^\.+/, "").trim();
    if (!ne) error = "替换扩展名为空";
    else outExt = "." + ne;
  }

  const name = (work + outExt).trim();
  if (!error) {
    const bad = validateName(name);
    if (bad) error = bad;
  }
  return { name, seq, error };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/// Lower-cased key used for every name comparison in this module.
function key(name) {
  return String(name || "").toLowerCase();
}

/// Directory part of a path, normalised for grouping. Falls back to "" so a
/// missing path groups with itself rather than exploding.
function dirKeyOf(path) {
  const norm = String(path || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? norm.replace(/\/+$/, "") : norm.slice(0, i);
}

/// Build the full rename plan.
///
/// `items`     [{ path, name }] in DISPLAY order — the sequence numbers follow
///             this order, so it must be the order the user sees.
/// `existing`  a Set of lower-cased names already present in the target
///             directory, or `null` when unknown (a search-results tab has no
///             single directory, so the caller passes null and those rows are
///             only checked against their own batch).
/// `rules`     a rules object (see `defaultRules`).
///
/// Each returned row: `{ path, name, index, newName, status, error }` where
/// status is one of:
///   "ok"        → will be renamed
///   "unchanged" → the rules produce the current name; nothing to do
///   "error"     → `error` explains why (illegal characters, or a collision)
export function buildRenamePlan(items, existing, rules) {
  const rows = (items || []).map((it, index) => {
    const res = computeNewName(it.name, index, rules);
    return {
      path: it.path || "",
      name: it.name,
      index,
      newName: res.name,
      seq: res.seq,
      status: "ok",
      error: null,
    };
  });

  // Rule-level failures (bad regex) and unchanged names are settled first —
  // they are properties of a single row and must not poison the group checks.
  for (const row of rows) {
    if (row.error) row.status = "error";
    else if (row.newName === row.name) row.status = "unchanged";
  }

  // Group by directory: only rows that end up in the SAME folder can collide.
  const groups = new Map();
  for (const row of rows) {
    const k = dirKeyOf(row.path);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }

  for (const group of groups.values()) {
    const moving = group.filter((r) => r.status === "ok");

    // ① Two rows in this batch computing the SAME target name. Unfixable —
    //    only one of them can ever own that name.
    const byTarget = new Map();
    for (const row of moving) {
      const k = key(row.newName);
      if (!byTarget.has(k)) byTarget.set(k, []);
      byTarget.get(k).push(row);
    }
    for (const [, same] of byTarget) {
      if (same.length < 2) continue;
      for (const row of same) {
        row.status = "error";
        row.error = "与本批次中其他项重名";
      }
    }

    // ② Target collides with something in the directory that is NOT moving.
    //    Names held by rows that ARE moving are fine — that's the swap case
    //    `planPhases` resolves via temporary names.
    const vacated = new Set(moving.map((r) => key(r.name)));
    if (existing) {
      for (const row of moving) {
        if (row.status !== "ok") continue;
        const k = key(row.newName);
        if (existing.has(k) && !vacated.has(k)) {
          row.status = "error";
          row.error = "目标已存在同名项";
        }
      }
    }
  }

  return rows;
}

/// Counts for the dialog's status bar and the confirm button's enabled state.
export function summarizePlan(rows) {
  const total = (rows || []).length;
  let ok = 0;
  let unchanged = 0;
  let errors = 0;
  for (const r of rows || []) {
    if (r.status === "ok") ok += 1;
    else if (r.status === "unchanged") unchanged += 1;
    else errors += 1;
  }
  return { total, ok, unchanged, errors };
}

/// Replace the last path segment of `fullPath` with `newName`.
/// Deliberately string surgery rather than `joinPath`: this runs once per item
/// per phase, and an IPC round-trip per item is exactly the cost the two-phase
/// scheme is trying to keep down.
export function withNewName(fullPath, newName) {
  const p = String(fullPath || "");
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i < 0) return String(newName || "");
  return p.slice(0, i + 1) + String(newName || "");
}

/// Split the moves into two phases so cyclic renames work.
///
/// Any move whose target is currently occupied by ANOTHER move's source must go
/// through a temporary name first (`a→b, b→a`). Everything else can be renamed
/// in place, since its target is free by construction.
///
/// `existing` (a Set of lower-cased names) is used to pick temporary names that
/// certainly don't collide.
///
/// Returns `{ phase1, phase2, tempNameOf }` where `tempNameOf(row)` gives the
/// temporary file name for a phase-1 row (null for phase-2 rows).
export function planPhases(rows, existing) {
  const moving = (rows || []).filter((r) => r.status === "ok");
  const sources = new Set(moving.map((r) => key(r.name)));

  const phase1 = [];
  const phase2 = [];
  for (const row of moving) {
    // Case-insensitive compare, but the row must not be targeting ITSELF (which
    // buildRenamePlan already classified as "unchanged", so it never reaches here).
    if (sources.has(key(row.newName)) && key(row.newName) !== key(row.name)) {
      phase1.push(row);
    } else {
      phase2.push(row);
    }
  }

  const temps = new Map();
  if (phase1.length) {
    const token = Math.random().toString(36).slice(2, 8);
    for (let i = 0; i < phase1.length; i++) {
      let name = `~minitc_tmp_${token}_${i}`;
      while (existing && existing.has(key(name))) {
        name = `~minitc_tmp_${token}_${i}_${Math.random().toString(36).slice(2, 4)}`;
      }
      temps.set(phase1[i], name);
    }
  }

  return { phase1, phase2, tempNameOf: (row) => temps.get(row) || null };
}
