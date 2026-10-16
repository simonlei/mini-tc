// "Is the user working with text, or with files?" -- the single answer every
// global keyboard handler needs before it claims a combo.
//
// This exists because the answer was previously written out four different
// ways, and they disagreed:
//   - App.vue's `isTypingTarget`  -> INPUT / TEXTAREA / isContentEditable
//   - the Ctrl+A guard             -> INPUT only
//   - the Ctrl+C/X/V guard         -> INPUT / TEXTAREA / isContentEditable (inlined)
//   - the Esc guard                -> INPUT / TEXTAREA / isContentEditable (inlined)
// The Ctrl+A one was the odd one out, and it is the visible bug: the text
// preview renders into `<pre class="preview-text">`, which is NOT an editable
// element and carries no tabindex, so clicking it leaves focus where it was.
// Ctrl+A therefore fell through to `getActivePanelRef().selectAll()` and
// selected the *file list* while the user meant to select the text in front
// of them. `isTypingTarget` alone cannot fix that -- the preview surface is
// not a typing target, which is exactly why the guard missed it.
//
// So the question is broader than "is this an input?": it is "does this event
// belong to a text surface?". Both halves are answered here.
//
// `.preview-text` (plain text / json / log) and `.preview-doc` (mammoth-rendered
// .docx) are the two user-selectable preview surfaces; both are non-editable,
// so a Ctrl+A on them must be handled explicitly (selectNodeContents) rather
// than deferred to the webview, which would select the whole document
// (file names included).

export const PREVIEW_TEXT_SELECTOR = ".preview-text, .preview-doc";

/**
 * True for elements that own their own text editing: the user typing into them
 * means the key belongs to the browser (native select-all, undo, paste).
 */
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return el.isContentEditable === true;
}

/**
 * The preview text surface containing `el`, or null.
 */
export function previewTextRoot(el) {
  if (!el || typeof el.closest !== "function") return null;
  return el.closest(PREVIEW_TEXT_SELECTOR);
}

/**
 * The preview text surface the current selection is anchored in, or null.
 *
 * Deliberately does NOT require a non-collapsed selection: a plain click into
 * the preview leaves a collapsed caret whose anchorNode is still inside the
 * text, and "select all" is precisely what a user asks for at that moment.
 * (The Ctrl+C guard uses a stricter test -- see App.vue's
 * hasPreviewTextSelection -- because copying a collapsed caret should NOT
 * shadow the file clipboard.)
 */
export function selectionPreviewRoot(selection) {
  if (!selection || !selection.anchorNode) return null;
  const node = selection.anchorNode;
  const el = node.nodeType === 3 ? node.parentElement : node;
  return previewTextRoot(el);
}

/**
 * Decide what Ctrl+A means for the current event.
 *
 * Returns one of:
 *   "native"      -- an editable element owns the key; let the webview do it.
 *   "previewText" -- the preview text surface owns the key; select its contents.
 *   "fileGrid"    -- nothing text-related is focused; select the file list.
 *
 * `target` is the event target (may be <body> when nothing is focused),
 * `selection` is `window.getSelection()`.
 */
export function classifySelectAll(target, selection) {
  if (isTypingTarget(target)) return "native";
  if (previewTextRoot(target)) return "previewText";
  if (selectionPreviewRoot(selection)) return "previewText";
  return "fileGrid";
}

/**
 * Select the entire contents of a preview text surface.
 *
 * Returns false when there is nothing to select (no root, or the webview
 * refuses to hand out a Selection) so the caller can fall back to the file
 * grid rather than swallowing the key.
 */
export function selectAllPreviewText(root, doc, view) {
  if (!root || !doc || typeof doc.createRange !== "function") return false;
  const selection = view && typeof view.getSelection === "function" ? view.getSelection() : null;
  if (!selection || typeof selection.addRange !== "function") return false;
  const range = doc.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}