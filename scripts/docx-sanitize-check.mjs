// Tests for src/docxSanitize.js -- the allowlist that stands between an
// attacker-authored .docx and the Tauri webview's IPC surface.
//
// Two rules this file exists to enforce:
//   1. The test imports the PRODUCTION module (../src/docxSanitize.js). Testing a
//      copy would let the real one rot unnoticed.
//   2. There is a control arm: the same payloads are run through the OLD
//      blacklist implementation. Without it, a harness that silently stopped
//      sanitizing would still report all-green -- exactly the failure mode where
//      "the bug looks like it does not exist".
//
// Run: node scripts/docx-sanitize-check.mjs

import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// dompurify's default export is a FACTORY under plain node (no DOM at import
// time), so sanitize() would be undefined. Seed the globals it reads at
// construction, then import the module under test.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NamedNodeMap = dom.window.NamedNodeMap;
globalThis.HTMLTemplateElement = dom.window.HTMLTemplateElement;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.trustedTypes = undefined;

const DOMPurify = (await import("dompurify")).default;

// Baseline for the hook-leak test, captured BEFORE any sanitizeDocxHtml() call
// runs. Comparing before/after is the only honest way to test "the hook did
// not leak": asserting on the absolute output would just be asserting on
// DOMPurify's own defaults (its built-in DATA_URI_TAGS permits data: on
// <img src>, which is precisely why this project needs the hook at all).
const BASELINE_BARE = DOMPurify.sanitize('<img src="data:text/html;base64,PHNjcmlwdD4=">', {
  ALLOWED_TAGS: ["img"], ALLOWED_ATTR: ["src"],
});

const mod = await import("../src/docxSanitize.js");
const { sanitizeDocxHtml, isAllowedInlineImageSrc, ALLOWED_TAGS, FORBID_TAGS } = mod;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

// ── the payloads ──
// Each is a way to reach script execution (or app-shell restyling) from inside
// the preview. `data:text/html` cases matter most: in a Tauri webview the main
// frame's origin is the app origin, and `window.__TAURI_INTERNALS__` is live
// there, so a same-origin navigation is arbitrary command execution.
const PAYLOADS = [
  ["script tag", "<p>hi</p><script>alert(1)</script>"],
  ["img onerror", '<img src="x" onerror="alert(1)">'],
  ["body onload", '<div onmouseover="alert(1)">hover</div>'],
  ["a javascript:", '<a href="javascript:alert(1)">click</a>'],
  ["a JaVaScRiPt mixed case", '<a href="JaVaScRiPt:alert(1)">click</a>'],
  ["a tab in scheme", '<a href="java&#9;script:alert(1)">click</a>'],
  ["a data:text/html", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>'],
  ["a data:text/html plain", '<a href="data:text/html,<script>alert(1)</script>">click</a>'],
  ["img data:text/html", '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">'],
  ["img data:text/html tab", '<img src="data:&#9;text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">'],
  ["img data:svg+xml", '<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+">'],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["iframe src javascript", '<iframe src="javascript:alert(1)"></iframe>'],
  ["object data", '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>'],
  ["embed", '<embed src="data:text/html,x">'],
  ["svg onload", '<svg onload="alert(1)"><circle r="10"/></svg>'],
  ["svg use xlink", '<svg><use xlink:href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"/></svg>'],
  ["math href", '<math><maction actiontype="statusline#javascript:alert(1)">x</maction></math>'],
  ["style block", '<style>body{display:none}</style><p>hi</p>'],
  ["style attr expr", '<div style="width:expression(alert(1))">x</div>'],
  ["link stylesheet", '<link rel="stylesheet" href="http://evil.example/x.css">'],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url=data:text/html,<script>alert(1)</script>">'],
  ["base tag", '<base href="http://evil.example/">'],
  ["form formaction", '<form action="http://evil.example/"><button formaction="javascript:alert(1)">go</button></form>'],
  ["input onfocus", '<input onfocus="alert(1)" autofocus>'],
  ["formaction on button", '<button formaction="javascript:alert(1)">go</button>'],
  ["template script", "<template><script>alert(1)</script></template>"],
  ["noscript mXSS", "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">"],
  ["details ontoggle", "<details open ontoggle=alert(1)>x</details>"],
  ["marquee onstart", "<marquee onstart=alert(1)>x</marquee>"],
  ["video onerror", '<video><source onerror="alert(1)"></video>'],
  ["a ping", '<a href="https://ok.example" ping="http://evil.example">x</a>'],
  ["xlink on a", '<a xlink:href="javascript:alert(1)" href="#">x</a>'],
];

// A structural check that does not depend on exact output text: nothing in the
// sanitized HTML may be able to execute or navigate. Attribute values are the
// risky part, so this looks at the parsed DOM rather than doing substring
// matching on the serialized string.
function assertInert(html, label) {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  for (const el of doc.body.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    assert.ok(
      !["script", "style", "iframe", "object", "embed", "form", "input",
        "button", "link", "meta", "base", "svg", "math", "template", "video",
        "audio", "source"].includes(tag),
      `${label}: <${tag}> survived`
    );
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      const v = attr.value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
      assert.ok(!n.startsWith("on"), `${label}: ${n} attribute survived`);
      assert.ok(
        !["srcdoc", "formaction", "action", "ping", "xlink:href"].includes(n),
        `${label}: ${n} attribute survived`
      );
      if (["href", "src", "xlink:href"].includes(n)) {
        assert.ok(
          !/^(?:javascript|data|vbscript|file):/.test(v) ||
            (n === "src" && tag === "img" && /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon);base64,/.test(v)),
          `${label}: dangerous URL survived in ${n}: ${v.slice(0, 60)}`
        );
      }
    }
  }
}

// ── control arm: the OLD blacklist implementation ──
// If this arm reports the payloads as "already safe", the payloads are wrong
// and every other assertion below is vacuous.
function oldBlacklist(html) {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  doc.querySelectorAll("script, style, iframe, object, embed, link, meta")
    .forEach((el) => el.remove());
  const walk = (node) => {
    if (node.nodeType === 1) {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on")) node.removeAttribute(attr.name);
        else if ((name === "href" || name === "src") && value.startsWith("javascript:")) {
          node.removeAttribute(attr.name);
        }
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// Count how many payloads the old implementation failed to neutralize.
const oldFailures = [];
for (const [name, payload] of PAYLOADS) {
  let inert = true;
  try {
    assertInert(oldBlacklist(payload), name);
  } catch {
    inert = false;
  }
  if (!inert) oldFailures.push(name);
}

check("control arm: old blacklist was actually bypassable", () => {
  assert.ok(
    oldFailures.length >= 3,
    `expected the old blacklist to miss several payloads, but it only missed ` +
    `${oldFailures.length} (${oldFailures.join(", ") || "none"}) -- the payload ` +
    `list is too weak to prove anything`
  );
});

// ── the actual tests ──

for (const [name, payload] of PAYLOADS) {
  check(`payload: ${name}`, () => {
    assertInert(sanitizeDocxHtml(payload), name);
  });
}

check("allowlist keeps ordinary document structure", () => {
  const out = sanitizeDocxHtml(
    "<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em>.</p>" +
    "<ul><li>one</li><li>two</li></ul>" +
    "<table><tr><td colspan=\"2\">cell</td></tr></table>"
  );
  for (const frag of ["<h1>", "Title", "<strong>", "bold", "<em>", "<li>", "one", "<table>", 'colspan="2"']) {
    assert.ok(out.includes(frag), `lost legitimate content: ${frag} (got: ${out})`);
  }
});

check("hyperlinks survive with a safe href", () => {
  const out = sanitizeDocxHtml('<a href="https://example.com/a?b=1">link</a>');
  assert.ok(out.includes('href="https://example.com/a?b=1"'), out);
  assert.ok(out.includes(">link"), out);
});

check("mailto and tel links survive", () => {
  assert.ok(sanitizeDocxHtml('<a href="mailto:a@b.c">m</a>').includes("mailto:a@b.c"));
  assert.ok(sanitizeDocxHtml('<a href="tel:+123">t</a>').includes("tel:+123"));
});

check("relative links survive", () => {
  assert.ok(sanitizeDocxHtml('<a href="#anchor">a</a>').includes("#anchor"));
  assert.ok(sanitizeDocxHtml('<a href="/docs/x.html">a</a>').includes("/docs/x.html"));
});

check("embedded docx images survive (data:image)", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const out = sanitizeDocxHtml(`<img src="${png}" alt="pic" width="10">`);
  assert.ok(out.includes(png), `legitimate inline image was dropped: ${out}`);
  assert.ok(out.includes('alt="pic"'), out);
});

check("data:image allowance is scoped to IMG@src", () => {
  // Same value, three places it must NOT be honoured.
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.ok(!sanitizeDocxHtml(`<a href="${png}">x</a>`).includes("data:"), "allowed in a@href");
  assert.ok(!sanitizeDocxHtml(`<img srcset="${png}">`).includes("data:"), "allowed in img@srcset");
  assert.ok(!isAllowedInlineImageSrc(png, "A"), "isAllowedInlineImageSrc accepted a non-IMG tag");
  assert.ok(!isAllowedInlineImageSrc(png, "svg"), "isAllowedInlineImageSrc accepted <svg>");
  assert.ok(isAllowedInlineImageSrc(png, "IMG"), "rejected a legitimate inline image");
  assert.ok(isAllowedInlineImageSrc(png, "img"), "rejected a legitimate inline image (lowercase)");
});

check("data:image/svg+xml is NOT an allowed inline image", () => {
  assert.ok(!isAllowedInlineImageSrc("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), "svg+xml accepted");
  const out = sanitizeDocxHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">');
  assert.ok(!out.includes("data:"), `svg payload survived: ${out}`);
});

check("non-image data: types are rejected everywhere", () => {
  for (const v of [
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:application/javascript,alert(1)",
    "data:image/png,notbase64", // right type, wrong encoding
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;charset=utf-8;base64,iVBORw0KGgo=", // extra parameter
  ]) {
    assert.ok(!isAllowedInlineImageSrc(v), `accepted as inline image: ${v}`);
    assert.ok(!sanitizeDocxHtml(`<img src="${v}">`).includes("data:"), `survived on img: ${v}`);
  }
});

check("data: obfuscated with control characters is rejected", () => {
  // Browsers strip C0 controls before resolving the scheme, so these are live.
  for (const v of ["data:\ttext/html,x", "data:\ntext/html,x", "data:\u0000text/html,x", "data: text/html,x"]) {
    assert.ok(!isAllowedInlineImageSrc(v), `accepted: ${JSON.stringify(v)}`);
    assert.ok(!sanitizeDocxHtml(`<img src="${v.replace(/\n/g, "")}">`).includes("data:"), `survived: ${JSON.stringify(v)}`);
  }
});

check("javascript: obfuscated with control characters is rejected", () => {
  const out = sanitizeDocxHtml('<a href="java&#9;script:alert(1)">x</a>');
  assert.ok(!out.toLowerCase().includes("script:"), out);
});

check("DOM clobbering via id/name is prevented", () => {
  const out = sanitizeDocxHtml('<p id="body">x</p><img name="location" src="a.png">');
  assert.ok(!/\sid=/.test(out), `id survived: ${out}`);
  assert.ok(!/\sname=/.test(out), `name survived: ${out}`);
});

check("ALLOWED_TAGS and FORBID_TAGS do not overlap", () => {
  const allowed = new Set(ALLOWED_TAGS);
  for (const t of FORBID_TAGS) {
    assert.ok(!allowed.has(t), `<${t}> is both allowed and forbidden`);
  }
});

check("allowlist itself contains nothing executable", () => {
  for (const t of ALLOWED_TAGS) {
    assert.ok(
      !["script", "style", "iframe", "object", "embed", "form", "input",
        "link", "meta", "base", "svg", "math", "template"].includes(t),
      `ALLOWED_TAGS contains a dangerous tag: ${t}`
    );
  }
});

check("non-string / empty input is handled", () => {
  for (const v of [null, undefined, 0, 123, {}, [], ""]) {
    assert.equal(sanitizeDocxHtml(v), "", `not empty for ${JSON.stringify(v)}`);
  }
});

check("sanitizing is idempotent", () => {
  const once = sanitizeDocxHtml("<p>hi</p><script>alert(1)</script><img src='data:text/html,x'>");
  assert.equal(sanitizeDocxHtml(once), once, "second pass changed the output");
});

check("the URI hook does not leak into later sanitize() calls", () => {
  // The hook is global state on the shared DOMPurify instance. If it leaked, a
  // bare call made after a docx preview would behave differently from the same
  // call made before one. Compared against BASELINE_BARE rather than an
  // absolute expectation, because DOMPurify's own defaults legitimately allow
  // data: on <img src>.
  sanitizeDocxHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
  const after = DOMPurify.sanitize('<img src="data:text/html;base64,PHNjcmlwdD4=">', {
    ALLOWED_TAGS: ["img"], ALLOWED_ATTR: ["src"],
  });
  assert.equal(after, BASELINE_BARE, "the hook leaked into a later sanitize() call");
});

check("mammoth's typical output round-trips", () => {
  // Shaped like real mammoth output: inline-styled runs, a list, a hyperlink.
  const html =
    '<p><strong>Title</strong></p><p><em>Sub</em></p>' +
    '<ol><li><p>first</p></li><li><p>second</p></li></ol>' +
    '<p><a href="https://example.com">ref</a></p>' +
    '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="diagram"></p>';
  const out = sanitizeDocxHtml(html);
  for (const frag of ["<strong>Title</strong>", "<em>Sub</em>", "<li>", "first", "https://example.com", "data:image/png"]) {
    assert.ok(out.includes(frag), `lost ${frag}: ${out}`);
  }
});

// ── CSP regression guard ──
// The sanitizer is the first line of defence; the CSP is the second. Both were
// part of the same P0, so both are guarded here: a future edit that flips
// `csp` back to null (which is what it was before this fix) would otherwise
// restore the vulnerability silently, with no test failing.
//
// Each source below is there because something in the app needs it -- the
// comment names the feature. Removing one to "tighten" the policy will break
// that feature at runtime, so the reason is recorded rather than implied.
const CSP_REQUIREMENTS = [
  // The whole frontend bundle is served from the app's own origin.
  ["default-src", "'self'", "应用自身源"],
  // 'wasm-unsafe-eval' is required by libheif (HEIC decode worker). Its wasm is
  // embedded as base64 and instantiated via WebAssembly, which CSP treats as
  // eval. Dropping this breaks HEIC preview.
  ["script-src", "'wasm-unsafe-eval'", "libheif 的 HEIC 解码（wasm 实例化）"],
  // Vue injects component <style> blocks at runtime.
  ["style-src", "'unsafe-inline'", "Vue 运行时注入的组件样式"],
  // Image/PDF/video preview all go through convertFileSrc() (asset protocol),
  // plus blob: for decoded HEIC pixels.
  ["img-src", "asset:", "图片/PDF/视频预览走 asset 协议"],
  ["img-src", "http://asset.localhost", "asset 协议（Windows 上的主机名形式）"],
  ["img-src", "blob:", "HEIC 解码后的 objectURL"],
  // Inline images embedded in a .docx render as data:image URLs.
  ["img-src", "data:", "docx 内嵌图片（data:image）"],
  ["media-src", "asset:", "视频预览走 asset 协议"],
  ["media-src", "blob:", "视频/字幕的 objectURL"],
  // Tauri IPC. Tauri's own docs put these in connect-src by hand -- it does NOT
  // add them automatically, so losing either one silently breaks every command.
  ["connect-src", "ipc:", "Tauri IPC（非 Windows 平台）"],
  ["connect-src", "http://ipc.localhost", "Tauri IPC（Windows）"],
  ["connect-src", "asset:", "fetch(convertFileSrc(...)) 读取本地文件"],
  ["frame-src", "asset:", "PDF 预览的 <iframe>"],
  // The HEIC decoder runs in a Worker (heicDecode.worker.js via Vite ?worker).
  ["worker-src", "blob:", "HEIC 解码 Worker"],
];

// Tauri accepts either form: an object keyed by directive, or one CSP string.
// Normalize so the guard does not report a false failure against a legitimate
// string-form policy.
function normalizeCsp(policy) {
  if (policy === null || policy === undefined) return null;
  if (typeof policy === "string") {
    const out = {};
    for (const part of policy.split(";")) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      out[tokens[0].toLowerCase()] = tokens.slice(1);
    }
    return out;
  }
  if (typeof policy === "object") return policy;
  return null;
}

function cspSources(policy, directive) {
  const v = policy[directive];
  if (v === undefined) return null;
  return Array.isArray(v) ? v : String(v).split(/\s+/).filter(Boolean);
}

function checkCsp(label, rawPolicy) {
  // The headline regression: no policy at all means the docx preview renders
  // with no CSP defence. Checked first and independently of the per-directive
  // assertions below, which cannot run when there is no policy to read.
  check(`csp[${label}] is not null/disabled`, () => {
    assert.notEqual(rawPolicy, null, "csp is null -- the docx preview has no CSP defence at all");
    assert.notEqual(rawPolicy, undefined, "csp is absent -- the docx preview has no CSP defence at all");
  });

  const policy = normalizeCsp(rawPolicy);
  check(`csp[${label}] is a valid object or string policy`, () => {
    assert.ok(policy, `csp is neither an object nor a string: ${JSON.stringify(rawPolicy)}`);
  });
  if (!policy) return;

  for (const [directive, source, why] of CSP_REQUIREMENTS) {
    check(`csp[${label}] ${directive} allows ${source} (${why})`, () => {
      const sources = cspSources(policy, directive);
      assert.ok(sources !== null, `${directive} is not declared at all -- needed for ${why}`);
      assert.ok(
        sources.includes(source),
        `${directive} is missing "${source}" (needed for ${why}); got ${JSON.stringify(sources)}`
      );
    });
  }
  // Directives that must stay closed. These are the ones that turn an XSS into
  // something worse: a <base> rewrites every relative URL in the document, and
  // form-action lets a crafted form ship data anywhere.
  for (const [directive, expected] of [["object-src", "'none'"], ["form-action", "'none'"]]) {
    check(`csp[${label}] ${directive} is ${expected}`, () => {
      const sources = cspSources(policy, directive);
      assert.deepEqual(sources, [expected], `${directive} should be ${expected}, got ${JSON.stringify(sources)}`);
    });
  }
}

const tauriConf = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
);
const security = tauriConf.app.security;
checkCsp("prod", security.csp);
checkCsp("dev", security.devCsp);

// devCsp must exist separately: without it Tauri applies the production policy
// to the dev server too, which breaks Vite HMR's websocket and inline scripts.
check("devCsp is set separately from csp", () => {
  assert.ok(security.devCsp, "devCsp missing -- production CSP would be applied to the vite dev server");
  assert.ok(
    (security.devCsp["connect-src"] || []).includes("ws://localhost:5173"),
    "devCsp connect-src does not allow the vite HMR websocket"
  );
});

// The asset protocol must stay enabled: convertFileSrc() is how every local
// file preview loads, and with the protocol off they all break.
check("assetProtocol stays enabled", () => {
  assert.equal(security.assetProtocol.enable, true, "assetProtocol disabled -- all local previews break");
});

// The whole point of the P0: the v-html sink must go through the allowlist, not
// a hand-rolled blacklist. Asserted statically against the source, because the
// vulnerable version was equally "present" -- only the callee differed.
check("FilePreview.vue routes v-html output through sanitizeDocxHtml", () => {
  const src = readFileSync(new URL("../src/components/FilePreview.vue", import.meta.url), "utf8");
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    /import\s*\{[^}]*sanitizeDocxHtml[^}]*\}\s*from\s*["'][^"']*docxSanitize\.js["']/.test(withoutComments),
    "FilePreview.vue does not import sanitizeDocxHtml from docxSanitize.js"
  );
  assert.ok(
    /sanitizeDocxHtml\s*\(/.test(withoutComments),
    "FilePreview.vue never calls sanitizeDocxHtml()"
  );
  // The old blacklist must be gone. Its two halves (on* stripping and the
  // javascript: prefix test) are the specific things that were insufficient.
  assert.ok(
    !/sanitizeHtml/.test(withoutComments),
    "FilePreview.vue still references the old blacklist (sanitizeHtml)"
  );
  assert.ok(
    !/querySelectorAll\(\s*["']script,\s*style/.test(withoutComments),
    "FilePreview.vue still contains the old blacklist element-removal list"
  );
});

// ── report ──
console.log(`docx sanitize: ${passed} passed, ${failures.length} failed`);
console.log(`control arm: old blacklist missed ${oldFailures.length}/${PAYLOADS.length} payloads`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("all docx sanitizer assertions passed");