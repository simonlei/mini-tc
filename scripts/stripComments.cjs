/// Strip comments from JS/Vue source while preserving line positions.
///
/// Shared by `lint-imports.js` (also CommonJS, `require`s this) and the
/// pure-logic test scripts (ESM, default-imports this) — see
/// `format-size-check.mjs`, which needs to know whether `Number.isFinite`
/// appears *before* `Math.log` in real code. That is a positional constraint,
/// and this file's own comment block mentions both names, so searching the raw
/// text would let the documentation satisfy the assertion on its own. Stripping
/// first is the only way to make the check mean what it says.
///
/// Replaces characters with spaces rather than deleting, so a byte offset or
/// `indexOf` result still points at the right line and a failure message keeps
/// its original line numbering. `//` is only consumed when not preceded by a
/// colon, so `http://` inside a string literal survives.
///
/// CommonJS on purpose: `lint-imports.js` uses `require` + `__dirname` and
/// there is no `"type": "module"` in package.json. ESM callers get it via
/// `import mod from "./stripComments.cjs"`, which Node supports natively.
module.exports.stripComments = function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
};
