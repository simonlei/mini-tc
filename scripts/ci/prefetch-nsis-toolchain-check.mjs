// 验证 CI 预取 NSIS 工具链的脚本：解压、目录解析、常量读取、平台差异。
//
// 直接 `node scripts/ci/prefetch-nsis-toolchain-check.mjs`。
//
// 为什么这脚本也要有测试：它跑在 CI 上，失败的表现是「发布挂掉」，而不是
// 单元测试报红 —— 没人会在合入前发现它解压解错了目录名。所以这里把最容易
// 出错的几个纯逻辑点单独钉住：
//
//   ① ZIP 解压要正确剥掉顶层目录（NSIS 包是 nsis-3.11/…，bundler 期望 NSIS/…）；
//   ② 要挡掉目录穿越条目（条目名来自网络）；
//   ③ 必需文件清单要和 bundler 2.9.4 的一致（少一个 bundler 就整目录重下，等于白下）；
//   ④ 工具目录要和 Rust 侧 dirs::cache_dir() 对齐，否则 bundler 根本不去那里找；
//   ⑤ Windows 与非 Windows 需要的文件不同（非 Windows 只要插件 DLL）。
//
// 不测的部分：真实网络下载（依赖外网，CI 里才是它的主场）。
// 端到端那次真下载由 GitHub Actions 自己验证。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_REL,
  WINDOWS_REQUIRED_FILES,
  FALLBACK_CONSTANTS,
  commonTopSegment,
  extractZip,
  findCliBinary,
  missingRequiredFiles,
  readBundlerConstants,
  requiredFiles,
  resolveConstants,
  sha1,
  toolsDirectory,
} from "./prefetch-nsis-toolchain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

// ── 造一个最小 ZIP ────────────────────────────────────────────────
// ZIP 结构：本地文件头 + 数据 + 中央目录 + 结束记录。
// 这里只造「deflate（方法 8）」，因为 NSIS 包全是 deflate。

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) >>> 0 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10); // method: deflate
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nsis-prefetch-check-"));

// ── ① 解压：剥掉顶层目录 ──────────────────────────────────────────
section("ZIP 解压");

{
  const zip = makeZip([
    { name: "nsis-3.11/makensis.exe", data: Buffer.from("MAKENSIS") },
    { name: "nsis-3.11/Bin/makensis.exe", data: Buffer.from("BIN") },
    { name: "nsis-3.11/Include/MUI2.nsh", data: Buffer.from("MUI2") },
  ]);

  const dest = path.join(TMP, "strip");
  const written = extractZip(zip, dest, { stripTopLevel: true });
  check("解压写入 3 个文件", written === 3);
  check("剥掉顶层目录后 makensis.exe 在根下", fs.existsSync(path.join(dest, "makensis.exe")));
  check(
    "嵌套目录结构保留（Bin/makensis.exe）",
    fs.existsSync(path.join(dest, "Bin", "makensis.exe"))
  );
  check("深层目录保留（Include/MUI2.nsh）", fs.existsSync(path.join(dest, "Include", "MUI2.nsh")));
  check(
    "内容正确",
    fs.readFileSync(path.join(dest, "makensis.exe"), "utf8") === "MAKENSIS"
  );

  // 不剥顶层目录时，条目名原样落地。
  const dest2 = path.join(TMP, "nostrip");
  extractZip(zip, dest2, { stripTopLevel: false });
  check(
    "不剥时保留原目录名",
    fs.existsSync(path.join(dest2, "nsis-3.11", "makensis.exe"))
  );
}

// ── ② 目录穿越要挡掉 ─────────────────────────────────────────────
section("目录穿越防护");

{
  let threw = null;
  try {
    extractZip(makeZip([{ name: "../evil.txt", data: Buffer.from("X") }]), path.join(TMP, "esc"), {
      stripTopLevel: false,
    });
  } catch (e) {
    threw = e;
  }
  check("含 .. 的条目名被拒绝", threw !== null);
  check("拒绝时给出可读原因", threw !== null && /非法条目路径/.test(threw.message));
  check("没有把文件写到目标目录外", !fs.existsSync(path.join(TMP, "evil.txt")));
}

// ── ③ 必需文件清单 ────────────────────────────────────────────────
section("必需文件清单");

{
  // bundler 2.9.4 的 NSIS_REQUIRED_FILES（Windows）。
  const expected = [
    "makensis.exe",
    "Bin/makensis.exe",
    "Stubs/lzma-x86-unicode",
    "Stubs/lzma_solid-x86-unicode",
    "Plugins/x86-unicode/additional/nsis_tauri_utils.dll",
    "Include/MUI2.nsh",
    "Include/FileFunc.nsh",
    "Include/x64.nsh",
    "Include/nsDialogs.nsh",
    "Include/WinMessages.nsh",
    "Include/Win/COM.nsh",
    "Include/Win/Propkey.nsh",
    "Include/Win/RestartManager.nsh",
  ];
  check(
    "Windows 清单与 bundler 2.9.4 一致",
    JSON.stringify(WINDOWS_REQUIRED_FILES) === JSON.stringify(expected)
  );
  check("插件路径与 bundler 一致", PLUGIN_REL === expected[4]);
  check("Windows 需要完整工具链", requiredFiles("win32").length === expected.length);
  check("非 Windows 只要插件 DLL", JSON.stringify(requiredFiles("darwin")) === JSON.stringify([PLUGIN_REL]));
  check("Linux 同样只要插件 DLL", JSON.stringify(requiredFiles("linux")) === JSON.stringify([PLUGIN_REL]));
}

// ── ④ 工具目录要和 dirs::cache_dir() 对齐 ────────────────────────
section("工具目录");

{
  const home = path.join("C:", "Users", "runner");
  check(
    "Windows 用 %LOCALAPPDATA%\\tauri",
    toolsDirectory("win32", { LOCALAPPDATA: path.join(home, "AppData", "Local") }, home) ===
      path.join(home, "AppData", "Local", "tauri")
  );
  check(
    "macOS 用 ~/Library/Caches/tauri",
    toolsDirectory("darwin", {}, home) === path.join(home, "Library", "Caches", "tauri")
  );
  check(
    "Linux 用 $XDG_CACHE_HOME/tauri",
    toolsDirectory("linux", { XDG_CACHE_HOME: "/tmp/xdg" }, home) === path.join("/tmp/xdg", "tauri")
  );
  check(
    "Linux 无 XDG 时用 ~/.cache/tauri",
    toolsDirectory("linux", {}, home) === path.join(home, ".cache", "tauri")
  );
  check(
    "TAURI_TOOLS_DIR 可覆盖（测试用）",
    toolsDirectory("win32", { TAURI_TOOLS_DIR: "/tmp/override" }, home) === path.resolve("/tmp/override")
  );
}

// ── ⑤ 缺文件要能查出来 ────────────────────────────────────────────
section("缺失检测");

{
  const empty = path.join(TMP, "empty");
  fs.mkdirSync(empty, { recursive: true });
  const missing = missingRequiredFiles(empty, "win32");
  check("空目录下报出全部缺失项", missing.length === WINDOWS_REQUIRED_FILES.length);
  check("缺失项就是清单本身", JSON.stringify(missing) === JSON.stringify(WINDOWS_REQUIRED_FILES));

  const partial = path.join(TMP, "partial");
  fs.mkdirSync(path.join(partial, "Bin"), { recursive: true });
  fs.writeFileSync(path.join(partial, "makensis.exe"), "x");
  check(
    "部分存在时只报剩下缺的",
    missingRequiredFiles(partial, "win32").length === WINDOWS_REQUIRED_FILES.length - 1
  );
}

// ── ⑥ 从 CLI 二进制读常量 ─────────────────────────────────────────
section("CLI 常量读取");

{
  // 构造一段仿二进制：URL 后面紧跟 SHA1（Rust 常量在二进制里的排布）。
  const fake =
    "xx" +
    "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip" +
    "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D" +
    "yy" +
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll" +
    "75197FEE3C6A814FE035788D1C34EAD39349B860" +
    "zz";
  const parsed = readBundlerConstants(Buffer.from(fake, "latin1"));
  check("读出 NSIS zip 地址", parsed?.nsisZipUrl?.endsWith("nsis-3.11.zip") === true);
  check("读出 NSIS zip 哈希", parsed?.nsisZipSha1 === "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D");
  check("读出插件地址", parsed?.tauriUtilsUrl?.endsWith("nsis_tauri_utils.dll") === true);
  check("读出插件哈希", parsed?.tauriUtilsSha1 === "75197FEE3C6A814FE035788D1C34EAD39349B860");

  // 二进制里没有这些常量时必须返回 null，而不是给出错的常量。
  check("没有常量时返回 null", readBundlerConstants(Buffer.from("nothing here", "latin1")) === null);

  // 有 URL 但后面跟的不是合法 SHA1 —— 必须判为「读不出」，退回兜底常量。
  // 这一条不能省：否则「找不到哈希就悄悄返回别的东西」这类退化实现能蒙混过关。
  const urlOnly =
    "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip" +
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll";
  check("有 URL 但无哈希时返回 null", readBundlerConstants(Buffer.from(urlOnly, "latin1")) === null);

  // 有 URL、后面跟的是纯数字长串（Rust 的查表常量，不是 SHA1）—— 同样不能当成哈希。
  const digitsOnly =
    "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip" +
    "0123456789012345678901234567890123456789" +
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll" +
    "0123456789012345678901234567890123456789";
  check("纯数字长串不被当成 SHA1", readBundlerConstants(Buffer.from(digitsOnly, "latin1")) === null);

  // 兜底常量必须自洽：哈希是 40 位十六进制。
  check(
    "兜底常量哈希格式正确",
    /^[0-9A-F]{40}$/.test(FALLBACK_CONSTANTS.nsisZipSha1) &&
      /^[0-9A-F]{40}$/.test(FALLBACK_CONSTANTS.tauriUtilsSha1)
  );

  // 真实的 CLI 二进制（本机装了才测）。
  const bin = findCliBinary();
  if (bin) {
    const real = readBundlerConstants(fs.readFileSync(bin));
    check("真实 CLI 二进制里读得出常量", real !== null);
    check("真实常量与兜底常量一致（CLI 未升级）", real?.nsisZipSha1 === FALLBACK_CONSTANTS.nsisZipSha1);
  } else {
    console.log("  --   本机没装 tauri CLI，跳过真实二进制校验");
  }

  // 读不到时退回兜底常量。
  const fallback = resolveConstants(() => null);
  check("读不到时退回兜底常量", fallback.nsisZipSha1 === FALLBACK_CONSTANTS.nsisZipSha1);
  check("兜底来源被标注出来", typeof fallback.source === "string" && fallback.source.length > 0);
}

// ── ⑦ 顶层目录判定 ────────────────────────────────────────────────
section("顶层目录判定");

{
  check("单一顶层目录能识别", commonTopSegment(["a/x", "a/y"]) === "a");
  check("多个顶层目录不识别", commonTopSegment(["a/x", "b/y"]) === null);
  check("无顶层目录（直接是文件）不识别", commonTopSegment(["x", "y"]) === null);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n通过 ${passed} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
