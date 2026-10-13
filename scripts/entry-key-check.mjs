// 验证文件列表行的 `:key` 身份（entryKey）不会再退化成 `entry.name`。
// 直接 `node scripts/entry-key-check.mjs` 跑。
//
// 背景：行循环曾用 `:key="entry.name"`。名字只在**单个目录内**唯一，而搜索结果
// 面板里同一个 `report.zip` 可能同时来自十个不同目录。key 撞车后 Vue 会复用错误
// 的 DOM 节点 —— 这不只是行内容错位：行内的内联改名输入框会挂到**别的文件**上，
// 回车提交就把一个用户没输入过的名字写到用户没选中的文件上。
//
// 这里刻意测两件事，而不是只测第一件：
//   ① entryKey 在真实同名搜索结果上确实唯一（改回 `entry.name` 立刻失败）；
//   ② FileList.vue 的行循环确实调的是 entryKey，而不是有人在模板里手写回
//      `entry.name`（改实现不改模板时 ① 仍会全绿，只有 ② 能抓住）。
//
// 不测的部分：不模拟 Vue 的 patch 算法本身（那是在测 Vue，不是在测我们），
// 也不声称覆盖了「key 撞车后的 DOM 表现」——那需要真实渲染，只能靠 review。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { entryKey } from "../src/paths.js";

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

// 一次真实的 `*.zip` 内容搜索：跨目录同名是常态，不是构造出来的边缘用例。
const SEARCH_HITS = [
  { path: "D:\\proj\\alpha\\report.zip", name: "report.zip", dir: "D:\\proj\\alpha" },
  { path: "D:\\proj\\beta\\report.zip", name: "report.zip", dir: "D:\\proj\\beta" },
  { path: "D:\\proj\\beta\\src\\report.zip", name: "report.zip", dir: "D:\\proj\\beta\\src" },
  { path: "E:\\backup\\2024\\report.zip", name: "report.zip", dir: "E:\\backup\\2024" },
];

console.log("① 搜索结果里的同名项：key 必须唯一（改回 entry.name 立刻失败）");
{
  const byName = new Set(SEARCH_HITS.map((e) => e.name));
  check(
    "前置确认：这批结果里名字确实是重复的（否则本测试测的是空气）",
    byName.size === 1 && SEARCH_HITS.length === 4
  );

  const byKey = new Set(SEARCH_HITS.map(entryKey));
  check("entryKey 四条互不相同", byKey.size === SEARCH_HITS.length);

  // 反向确认：用 name 当 key 必然撞车，否则上面的断言说明我构造错了数据。
  const nameKeyed = new Set(SEARCH_HITS.map((e) => e.name));
  check("对照组：用 entry.name 当 key 时确实撞车（证明断言有分辨力）", nameKeyed.size === 1);
}

console.log("\n② 常规目录列表：key 不应退化");
{
  const LISTING = [
    { path: "C:\\Users\\simon\\a.txt", name: "a.txt" },
    { path: "C:\\Users\\simon\\b.txt", name: "b.txt" },
    { path: "C:\\Users\\simon\\c.txt", name: "c.txt" },
  ];
  check("三个条目 key 互不相同", new Set(LISTING.map(entryKey)).size === 3);
  check("大小写不同的路径不被归一（key 就是 path 原样）",
    entryKey({ path: "C:\\x\\A.txt", name: "A.txt" }) === "C:\\x\\A.txt");
}

console.log("\n③ 缺 path 的条目：退化到 name 而不是渲染不出东西");
{
  check("无 path 有 name → 用 name", entryKey({ name: "a.txt" }) === "a.txt");
  check("无 path 无 name → 空串而非 undefined", entryKey({}) === "");
  check("null 也不抛", entryKey(null) === "");
}

console.log("\n④ 模板静态检查：行循环必须调 entryKey");
{
  const file = path.join(ROOT, "src", "components", "FileList.vue");
  const src = fs.readFileSync(file, "utf8");

  // 只取 <template> 段，避免 script 里的注释/import 干扰。
  const tpl = src.slice(0, src.indexOf("</template>"));

  const keyAttrs = [...tpl.matchAll(/:key="([^"]*)"/g)].map((m) => m[1].trim());
  check("模板里有 :key 绑定", keyAttrs.length > 0);
  check(
    "没有 :key 绑到 entry.name（虚拟目录必然撞键）",
    !keyAttrs.some((k) => /\bentry\.name\b/.test(k))
  );
  check(
    "行循环的 :key 用的是 entryKey(...)",
    keyAttrs.includes("entryKey(entry)")
  );

  // entryKey 必须真的被导入，否则模板里那个调用是 undefined。
  const importM = src.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/paths\.js["']/);
  check("FileList.vue 从 paths.js 导入了 entryKey",
    !!importM && importM[1].split(",").map((s) => s.trim()).includes("entryKey"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);