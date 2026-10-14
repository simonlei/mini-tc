// 验证「打开预览」的并发守卫：await 之前取的目的地快照，await 之后还能不能落地。
// 直接 `node scripts/preview-request.test.mjs` 跑。
//
// 判据：断言必须在「去掉守卫」（恒返回 true）的实现下失败。所以除了纯逻辑语义，
// 还静态断言 App.vue 的每一个 await 落地点都真的查了守卫 —— 只测纯逻辑的话，
// 把调用点删掉照样全绿。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makePreviewRequest, previewRequestLands } from "../src/previewRequest.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

const DIR = "C:\\pics";
function req(over = {}) {
  return makePreviewRequest({
    panelId: "left",
    activePanelId: "left",
    dir: DIR,
    entry: { path: "C:\\pics\\a.heic", name: "a.heic" },
    ...over,
  });
}

console.log("什么都没变：结果可落地");
{
  check("同面板同目录同条目 → 可落地", previewRequestLands(req(), req()) === true);
}

console.log("\n快速按 ↓ 翻文件：先发的请求必须被作废");
{
  check("选中项从 a 变成 b 后，a 的结果作废 —— 这就是原 bug",
    previewRequestLands(req(), req({ entry: { path: "C:\\pics\\b.heic", name: "b.heic" } })) === false);
  check("b 自己的结果可落地",
    previewRequestLands(
      req({ entry: { path: "C:\\pics\\b.heic", name: "b.heic" } }),
      req({ entry: { path: "C:\\pics\\b.heic", name: "b.heic" } })
    ) === true);
}

console.log("\nA→B→A 折返：不能谁都不落地（序号模型会踩的坑）");
{
  const A = req();
  const B = req({ entry: { path: "C:\\pics\\b.heic", name: "b.heic" } });
  check("折返后迟到的 A 仍可落地", previewRequestLands(A, A) === true);
  check("中途的 B 仍作废", previewRequestLands(B, A) === false);
}

console.log("\n切面板：源面板没变但活动面板变了");
{
  check("活动面板切走 → 作废",
    previewRequestLands(req(), req({ activePanelId: "right" })) === false);
  check("连源面板一起换 → 作废",
    previewRequestLands(req(), req({ panelId: "right", activePanelId: "right" })) === false);
}

console.log("\n换目录：同名文件也不是同一个目的地");
{
  check("同一条目键但目录变了 → 作废",
    previewRequestLands(req(), req({ dir: "C:\\videos" })) === false);
  // 搜索结果页里同名是常态，只比 key 不比 dir 会把另一个目录的行当成同一个。
  check("同名不同目录 → 作废",
    previewRequestLands(
      req({ dir: "C:\\a", entry: { path: "C:\\a\\photo.heic", name: "photo.heic" } }),
      req({ dir: "D:\\b", entry: { path: "D:\\b\\photo.heic", name: "photo.heic" } })
    ) === false);
}

console.log("\n空状态：没有选中项 / 快照缺失");
{
  check("当前无选中项（导航后）→ 作废", previewRequestLands(req(), req({ entry: null })) === false);
  check("请求快照为 undefined → 作废", previewRequestLands(undefined, req()) === false);
  check("当前状态为 undefined → 作废", previewRequestLands(req(), undefined) === false);
  check("makePreviewRequest() 空参不抛，判为不可落地",
    previewRequestLands(makePreviewRequest(), makePreviewRequest()) === false);
}

console.log("\n同目录不同条目：只比 key 不够（key 相同但目录不同已在上面覆盖）");
{
  check("key 不同 → 作废",
    previewRequestLands(
      req({ entry: { path: "C:\\pics\\a.heic", name: "a.heic" } }),
      req({ entry: { path: "C:\\pics\\z.heic", name: "z.heic" } })
    ) === false);
}

// ── 静态断言：调用点真的查了守卫 ──
// 纯逻辑测试只覆盖判据本身。把 App.vue 里的调用删掉（改实现不改判据）时上面全绿，
// 所以必须钉住「每一个 await 之后写 preview* 状态的地方都查了 previewStillWanted」。
const appSrc = stripComments(
  fs.readFileSync(path.join(ROOT, "src", "App.vue"), "utf8")
);

// 抽出每个函数体，方便在「写 preview* 状态的 await 落地点」附近找守卫调用。
function bodies(src) {
  const out = [];
  const re = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", re.lastIndex - 1);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ name: m[1], body: src.slice(open, i) });
    re.lastIndex = i;
  }
  return out;
}

// watch(..., async (x) => {...}) 的匿名回调不在上面的具名函数表里，单独按
// `watch(` 出现的位置切块。
function watchBlocks(src) {
  const out = [];
  let idx = 0;
  for (;;) {
    const at = src.indexOf("watch(", idx);
    if (at < 0) break;
    let depth = 0;
    let i = src.indexOf("(", at);
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(at, i + 1));
    idx = i + 1;
  }
  return out;
}

console.log("\n静态断言：直接 await entryPath 的落地点都查了守卫（剥注释后）");
{
  const blocks = [
    ...bodies(appSrc),
    ...watchBlocks(appSrc).map((b) => ({ name: "watch", body: b })),
  ];
  const DIRECT = /await\s+entryPath\(/;
  const FORWARD = /await\s+showFilePreview\(/;
  const GATE = "previewStillWanted(";
  // 只有「await 之后真的会写 preview* 状态」的块才需要守卫 —— openBatchRename
  // 也 await entryPath，但它写的是 batchRenameItems，与预览无关。
  const WRITES_PREVIEW = /preview(Visible|Panel|Kind|FilePath|FileName|FileBytes|AsText)\.value\s*=/;

  // 直接自己 await entryPath 的块：结果就地写进 preview* 状态，必须自己查守卫。
  // （转发给 showFilePreview 的块不用重复查 —— 守卫在那一层。）
  const direct = blocks.filter((b) => DIRECT.test(b.body) && WRITES_PREVIEW.test(b.body));
  check("扫到 4 个直接 await entryPath 的预览落地点", direct.length === 4);
  for (const b of direct) {
    check(`${b.name} 查了 previewStillWanted`, b.body.includes(GATE));
  }

  // 转发给 showFilePreview 的块：必须把确定的 panelId 传下去，不能让被调方
  // 在 await 之后自己读 activePanel。（togglePreview 两条分支都有：视频自己 await
  // entryPath，非视频转发给 showFilePreview，所以它同时出现在两类里。）
  // 判据用 `await` 前缀 —— 函数**定义**也含 showFilePreview(，不算调用点。
  const forward = blocks.filter((b) => /await\s+showFilePreview\(/.test(b.body));
  check("扫到 4 个转发块", forward.length === 4);
  for (const b of forward) {
    // 第四个实参必须是 panelId。不能用 `[^)]*` 匹配实参列表：`isTextPreviewExt(ext)`
    // 自带右括号，会让匹配在半途截断。
    check(`${b.name} 转发了 panelId`, /,\s*panelId\s*\)/.test(b.body));
  }
}

console.log("\n静态断言：showFilePreview 的 panel 来自参数，不是 await 后读 activePanel");
{
  const fn = bodies(appSrc).find((b) => b.name === "showFilePreview");
  check("showFilePreview 存在", !!fn);
  // 签名里带 panelId，且落地时用的是它。
  check("签名接受 panelId", /panelId\s*=/.test(appSrc.slice(appSrc.indexOf("function showFilePreview"))));
  check(
    "落地用 panelId 推导对面板，而不是 activePanel",
    /previewPanel\.value\s*=\s*panelId\s*===/.test(fn.body)
  );
}

console.log("\n静态断言：写入 preview* 状态前必须先过守卫（顺序，不是存在即可）");
{
  const fn = bodies(appSrc).find((b) => b.name === "showFilePreview");
  const gateAt = fn.body.indexOf("previewStillWanted(");
  const writeAt = fn.body.indexOf("previewPanel.value");
  check("守卫出现在写入之前", gateAt >= 0 && writeAt >= 0 && gateAt < writeAt);
  // 「存在即可」型断言恒绿：删掉一处写入仍会过。数出全部 preview* 写入点。
  const writes = fn.body.match(/preview(Visible|Panel|Kind|FilePath|FileName|FileBytes|AsText)\.value\s*=/g) || [];
  check("写入点数量符合预期（7 个）", writes.length === 7);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
