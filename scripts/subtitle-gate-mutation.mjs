// 变异测试：确认 scripts/subtitle-gate-check.mjs 的断言真的有分辨力。
// 直接 `node scripts/subtitle-gate-mutation.mjs` 跑。
//
// METHODOLOGY 的硬约束：
//   🚨 「0 FAIL」先证明变异真的注入了 —— 替换用了跨行锚点而目标行是单行时
//      count==0，文件没被改，测试全绿被误读成「断言瞎」。所以每次注入后
//      **打印 anchor found 并 assert 恰好 1 处**。
//   🚨 被测组必须 import 生产代码，否则变异后仍全绿。
//   ⚠️ 变异 0 FAIL 先判「等价变异」还是「测试盲区」，如实记录，不要硬凑断言。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "src", "subtitleGate.js");
const VUE = path.join(ROOT, "src", "components", "VideoPreview.vue");
const SUITE = path.join(ROOT, "scripts", "subtitle-gate-check.mjs");

const gateOrig = fs.readFileSync(GATE, "utf8");
const vueOrig = fs.readFileSync(VUE, "utf8");

let failed = 0;
let caught = 0;
let equivalent = 0;

/**
 * @param {string} label
 * @param {string} file要改的文件
 * @param {string} from 锚点（必须是单行、可数出恰好 1 处）
 * @param {string} to   替换成
 */
function mutate(label, file, from, to) {
  const orig = fs.readFileSync(file, "utf8");
  // ⚠️ 锚点里的 \n 必须匹配目标文件真实的换行符。本仓库 .vue 是 CRLF
  // （实测 985/985），src/*.js 是 LF —— 锚点写 \n 去改 .vue 会 count==0，
  // 文件没被改、测试全绿，被误读成「断言瞎」。METHODOLOGY 记过的假阴性。
  const eol = orig.includes("\r\n") ? "\r\n" : "\n";
  const fromE = from.replace(/\n/g, eol);
  const toE = to.replace(/\n/g, eol);
  const count = orig.split(fromE).length - 1;
  if (count !== 1) {
    // METHODOLOGY：注入失败 ≠ 断言瞎。必须当场报出来，不能当成「变异存活」。
    console.log(`  ANCHOR-MISS ${label} —— 锚点出现 ${count} 次（要求恰好 1，eol=${JSON.stringify(eol)}），变异未注入`);
    failed++;
    return;
  }
  console.log(`  anchor found: 1  (${label})`);
  fs.writeFileSync(file, orig.replace(fromE, toE), "utf8");
  let out = "";
  let code = 0;
  try {
    execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout || ""}${e.stderr || ""}`;
  } finally {
    fs.writeFileSync(file, orig, "utf8");
  }
  const m = out.match(/(\d+) passed \/ (\d+) failed/);
  const failedCount = m ? +m[2] : -1;
  if (code !== 0 && failedCount > 0) {
    caught++;
    console.log(`  CAUGHT  ${label}  (${failedCount} 例失败)`);
  } else {
    // 0 FAIL：要么等价变异（改不动行为），要么测试盲区。逐个判别后如实标注。
    equivalent++;
    console.log(`  SURVIVED ${label}  —— 需人工判别：等价变异 or 测试盲区`);
  }
}

console.log("== 变异：src/subtitleGate.js（判据本体）==");

mutate(
  "lands 恒返回 true（去掉守卫）",
  GATE, "      return !!token && token === current;", "      return true;"
);

mutate(
  "lands 忽略 token 身份（只比非空）",
  GATE, "      return !!token && token === current;", "      return !!token;"
);

mutate(
  "begin 复用同一个对象（退化成恒真）",
  GATE, "      current = {};\n      return current;", "      current = current || {};\n      return current;"
);

mutate(
  "reset 不作废在飞链",
  GATE, "      current = null;\n    },\n  };\n}", "      /* noop */\n    },\n  };\n}"
);

mutate(
  "matched 判定去掉结尾的 \".\"（a2.srt 误判为命中）",
  GATE, "matched: s === stem || s.startsWith(stem + \".\")", "matched: s.startsWith(stem)"
);

mutate(
  "matched 判定永远为 false",
  GATE, "matched: s === stem || s.startsWith(stem + \".\")", "matched: false"
);

mutate(
  "stemOf 剥掉全部扩展名（a.en.srt → a）",
  GATE, '  return String(name || "").replace(/\\.[^.]+$/, "");',
  '  return String(name || "").replace(/(\\.[^.]+)+$/, "");'
);

mutate(
  "extOf 把无扩展名文件也当字幕（README → readme）",
  GATE, "  return p.length > 1 ? p.pop().toLowerCase() : \"\";",
  "  return p.pop().toLowerCase();"
);

mutate(
  "不过滤目录（目录也进候选）",
  GATE, ".filter((e) => e && !e.is_dir && wanted.includes(extOf(e.name)))",
  ".filter((e) => e && wanted.includes(extOf(e.name)))"
);

mutate(
  "排序丢掉 matched 优先",
  GATE, ".sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0) || a.name.localeCompare(b.name));",
  ".sort((a, b) => a.name.localeCompare(b.name));"
);

mutate(
  "不再透传 path（调用点的 joinPath 兜底变死代码）",
  GATE, "      if (e.path) out.path = e.path;", "      /* dropped */"
);

console.log("\n== 变异：src/components/VideoPreview.vue（调用点）==");

mutate(
  "loadVideo 快照取在 await 之后",
  VUE, "  const filePath = props.filePath;", "  const filePath = await null, later = props.filePath;"
);

mutate(
  "detectSubtitles 里重新读 props.fileName（原 bug 的另一半）",
  VUE, "  const candidates = subtitleCandidates(list, base, SUB_EXTS);",
  "  const candidates = subtitleCandidates(list, props.fileName.replace(/\\.[^.]+$/, \"\"), SUB_EXTS);"
);

mutate(
  "begin() 挪进 isExternalOnly 分支（external-only 不再作废在飞链）",
  VUE, "  const token = subtitleGate.begin();", "  let token = null;"
);

mutate(
  "去掉 listDirectory 之后的守卫",
  VUE, "    const list = (await listDirectory(dir)).entries;\n    if (!subtitleGate.lands(token)) return;",
  "    const list = (await listDirectory(dir)).entries;"
);

mutate(
  "去掉提交前的最终守卫",
  VUE, "    }\n    if (!subtitleGate.lands(token)) return;\n    // Single commit.", "    }\n    // Single commit."
);

mutate(
  "改回逐文件 push（半更新中间态）",
  VUE, "    subtitleTracks.value = tracks;", "    for (const t of tracks) subtitleTracks.value.push(t);"
);

mutate(
  "onBeforeUnmount 不作废在飞探测",
  VUE, "  subtitleGate.reset();", "  /* noop */"
);

mutate(
  "onMounted 不复核 mountedPath（重复加载竞态）",
  VUE, "    if (props.filePath === mountedPath) await loadVideo();", "    await loadVideo();"
);

mutate(
  "loaded.push 之前不查守卫（陈旧链继续累积）",
  VUE, "      if (!subtitleGate.lands(token)) return;\n      if (track) loaded.push(track);", "      if (track) loaded.push(track);"
);

console.log(`\n${caught} caught / ${equivalent} survived / ${failed} anchor-miss`);
if (failed > 0) process.exit(1);
process.exit(equivalent === 0 ? 0 : 2);
