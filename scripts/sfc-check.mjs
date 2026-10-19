// SFC 编译校验：用 @vue/compiler-sfc 逐个编译 src/components/*.vue。
// 直接 `node scripts/sfc-check.mjs` 跑。
//
// 为什么需要它：静态断言（subtitle-gate-check 那一套）只把 .vue 当**文本**读，
// 抓不到「同一个标识符声明了两次」这类**语法/作用域**错误。
// 真实案例（2026-10-19）：修字幕守卫时把 `function getExt` 又插了一份，246 行已有
// 一个 → `Identifier 'getExt' has already been declared`，而当轮 `npm test`
// **70 断言 + 20 变异全绿**—— 因为没有一条断言会去编译这个文件。
//
// 为什么不跑 `vite build`：那是完整构建（用户自己跑 dev.sh / 打包时触发）。
// 这里只做「单文件语法 + SFC 结构」校验，无端口、无 dist 产物、秒级完成。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "@vue/compiler-sfc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS = path.join(ROOT, "src", "components");

const files = fs
  .readdirSync(COMPONENTS)
  .filter((f) => f.endsWith(".vue"))
  .sort();

if (files.length === 0) {
  console.log("src/components 下没有 .vue 文件 —— 这本身就不对，请检查目录");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const abs = path.join(COMPONENTS, f);
  const src = fs.readFileSync(abs, "utf8");
  // Use forward slashes: the compiler embeds this id in error positions, and a
  // Windows path with backslashes makes its own messages unparseable.
  const filename = "src/components/" + f;
  try {
    const { descriptor, errors } = parse(src, { filename });
    if (errors.length) {
      throw new Error(errors.map((e) => e.message || String(e)).join("; "));
    }
    // compileScript is what actually reports "Identifier X has already been
    // declared" — parse() alone only checks SFC block structure.
    compileScript(descriptor, { id: filename });
    console.log("  ok   " + filename);
  } catch (e) {
    failed++;
    console.log("  FAIL " + filename);
    console.log("       " + String(e.message).split("\n").slice(0, 3).join("\n       "));
  }
}

console.log(`\n${files.length - failed}/${files.length} 个 .vue 编译通过`);
process.exit(failed === 0 ? 0 : 1);
