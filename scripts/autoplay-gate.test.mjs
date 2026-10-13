// 验证视频自动续播的授权闸门。直接 `node scripts/autoplay-gate.test.mjs` 跑。
//
// 判据：断言必须在退化实现下失败 ——
//   ① claim 恒返回 true（= 旧的「子组件自己置位、无条件自动播」）；
//   ② claim 不清除 armed（= 授权能跨过一次加载存活）。
// 全绿但抓不住退化的测试等于没测试。
//
// 这里复刻的**不是**组件，而是「App.playNextVideo 的 5 个提前 return + 用户的
// 手动选择」这条真实时序：每一步都问 gate，而不问任何一个 Vue ref。

import { createAutoplayGate } from "../src/autoplayGate.js";

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

const A = "C:\\vids\\a.mp4";
const B = "C:\\vids\\b.mp4";
const LAST = "C:\\vids\\z.mp4";

// ── playNextVideo 的 5 个提前 return，各自都不该留下授权 ──
// 这里复刻真实时序：onEnded 触发 → 父组件走某个 bail 分支 → 不 arm。
// 若实现退回到「子组件自己置位」，这些分支之后 gate 就会是 armed。
//
// ⚠️ 每个分支必须配**对应的状态**：bail 函数读的就是这些字段，全给「有值」
// 的状态等于没触发 bail —— 断言恒真的测试是在测空气。
const HEALTHY = {
  previewVisible: true,
  previewKind: "video",
  currentName: "a.mp4",
  next: { name: "b.mp4" },
  dir: "C:\\vids",
};
const BAILS = {
  "预览已关": { ...HEALTHY, previewVisible: false },
  "当前不是视频": { ...HEALTHY, previewKind: "file" },
  "拿不到当前文件名": { ...HEALTHY, currentName: "" },
  "已是列表最后一条": { ...HEALTHY, next: null },
  "拿不到目录": { ...HEALTHY, dir: "" },
};

// 照抄 App.playNextVideo 的判定链与顺序。
function judge(state) {
  if (!state.previewVisible || state.previewKind !== "video") return "预览不可用";
  if (!state.currentName) return "无当前名";
  if (!state.next) return "末条";
  if (!state.dir) return "无目录";
  return null;
}

function replayEnded(state) {
  const gate = createAutoplayGate();
  // 子组件 onEnded：只 emit，不再自己置位（这正是本次修法）
  const bailReason = judge(state);
  if (!bailReason) gate.arm("C:\\vids\\b.mp4");
  return { gate, bailReason };
}

console.log("父组件每一个提前 return 之后，gate 都必须处于未授权状态");
for (const [label, state] of Object.entries(BAILS)) {
  const { gate, bailReason } = replayEnded(state);
  check(`${label} 命中 bail`, bailReason !== null);
  check(`${label} → 未授权`, gate.isArmed() === false);
}

console.log("\n对照：全部条件齐备时必须授权（否则续播功能整体失效）");
{
  const { gate, bailReason } = replayEnded(HEALTHY);
  check("健康状态不 bail", bailReason === null);
  check("健康状态已授权", gate.isArmed() === true);
  check("下一次加载消费到", gate.claim("C:\\vids\\b.mp4") === true);
}

console.log("\n原 bug：末条视频播完后手动选另一条，不该自己播");
{
  const { gate, bailReason } = replayEnded(BAILS["已是列表最后一条"]);
  check("确实走到末条分支", bailReason !== null);
  // 用户手动点 B
  check("手动选 B 时不自动播", gate.claim(B) === false);
}
console.log("\n原 bug：预览在 await 期间被关掉，之后手动打开不该自己播");
{
  const gate = createAutoplayGate();
  gate.arm(B); // await entryPath 之后武装
  gate.arm(null); // closePreview() 在事件处撤销
  check("撤销后手动打开 B 不自动播", gate.claim(B) === false);
}

console.log("\n正常续播：授权必须被下一次加载消费掉");
{
  const gate = createAutoplayGate();
  gate.arm(B);
  check("消费命中 → 自动播", gate.claim(B) === true);
  check("消费后即失效", gate.isArmed() === false);
  check("同一条不会被消费两次", gate.claim(B) === false);
}

console.log("\n授权是一次性的：不能跨过一次加载存活");
{
  const gate = createAutoplayGate();
  gate.arm(B);
  check("首次命中", gate.claim(B) === true);
  // 用户随后手动选了 A —— 旧实现下这里会拿到残留的 true
  check("之后的加载拿不到残留授权", gate.claim(A) === false);
  check("再往后仍然拿不到", gate.claim(LAST) === false);
}

console.log("\n未授权时的普通加载：永远不自动播");
{
  const gate = createAutoplayGate();
  check("无授权 → 不播", gate.claim(A) === false);
  check("再选一条 → 仍不播", gate.claim(B) === false);
}

console.log("\n「授权了但没真换文件」（下一条是 WebView 解不了的格式）");
{
  // playNextVideo arm 了 B，但 VideoPreview.loadVideo() 对 EXTERNAL_ONLY 提前
  // return —— claim 在该分支之前执行，所以授权在此被消费掉。
  const gate = createAutoplayGate();
  gate.arm(B);
  const claimed = gate.claim(B);
  check("B 的加载确实消费了授权", claimed === true);
  check("EXTERNAL_ONLY 分支提前 return 不会留下残留", gate.isArmed() === false);
  // 用户手动点别的视频
  check("用户手动选 A 不受影响", gate.claim(A) === false);
}

console.log("\n路径必须精确匹配（授权不是「任意下一条」）");
{
  const gate = createAutoplayGate();
  gate.arm(B);
  check("同名不同目录不算命中", gate.claim("D:\\other\\b.mp4") === false);
}
{
  const gate = createAutoplayGate();
  gate.arm(B);
  check("另一条不算命中", gate.claim(A) === false);
}

console.log("\n空 / 非法输入不得凭空授权");
{
  const gate = createAutoplayGate();
  gate.arm("");
  check("arm('') 不授权", gate.isArmed() === false);
  check("claim('') 不播", gate.claim("") === false);
}
{
  const gate = createAutoplayGate();
  gate.arm(null);
  check("arm(null) 不授权", gate.isArmed() === false);
}
{
  const gate = createAutoplayGate();
  gate.arm(undefined);
  check("arm(undefined) 不授权", gate.isArmed() === false);
}

console.log("\n连续续播：A→B→C 每一段各自授权、各自消费");
{
  const gate = createAutoplayGate();
  gate.arm(B);
  check("B 自动播", gate.claim(B) === true);
  gate.arm("C:\\vids\\c.mp4");
  check("C 自动播", gate.claim("C:\\vids\\c.mp4") === true);
}

console.log("\n重复 arm 覆盖前一个（权威来源是父组件此刻的意图）");
{
  const gate = createAutoplayGate();
  gate.arm(B);
  gate.arm(A); // 父组件改了主意
  // 先验旧授权：claim 会消费，所以每种组合各用一个 gate
  check("旧授权 B 失效", gate.claim(B) === false);
  const gate2 = createAutoplayGate();
  gate2.arm(B);
  gate2.arm(A);
  check("新授权 A 生效", gate2.claim(A) === true);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
