#!/usr/bin/env node
// Pick the Node.js that dev.bat / dev.sh should run the toolchain with.
//
// WHY THIS EXISTS
// ---------------
// Both launchers used to resolve Node by taking the FIRST candidate they found:
//
//   dev.bat:  for /d %%v in ("...\versions\*") ... goto :node_found
//   dev.sh :  for dir in "$HOME/.workbuddy/binaries/node/versions"/* ...
//
// Both `for /d` and the bash glob enumerate in lexicographic order, so on a
// machine with 22.12.0 and 22.22.2 they always land on 22.12.0 -- the OLDEST
// one, silently. The failure mode is nasty: not an install error, but a
// runtime crash much later. jsdom 30 declares `engines.node: "^22.22.2"` and
// calls `zlib.createZstdDecompress` (node 22.15+); on 22.12.0 the whole test
// suite dies at *import* time with no warning. Declared engines are not a
// guarantee, so the version we pick has to be checked against what actually
// runs.
//
// Resolution order (deliberate, not alphabetical):
//   1. PATH, front to back -- an explicitly configured node wins, that is the
//      user's environment talking. We do NOT take the first PATH hit blindly:
//      if it fails `engines`, we keep scanning instead of giving up.
//   2. Well-known install locations, newest satisfying `engines`.
// A candidate is only accepted if it satisfies `engines.node`; if nothing
// satisfies it, the newest candidate overall is returned anyway (with a loud
// warning) -- refusing to pick anything would be worse than picking something
// and saying so.
//
// Usage:
//   node scripts/pick-node.js              prints the chosen directory (stdout)
//   node scripts/pick-node.js --print-all  prints "dir<TAB>version" per candidate
//
// Diagnostics go to STDERR so that dev.bat can capture stdout with `for /f`
// and get exactly one line. stdout carries the answer and nothing else.

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// How deep to look for node.exe under a version-manager root. fnm nests it as
// <multishell>/installation/node.exe, so depth 1 is not enough; 3 is plenty
// and still bounded (no unbounded recursion over a user profile).
const MAX_DEPTH = 3;

// ── version parsing / comparison ────────────────────────────────────────────

/** "v22.22.2" / "22.12.0" / " 22.22.2-6 " -> {major,minor,patch}; else null. */
function parseVersion(raw) {
  if (typeof raw !== "string") return null;
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Ascending: negative if a < b, 0 if equal, positive if a > b. */
function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

const TERM_RE = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Parse a node `engines` range into a predicate.
 * Returns null when the syntax is not one we understand -- callers must then
 * IGNORE the constraint rather than silently treating every candidate as
 * failing it (that would degrade to "pick nothing").
 */
function compileRange(range) {
  if (typeof range !== "string" || range.trim() === "") {
    return { test: () => true, understood: true };
  }
  const groups = range.split("||").map((g) => g.trim()).filter(Boolean);
  const terms = [];
  for (const g of groups) {
    for (const term of g.split(/\s+/)) {
      const m = TERM_RE.exec(term);
      if (!m) return null;
      terms.push({
        any: groups.length > 1 || g.split(/\s+/).length > 1,
        op: m[1] || "=",
        target: {
          major: Number(m[2]),
          minor: m[3] === undefined ? 0 : Number(m[3]),
          patch: m[4] === undefined ? 0 : Number(m[4]),
        },
      });
    }
  }
  // A range is a disjunction of conjunctions; splitting on "||" first and
  // remembering group membership is what makes ">=20 || >=22" behave.
  const groupSizes = groups.map((g) => g.split(/\s+/).filter(Boolean).length);
  let cursor = 0;
  const orGroups = groupSizes.map((size) => terms.slice(cursor, (cursor += size)));

  return {
    understood: true,
    test: (version) =>
      orGroups.some((conjunction) => conjunction.every((t) => termHolds(version, t))),
  };
}

function termHolds(version, { op, target }) {
  const c = compareVersions(version, target);
  switch (op) {
    case ">=": return c >= 0;
    case "<=": return c <= 0;
    case ">": return c > 0;
    case "<": return c < 0;
    case "=": return c === 0;
    // ^0.x is intentionally NOT special-cased (npm treats it differently);
    // our own engines string stays on simple comparators.
    case "^": return c >= 0 && version.major === target.major;
    case "~": return c >= 0 && version.major === target.major && version.minor === target.minor;
    default: return false;
  }
}

// ── candidate discovery ─────────────────────────────────────────────────────

/** Directories that may contain `node.exe`, shallowest first. */
function candidateRoots(env) {
  const home = env.USERPROFILE || env.HOME || "";
  const roots = [];
  // PATH entries are handled separately (they need probeVersion too, but they
  // are the *priority* source, so they stay a distinct list).
  for (const dir of [
    env.ProgramFiles ? path.join(env.ProgramFiles, "nodejs") : null,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "nodejs") : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "fnm_multishells") : null,
    home ? path.join(home, ".fnm") : null,
    home ? path.join(home, ".nvm", "versions", "node") : null,
    home ? path.join(home, ".workbuddy", "binaries", "node", "versions") : null,
  ]) {
    if (dir) roots.push(dir);
  }
  return roots;
}

/** Every PATH entry, in order, that actually contains node.exe. */
function pathCandidates(env, io) {
  const raw = env.PATH || env.Path || "";
  const sep = raw.includes(";") ? ";" : ":";
  const out = [];
  const seen = new Set();
  for (const entry of raw.split(sep)) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (io.exists(path.join(dir, "node.exe"))) out.push(dir);
  }
  return out;
}

/** Bounded search for `node.exe` under `dir`; returns absolute exe paths. */
function findNodeExes(dir, io, depth = 0, acc = []) {
  if (depth > MAX_DEPTH) return acc;
  let entries;
  try {
    entries = io.listDirs(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const child = path.join(dir, name);
    if (name.toLowerCase() === "node.exe") acc.push(child);
  }
  // Depth 0 is the root itself (ProgramFiles\nodejs\node.exe).
  for (const name of entries) {
    if (name.toLowerCase() === "node.exe") continue;
    const child = path.join(dir, name);
    if (!io.isDir(child)) continue;
    findNodeExes(child, io, depth + 1, acc);
  }
  return acc;
}

/** Well-known locations, newest first is decided later by pickBest. */
function wellKnownCandidates(env, io) {
  const out = [];
  for (const root of candidateRoots(env)) {
    // A root may itself hold node.exe, or hold version-named subdirs that do.
    for (const exe of findNodeExes(root, io)) {
      out.push(path.dirname(exe));
    }
  }
  return out;
}

// ── selection ───────────────────────────────────────────────────────────────

/**
 * candidates: [{dir, version}] where version is {major,minor,patch} or null.
 * Returns the chosen candidate, or null when there are none.
 */
function pickBest(candidates, accepts) {
  const usable = candidates.filter((c) => c && c.version);
  if (!usable.length) return null;
  const ok = usable.filter((c) => accepts(c.version));
  // Fall back to every candidate when none satisfies `accepts`. Refusing to
  // pick anything would leave the launcher with no node at all, which is
  // strictly worse than picking the newest and warning about it.
  //
  // The `ok.length ?` guard is load-bearing, and it is NOT equivalent to just
  // `pool = ok`: with an empty pool, `pool[0]` is `undefined` and the loop
  // body never runs, so the function would return `undefined` -- which
  // passes a `!== null` check at the call site while breaking every
  // `chosen.version` dereference. Hence an explicit pool check below.
  const pool = ok.length ? ok : usable;
  if (!pool.length) return null;
  let best = pool[0];
  for (const c of pool.slice(1)) {
    if (compareVersions(c.version, best.version) > 0) best = c;
  }
  return best;
}

// ── environment plumbing (injectable so the tests need no real filesystem) ──

function realIo() {
  return {
    exists: (p) => fs.existsSync(p),
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    listDirs: (p) => fs.readdirSync(p),
    // readEngines 依赖它。**曾经漏掉这一项** —— io.readFile is not a
    // function 抛出的 TypeError 被 readEngines 的 `catch {}` 吞掉，于是
    // engines 永远读成空串、按 engines 过滤的那段代码从未真正生效，
    // 而所有断言仍然全绿（因为"无约束时取最新"恰好也是想要的行为）。
    // 这类"约束静默失效"只能靠"故意构造违反约束的场景"来暴露。
    readFile: (p, enc) => fs.readFileSync(p, enc),
  };
}

/**
 * 读 package.json 的 engines.node。
 *
 * 失败时**区分两种情况**并都可见：读不到文件（正常，launcher 可能被拷到
 * 项目外）与文件在但解析失败（不正常，值得告警）。早先把两者一起
 * `catch { return "" }` 掉，第二个就成了静默失效。
 */
function readEngines(io, root) {
  let text;
  try {
    text = io.readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return { range: "", note: null };
  }
  try {
    const pkg = JSON.parse(text);
    return { range: (pkg.engines && pkg.engines.node) || "", note: null };
  } catch (e) {
    return {
      range: "",
      note: `[WARN] package.json is not valid JSON (${e.message}) -- ` +
        "ignoring engines.node.",
    };
  }
}

/** Ask the candidate itself. `node -p` beats parsing its folder name. */
function probeVersion(dir) {
  const r = spawnSync(path.join(dir, "node.exe"), ["-p", "process.versions.node"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  return parseVersion(String(r.stdout || "").trim());
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const io = realIo();
  const env = process.env;
  const root = ROOT;
  const { range: enginesRaw, note: enginesNote } = readEngines(io, root);
  const compiled = compileRange(enginesRaw);
  const warns = [];
  if (enginesNote) warns.push(enginesNote);

  let accepts = () => true;
  if (compiled) {
    accepts = compiled.test;
  } else {
    warns.push(
      `[WARN] could not parse engines.node "${enginesRaw}" -- ignoring the constraint.`
    );
  }

  const seen = new Set();
  const candidates = [];
  const add = (dir) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ dir: path.resolve(dir), version: probeVersion(dir) });
  };

  // PATH first, then well-known locations. pickBest re-orders by version, but
  // an explicit PATH entry outranks a discovered one at equal version.
  const ordered = [...pathCandidates(env, io), ...wellKnownCandidates(env, io)];
  const pathSet = new Set(pathCandidates(env, io).map((d) => path.resolve(d).toLowerCase()));
  for (const dir of ordered) {
    add(dir);
    if (candidates.length && pathSet.has(path.resolve(dir).toLowerCase())) {
      candidates[candidates.length - 1].onPath = true;
    }
  }

  for (const c of candidates.filter((c) => c.version && !accepts(c.version))) {
    warns.push(
      `[WARN] ${c.dir} (v${c.version.major}.${c.version.minor}.${c.version.patch}) ` +
        `does not satisfy engines.node "${enginesRaw}".`
    );
  }

  const chosen = pickBest(candidates, accepts);
  if (!chosen) {
    console.error("[ERROR] No usable node.exe found.");
    for (const w of warns) console.error(w);
    process.exit(1);
  }
  if (!accepts(chosen.version)) {
    warns.push(
      `[WARN] No candidate satisfies engines.node "${enginesRaw}" -- ` +
        `using the newest one available anyway.`
    );
  }

  // A PATH hit at the same version is the user's own choice; prefer it so the
  // launcher does not silently relocate node.
  const sameVersionOnPath = candidates.find(
    (c) => c.onPath && c.version && chosen.version &&
      compareVersions(c.version, chosen.version) === 0
  );
  const final = sameVersionOnPath || chosen;

  for (const w of warns) console.error(w);
  if (argv.includes("--print-all")) {
    for (const c of candidates) {
      const v = c.version
        ? `${c.version.major}.${c.version.minor}.${c.version.patch}`
        : "unknown";
      console.log(`${c.dir}\t${v}`);
    }
    return;
  }
  // Trailing separator on purpose: both launchers splice this straight into
  // PATH ("set PATH=%NODE_DIR%;%PATH%" / "export PATH=$NODE_BIN:$PATH"), and
  // a missing separator would make "C:\...\22.22.2-6node" out of the
  // concatenation -- silently producing a PATH entry that matches nothing.
  console.log(final.dir + path.sep);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  parseVersion,
  compareVersions,
  compileRange,
  candidateRoots,
  pathCandidates,
  wellKnownCandidates,
  pickBest,
  probeVersion,
};