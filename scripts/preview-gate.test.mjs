// 验证预览加载的并发守卫。直接 `node scripts/preview-gate.test.mjs` 跑。
//
// 判据：断言必须在「去掉守卫」（恒返回 true）的实现下失败。全绿但抓不住
// 退化的测试等于没测试。

import { previewLands } from "../src/previewGate.js";

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

const A = "C:\\pics\\a.heic";
const B = "C:\\pics\\b.heic";

console.log("快速按 ↓ 翻 HEIC：先发的 A 必须被作废");
{
  check("A 请求发出后、翻到 B 前，本可落地", previewLands(A, A) === true);
  check("A 迟到时（B 已选中）被作废 —— 这就是原 bug",
    previewLands(A, B) === false);
  check("B 自己的结果可落地", previewLands(B, B) === true);
}

console.log("\nA→B→C 连续翻页：只有最后一个的结果落地");
{
  check("A 作废", previewLands(A, "C:\\pics\\c.heic") === false);
  check("B 作废", previewLands(B, "C:\\pics\\c.heic") === false);
  check("C 落地", previewLands("C:\\pics\\c.heic", "C:\\pics\\c.heic") === true);
}

console.log("\nA→B→A 折返：不能谁都不落地（序号模型会踩的坑）");
{
  // 首个 A 请求拖尾才回，此时选中项已经回到 A —— 它必须能落地，
  // 否则用户回到 A 后预览一直是空的。
  check("折返后迟到的 A 仍可落地", previewLands(A, A) === true);
  check("中途的 B 仍作废", previewLands(B, A) === false);
}

console.log("\n关闭预览（filePath 变空）");
{
  check("预览已关时，任何在飞结果都作废", previewLands(A, "") === false);
  // 空路径的请求本身不算「落地」—— watcher 里的 `if (props.filePath)` 已经
  // 拦掉了这种调用，这里只保证它不会误判成「有内容要写」。
  check("空路径对空路径判为可落地（无害，调用点已拦）", previewLands("", "") === true);
}

console.log("\n同名不同目录：判据是完整路径而非文件名");
{
  const left = "C:\\a\\photo.heic";
  const right = "D:\\b\\photo.heic";
  check("同名不同目录必须判为不同文件", previewLands(left, right) === false);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);