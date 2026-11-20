// 记事本功能的回归护栏：快捷键、预览互斥、保存策略、文档。
// 直接 `node scripts/notepad-check.mjs` 跑。
//
// 静态断言检查的是「接线」，不是「存在即可」：模板里必须真的渲染 Notepad、
// 两个 watcher 必须真的放过记事本、Ctrl+Q 必须能从记事本切到文件预览。
// 末尾的变异臂逐个破坏关键条件，确认每条断言都有分辨力。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stripCommentsMod from "./stripComments.cjs";

const stripComments = stripCommentsMod.stripComments || stripCommentsMod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SOURCE = {
  app: read("src/App.vue"),
  shortcuts: read("src/shortcuts.js"),
  notepad: read("src/components/Notepad.vue"),
  readme: read("README.md"),
};

function check(name, cond, failures) {
  if (!cond) failures.push(name);
}

function verify(src, failures) {
  const app = stripComments(src.app);
  const shortcuts = stripComments(src.shortcuts);
  const note = stripComments(src.notepad);

  // ── 快捷键 ──
  check(
    "shortcuts.js 声明 notepad.toggle 为全局 Ctrl+E",
    /id:\s*"notepad\.toggle"[\s\S]{0,260}?scope:\s*"global"[\s\S]{0,260}?defaults:\s*\["Ctrl\+E"\]/.test(shortcuts),
    failures
  );
  check(
    "App.vue 的全局 keydown 认领 notepad.toggle",
    /matches\("notepad\.toggle",\s*e\)/.test(app) && /toggleNotepad\(\)/.test(app),
    failures
  );
  check(
    "Esc 从记事本 textarea 也能关闭",
    /matches\("preview\.close", e\)[\s\S]{0,220}?isNotepadPreview\(\)[\s\S]{0,220}?e\.target\?\.classList\?\.contains\("notepad-editor"\)/.test(app) &&
      /if \(!isTypingTarget\(e\.target\)\) \{/.test(app),
    failures
  );

  // ── 模板 / 状态机 ──
  const notepadMounts = [...app.matchAll(/<Notepad\b[\s\S]*?\/>/g)].map((m) => m[0]);
  check("左右两栏各挂载一个 Notepad", notepadMounts.length === 2, failures);
  check(
    "两个 Notepad 都只在 previewKind === 'notepad' 时渲染",
    notepadMounts.length === 2 &&
      notepadMounts.every((m) => /previewKind === 'notepad'/.test(m) && /@close="closePreview"/.test(m)),
    failures
  );
  check(
    "记事本用对侧面板（不是当前栏）",
    /function toggleNotepad\(\)[\s\S]*?previewPanel\.value = activePanel\.value === "left" \? "right" : "left"/.test(app),
    failures
  );
  check(
    "记事本不跟随文件选择 / 面板切换 / 删除事件",
    (app.match(/if \(isNotepadPreview\(\)\) return;/g) || []).length >= 3,
    failures
  );
  check(
    "Ctrl+Q 从记事本切到文件预览，而不是直接关掉",
    /const fromNotepad = isNotepadPreview\(\);[\s\S]{0,240}?if \(!fromNotepad\) return;/.test(app),
    failures
  );
  check(
    "记事本状态会被恢复到下次启动",
    /s\.kind === "notepad"/.test(app) && /if \(p\.kind === "notepad"\)/.test(app),
    failures
  );

  // ── 保存 ──
  check('内容存到 ~/.minitc/notepad.json 对应的配置名 "notepad"', /CONFIG_KEY = "notepad"/.test(note), failures);
  check("每秒定时保存", /SAVE_INTERVAL_MS = 1000/.test(note) && /setInterval\(flush, SAVE_INTERVAL_MS\)/.test(note), failures);
  check(
    "读写都走统一的配置通道",
    /import \{ loadConfig, saveConfig \}/.test(note) &&
      /await loadConfig\(CONFIG_KEY\)/.test(note) &&
      /saveConfig\(CONFIG_KEY, body\)/.test(note),
    failures
  );
  check(
    "关窗 / 卸载时强制保存最后一段输入",
    /flush\(true\)/.test(note) &&
      /window\.addEventListener\("beforeunload", onPageHide\)/.test(note) &&
      /clearInterval\(saveTimer\)/.test(note),
    failures
  );
  check("输入框可识别（textarea 带 notepad-editor 类）", /class="notepad-editor"/.test(note), failures);

  // ── 文档 ──
  check("README 记录了 Ctrl+E 和保存位置", /\| 切换记事本 \| `Ctrl\+E` \|/.test(src.readme) && /~\/\.minitc\/notepad\.json/.test(src.readme), failures);
}

const baseline = [];
verify(SOURCE, baseline);
for (const name of baseline) console.log(`  FAIL ${name}`);
console.log(`\n${baseline.length === 0 ? "ok" : "FAILED"}: ${15 - baseline.length} passed / ${baseline.length} failed`);

const mutations = {
  "timer becomes 60 seconds": { notepad: SOURCE.notepad.replace("SAVE_INTERVAL_MS = 1000", "SAVE_INTERVAL_MS = 60000") },
  "shortcut moves to Ctrl+Q": { shortcuts: SOURCE.shortcuts.replace('defaults: ["Ctrl+E"]', 'defaults: ["Ctrl+Q"]') },
  "notepad follows the file selection": { app: SOURCE.app.replace("if (isNotepadPreview()) return; // typing a note must never be replaced by a file preview", "") },
  "Ctrl+Q closes the notepad without opening a file": { app: SOURCE.app.replace("if (!fromNotepad) return;", "return;") },
  "notepad writes to a different config": { notepad: SOURCE.notepad.replace('CONFIG_KEY = "notepad"', 'CONFIG_KEY = "notes"') },
};

let caught = 0;
for (const [name, patch] of Object.entries(mutations)) {
  const failures = [];
  verify({ ...SOURCE, ...patch }, failures);
  if (failures.length > 0) caught += 1;
  console.log(`  ${failures.length > 0 ? "ok    caught" : "FAIL  missed"}: ${name}`);
}
console.log(`\n${caught} caught / ${Object.keys(mutations).length - caught} missed`);

if (baseline.length > 0 || caught !== Object.keys(mutations).length) process.exitCode = 1;
