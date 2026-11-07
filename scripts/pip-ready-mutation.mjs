// 变异测试：确认 pip-ready-check.mjs 的断言真能抓到退化实现。
// 每个变异都必须让套件 FAIL；漏掉一个即视为断言没有分辨力。
// 还原只用内存原文写回（绝不 git checkout），跑完逐个比对字节。
// Run: node scripts/pip-ready-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "pip-ready-check.mjs");
const READY = path.join(ROOT, "src", "pipReady.js");
const VUE = path.join(ROOT, "src", "components", "VideoPreview.vue");

const originals = {
  [READY]: fs.readFileSync(READY, "utf8"),
  [VUE]: fs.readFileSync(VUE, "utf8"),
};

const MUTANTS = [
  {
    target: READY,
    name: "就绪判据恒真（未加载完也直接请求 PiP）",
    code: "  return readyState >= 1 && videoWidth > 0;",
    restore: "  return true;",
  },
  {
    target: READY,
    name: "等待意图不绑定文件（换片后突然弹小窗）",
    code: "  return intentPath !== null && intentPath !== undefined && intentPath === currentPath;",
    restore: "  return intentPath !== null;",
  },
  {
    target: READY,
    name: "取消等待失效",
    code: "      if (ctx.cancelled) { finish({ ok: false, reason: \"cancelled\" }); return; }",
    restore: "",
  },
  {
    target: READY,
    name: "超时被误报为成功",
    code: "reason: \"timeout\"",
    restore: "reason: \"ready\"",
  },
  {
    target: READY,
    name: "兑现后不摘事件监听器",
    code: "      video.removeEventListener(\"loadedmetadata\", check);\n",
    restore: "",
  },
  {
    target: VUE,
    name: "等待不再发生在点击的 await 链里",
    code: "    const wait = await waitForVideoReady(v, ctx);",
    restore: "    const wait = { ok: true, reason: \"ready\" };",
  },
  {
    target: VUE,
    name: "删掉 await 后的目的地判据",
    code: "    if (!pipIntentLands(ctx.path, props.filePath)) return;\n",
    restore: "",
  },
  {
    target: VUE,
    name: "模板不再反馈等待状态",
    code: "{{ pipWaiting ? \"等待加载…\" : \"画中画\" }}",
    restore: "画中画",
  },
  {
    target: VUE,
    name: "tooltip 不再提示等待",
    code: "  if (pipWaiting.value) return \"等待视频加载后自动进入画中画（再点一次取消）\";\n",
    restore: "",
  },
  {
    target: VUE,
    name: "加载失败时不取消等待",
    code: "  cancelPipWait(); // 加载失败别让用户等满超时\n",
    restore: "",
  },
  {
    target: VUE,
    name: "实测无效的 document.title 死代码回归",
    code: "const inPip = ref(false);",
    restore: "const inPip = ref(false);\ndocument.title = props.fileName;",
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = originals[m.target];
  const parts = before.split(m.code);
  console.log(`  anchor found: ${parts.length - 1}  [${m.name}]`);
  if (parts.length !== 2) {
    console.log(`  FAIL  anchor must occur exactly once`);
    missed += 1;
    continue;
  }
  const mutated = parts.join(m.restore);
  if (mutated === before) {
    console.log(`  FAIL  mutation produced no change`);
    missed += 1;
    continue;
  }

  fs.writeFileSync(m.target, mutated, "utf8");
  let failed = false;
  let tail = "";
  try {
    const out = execFileSync(process.execPath, [SUITE], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    tail = out.trim().split("\n").slice(-1)[0] || "";
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = out.trim().split("\n").filter((l) => /passed/.test(l)).slice(-1)[0] || "threw";
  } finally {
    fs.writeFileSync(m.target, before, "utf8");
  }

  if (failed) {
    caught += 1;
    console.log(`  ok    caught: ${m.name}  (${tail})`);
  } else {
    missed += 1;
    console.log(`  FAIL  NOT CAUGHT: ${m.name}`);
  }
}

let restored = true;
for (const [file, original] of Object.entries(originals)) {
  if (fs.readFileSync(file, "utf8") !== original) {
    fs.writeFileSync(file, original, "utf8");
    restored = false;
  }
}
console.log(`\n  sources restored: ${restored}`);
console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0 || !restored) process.exit(1);
