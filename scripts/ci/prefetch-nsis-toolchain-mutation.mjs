// 变异测试：确认 prefetch-nsis-toolchain-check.mjs 的断言真能抓到退化实现。
//
// 这个脚本跑在 CI 上，坏了的表现是「发布挂掉」而不是「测试报红」——
// 所以断言必须有分辨力，否则套件全绿并不代表它能挡住什么。
//
// 这里每个变异都必须让套件 FAIL；漏掉一个即视为对应断言恒真。
//
// 还原只用内存原文写回（绝不 git checkout —— 那样会把本轮刚做好的修复一起回滚）。
//
// Run: node scripts/ci/prefetch-nsis-toolchain-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITE = path.join(ROOT, "scripts", "ci", "prefetch-nsis-toolchain-check.mjs");
const TARGET = path.join(ROOT, "scripts", "ci", "prefetch-nsis-toolchain.mjs");

const originals = {
  [TARGET]: fs.readFileSync(TARGET, "utf8"),
};

const MUTANTS = [
  // ── 解压：不再剥顶层目录 ────────────────────────────────────────
  {
    name: "解压不剥顶层目录（bundler 会找不到 NSIS/makensis.exe）",
    from: "  const top = stripTopLevel ? commonTopSegment(entries.map((e) => e.name)) : null;",
    to: "  const top = null;",
  },
  // ── 解压：漏掉压缩方法判断，坏数据直接当原文写盘 ──────────────
  {
    name: "解压不处理 deflate（写出的是压缩数据）",
    from: "    else if (entry.method === 8) data = zlib.inflateRawSync(raw);",
    to: "    else if (entry.method === 8) data = Buffer.from(raw);",
  },
  // ── 目录穿越防护被去掉 ──────────────────────────────────────────
  {
    name: "去掉目录穿越防护",
    from: '    if (!rel || rel.split("/").includes("..") || path.isAbsolute(rel)) {',
    to: "    if (false) {",
  },
  // ── 必需文件清单少一项 ──────────────────────────────────────────
  {
    name: "Windows 必需文件清单少一项（bundler 会整目录重下）",
    from: '  "Include/Win/RestartManager.nsh",\n];',
    to: '  "Include/Win/RestartManager.nsh",\n].slice(0, 12);',
  },
  // ── 非 Windows 也要求完整工具链 ────────────────────────────────
  {
    name: "非 Windows 也要完整工具链（多下 2.4MB，且与 bundler 期望不符）",
    from: '  return platform === "win32" ? WINDOWS_REQUIRED_FILES : [PLUGIN_REL];',
    to: "  return WINDOWS_REQUIRED_FILES;",
  },
  // ── 工具目录算错 ────────────────────────────────────────────────
  {
    name: "Windows 工具目录算成 %APPDATA%（bundler 根本不去那儿找）",
    from: "    const local = env.LOCALAPPDATA || path.join(home, \"AppData\", \"Local\");",
    to: "    const local = env.APPDATA || path.join(home, \"AppData\", \"Roaming\");",
  },
  // ── macOS 工具目录算错 ──────────────────────────────────────────
  {
    name: "macOS 工具目录算成 ~/.cache（bundler 找不到）",
    from: '  if (platform === "darwin") return path.join(home, "Library", "Caches", "tauri");',
    to: '  if (platform === "darwin") return path.join(home, ".cache", "tauri");',
  },
  // ── 缺失检测永远返回空 ──────────────────────────────────────────
  {
    name: "缺失检测恒返回空（工具链不全也当齐了）",
    from: "  return requiredFiles(platform).filter(\n    (f) => !fs.existsSync(path.join(nsisDir, ...f.split(\"/\")))\n  );",
    to: "  return [];",
  },
  // ── 常量读取：URL 后面不再找哈希 ───────────────────────────────
  {
    name: "读常量时不再找 SHA1（拿不到就返回 null，脚本退到兜底）",
    from: "  if (!zipSha1 || !dllSha1) return null;",
    to: "  if (!zipSha1 || !dllSha1) return { ...FALLBACK_CONSTANTS };",
  },
  // ── 常量读取：把纯数字长串也当哈希 ─────────────────────────────
  {
    name: "SHA1 匹配放宽到纯数字串（会误配查表常量）",
    from: '  if (!m || !/[A-F]/.test(m[0])) return null;',
    to: "  if (!m) return null;",
  },
  // ── 顶层目录判定放宽 ────────────────────────────────────────────
  {
    name: "顶层目录判定不检查唯一性（多层目录时剥错）",
    from: "  return tops.size === 1 ? [...tops][0] : null;",
    to: "  return [...tops][0];",
  },
];

// ⚠️ 锚点的换行符必须按目标文件归一化。实测本仓库 .mjs 是 LF。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;
let passed = 0;
const failures = [];

for (const mu of MUTANTS) {
  // 默认所有变异都打在预取脚本上；需要打别的文件时用 mu.target 覆盖。
  const target = mu.target || TARGET;
  const original = originals[target];
  const from = nlFor(target, mu.from);
  const to = nlFor(target, mu.to);

  if (original === undefined) {
    failures.push(`${mu.name}（目标文件不存在：${target}）`);
    console.log(`  FAIL ${mu.name} —— 目标文件不存在`);
    continue;
  }
  if (!original.includes(from)) {
    failures.push(`${mu.name}（锚点未命中，变异没注入）`);
    console.log(`  FAIL ${mu.name} —— 锚点没命中`);
    continue;
  }

  let failedNow = 0;
  let out = "";
  try {
    fs.writeFileSync(target, original.split(from).join(to), "utf8");
    try {
      execFileSync(process.execPath, [SUITE], { encoding: "utf8" });
    } catch (e) {
      failedNow = 1;
      out = (e.stdout || "") + (e.stderr || "");
    }
  } finally {
    fs.writeFileSync(target, original, "utf8");
  }

  if (failedNow) {
    passed++;
    const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
    console.log(
      `  ok   变异被断言抓到（FAIL 如预期）${firstFail ? " | " + firstFail.trim() : ""}`
    );
  } else {
    failures.push(mu.name);
    console.log("  FAIL 变异未被抓到 —— 该断言是恒真的");
  }
}

console.log(`\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length) process.exitCode = 1;
