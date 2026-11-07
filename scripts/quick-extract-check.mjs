// 验证「快捷键快速解压」与右键「用 7-Zip 解压」是同一条执行路径。
//
// 直接 `node scripts/quick-extract-check.mjs`；`-- --mutate` 跑变异臂。
//
// ── 这个改动为什么需要三层判据 ────────────────────────────────────────
// 接线跨 4 个文件：shortcuts.js 声明命令 → FileList.vue 认领按键并 emit
// → FilePanel.vue 模板转发 → doExtract 调后端。任何一环断掉都是「按了没反应」，
// 而纯逻辑测试全绿、组件也编译得过（METHODOLOGY.md：「改实现不改调用点」）。
// 所以：① 命令注册与按键命中用生产模块跑；② 工具挑选抽成 plain 模块跑真值表；
// ③ 接线与「两条入口同 mode / 同 GUI 工具集 / await 前抓快照」用静态断言钉住；
// ④ 变异臂逐个证明这些断言不是恒真的。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mod from "./stripComments.cjs";
import { COMMANDS, bindingsOf, computeConflicts, matches } from "../src/shortcuts.js";
import { guiExtractTools, pickExtractTool } from "../src/archiveTools.js";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILELIST = path.join(ROOT, "src", "components", "FileList.vue");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const SHORTCUTS = path.join(ROOT, "src", "shortcuts.js");
const TOOLS = path.join(ROOT, "src", "archiveTools.js");

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

// ── 1. 命令注册（import 生产模块，不是读文本） ──

section("1. list.extract 命令已注册且按键真的命中");

const cmd = COMMANDS.find((c) => c.id === "list.extract");
check("shortcuts.js 的 COMMANDS 里有 list.extract", !!cmd);
check("scope 是 fileList（需要选中行，且面板才拥有解压 IPC）", cmd?.scope === "fileList");
check("默认键含 Alt+F9 与 F9", !!cmd && cmd.defaults.includes("Alt+F9") && cmd.defaults.includes("F9"));
check(
  "不与同 scope 的其它命令冲突",
  !!cmd && computeConflicts(bindingsOf).get("list.extract")?.errors.length === 0
);

function ev(o = {}) {
  return {
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    key: "", code: "", ...o,
  };
}
check("F9 命中 list.extract", matches("list.extract", ev({ code: "F9", key: "F9" })));
check("Alt+F9 命中 list.extract", matches("list.extract", ev({ code: "F9", key: "F9", altKey: true })));
check("Ctrl+F9 不命中", !matches("list.extract", ev({ code: "F9", key: "F9", ctrlKey: true })));
check("回车不命中（不能抢 list.open）", !matches("list.extract", ev({ code: "Enter", key: "Enter" })));

// ── 2. 工具挑选真值表（生产纯函数） ──

section("2. GUI 工具挑选：7-Zip 优先、无 GUI 返回 null");

const sevenZip = { id: "7zip-7z-gui", name: "7-Zip", syntax: "7z-gui" };
const winrar = { id: "winrar-gui", name: "WinRAR", syntax: "winrar-gui" };
const cli = { id: "7zip-7z-cli", name: "7-Zip", syntax: "7z-cli" };

check("空列表 → []", guiExtractTools([]).length === 0);
check("null/undefined → []", guiExtractTools(null).length === 0 && guiExtractTools(undefined).length === 0);
check("只装 CLI 时 GUI 列表为空", guiExtractTools([cli]).length === 0);
check("GUI 工具全部列出（右键菜单逐个展示）", guiExtractTools([sevenZip, cli, winrar]).length === 2);
check("缺 syntax 的脏数据不炸", guiExtractTools([{ name: "?" }, null, sevenZip]).length === 1);
check("WinRAR 排在前面时快捷键仍优先 7-Zip", pickExtractTool([winrar, sevenZip]) === sevenZip);
check("没有 7-Zip 时退回其它 GUI 工具", pickExtractTool([cli, winrar]) === winrar);
check("只有 CLI → null（与右键一样不提供解压）", pickExtractTool([cli]) === null);
check("空列表 → null（显式 null，调用方不会读 undefined.id）", pickExtractTool([]) === null);

// ── 3. 静态接线 ──

const appSrc = stripComments(fs.readFileSync(FILELIST, "utf8"));
const panelSrc = stripComments(fs.readFileSync(PANEL, "utf8"));

function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const braceAt = src.indexOf("{", at + decl.length - 1);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceAt, i + 1);
    }
  }
  return null;
}

section("3. 按键 → 列表 emit → 面板（接线断点逐个钉）");

const emits = /const emit = defineEmits\(([\s\S]*?)\);/.exec(appSrc)?.[1] || "";
check("defineEmits 声明了 extract 事件", emits.includes('"extract"'));

const keyBody = bodyOf(appSrc, "function onKeydown(e) {");
check("FileList.vue 抽到 onKeydown 函数体", !!keyBody && keyBody.length > 0);
check("onKeydown 用 matches 认领 list.extract", !!keyBody && keyBody.includes('matches("list.extract", e)'));
check("onKeydown 用 markHandled 消费这次按键", !!keyBody && keyBody.includes("markHandled(e)"));
check("onKeydown 发出 extract 事件", !!keyBody && keyBody.includes('emit("extract")'));
check(
  "emit 恰好一处（多一处会重复解压，少一处是断线）",
  (appSrc.match(/emit\("extract"\)/g) || []).length === 1
);
check(
  "IME 守卫仍在第一个 matches 之前",
  !!keyBody && keyBody.indexOf("isImeKeydown(e)") >= 0 &&
    keyBody.indexOf("isImeKeydown(e)") < keyBody.indexOf("matches(")
);

check("FilePanel.vue 模板把 extract 转给 extractSelected", panelSrc.includes('@extract="extractSelected"'));
check("FilePanel.vue import 了共享的 archiveTools.js", /import\s*\{[^}]*pickExtractTool[^}]*\}\s*from\s*"\.\.\/archiveTools\.js"/.test(panelSrc));

const exBody = bodyOf(panelSrc, "async function extractSelected() {");
check("抽到 extractSelected 函数体", !!exBody && exBody.length > 0);
check("用光标行复用 extractTargets（与右键同一批目标）", !!exBody && exBody.includes("extractTargets(selectedEntry.value)"));
check("先做工具探测（惰性、缓存）", !!exBody && exBody.includes("await ensureArchiveTools()"));
check("工具挑选走共享纯函数", !!exBody && exBody.includes("pickExtractTool(archiveTools.value)"));
check("无图形工具时给出与右键相同的提示", !!exBody && exBody.includes('showToast("未检测到 7-Zip 等压缩工具", "error")'));
check("最终调到 doExtract", !!exBody && exBody.includes("doExtract(targets, tool,"));
check(
  "path / targets 在 await 之前捕获并显式透传（导航不改写解压目的地）",
  !!exBody && exBody.indexOf("const path =") < exBody.indexOf("await ensureArchiveTools()") &&
    exBody.indexOf("const targets =") < exBody.indexOf("await ensureArchiveTools()") &&
    exBody.includes('doExtract(targets, tool, "to_folder", path)')
);

section("4. 两条入口同源：同一批 GUI 工具、同一个 mode");

const menuBody = bodyOf(panelSrc, "function buildMenuItems(entry) {");
check("抽到 buildMenuItems 函数体", !!menuBody && menuBody.length > 0);
check("右键菜单用共享的 guiExtractTools（不是自己再写一份过滤）", !!menuBody && menuBody.includes("guiExtractTools(archiveTools.value)"));
check("右键菜单遍历 GUI 工具列表", !!menuBody && menuBody.includes("for (const tool of extractTools)"));

const selBody = bodyOf(panelSrc, "async function handleCtxSelect(item) {");
check("handleCtxSelect 仍调 doExtract（右键路径没被改坏）", !!selBody && selBody.includes("doExtract(targets, item.tool, item.mode, path)"));

const menuMode = /mode:\s*"([^"]+)"/.exec(menuBody || "")?.[1] || "";
const quickMode = /doExtract\(targets, tool, "([^"]+)", path\)/.exec(exBody || "")?.[1] || "";
check("右键菜单 mode 可定位", menuMode.length > 0);
check("快捷键 mode 可定位", quickMode.length > 0);
check(`快捷键与右键解压到同一目的地（${quickMode} / ${menuMode}）`, quickMode.length > 0 && quickMode === menuMode);

// ── report ──

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log("全部通过");
}

// ── 变异臂 ──

if (process.argv.includes("--mutate")) {
  console.log(`\n${"═".repeat(50)}\n变异测试（每个都应 FAIL）\n${"═".repeat(50)}`);
  const { execFileSync } = await import("node:child_process");

  // 锚点按目标文件实际换行符归一化：仓库里 .vue / .js 的换行并不统一。
  const nlFor = (file, s) =>
    (fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s);

  const mutations = [
    { name: "① 面板模板不再接收 extract 事件", file: PANEL,
      from: '@extract="extractSelected"', to: '@extract="extractSelectedTypo"' },
    { name: "② 列表按键不再发 extract", file: FILELIST,
      from: 'emit("extract");', to: 'emit("rename");' },
    { name: "③ 快捷键改成解压到当前目录（与右键漂移）", file: PANEL,
      from: 'doExtract(targets, tool, "to_folder", path);', to: 'doExtract(targets, tool, "here", path);' },
    { name: "④ 不再优先 7-Zip", file: TOOLS,
      from: 'gui.find((t) => t.syntax === "7z-gui")', to: "gui.find(() => false)" },
    { name: "⑤ 命令 scope 改成 global", file: SHORTCUTS,
      from: '{ id: "list.extract", scope: "fileList", label: "快速解压"',
      to: '{ id: "list.extract", scope: "global", label: "快速解压"' },
    { name: "⑥ 只改右键菜单的 mode（快捷键没动，只有同源断言能抓）", file: PANEL,
      from: 'mode: "to_folder",', to: 'mode: "here",' },
  ];

  for (const mu of mutations) {
    const original = fs.readFileSync(mu.file, "utf8");
    const from = nlFor(mu.file, mu.from);
    const to = nlFor(mu.file, mu.to);
    const count = original.split(from).length - 1;
    console.log(`\n▶ ${mu.name}`);
    console.log(`  anchor found: ${count}`);
    if (count !== 1) {
      console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
      failures.push(`变异目标未唯一命中：${mu.name}`);
      continue;
    }
    let failedNow = 0;
    let out = "";
    try {
      fs.writeFileSync(mu.file, original.split(from).join(to), "utf8");
      try {
        execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8" });
      } catch (e) {
        failedNow = 1;
        out = (e.stdout || "") + (e.stderr || "");
      }
    } finally {
      fs.writeFileSync(mu.file, original, "utf8");
    }
    if (failedNow) {
      passed++;
      const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
      console.log(`  ok   变异被断言抓到（FAIL 如预期）${firstFail ? " | " + firstFail.trim() : ""}`);
    } else {
      failures.push(`变异未被抓到：${mu.name}`);
      console.log("  FAIL 变异未被抓到 —— 该断言是恒真的");
    }
  }
  console.log(
    `\n变异测试结束：${failures.length ? `FAIL ${failures.length} 项` : "全部变异均被抓到"}`
  );
}

if (failures.length) process.exitCode = 1;
