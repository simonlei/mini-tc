#!/usr/bin/env node
// 预取 Tauri 打包所需的 NSIS 工具链（CI 专用）。
//
// 背景：tauri-bundler 在「打安装包」这一步才去 GitHub Release 下载 NSIS，
// 而且是单次请求、没有重试。GitHub Release 的资源 CDN 偶发 504，于是整条
// 发布流水线在编译完 6 分半之后挂在最后一步：
//
//     Info Verifying NSIS package
//     Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip
//     Error failed to bundle project: `http status: 504`
//
// 失败点还会漂移（这次是 nsis-3.11.zip，下次是 nsis_tauri_utils.dll），
// 说明是链路抖动而不是文件缺失 —— 单纯重跑有时能过，但不可靠。
//
// 做法：在跑 tauri build 之前先把工具链下好、校验哈希、放到 bundler 期望的
// 位置。bundler 发现目录已存在、必需文件齐全、插件 DLL 哈希正确，就不会再联网。
//
// 工具链只需要按平台准备：
//   - Windows：完整的 NSIS（makensis.exe 等）+ 插件 DLL；
//   - macOS / Linux：只要插件 DLL（NSIS 工具本身用系统装的 makensis）。
//     bundler 里对应的是 `#[cfg(not(target_os = "windows"))]` 那份必需文件清单。
//
// 下载地址与 SHA1 不写死在脚本里，而是从本仓库安装的 tauri CLI 二进制里读
// （那就是 bundler 自己用的那份常量），所以升级 @tauri-apps/cli 时不需要
// 手工同步 NSIS 版本号。读不到就退回脚本内记录的兜底常量。
//
// 幂等：工具链已就位就直接退出，因此每轮 CI 都可以无条件跑这个步骤。
//
// 失败不致命：预取失败只告警并继续，让 bundler 自己再试一次（它至少还有
// 官方源这条路）。这个脚本只能让构建更快更稳，不能把原本能过的构建搞挂。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// 插件 DLL 的相对路径。bundler 把插件装在 NSIS/Plugins/x86-unicode/additional/ 下，
// 两个平台一致。
export const PLUGIN_REL = "Plugins/x86-unicode/additional/nsis_tauri_utils.dll";

// Windows 下 bundler 要求的全部文件（tauri-bundler 2.9.4 的 NSIS_REQUIRED_FILES）。
// 少一个，bundler 就认定目录不完整、把整个目录删掉重新下载 —— 那就等于白下。
export const WINDOWS_REQUIRED_FILES = [
  "makensis.exe",
  "Bin/makensis.exe",
  "Stubs/lzma-x86-unicode",
  "Stubs/lzma_solid-x86-unicode",
  PLUGIN_REL,
  "Include/MUI2.nsh",
  "Include/FileFunc.nsh",
  "Include/x64.nsh",
  "Include/nsDialogs.nsh",
  "Include/WinMessages.nsh",
  "Include/Win/COM.nsh",
  "Include/Win/Propkey.nsh",
  "Include/Win/RestartManager.nsh",
];

// 读不到 CLI 二进制时的兜底常量，对应 @tauri-apps/cli 2.11.x 内置的
// tauri-bundler 2.9.4。升级 CLI 后如果二进制读法失效，这里也要跟着改。
export const FALLBACK_CONSTANTS = {
  nsisZipUrl:
    "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip",
  nsisZipSha1: "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D",
  tauriUtilsUrl:
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll",
  tauriUtilsSha1: "75197FEE3C6A814FE035788D1C34EAD39349B860",
};

// 抓取顺序：先官方源，官方源抽风再退到代理。代理只影响可用性，不影响完整性 ——
// 每个文件都按 bundler 自己的 SHA1 校验过。
const SOURCES = [
  { name: "github.com", prefix: "" },
  { name: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
  { name: "ghfast.top", prefix: "https://ghfast.top/" },
];

const ATTEMPTS_PER_SOURCE = 2;
const FETCH_TIMEOUT_MS = 60_000;
const TOTAL_DEADLINE_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI 二进制里的常量 ─────────────────────────────────────────────

// 找到本平台安装的 tauri CLI 原生二进制（npm 只会装当前平台的那个）。
export function findCliBinary(root = ROOT) {
  const scope = path.join(root, "node_modules", "@tauri-apps");
  if (!fs.existsSync(scope)) return null;

  const token = { win32: "win32", darwin: "darwin", linux: "linux" }[process.platform];

  const candidates = [];
  for (const dir of fs.readdirSync(scope)) {
    if (!dir.startsWith("cli-")) continue;
    const dirPath = path.join(scope, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith(".node")) {
        candidates.push({ dir, file: path.join(dirPath, file) });
      }
    }
  }
  if (candidates.length === 0) return null;

  const preferred = candidates.find((c) => token && c.dir.includes(token));
  return (preferred || candidates[0]).file;
}

// SHA1 在二进制里紧跟在对应 URL 后面（Rust 常量按声明顺序落盘）。
// 只在紧邻窗口里找，避免误匹配到别处的 40 位十六进制串。
function sha1After(text, from) {
  const window = text.slice(from, from + 128);
  const m = /[0-9A-F]{40}/.exec(window);
  // 纯数字的长串（查表常量）不是 SHA1，排除掉。
  if (!m || !/[A-F]/.test(m[0])) return null;
  return m[0];
}

// 从 CLI 二进制里取出 bundler 用的 NSIS 下载地址与哈希。
export function readBundlerConstants(binary) {
  const text = binary.toString("latin1");

  const zip = /https:\/\/github\.com\/tauri-apps\/binary-releases\/releases\/download\/nsis-[0-9.]+\/nsis-[0-9.]+\.zip/.exec(
    text
  );
  const dll =
    /https:\/\/github\.com\/tauri-apps\/nsis-tauri-utils\/releases\/download\/[^"\s]+?\/nsis_tauri_utils\.dll/.exec(
      text
    );
  if (!zip || !dll) return null;

  const zipSha1 = sha1After(text, zip.index + zip[0].length);
  const dllSha1 = sha1After(text, dll.index + dll[0].length);
  if (!zipSha1 || !dllSha1) return null;

  return {
    nsisZipUrl: zip[0],
    nsisZipSha1: zipSha1,
    tauriUtilsUrl: dll[0],
    tauriUtilsSha1: dllSha1,
  };
}

// ── ZIP 解压（不引第三方依赖） ──────────────────────────────────────

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("zip: 找不到中央目录结束记录");
}

// NSIS 包里所有条目都挂在同一个顶层目录下（nsis-3.11/…）。这一层要去掉，
// 因为 bundler 期望的是 NSIS/ 下面直接是 makensis.exe。
export function commonTopSegment(names) {
  const tops = new Set();
  for (const name of names) {
    const i = name.indexOf("/");
    if (i <= 0) return null;
    tops.add(name.slice(0, i));
  }
  return tops.size === 1 ? [...tops][0] : null;
}

// 解压到 destDir。可选剥掉所有条目共有的顶层目录。
export function extractZip(buf, destDir, { stripTopLevel = false } = {}) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: 中央目录项签名不对");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ method, compressedSize, localOffset, name });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const top = stripTopLevel ? commonTopSegment(entries.map((e) => e.name)) : null;
  if (stripTopLevel && !top) {
    throw new Error("zip: 条目没有统一的顶层目录，无法按预期剥掉");
  }

  let written = 0;
  for (const entry of entries) {
    let rel = entry.name;
    if (top) rel = rel.slice(top.length + 1);
    rel = rel.replace(/\\/g, "/");
    // 防目录穿越（条目名来自网络，不该信）。
    if (!rel || rel.split("/").includes("..") || path.isAbsolute(rel)) {
      throw new Error(`zip: 非法条目路径 ${entry.name}`);
    }

    const dest = path.join(destDir, ...rel.split("/").filter(Boolean));
    if (entry.name.endsWith("/")) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }

    const nameLen = buf.readUInt16LE(entry.localOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

    let data;
    if (entry.method === 0) data = Buffer.from(raw);
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: 不支持的压缩方式 ${entry.method}`);

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written++;
  }
  return written;
}

// ── 工具链目录 ─────────────────────────────────────────────────────

// 与 Rust 侧 dirs::cache_dir() 对齐：Windows 用 FOLDERID_LocalAppData
// （即 %LOCALAPPDATA%），macOS 用 ~/Library/Caches，Linux 用
// $XDG_CACHE_HOME 或 ~/.cache。bundler 在 tauri.conf.json 没有开
// useLocalToolsDir 时，就是往这个目录下放 "tauri"。
export function toolsDirectory(
  platform = process.platform,
  env = process.env,
  home = os.homedir()
) {
  if (env.TAURI_TOOLS_DIR) return path.resolve(env.TAURI_TOOLS_DIR);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(local, "tauri");
  }
  if (platform === "darwin") return path.join(home, "Library", "Caches", "tauri");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "tauri");
}

// 当前平台需要哪些文件才满足 bundler 的检查。
export function requiredFiles(platform = process.platform) {
  return platform === "win32" ? WINDOWS_REQUIRED_FILES : [PLUGIN_REL];
}

export function missingRequiredFiles(nsisDir, platform = process.platform) {
  return requiredFiles(platform).filter(
    (f) => !fs.existsSync(path.join(nsisDir, ...f.split("/")))
  );
}

export function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

// ── 下载 ───────────────────────────────────────────────────────────

async function fetchOnce(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "mini-tc-ci-prefetch-nsis" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 依次尝试各来源；单个来源内部重试几次。全部失败才抛错。
export async function download(url, label, sources = SOURCES) {
  const deadline = Date.now() + TOTAL_DEADLINE_MS;

  for (const source of sources) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_SOURCE; attempt++) {
      if (Date.now() > deadline) {
        throw new Error(`${label}: 超过总时间预算仍未拿到`);
      }
      try {
        const data = await fetchOnce(source.prefix + url);
        console.log(`  ${label} <- ${source.name}（第 ${attempt} 次尝试，${data.length} 字节）`);
        return data;
      } catch (err) {
        console.log(`  ${label} <- ${source.name} 失败（${err.message}），重试中…`);
        if (attempt < ATTEMPTS_PER_SOURCE) await sleep(3000 * attempt);
      }
    }
  }
  throw new Error(`${label}: 所有来源都失败`);
}

// ── 主流程 ─────────────────────────────────────────────────────────

export async function main() {
  const platform = process.platform;
  const toolsDir = toolsDirectory(platform);
  const nsisDir = path.join(toolsDir, "NSIS");
  const pluginPath = path.join(nsisDir, ...PLUGIN_REL.split("/"));

  const constants = resolveConstants();
  console.log(`NSIS 工具链目录：${nsisDir}`);
  console.log(`NSIS 版本来源：${constants.source}`);

  // 已经在位就别折腾了。
  if (
    missingRequiredFiles(nsisDir, platform).length === 0 &&
    fs.existsSync(pluginPath) &&
    sha1(fs.readFileSync(pluginPath)) === constants.tauriUtilsSha1.toLowerCase()
  ) {
    console.log("工具链已就位且哈希正确，跳过下载。");
    return;
  }

  // 插件 DLL 是两个平台都要的。
  console.log("下载插件 DLL…");
  const dll = await download(constants.tauriUtilsUrl, "nsis_tauri_utils.dll");
  const dllSha1 = sha1(dll);
  if (dllSha1 !== constants.tauriUtilsSha1.toLowerCase()) {
    throw new Error(
      `nsis_tauri_utils.dll 哈希不符：期望 ${constants.tauriUtilsSha1}，实际 ${dllSha1}`
    );
  }

  if (platform === "win32") {
    console.log("下载 NSIS 工具链…");
    const zip = await download(constants.nsisZipUrl, "nsis-3.11.zip");
    const zipSha1 = sha1(zip);
    if (zipSha1 !== constants.nsisZipSha1.toLowerCase()) {
      throw new Error(`nsis zip 哈希不符：期望 ${constants.nsisZipSha1}，实际 ${zipSha1}`);
    }

    // 先解压到临时目录，再整体换上 —— 直接清空 NSIS/ 会把刚写进去的插件也删掉。
    const stagingDir = path.join(toolsDir, "NSIS.staging");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const files = extractZip(zip, stagingDir, { stripTopLevel: true });
    console.log(`  解压 ${files} 个文件`);

    // 插件要在解压之后再放：NSIS 压缩包里没有它（bundler 也是单独下载的）。
    const stagedPlugin = path.join(stagingDir, ...PLUGIN_REL.split("/"));
    fs.mkdirSync(path.dirname(stagedPlugin), { recursive: true });
    fs.writeFileSync(stagedPlugin, dll);

    // 不用 rename 换目录：Windows 上跨目录 rename 同一卷会报 EPERM。
    // 改成删掉旧目录后逐项搬过去。
    fs.rmSync(nsisDir, { recursive: true, force: true });
    fs.mkdirSync(nsisDir, { recursive: true });
    for (const entry of fs.readdirSync(stagingDir)) {
      fs.renameSync(path.join(stagingDir, entry), path.join(nsisDir, entry));
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } else {
    // 非 Windows 只要插件，NSIS 本体用系统装的 makensis。
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, dll);
  }

  const missing = missingRequiredFiles(nsisDir, platform);
  if (missing.length > 0) {
    throw new Error(`工具链仍不完整，缺少：${missing.join(", ")}`);
  }
  console.log("工具链就绪。");
}

// 优先从 CLI 二进制读 bundler 的常量，读不到退回兜底值。
export function resolveConstants(binaryReader = () => {
  const bin = findCliBinary();
  return bin ? fs.readFileSync(bin) : null;
}) {
  try {
    const binary = binaryReader();
    if (binary) {
      const parsed = readBundlerConstants(binary);
      if (parsed) return { ...parsed, source: "tauri CLI 二进制" };
    }
  } catch {
    // 读不到就走兜底。
  }
  return { ...FALLBACK_CONSTANTS, source: "脚本内兜底常量" };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    // 不致命：bundler 自己还会再试一次官方源。
    console.warn(`⚠ 预取 NSIS 工具链失败：${err.message}`);
    console.warn("  继续构建，bundler 将自行尝试下载（可能再次遇到 504）。");
    process.exit(0);
  });
}
