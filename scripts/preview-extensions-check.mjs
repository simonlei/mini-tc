// Guards the preview-extension mapping: the five preview types, their default
// suffix lists, the "one suffix = one preview type" invariant, config migration
// from the old text-only file, and — via static assertions — that every UI
// consumer really reads the shared mapping instead of a private copy.
//
// The pure half imports the PRODUCTION module (not a replica), so a mutation of
// src/previewExtensions.js is visible here. See preview-extensions-mutation.mjs.
//
// Run: node scripts/preview-extensions-check.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const R = await import(pathToFileURL(path.join(ROOT, "src", "previewExtensions.js")).href);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log("  FAIL " + msg);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg}\n         got  ${a}\n         want ${b}`);
}

// ── 1. Defaults ────────────────────────────────────────────────────────────

eq(R.PREVIEW_TYPES.map((t) => t.key), ["text", "image", "video", "pdf", "doc"], "exactly the five supported preview types, in priority order");
const D = R.defaultMapping();
eq(Object.keys(D), ["text", "image", "video", "pdf", "doc"], "defaultMapping() covers every type");
eq(D.text, ["txt", "md", "json", "log"], "text defaults");
eq(D.pdf, ["pdf"], "pdf defaults");
eq(D.doc, ["doc", "docx"], "doc defaults");
eq(D.image.length, 13, "13 image defaults (incl. HEIC family)");
eq(D.video.length, 22, "22 video defaults");
ok(D.image.includes("jfif") && D.image.includes("heic") && D.image.includes("avci"), "JPEG alias + HEIC family are image defaults");
ok(D.video.includes("mkv") && D.video.includes("m2ts"), "video defaults keep the less common formats");
eq(R.findConflicts(D), [], "built-in defaults contain NO cross-type duplicate");
ok(R.PREVIEW_TYPES.every((t) => t.label && t.hint && Array.isArray(t.defaults)), "every type has a label / hint / defaults for the settings UI");
eq(R.HEIC_IMAGE_EXTENSIONS, ["heic", "heif", "hif", "avci"], "HEIC rendering subset");
eq(R.MAMMOTH_DOC_EXTENSIONS, ["docx"], "mammoth rendering subset");

// The defaultMapping() call must not hand out the shared arrays (a caller
// mutating it would corrupt every later default).
D.text.push("__mutated");
ok(!R.defaultMapping().text.includes("__mutated"), "defaultMapping() returns fresh arrays");

// ── 2. Normalisation / labels ──────────────────────────────────────────────

eq(R.normalizeExt("  .CSV  "), "csv", "normalizeExt: trim + lowercase + strip leading dots");
eq(R.normalizeExt("JPG"), "jpg", "normalizeExt: uppercase");
eq(R.normalizeExt("a.b"), "ab", "normalizeExt: strips non-alphanumerics");
eq(R.normalizeExt("!!!"), "", "normalizeExt: junk becomes empty");
eq(R.normalizeExt(""), "", "normalizeExt: empty sentinel survives");
eq(R.extLabel(""), "(无后缀)", "extLabel: the no-extension sentinel");
eq(R.extLabel("csv"), ".csv", "extLabel: ordinary suffix");
eq(R.typeLabel("image"), "图片", "typeLabel");

// ── 3. Classification ──────────────────────────────────────────────────────

eq(R.classifyExt("txt", D), "text", "classify txt");
eq(R.classifyExt("md", D), "text", "classify md");
eq(R.classifyExt("jpg", D), "image", "classify jpg");
eq(R.classifyExt("heic", D), "image", "HEIC is an image, not its own preview type");
eq(R.classifyExt("mp4", D), "video", "classify mp4");
eq(R.classifyExt("pdf", D), "pdf", "classify pdf");
eq(R.classifyExt("docx", D), "doc", "classify docx");
eq(R.classifyExt("doc", D), "doc", "classify legacy doc");
eq(R.classifyExt(".PNG", D), "image", "classify is case/dot tolerant");
eq(R.classifyExt(" MKV ", D), "video", "classify trims and lowercases");
eq(R.classifyExt("exe", D), null, "unknown extension is not previewable");
eq(R.classifyExt("", D), null, "no-extension files start unclaimed");
// Even a corrupt mapping must resolve deterministically: FIRST type wins.
const rawConflict = { ...D, text: ["txt", "jpg"], image: ["jpg"] };
eq(R.classifyExt("jpg", rawConflict), "text", "a conflicting mapping resolves to the FIRST type, never two renderers");

// ── 4. The invariant: one suffix → at most one type ────────────────────────

eq(R.findConflicts(rawConflict), [{ ext: "jpg", types: ["text", "image"] }], "findConflicts reports the ext and BOTH owning types");
eq(R.findConflicts({ ...D, text: ["txt", "txt"] }), [], "a duplicate within ONE type is not a cross-type conflict");
eq(R.ownerOfExt("jpg", D), "image", "ownerOfExt finds the owner");
eq(R.ownerOfExt("jpg", D, "image"), null, "ownerOfExt honours excludeKey");
eq(R.ownerOfExt("exe", D), null, "ownerOfExt returns null for an unclaimed suffix");

const base = R.defaultMapping();
const added = R.addExtToType(base, "text", "csv");
ok(added.error === "", "adding a free suffix succeeds");
ok(added.mapping.text.includes("csv"), "the suffix lands in the requested type");
ok(!base.text.includes("csv"), "addExtToType does NOT mutate the input mapping");
ok(added.mapping.image === base.image, "unrelated type arrays are reused untouched");

const dup = R.addExtToType(base, "text", "txt");
ok(dup.error.includes("已在"), "adding a suffix already in THIS type is rejected");
eq(dup.mapping, base, "a within-type duplicate leaves the mapping unchanged");

const clash = R.addExtToType(base, "text", "JPG");
ok(clash.error.includes("图片"), "cross-type collision error names the owning type");
ok(clash.error.includes(".jpg"), "cross-type collision error names the suffix");
eq(clash.owner, "image", "collision result reports the owner key");
eq(clash.mapping, base, "a cross-type collision leaves the mapping unchanged");

const bad = R.addExtToType(base, "text", "!!!");
ok(bad.error.includes("有效"), "invalid input is rejected");
eq(bad.mapping, base, "invalid input leaves the mapping unchanged");
eq(R.addExtToType(base, "nope", "csv").mapping, base, "unknown preview type is rejected");

// Removal is scoped to one type.
const removed = R.removeExtFromType(base, "image", "jpg");
ok(!removed.image.includes("jpg"), "removeExtFromType removes the suffix");
ok(removed.text.includes("txt") && removed.video.includes("mp4"), "removeExtFromType leaves other types alone");
ok(base.image.includes("jpg"), "removeExtFromType does NOT mutate the input mapping");

// ── 5. normalizeMapping: the disk-safety net ───────────────────────────────

const cleaned = R.normalizeMapping(rawConflict);
eq(R.findConflicts(cleaned), [], "normalizeMapping removes a cross-type duplicate from a hand-edited config");
ok(cleaned.text.includes("jpg") && !cleaned.image.includes("jpg"), "the FIRST type keeps the contested suffix");
eq(R.normalizeMapping({ text: [] }).text, [], "an explicit empty list is respected (all suffixes of a type can be removed)");
eq(R.normalizeMapping({ text: null }).text, R.defaultsFor("text"), "a missing/broken type falls back to its defaults");
const sentinel = R.normalizeMapping({ ...D, text: ["", "txt", "txt", "!!!", ".CSV", 42] });
eq(sentinel.text, ["", "txt", "csv"], "normalizeMapping keeps the '' sentinel, drops junk/duplicates, normalises the rest");
eq(R.normalizeMapping(null), R.defaultMapping(), "normalizeMapping(null) is the default mapping");

// ── 6. Legacy config migration ─────────────────────────────────────────────

eq(R.parseLegacyTextConfig(null), null, "no legacy file → null");
eq(R.parseLegacyTextConfig("not json"), null, "corrupt legacy file → null");
eq(
  R.parseLegacyTextConfig('["csv","xml"]'),
  ["txt", "md", "json", "log", "csv", "xml"],
  "legacy delta ARRAY is merged with built-ins"
);
eq(
  R.parseLegacyTextConfig('{"txt":true,"md":false,"csv":true,"log":false,"":true}'),
  ["txt", "csv", ""],
  "legacy {ext:bool} respects disabled built-ins and keeps the '' sentinel"
);
eq(R.parseLegacyTextConfig("{}"), [], "empty legacy object is a valid (empty) text list");

// ── 7. New config parse / serialize ────────────────────────────────────────

const custom = R.defaultMapping();
custom.text.push("csv");
custom.image = custom.image.filter((e) => e !== "jpg");
const serialized = R.serializeMapping(custom);
const parsedDoc = JSON.parse(serialized);
eq(parsedDoc.version, 2, "saved config is versioned");
eq(Object.keys(parsedDoc.types), ["text", "image", "video", "pdf", "doc"], "saved config has all five types");
ok(parsedDoc.types.text.includes("csv") && !parsedDoc.types.image.includes("jpg"), "saved config reflects removals as well as additions");
eq(R.parseMapping(serialized, null), custom, "serialize → parse round trip");

const withConflict = JSON.stringify({ version: 2, types: { ...D, text: ["txt", "mp4"], video: ["mp4"] } });
eq(R.findConflicts(R.parseMapping(withConflict, null)), [], "conflicts are stripped on load (never on disk)");
const loadedConflict = R.parseMapping(withConflict, null);
ok(loadedConflict.text.includes("mp4") && !loadedConflict.video.includes("mp4"), "load keeps the first owner of a contested suffix");

eq(R.parseMapping(null, null), R.defaultMapping(), "no config at all → defaults");
eq(R.parseMapping("not json", null), R.defaultMapping(), "corrupt new config → defaults");
const legacyObj = '{"txt":true,"md":false,"csv":true,"":true}';
const migrated = R.parseMapping(null, legacyObj);
eq(migrated.text, ["txt", "csv", ""], "migration: legacy object becomes the text list");
eq(migrated.image, R.defaultsFor("image"), "migration: image keeps its defaults");
eq(migrated.video, R.defaultsFor("video"), "migration: video keeps its defaults");
eq(migrated.pdf, ["pdf"], "migration: pdf keeps its defaults");
eq(migrated.doc, ["doc", "docx"], "migration: doc keeps its defaults");
const migratedDelta = R.parseMapping(null, '["csv","xml"]');
eq(migratedDelta.text, ["txt", "md", "json", "log", "csv", "xml"], "migration: legacy delta array keeps built-ins");
// A real new config must WIN over a stale legacy file.
eq(R.parseMapping(serialized, legacyObj).text, custom.text, "new config takes precedence over the legacy file");
eq(R.parseMapping(JSON.stringify({ text: ["csv"], image: [] }), null).video, R.defaultsFor("video"), "bare mapping object with missing types is accepted and defaults fill the gaps");

// serializeMapping must never publish a conflict, even if handed one.
eq(R.findConflicts(JSON.parse(R.serializeMapping(rawConflict)).types), [], "serializeMapping refuses to persist a conflicting mapping");

// ── 8. Static assertions: every consumer reads the shared mapping ──────────
// The pure tests above would all stay green if a caller kept its own private
// suffix list, so the wiring is pinned separately.

const app = text("src/App.vue");
const filePreview = text("src/components/FilePreview.vue");
const fileList = text("src/components/FileList.vue");
const searchDialog = text("src/components/SearchDialog.vue");
const settingsDialog = text("src/components/SettingsDialog.vue");
const store = text("src/previewConfig.js");

for (const stale of ["PREVIEWABLE_EXTENSIONS", "VIDEO_EXTENSIONS", "BUILTIN_TEXT_EXTENSIONS", "textPreviewExtensions", "loadTextPreviewConfig", "saveTextPreviewConfig"]) {
  ok(!app.includes(stale), `App.vue has no leftover ${stale}`);
}
ok(app.includes(':mapping="previewMapping"'), "App.vue passes the live mapping into SettingsDialog");
ok(app.includes("loadPreviewExtConfig()"), "App.vue loads the shared mapping at boot");
ok(app.includes("applyPreviewMapping(mapping)") && app.includes("savePreviewExtConfig()"), "App.vue applies AND persists the settings save");
ok(app.includes("claimTextPreviewExt(ext)") && app.includes("savePreviewExtConfig()"), "「按文本预览」 registers its suffix through the shared store");
ok(app.includes('return previewKindOf(ext) !== null'), "isPreviewableExt delegates to the shared mapping");
ok(app.includes('return previewKindOf(ext) === "text"'), "isTextPreviewExt delegates to the shared mapping");
eq(app.match(/previewKindOf\(ext\) === "video"/g)?.length ?? 0, 3, "all THREE video routing branches (toggle / selection / panel switch) use the mapping");

ok(!filePreview.includes("const IMAGE_EXTENSIONS") && !filePreview.includes("const HEIC_EXTENSIONS"), "FilePreview.vue has no private image suffix list");
ok(filePreview.includes("previewKindOf(ext)"), "FilePreview.vue classifies via the shared mapping");
ok(filePreview.includes('const kind = props.asText ? "text" : previewKindOf(ext)'), "「按文本预览」 one-shot override is preserved");
ok(filePreview.includes('kind === "image"') && filePreview.includes('kind === "pdf"') && filePreview.includes('kind === "doc"') && filePreview.includes('kind === "video"'), "FilePreview.vue branches on image / video / pdf / doc");
ok(filePreview.includes('kind !== "text"') && filePreview.includes('"暂不支持预览该格式"'), "unmapped suffixes fall through to the unsupported branch");
ok(filePreview.includes("HEIC_IMAGE_EXTENSIONS.includes(ext)") && filePreview.includes("MAMMOTH_DOC_EXTENSIONS.includes(ext)"), "HEIC / docx rendering strategies stay inside their mapped type");
ok(filePreview.includes("readFilePreview(props.filePath, true)"), "text-typed suffixes force a backend text read (backend TEXT_EXTENSIONS is fixed)");
ok(filePreview.includes("previewKindOf(getExtension(props.fileName))"), "an open preview reloads when a settings save reclassifies its file");
ok(!filePreview.includes("() => [props.filePath,"), "the reload watch uses a value-comparable STRING key, not a fresh array (Vue compares getter results by identity)");

ok(!fileList.includes("VIDEO_EXTS"), "FileList.vue has no private video suffix list");
ok(fileList.includes('previewKindOf(ext) === "video"'), "autoplay-next uses the shared mapping");
ok(fileList.includes("const kind = previewKindOf(ext)"), "FileList.vue icons consult the shared mapping for user-added suffixes");

ok(!searchDialog.includes("const EXT_ICON"), "SearchDialog.vue has no private preview suffix table");
ok(searchDialog.includes("ICON_ONLY_EXTENSIONS"), "SearchDialog.vue keeps only NON-preview icon suffixes locally");
ok(searchDialog.includes("const kind = previewKindOf(ext)"), "SearchDialog.vue classifies search hits through the shared mapping");

ok(settingsDialog.includes("PREVIEW_TYPES") && settingsDialog.includes("v-for=\"type in types\""), "SettingsDialog renders one section PER preview type");
ok(settingsDialog.includes("addExtToType") && settingsDialog.includes("removeExtFromType"), "SettingsDialog delegates add/remove to the shared rules");
ok(settingsDialog.includes("findConflicts(drafts)"), "SettingsDialog validates the invariant before emitting a save");
ok(!/\.push\(/.test(settingsDialog), "SettingsDialog never bypasses the conflict check with a raw array push");
ok(settingsDialog.includes("resetType(type.key)") && settingsDialog.includes("resetAll()"), "per-type and global reset are both available");
ok(!settingsDialog.includes("extensions: { type: Array"), "SettingsDialog no longer takes a text-only extensions prop");
ok(settingsDialog.includes("isImeKeydown(e)") && !settingsDialog.includes("@keydown.enter.prevent"), "the suffix input's Enter handler has an IME guard and does not unconditionally preventDefault");

ok(store.includes('"preview-extensions"') && store.includes('"text-preview-extensions"'), "store reads the new config AND migrates the old one");
ok(store.includes("applyPreviewMapping") && store.includes("savePreviewExtConfig") && store.includes("claimTextPreviewExt"), "store owns apply / save / claim");
ok(store.includes("findConflicts(previewMapping)"), "store refuses to persist a conflicting mapping");
ok(store.includes("export const previewMapping = reactive("), "the mapping is a module-singleton reactive object shared by all consumers");

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
