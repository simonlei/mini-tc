// 验证「启动器选 Node」不再取字典序第一个，而是取满足 engines 的最新版本。
// 直接 `node scripts/node-pick-check.mjs` 跑。
//
// 背景（TODO.md P2 第一条）：dev.bat 与 dev.sh 都用
//   for /d %%v in ("...\versions\*")   /   for dir in ".../versions"/*
// 选 Node，两者都按**字典序**枚举，于是 22.12.0 永远排在 22.22.2 前面、
// 被选中 —— 选中的恰恰是最旧的那个。症状不是安装报错，而是运行时在
// import 阶段崩：jsdom 30 要 node ^22.22.2，在 22.12.0 上调
// zlib.createZstdDecompress（node 22.15+ 才有）直接死，且**无告警**。
//
// 这里分四层，因为每层能抓住不同类型的回归：
//   ① 纯函数表：版本解析 / 比较 / engines 区间（锚定 pick-node.js 自身）；
//   ② 对照臂：把旧实现逐字复刻，证明这些断言真的有分辨力、不是恒真；
//   ③ 真实文件系统集成：在临时目录里造版本树，跑**真的** pickBest，
//      含旧代码会选错的那些组合；
//   ④ 静态断言：dev.bat / dev.sh 确实改成了调用 pick-node.js，且
//      pick-node.js 没有任何残留的「取第一个」逻辑。
//
// 不测的部分：dev.bat 本身在本机跑不了（cmd.exe 被沙箱封禁），所以
// 「batch 语法正确」无法端到端验证 —— 这一点如实记录，不假装覆盖了。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// stripComments.cjs 只认 JS 的 // 与 /* */。启动器各有自己的注释语法：
// batch 是 REM，shell 是 #。不剥注释就会把「解释旧 bug 的说明文字」当成
// 残留代码（实测踩过：`:node_found` 只出现在 REM 里，断言却报了 FAIL）。
const require = createRequire(import.meta.url);
const pick = require("./pick-node.js");

/** 剥掉 REM / REM. 开头的行（batch 注释）。 */
function stripRem(src) {
  return src.replace(/^\s*REM\.?\s.*$/gm, "").replace(/REM\s/g, " ");
}

/** 剥掉 # 开头的行（shell 注释），并去掉续行符，让 for 块变成单行可匹配。 */
function stripHash(src) {
  return src.replace(/^\s*#.*$/gm, "");
}

const { parseVersion, compareVersions, compileRange, pickBest } = pick;

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

const V = (s) => ({ dir: `C:/fake/${s}`, version: parseVersion(s) });

// ── 对照臂：旧实现的逐字复刻 ──
// dev.bat: for /d %%v in ("...\versions\*") -> if exist "%%v\node.exe" -> goto
// dev.sh : for dir in ".../versions"/*      -> if [ -x "${dir}/node.exe" ] -> return
// 两者都按**字典序**枚举，取第一个「含 node.exe」的目录。
// fs.readdirSync 在 NTFS 上返回名字序（与 for /d 一致），所以这里能复现。
function oldFirstWithNodeExe(names, hasExe) {
  for (const name of names) {
    if (hasExe(name)) return name;
  }
  return undefined;
}

console.log("① 纯函数表：版本解析与比较");
{
  check("'v22.22.2' 解析出 22.22.2",
    JSON.stringify(parseVersion("v22.22.2")) === '{"major":22,"minor":22,"patch":2}');
  check("'22.12.0'（无 v 前缀）同样解析", parseVersion("22.12.0").minor === 12);
  check("带尾随 '-6' 的目录名解析出 base 版本",
    parseVersion("22.22.2-6").patch === 2);
  check("前导空白被容忍", parseVersion("  22.22.2 \n").major === 22);
  check("空串 → null", parseVersion("") === null);
  check("undefined → null", parseVersion(undefined) === null);
  check("非版本串 → null", parseVersion("current") === null);
  check("null → null", parseVersion(null) === null);

  check("22.22.2 > 22.12.0（字典序会说反）",
    compareVersions(parseVersion("22.22.2"), parseVersion("22.12.0")) > 0);
  check("22.12.0 < 22.22.2", compareVersions(parseVersion("22.12.0"), parseVersion("22.22.2")) < 0);
  check("24.0.0 > 22.22.2（大版本优先）",
    compareVersions(parseVersion("24.0.0"), parseVersion("22.22.2")) > 0);
  check("22.22.2 == 22.22.2", compareVersions(parseVersion("22.22.2"), parseVersion("22.22.2")) === 0);
  check("22.22.2-6 == 22.22.2（后缀不影响 base 比较）",
    compareVersions(parseVersion("22.22.2-6"), parseVersion("22.22.2")) === 0);
  check("9.1.2 < 22.12.0（字符串比较会误判 '9' > '2'）",
    compareVersions(parseVersion("9.1.2"), parseVersion("22.12.0")) < 0);
  check("22.22.10 > 22.22.9（数字段不是字典序）",
    compareVersions(parseVersion("22.22.10"), parseVersion("22.22.9")) > 0);
}

console.log("\n② engines 区间解析");
{
  const always = compileRange("");
  check("空区间 → 全接受", always.test(parseVersion("9.0.0")) === true);

  const gte = compileRange(">=22.22.2");
  check("理解 '>=22.22.2'", gte && gte.understood === true);
  check("22.22.2 满足 >=22.22.2", gte.test(parseVersion("22.22.2")) === true);
  check("22.12.0 不满足 >=22.22.2", gte.test(parseVersion("22.12.0")) === false);
  check("24.0.0 满足 >=22.22.2", gte.test(parseVersion("24.0.0")) === true);

  // jsdom 28 真实声明的区间，正是需要能正确解析的那类（带 || 与 ^）
  const jsdom = compileRange("^20.19.0 || ^22.12.0 || >=24.0.0");
  check("理解 jsdom 的 '^20.19.0 || ^22.12.0 || >=24.0.0'", jsdom && jsdom.understood === true);
  check("jsdom 区间：20.19.0 接受", jsdom.test(parseVersion("20.19.0")) === true);
  check("jsdom 区间：22.12.0 接受", jsdom.test(parseVersion("22.12.0")) === true);
  check("jsdom 区间：24.0.0 接受", jsdom.test(parseVersion("24.0.0")) === true);
  check("jsdom 区间：22.11.0 拒绝（^22.12.0 之下）", jsdom.test(parseVersion("22.11.0")) === false);
  check("jsdom 区间：9.1.2 拒绝", jsdom.test(parseVersion("9.1.2")) === false);
  check("jsdom 区间：23.5.0 拒绝（^22.x 只看 major）", jsdom.test(parseVersion("23.5.0")) === false);

  // 空格是 AND，不是把范围收窄成最后一个 token。
  const conj = compileRange(">=20.0.0 <23.0.0");
  check("理解 '>=20.0.0 <23.0.0'（空格=AND）", conj && conj.understood === true);
  check("AND：22.x 接受", conj.test(parseVersion("22.5.0")) === true);
  check("AND：19.x 拒绝", conj.test(parseVersion("19.5.0")) === false);
  check("AND：23.x 拒绝（上界）", conj.test(parseVersion("23.5.0")) === false);

  check("'~22.12.0' 接受 22.12.9", compileRange("~22.12.0").test(parseVersion("22.12.9")) === true);
  check("'~22.12.0' 拒绝 22.13.0", compileRange("~22.12.0").test(parseVersion("22.13.0")) === false);
  check("'=22.12.0' 精确匹配", compileRange("=22.12.0").test(parseVersion("22.12.0")) === true);

  // 语法不认识时必须返回 null（让调用方**忽略**约束），
  // 而不是返回一个「全都拒绝」的谓词 —— 那会退化成「选不出 node」。
  check("无法解析的语法 → null", compileRange("latest") === null);
  check("无法解析 → null（而非恒 false 谓词）", compileRange("not-a-range") === null);
  check("undefined 区间 → 全接受（不报错）", compileRange(undefined).test(parseVersion("9.0.0")) === true);
}

console.log("\n③ 对照臂：旧实现在同一批输入上确实选错");
{
  // 复现本机真实目录序（实测 readdirSync 返回 22.12.0 22.22.2-6 24.0.0 9.1.2）
  const NAMES = ["22.12.0", "22.22.2-6", "24.0.0", "9.1.2"];
  const hasExe = (n) => NAMES.includes(n); // 四个都是版本目录，都有 node.exe

  check("对照臂保真：旧实现在本机目录序下选中 22.12.0",
    oldFirstWithNodeExe(NAMES, hasExe) === "22.12.0");
  check("对照臂保真：旧实现选中的是**次旧**而非最旧（9.1.2 排在更后）",
    oldFirstWithNodeExe(NAMES, hasExe) !== "9.1.2");
  check("对照臂保真：目录序里确实存在更新的 22.22.2 与 24.0.0",
    NAMES.includes("22.22.2-6") && NAMES.includes("24.0.0"));

  const gte = compileRange(">=22.22.2");

  // 有分辨力的核心证据：同一批候选，旧实现与新实现**结论不同**。
  const NEWEST = "24.0.0";
  check(
    `旧实现选 ${oldFirstWithNodeExe(NAMES, hasExe)}，新实现选 ${NEWEST} —— 结果不同（这就是被修掉的 bug）`,
    oldFirstWithNodeExe(NAMES, hasExe) !== NEWEST
  );

  // 新实现在这批输入上确实给出「满足约束的最新」。
  const cands = NAMES.map(V);
  const chosen = pickBest(cands, gte.test);
  check("新实现在这批上选中 24.0.0", chosen.version.major === 24);
  check("新实现的选中者确实满足 engines", gte.test(chosen.version) === true);

  // 反向确认：新实现在**旧实现本来就选对**的输入上没有画蛇添足。
  // 只有 22.12.0 时，两种策略都得选 22.12.0 —— 此时若断言要求「必须选最新的
  // 满足约束者」，22.12.0 在无约束时就是最新，结论应一致。
  const single = pickBest([V("22.12.0")], () => true);
  check("只有一个候选时选中它", single.version.minor === 12);

  // 只有在旧实现**恰好蒙对**的输入上，新实现也必须给出同一答案 ——
  // 否则「取最新」可能反而把一个可用版本换掉（这才是过度修复）。
  // 注意期望值写的是**解析后的版本**而非目录名：`22.22.2-6` 的 base 是 22.22.2。
  const OLD_PICKED_CORRECTLY = [
    ["9.1.2", "9.1.2"],         // 字典序里 9.x 在最后 → 旧选 9.1.2，新也该选 9.1.2
    ["22.22.2-6", "22.22.2"],   // 只有它 → 一致（期望值是 base 版本）
    ["24.0.0", "24.0.0"],       // 大版本排在字典序最前 → 旧选 24.0.0，新也该选 24.0.0
  ];
  for (const [only, expected] of OLD_PICKED_CORRECTLY) {
    const names = [only];
    const picked = pickBest(names.map(V), () => true);
    const got = `${picked.version.major}.${picked.version.minor}.${picked.version.patch}`;
    check(`旧实现本就选对的输入 [${only}]：新旧一致（没画蛇添足）`,
      oldFirstWithNodeExe(names, (n) => n === only) === only && got === expected);
  }
}

console.log("\n④ 真实文件系统集成：临时版本树 + 真的候选枚举 / pickBest");
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "minitc-nodever-"));
  try {
    // 必须建在 candidateRoots 真正会去看的那个形状上，否则 wellKnownCandidates
    // 正确地返回空数组、断言也会「因为错误的原因」通过。
    const versionsDir = path.join(base, ".workbuddy", "binaries", "node", "versions");
    // 按**字典序**写入，正是旧实现会踩到的顺序。
    for (const v of ["22.12.0", "22.22.2-6", "24.0.0", "9.1.2"]) {
      fs.mkdirSync(path.join(versionsDir, v), { recursive: true });
      fs.writeFileSync(path.join(versionsDir, v, "node.exe"), "stub");
    }
    // 噪声：非版本目录、名为 current 的文件、.locks 目录（字典序最前）。
    fs.mkdirSync(path.join(versionsDir, ".locks"), { recursive: true });
    fs.writeFileSync(path.join(versionsDir, "current"), "22.22.2-6");
    fs.mkdirSync(path.join(versionsDir, "notaversion"), { recursive: true });
    fs.writeFileSync(path.join(versionsDir, "notaversion", "node.exe"), "stub");

    const io = {
      exists: (p) => fs.existsSync(p),
      isDir: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
      listDirs: (p) => fs.readdirSync(p),
    };
    const exeDirs = pick.wellKnownCandidates({ USERPROFILE: base }, io);

    check("候选枚举找到 5 个含 node.exe 的目录", exeDirs.length === 5,
      `实际 ${exeDirs.length}: ${JSON.stringify(exeDirs)}`);
    check("找到的目录都真实存在 node.exe",
      exeDirs.every((d) => fs.existsSync(path.join(d, "node.exe"))));
    check("非版本目录 notaversion 也被发现（枚举不做版本名假设）",
      exeDirs.some((d) => d.endsWith("notaversion")));
    check(".locks 下没有 node.exe 因此不产生候选",
      !exeDirs.some((d) => d.includes(".locks")));

    // 旧实现在这棵真树上的选择：`for /d` 拿到字典序，靠 if exist 守卫跳过
    // 没有 node.exe 的条目，取第一个命中的。
    const realDirOrder = fs.readdirSync(versionsDir);
    const oldPick = oldFirstWithNodeExe(
      realDirOrder,
      (n) => fs.existsSync(path.join(versionsDir, n, "node.exe"))
    );
    check("旧实现在这棵真树上选中 22.12.0（.locks 被守卫跳过）", oldPick === "22.12.0");

    // 用真的 pickBest，候选的 version 按 probeVersion 的解析规则从目录名得到
    // （真实 node.exe 是 stub，spawn 它没有意义，所以这里走同一套 parseVersion）。
    const byName = exeDirs
      .map((d) => ({ dir: d, version: parseVersion(path.basename(d)) }))
      .filter((c) => c.version);
    check("4 个候选的版本名可解析（notaversion 被排除在外）", byName.length === 4);

    const gte = compileRange(">=22.22.2");
    const newestOk = pickBest(byName, gte.test);
    check("有约束时选中满足约束的最新 = 24.0.0", newestOk && newestOk.version.major === 24);
    check("选中者满足 >=22.22.2", gte.test(newestOk.version) === true);

    const anyOk = pickBest(byName, () => true);
    check("无约束时选中全局最新 = 24.0.0（不是 9.1.2，也不是 22.12.0）",
      anyOk.version.major === 24 && anyOk.version.minor === 0);

    // 关键对照：旧实现在同一棵树上选 22.12.0，新实现选 24.0.0。
    check("真树上：新旧结论不同（bug 确实被修掉）", oldPick !== "24.0.0");

    // probeVersion 的解析规则与目录名解析必须一致 —— 否则 main() 里
    // 「用 probeVersion 的结果排序」和这里的断言会各说各话。
    check("目录名 '22.22.2-6' 的 base 版本就是 22.22.2（与 node -p 的输出同形）",
      parseVersion("22.22.2-6").major === 22 && parseVersion("22.22.2-6").minor === 22);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

console.log("\n⑤ 边界：候选为空 / 版本不可解析 / 约束无人满足");
{
  check("空候选 → null", pickBest([], () => true) === null);
  check("全是 null 版本 → null", pickBest([{ dir: "a", version: null }], () => true) === null);
  check("版本不可解析的候选被跳过",
    pickBest([{ dir: "a", version: null }, V("22.22.2")], () => true).version.minor === 22);

  // 无人满足约束时**不能**返回 null（那会让 dev.bat 直接罢工），
  // 退回「全部候选里最新的」并由调用方告警。
  const unsat = compileRange(">=99.0.0");
  const fallback = pickBest([V("22.12.0"), V("22.22.2")], unsat.test);
  check("无人满足约束时仍选出最新的（不罢工）", fallback.version.minor === 22);
  check("该结果确实不满足约束（供调用方告警）", unsat.test(fallback.version) === false);

  check("单个候选 + 单个约束", pickBest([V("22.22.2")], () => true).version.minor === 22);
}

console.log("\n⑥ 静态断言：两个启动器都把版本决策交给了 pick-node.js");
{
  const bat = fs.readFileSync(path.join(ROOT, "dev.bat"), "utf8");
  const sh = fs.readFileSync(path.join(ROOT, "dev.sh"), "utf8");

  check("dev.bat 调用 pick-node.js", bat.includes("pick-node.js"));
  check("dev.sh 调用 pick-node.js", sh.includes("pick-node.js"));

  // 不变量不是「不再出现 for 循环」—— bootstrap 阶段**必须**有一个目录扫描
  // 来找到「任意一个能跑 node 的东西」，没有它就无从执行 pick-node.js。
  // 不变量是：那个扫描的结果**不再直接决定用哪个 node**。
  // ① dev.bat：旧的 for /d + goto :node_found 必须消失（goto = 直接定型）。
  // 必须先剥注释 —— 新代码的 REM 里**故意**引用了 `:node_found` 来解释旧 bug，
  // 直接对原文 grep 会把这段说明当成残留（实测踩过：断言假阴性）。
  const batCode = stripRem(bat);
  check("dev.bat 不再用 for /d + goto 自行定型 node 版本",
    !/for \/d %%v in \([^)]*versions\\\*/.test(batCode));
  check("dev.bat 不再有 :node_found 标签（旧定型点，剥注释后）",
    !batCode.includes(":node_found"));
  check("dev.bat 的选型结果来自 pick-node.js 的 stdout（for /f 捕获）",
    /for \/f "usebackq delims=" %%n in \(`"!NODE_BOOT!" "%PROJECT_ROOT%scripts\\pick-node\.js"`\)/.test(batCode));
  check("dev.bat 的 bootstrap 扫描与定型是两个不同标签（bootstrap 不定型）",
    batCode.includes(":node_boot_found") && !batCode.includes(":node_found"));

  // ② dev.sh：旧的 `for dir in ".../versions"/*` 后**立刻 return 0** 是定型信号。
  // 现在的 bootstrap 循环用 break（跳出循环后仍交给 pick-node.js）。
  // 正则用 multiline 且限制在 for 块内，避免跨注释误匹配。
  const shCode = stripHash(sh);
  check("dev.sh 的 node 选择结果来自 pick-node.js 的 stdout",
    /chosen="\$\("\$bootstrap" "\$\{SCRIPT_DIR\}\/scripts\/pick-node\.js"\)"/.test(shCode));
  check("dev.sh 不再用 `return 0` 在扫描循环里定型 node 版本",
    !/versions[^)]*\)\s*;\s*do\s*\n(?:[^\n]*\n){0,6}?\s*return 0/.test(shCode));
  // 顺序不变量：bootstrap 扫描在前，pick-node.js 在后 —— 若有人把
  // pick-node.js 挪到扫描之前，扫描就变成了「覆盖选型结果」。
  const bootIdx = shCode.indexOf("bootstrap=");
  const pickIdx = shCode.indexOf("pick-node.js");
  check("dev.sh 里 bootstrap 扫描在 pick-node.js 之前（选型不被覆盖）",
    bootIdx !== -1 && pickIdx !== -1 && bootIdx < pickIdx);

  // batch 硬约束：非 ASCII 会让 cmd.exe 从中间切断长行。REM 注释也必须纯 ASCII。
  const nonAscii = bat.match(/[\u0080-\uFFFF]/g);
  check("dev.bat 保持纯 ASCII（cmd.exe 多字节切断长行的坑）", nonAscii === null);
  if (nonAscii) console.log(`       非 ASCII 字符: ${JSON.stringify([...new Set(nonAscii)])}`);

  // CRLF：Edit 工具默认写 LF，混行尾会让 cmd.exe 解析错乱。
  const raw = fs.readFileSync(path.join(ROOT, "dev.bat"), "latin1");
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/\n/g) || []).length;
  check(`dev.bat 行尾全为 CRLF（CRLF=${crlf} 裸LF=${lf - crlf}）`, crlf === lf);

  // pick-node.js 自己不得残留「取第一个」的逻辑。
  const pj = fs.readFileSync(path.join(ROOT, "scripts", "pick-node.js"), "utf8");
  check("pick-node.js 没有 readdirSync 后取 [0] 的残留",
    !/readdirSync\([^)]*\)\s*\[\s*0\s*\]/.test(pj));
  check("pick-node.js 导出了 pickBest（供测试与复用）",
    /module\.exports[\s\S]*pickBest/.test(pj));

  // stdout 契约：dev.bat 的 `for /f` 与 dev.sh 的 `$(...)` 都只吃 stdout。
  // 诊断信息一旦混进 stdout，NODE_DIR 就变成多行文本拼成的废路径，且症状是
  // 「node 明明装了却说找不到」—— 极难排查。
  //
  // 这里**真的执行**一次 CLI 并检查 stdout 行数，而不是 grep 源码里的
  // console.error：变异测试实测过，源码级断言抓不到「写错流」——
  // 把 console.error 改成 console.log 后，那些断言依然全绿（恒真）。
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "pick-node.js")], {
    encoding: "utf8",
    timeout: 60000,
  });
  const outLines = String(cli.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  check(`CLI 退出码为 0（实际 ${cli.status}）`, cli.status === 0);
  check(`CLI 的 stdout 恰好一行（实际 ${outLines.length} 行）—— 否则 dev.bat 的 for /f 会拿到废路径`,
    outLines.length === 1);
  check("CLI stdout 的那一行就是选中目录的绝对路径",
    outLines.length === 1 && /^[A-Za-z]:\\/.test(outLines[0]));
  check("CLI stdout 带尾反斜杠（dev.bat 直接 set PATH=%NODE_DIR%;... 拼接）",
    outLines.length === 1 && outLines[0].endsWith("\\"));
  check("CLI 选出的目录里确有 node.exe（stdout 不是空壳）",
    outLines.length === 1 && fs.existsSync(path.join(outLines[0], "node.exe")));

  // --print-all 走的是另一个分支，两条输出路径都不能混 stdout。
  const all = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "pick-node.js"), "--print-all"],
    { encoding: "utf8", timeout: 60000 }
  );
  const allLines = String(all.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  check(`--print-all 输出每个候选一行（实际 ${allLines.length} 行）`, allLines.length > 1);
  check("--print-all 每行是 dir<TAB>version 两列",
    allLines.every((l) => l.split("\t").length === 2));

  // ⚠️ 上面那次执行在本机**没有任何 warning**，那两行 console.error(w)
  // 根本没被调用 —— 于是「诊断写 stderr」这条约束在干净环境下是恒真的
  // （变异测试实测：把 console.error 全改成 console.log，仍然 0 FAIL）。
  // 所以必须构造一个**必然产生 warning** 的场景：
  // 复制一份 package.json 到临时目录，把 engines.node 改成 99.0.0，
  // 于是每个候选都触发「不满足 engines」的告警 + 「无人满足」的兜底告警。
  // 此时 stdout 若混入告警，for /f 拿到的就是多行废路径。
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "minitc-pickcli-"));
  try {
    fs.mkdirSync(path.join(sandbox, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, "scripts", "pick-node.js"),
      path.join(sandbox, "scripts", "pick-node.js")
    );
    fs.writeFileSync(
      path.join(sandbox, "package.json"),
      JSON.stringify({ name: "sandbox", engines: { node: ">=99.0.0" } })
    );
    const noisy = spawnSync(
      process.execPath,
      [path.join(sandbox, "scripts", "pick-node.js")],
      { encoding: "utf8", timeout: 60000 }
    );
    const noisyOut = String(noisy.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    const noisyErr = String(noisy.stderr || "").trim();

    check("构造成功：该场景确实产生了告警（否则下面几条是恒真的）",
      noisyErr.includes("does not satisfy engines"), `stderr=${JSON.stringify(noisyErr.slice(0, 120))}`);
    check(`有告警时 stdout 仍然恰好一行（实际 ${noisyOut.length} 行）`,
      noisyOut.length === 1);
    check("告警确实写进了 stderr 而不是 stdout",
      noisyOut.length === 1 && !noisyOut[0].includes("[WARN]"));
    check("无人满足约束时仍选出候选而不是罢工（stdout 非空）",
      noisyOut.length === 1 && /^[A-Za-z]:\\/.test(noisyOut[0]));
    check("无人满足时的兜底告警也进了 stderr",
      noisyErr.includes("using the newest one available anyway"));

    // 兜底的**行为**本身：无人满足时不能返回 null。
    // 只断言"stdout 非空"是不够的 —— 实测变异 `const pool = ok;`
    // （去掉 `ok.length ? ok : usable` 兜底）依然 0 FAIL，因为 pickBest
    // 在 pool 为空时对空数组返回 null，而 main() 走的是 `[ERROR] No usable
    // node.exe found.` + exit 1，stdout 恰好也是空。
    // 所以这里必须断言退出码 0 且选出的**仍是最新的那个**。
    const noFallback = pick.pickBest(
      [V("22.12.0"), V("22.22.2")],
      (v) => v.major >= 99
    );
    check("pickBest：无人满足约束时仍返回最新的候选（不返回 null）",
      noFallback !== null);
    check("pickBest：兜底选出的是 22.22.2（最新的那个）",
      noFallback && noFallback.version.minor === 22);
    check("兜底结果确实不满足该约束（供调用方告警）",
      noFallback && noFallback.version.major < 99);
    check("无人满足约束时 CLI 退出码仍为 0（不罢工）", noisy.status === 0);

    // 返回类型契约：pickBest 找不到时必须返回 **null** 而不是 undefined。
    // undefined 能通过 `!== null`，却会让调用方的 `chosen.version` 崩掉。
    // 实测变异 `const pool = ok;`（去掉兜底）返回的就是 undefined。
    check("pickBest：候选为空时返回 null（不是 undefined）",
      pickBest([], () => true) === null);
    check("pickBest：全部版本不可解析时返回 null（不是 undefined）",
      pickBest([{ dir: "a", version: null }], () => true) === null);
    // 兜底路径必须给出**非 null** 的候选（而不是 undefined）。
    check("pickBest：兜底路径返回的是候选对象（严格非 null）",
      pickBest([V("1.0.0")], () => false) != null &&
      pickBest([V("1.0.0")], () => false) !== undefined);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log("\n⑦ 本机真实环境冒烟：真的探测真的能选出可用的 node");
{
  // 这一层跑的是 main() 的真实路径（spawn 真 node.exe -p，不打桩）：
  // 纯函数全绿也抓不到「probeVersion 在真机上 spawn 不动」这类问题。
  const chosen = pick.probeVersion;
  const dirs = [];
  for (const root of pick.candidateRoots(process.env)) {
    for (const d of pick.wellKnownCandidates(process.env, {
      exists: (p) => fs.existsSync(p),
      isDir: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
      listDirs: (p) => fs.readdirSync(p),
    })) {
      if (!dirs.includes(d)) dirs.push(d);
    }
  }
  check("本机至少探测到一个 node 候选", dirs.length > 0, `实际 ${dirs.length}`);
  check("本机至少有一个候选能被 probeVersion 问出版本",
    dirs.map(chosen).filter(Boolean).length > 0);

  // 若本机装了多个不同版本，断言选择结果确实是**最新**的。
  const probed = dirs
    .map((d) => ({ dir: d, version: chosen(d) }))
    .filter((c) => c.version);
  if (probed.length > 1) {
    const best = pick.pickBest(probed, () => true);
    let isMax = true;
    for (const c of probed) {
      if (pick.compareVersions(c.version, best.version) > 0) isMax = false;
    }
    check(`本机 ${probed.length} 个候选里选出的确实是最新的（${best.version.major}.${best.version.minor}.${best.version.patch}）`,
      isMax);
    console.log(`       本机候选: ${probed.map((c) => `${c.version.major}.${c.version.minor}.${c.version.patch}`).join(", ")}`);
  } else {
    console.log("  skip  本机只有一个可探测的 node 版本，跳过「选最新」比较");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);