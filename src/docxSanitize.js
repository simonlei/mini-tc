// ── docx preview sanitizer ──
// mammoth turns OOXML into HTML, and that HTML reaches the webview through
// `v-html`. The document is user-supplied and fully attacker-controlled: a
// .docx is a ZIP of XML, so anyone who can hand you a file (download, email
// attachment, USB) chooses its markup.
//
// In a Tauri webview a same-origin navigation is equivalent to arbitrary
// command execution: `window.__TAURI_INTERNALS__` is live on whatever origin
// the main frame sits on, so a document that makes the webview navigate to
// attacker-controlled HTML inherits the full IPC surface (read files, delete
// files, run commands). The previous implementation was a blacklist (strip
// <script>, strip on*, strip `javascript:`) and missed exactly that: it let
// `<a href="data:text/html,<script>…">` through untouched.
//
// So this is an explicit ALLOWLIST: anything unnamed is dropped, which makes
// the safe default "invisible" rather than "something we remembered to block".
// DOMPurify is used rather than a hand-rolled walker because the bypass surface
// (mutation XSS, namespace confusion, parser differentials) is exactly what
// gets re-discovered yearly; it is audited against those and is the most
// widely deployed HTML sanitizer.
//
// This module is deliberately plain (no Vue, no Tauri imports) so that
// scripts/docx-sanitize-check.mjs can load it directly under plain node -- the
// test must exercise THIS file, not a copy of it.

import DOMPurify from "dompurify";

// mammoth's documented output subset. Keeping this list tight is the point:
// a tag nobody thought about cannot be introduced later by a dependency bump.
export const ALLOWED_TAGS = [
  "p", "br", "hr", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "u", "s", "sub", "sup", "small", "mark",
  "blockquote", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "a", "img",
];

export const ALLOWED_ATTR = [
  "href", "src", "alt", "title", "width", "height",
  "colspan", "rowspan", "align", "valign",
];

// Belt-and-braces on top of ALLOWED_TAGS: naming the dangerous ones here means
// a future edit that widens ALLOWED_TAGS still cannot walk them back in.
// `<style>` matters most -- CSS can exfiltrate file bytes and restyle the
// whole app shell, which is not "just" a rendering bug.
export const FORBID_TAGS = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed",
  "applet", "form", "input", "button", "select", "option", "textarea",
  "link", "meta", "base", "svg", "math", "template", "noscript",
  "audio", "video", "source", "track",
];

export const FORBID_ATTR = [
  "srcdoc", "formaction", "action", "ping", "xlink:href", "background",
  "dynsrc", "lowsrc", "http-equiv",
];

// URL schemes allowed in href/src. Deliberately NOT `data:` -- `data:text/html`
// is a same-origin scripting vector (see file header).
//
// Semantics: a value with no scheme match is a relative URL, which resolves
// inside the app origin and cannot introduce a new scheme, so it is allowed.
export const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/|[^:]*$)/i;

// Attributes that can carry a URL. Checked in the hook below.
const URI_ATTRS = new Set(["src", "href", "xlink:href"]);

// The one legitimate need for inline bytes: images embedded in a .docx, which
// mammoth emits as data:image/...;base64. Note `svg+xml` is NOT in the list --
// an SVG is a scripting context, so allowing it here would reintroduce the
// exact hole this file exists to close. Whitespace is tolerated inside the
// base64 payload because HTML attribute values may legitimately contain it.
const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon);base64,[a-z0-9+/=\s]*$/i;

// C0 controls and space, stripped before inspecting a URL. Browsers ignore
// these when resolving a scheme, so "java\tscript:" and "data:\ttext/html" are
// live vectors that a naive startsWith("data:") test would wave through.
const URL_NOISE_RE = /[\u0000-\u0020\u007f-\u009f]/g;

/** True for the only data: value we permit: an inline image on <img src>. */
export function isAllowedInlineImageSrc(value, tagName = "IMG") {
  if (typeof value !== "string") return false;
  if (String(tagName).toUpperCase() !== "IMG") return false;
  return DATA_IMAGE_RE.test(value.replace(URL_NOISE_RE, ""));
}

/**
 * Sanitize mammoth's HTML output for display via v-html.
 *
 * @param {string} html raw HTML from mammoth.convertToHtml()
 * @returns {string} HTML safe to inject into the main document
 */
export function sanitizeDocxHtml(html) {
  if (typeof html !== "string" || html === "") return "";

  // Hooks live on the module-level DOMPurify instance, i.e. GLOBAL state, so it
  // is added and removed around exactly one call. It must not outlive the call:
  // left attached it would widen the URI policy of any other sanitize() in the
  // app (including ones added later for other features).
  //
  // The hook exists because DOMPurify's ALLOWED_URI_REGEXP is NOT the last word
  // on URLs. Verified in 3.4.17 (purify.es.mjs:2164): after the regex is
  // consulted, a final clause allows any `data:` value on src/href/xlink:href
  // when the tag is in DATA_URI_TAGS -- and that built-in set contains `img`.
  // So `<img src="data:text/html;base64,…">` survives a regex that rejects
  // data: outright. ADD_DATA_URI_TAGS cannot fix this: it is resolved with
  // `_resolveSetOption(..., { base: DEFAULT_DATA_URI_TAGS })`, which MERGES the
  // caller's array into the default set, so passing `[]` leaves the defaults
  // intact. Enforcing the data: policy here is the only way to narrow it.
  const hook = (node, data) => {
    const value = typeof data.attrValue === "string" ? data.attrValue : "";
    if (!URI_ATTRS.has(data.attrName)) return;
    if (!/^data:/i.test(value.replace(URL_NOISE_RE, ""))) return;
    if (isAllowedInlineImageSrc(value, node.nodeName)) return;
    data.keepAttr = false;
  };

  DOMPurify.addHook("uponSanitizeAttribute", hook);
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOWED_URI_REGEXP,
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      SANITIZE_DOM: true,
      // id/name from an untrusted document would allow DOM clobbering
      // (document.foo = ...), so those attributes are not allowed at all.
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      // Never let the untrusted document restyle or restate the app shell.
      SANITIZE_NAMED_PROPS: true,
    });
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute", hook);
  }
}