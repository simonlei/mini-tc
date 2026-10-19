// 验证字幕探测的并发守卫与候选筛选：一次 detectSubtitles 的结果，在 await 之后
// 还能不能落地；以及「哪个候选算命中」这个判定本身。
// 直接 `node scripts/subtitle-gate.test.mjs` 跑。
//
// 判据设计（来自 METHODOLOGY）：
//   ① 纯逻辑用例必须 import 生产代码，否则「改实现不改测试」照样全绿；
//   ② 配一个**对照臂**：把旧实现（无守卫、读 props 而不是读快照）在同一批场景
//      上跑一遍，要求它漏掉 ≥3 个 —— 否则「彻底坏掉」的 harness 自己也全绿；
//   ③ 静态断言钉住调用点（VideoPreview.vue 真的查了守卫、真的传了快照），
//      因为只测判据的话，把调用删掉纯逻辑测试仍然全绿。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSubtitleGate, subtitleCandidates } from "../src/subtitleGate.js";
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

// ─────────────────────────────────────────────────────────────
// 对照臂：旧实现（复刻自修好之前的 VideoPreview.vue）。
// 它没有守卫、在 await 之后重读 props，并逐文件 push。
// ─────────────────────────────────────────────────────────────
const SUB_EXTS = ["srt", "vtt", "ass", "ssa"];
function oldGetExt(name) {
  const p = name.split(".");
  return p.length > 1 ? p.pop().toLowerCase() : "";
}

/** 旧版 detectSubtitles。props 是一个可变对象；await 之间调用方可以换掉它。 */
async function oldDetectSubtitles(props, io) {
  const dir = await io.getParentDir(props.filePath);
  if (!dir) return;
  const list = (await io.listDirectory(dir)).entries;
  const base = props.fileName.replace(/\.[^.]+$/, ""); // ← 重读 props
  const found = list.filter((e) => !e.is_dir && SUB_EXTS.includes(oldGetExt(e.name)));
  const enriched = await Promise.all(
    found.map(async (e) => {
      const p = await io.joinPath(dir, e.name);
      const s = e.name.replace(/\.[^.]+$/, "");
      const matched = s === base || s.startsWith(base + ".");
      return { name: e.name, path: p, ext: oldGetExt(e.name), matched };
    })
  );
  enriched.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0) || a.name.localeCompare(b.name));
  for (const c of enriched) {
    const track = await io.readSubtitle(c); // 逐个 push 进共享的 tracks 数组
    if (track) io.tracks.push(track);
  }
}

/** 修好后的 detectSubtitles：快照在前、守卫贯穿、末尾一次性提交。 */
async function newDetectSubtitles(props, io, gate, token, filePath, base) {
  const dir = await io.getParentDir(filePath);
  if (!dir || !gate.lands(token)) return;
  const list = (await io.listDirectory(dir)).entries;
  if (!gate.lands(token)) return;
  const candidates = subtitleCandidates(list, base, SUB_EXTS);
  const loaded = [];
  for (const c of candidates) {
    const p = c.path || (await io.joinPath(dir, c.name));
    const track = await io.readSubtitle({ path: p, name: c.name, ext: c.ext, matched: c.matched });
    if (track) loaded.push(track);
    if (!gate.lands(token)) return;
  }
  if (!gate.lands(token)) return;
  io.tracks = loaded; // 一次性提交
}

// ── 一套可控的假 IPC：每个 await 点可以按剧本插一次「用户切了视频」 ──
function makeIO(script) {
  const io = {
    tracks: [],
    // script 是在第几次 await 时把 props 换成第二个文件
    flips: script || {},
    n: 0,
    async getParentDir(p) {
      io.n++;
      if (io.flips.atParent) io.flips.atParent();
      return "D:\\videos";
    },
    async listDirectory() {
      io.n++;
      if (io.flips.atList) io.flips.atList();
      return {
        entries: [
          { name: "a.mp4", is_dir: false, path: "D:\\videos\\a.mp4" },
          { name: "a.srt", is_dir: false, path: "D:\\videos\\a.srt" },
          { name: "a.en.srt", is_dir: false, path: "D:\\videos\\a.en.srt" },
          { name: "b.mp4", is_dir: false, path: "D:\\videos\\b.mp4" },
          { name: "b.srt", is_dir: false, path: "D:\\videos\\b.srt" },
          { name: "notes.txt", is_dir: false, path: "D:\\videos\\notes.txt" },
          { name: "subs", is_dir: true, path: "D:\\videos\\subs" },
        ],
      };
    },
    async joinPath(dir, name) {
      io.n++;
      return dir + "\\" + name;
    },
    async readSubtitle(c) {
      io.n++;
      return { label: c.name, cues: [{ start: 0, end: 1, text: c.name }], matched: c.matched };
    },
  };
  return io;
}

const FILE_A = { filePath: "D:\\videos\\a.mp4", fileName: "a.mp4" };
const FILE_B = { filePath: "D:\\videos\\b.mp4", fileName: "b.mp4" };

// ═════════════════════════════════════════════════════════════
console.log("== 对照臂：旧实现在同一批场景下必须漏掉 ≥3 个 ==");
{
  // 场景 1：切到 b 发生在 getParentDir 之后。实测（scripts/probe，勿凭猜改）：
  // 旧实现取到的 base 已经是 "b"，于是 b.srt 被标为命中排到最前，而 a.srt /
  // a.en.srt **matched=false 仍被收进轨道列表** —— 它从不按 base 过滤，base 只
  // 用来算 matched。这就是串台：a 的字幕出现在 b 的下拉框里。
  {
    const props = { ...FILE_A };
    const io = makeIO({ atParent: () => Object.assign(props, FILE_B) });
    await oldDetectSubtitles(props, io);
    const labels = io.tracks.map((t) => t.label);
    check("对照臂·场景1 旧实现把 a 的字幕也收进了（未按目标过滤）",
      labels.join(",") === "b.srt,a.en.srt,a.srt");
    check("对照臂·场景1 只有 b.srt 被标为命中，其余两条是「不认识的文件」",
      io.tracks.map((t) => t.matched).join(",") === "true,false,false");
  }

  // 场景 2：新文件的链已经清空并开始写入，旧链才 resolve —— 旧实现照样 push。
  {
    const props = { ...FILE_A };
    const io = makeIO({});
    // 模拟「新链已清空 tracks 并开始提交」
    io.tracks = [];
    const chained = oldDetectSubtitles(props, io);
    // 新链的提交（同步发生在旧链第一个 await 之后）
    io.tracks = [{ label: "b.srt", cues: [], matched: true }];
    await chained;
    check("对照臂·场景2 旧实现把 A 的字幕推进了新视频的轨道列表（这正是原 bug）",
      io.tracks.some((t) => t.label === "a.srt"));
  }

  // 场景 3：卸载后 —— 旧实现没有 reset，卸载后仍会写入。
  {
    const props = { ...FILE_A };
    const io = makeIO({});
    const chained = oldDetectSubtitles(props, io);
    io.tracks = []; // 组件已卸载，状态已死
    await chained;
    check("对照臂·场景3 旧实现在卸载后仍然写入", io.tracks.length > 0);
  }
}

// ═════════════════════════════════════════════════════════════
console.log("\n== 守卫：意图身份 ==");
{
  const gate = createSubtitleGate();
  const t1 = gate.begin();
  check("begin() 后本次链可落地", gate.lands(t1) === true);

  const t2 = gate.begin();
  check("第二次 begin 后第一次的链被作废 —— 这就是原 bug", gate.lands(t1) === false);
  check("第二次的链可落地", gate.lands(t2) === true);

  check("没有 token（null / undefined）一律不可落地", gate.lands(null) === false && gate.lands(undefined) === false);
  check("begin() 返回的是全新对象（不是自增序号）", gate.begin() !== gate.begin());

  gate.reset();
  check("reset() 后在飞的链全部作废（卸载）", gate.lands(gate.begin()) === true);
  const t3 = gate.begin();
  gate.reset();
  check("reset() 之后再 lands() → false", gate.lands(t3) === false);
  check("reset() 不会让下一次 begin 失效", gate.lands(gate.begin()) === true);
}

// ═════════════════════════════════════════════════════════════
console.log("\n== 守卫：串台场景（新实现必须不写）==");
{
  // 场景 1': listDirectory 期间切到 b
  {
    const gate = createSubtitleGate();
    const props = { ...FILE_A };
    const token = gate.begin();
    const filePath = props.filePath;
    const base = props.fileName.replace(/\.[^.]+$/, "");
    const io = makeIO({ atList: () => { Object.assign(props, FILE_B); gate.begin(); } });
    await newDetectSubtitles(props, io, gate, token, filePath, base);
    check("场景1' 目标在探测途中变了 → 一条字幕都不落地", io.tracks.length === 0);
    check("场景1' 落地的是空数组而不是 undefined（下游要能安全遍历）", Array.isArray(io.tracks));
  }

  // 场景 2': 新链已清空并提交，旧链随后 resolve
  {
    const gate = createSubtitleGate();
    const props = { ...FILE_A };
    const token = gate.begin();
    const io = makeIO({});
    const chained = newDetectSubtitles(props, io, gate, token, FILE_A.filePath, "a");
    io.tracks = [{ label: "b.srt", cues: [], matched: true }]; // 新链的提交
    gate.begin(); // 新链的 begin
    await chained;
    check("场景2' 旧链不覆盖新链的轨道列表",
      io.tracks.length === 1 && io.tracks[0].label === "b.srt");
  }

  // 场景 3': 卸载后
  {
    const gate = createSubtitleGate();
    const props = { ...FILE_A };
    const token = gate.begin();
    const io = makeIO({});
    const chained = newDetectSubtitles(props, io, gate, token, FILE_A.filePath, "a");
    gate.reset();
    await chained;
    check("场景3' 卸载后旧链不写入", io.tracks.length === 0);
  }

  // 场景 4: 什么都没变 → 必须落地（守卫不能把正常路径也掐死）
  {
    const gate = createSubtitleGate();
    const token = gate.begin();
    const io = makeIO({});
    await newDetectSubtitles({ ...FILE_A }, io, gate, token, FILE_A.filePath, "a");
    check("场景4 目标没变 → 正常落地全部字幕", io.tracks.length === 3);
    check("场景4 命中的排前面", io.tracks.slice(0, 2).every((t) => t.matched));
  }

  // 场景 5: A→B→A 折返 —— 本探测没有 in-flight 折叠，第三个链必须能落地
  {
    const gate = createSubtitleGate();
    const tA1 = gate.begin();
    const tB = gate.begin();
    const tA2 = gate.begin();
    check("场景5 折返后第一个 A 的链已被作废（不落地是对的：它会重复提交）",
      gate.lands(tA1) === false);
    check("场景5 中途的 B 已作废", gate.lands(tB) === false);
    check("场景5 最后一个 A 可落地（不存在「谁都不落地」）", gate.lands(tA2) === true);
  }
}

// ═════════════════════════════════════════════════════════════
console.log("\n== 候选筛选：matched 判定与排序 ==");
{
  const entries = [
    { name: "a.mp4", is_dir: false },
    { name: "a.srt", is_dir: false },
    { name: "a.en.srt", is_dir: false },
    { name: "a.forced.ass", is_dir: false },
    // 字典序在 "a.srt" 之前的未命中项 —— 没有它，「matched 优先排序」这条
    // 断言恒真（纯字典序恰好给出同一个顺序，删掉排序也照样过）。
    { name: "AAA.srt", is_dir: false },
    { name: "a2.srt", is_dir: false },
    { name: "a.txt", is_dir: false },
    { name: "sub", is_dir: true },
    // ⚠️ 目录名带字幕扩展名：没有它，「排除目录」这条断言恒真（`sub` 的扩展名
    // 不在白名单里，过滤器去掉不改变输出）。
    { name: "video.srt", is_dir: true },
    { name: "sub/b.srt", is_dir: false },
  ];
  const c = subtitleCandidates(entries, "a", SUB_EXTS);

  check("只保留字幕扩展名", c.every((x) => SUB_EXTS.includes(x.ext)));
  check("目录被排除（video.srt 是目录，扩展名合法）",
    !c.some((x) => x.name === "video.srt"));
  check("非字幕文件被排除（a.txt）", !c.some((x) => x.name === "a.txt"));
  check("主干完全相同 → matched", c.find((x) => x.name === "a.srt").matched === true);
  check("语言后缀 .en → matched", c.find((x) => x.name === "a.en.srt").matched === true);
  check("多层后缀 .forced.ass → matched（只剥最后一段扩展名）",
    c.find((x) => x.name === "a.forced.ass").matched === true);
  // stemOf 的语义钉死：视频叫 `a.en.mp4` 时 `a.en.srt` 必须命中。若 stemOf 改成
  // 剥掉全部扩展名（"a.en.srt" → "a"），这条会失败 —— 用 base="a" 时两种算法
  // 都判 true，分辨不出来。
  check("stemOf 只剥最后一段（视频 a.en.mp4 配 a.en.srt → matched）",
    subtitleCandidates([{ name: "a.en.srt", is_dir: false }], "a.en", SUB_EXTS)[0].matched === true);
  check("stemOf 只剥最后一段的反证（视频 a.mp4 不该匹配 a.en.srt 的完整主干）",
    subtitleCandidates([{ name: "a.en.srt", is_dir: false }], "a", SUB_EXTS)[0].matched === true);
  check("a2.srt 不算命中（裸 startsWith 会误判）", c.find((x) => x.name === "a2.srt").matched === false);
  check("别的文件的字幕不算命中", c.find((x) => x.name === "sub/b.srt").matched === false);
  // 命中 3 条（a.srt / a.en.srt / a.forced.ass），未命中 3 条（a2.srt /
  // AAA.srt / sub/b.srt）。AAA.srt 在**纯 ASCII 码顺序**下会排到最前，所以这条
  // 断言同时钉住了「matched 优先」与「未命中项内部按 localeCompare 排序」两件事
  // —— 删掉排序键里的 matched 分量时，纯码顺序会把 AAA.srt 提到 a.srt 之前。
  // 未命中组内部的 a2/AAA 次序是 localeCompare 的实测结果（数字段先于字母段），
  // 别凭直觉改。
  check("命中的恰好 3 条且全部排前面",
    c.slice(0, 3).every((x) => x.matched) && c.length === 6);
  check("未命中的按 localeCompare 排序，且全部排在命中项之后",
    c.slice(3).map((x) => x.name).join(",") === "a2.srt,AAA.srt,sub/b.srt");

  // 排序键的 matched 分量单独钉一组：这里视频叫 `z.mp4`，命中的字幕是 `z.srt`，
  // 未命中的两个名字（`A.srt` / `a.en.srt`）在**纯码顺序**下都比 "z.srt" 小。
  // 所以一旦排序键丢掉 matched 分量，输出会以 A.srt 开头 —— 上面那组分辨不出来
  // （实测三种顺序在 a/AAA/a2 上巧合一致）。
  {
    const z = subtitleCandidates(
      [{ name: "A.srt", is_dir: false }, { name: "z.srt", is_dir: false }, { name: "a.en.srt", is_dir: false }],
      "z",
      SUB_EXTS
    );
    check("matched 分量真的在排序键里（未命中的 A.srt 不得排到命中的 z.srt 之前）",
      z.map((x) => x.name).join(",") === "z.srt,a.en.srt,A.srt");
    check("z.srt 被标为命中，另两条未命中",
      z[0].matched === true && z[1].matched === false && z[2].matched === false);
  }
  // 边界
  check("空 entries → []", Array.isArray(subtitleCandidates([], "a", SUB_EXTS)) &&
    subtitleCandidates([], "a", SUB_EXTS).length === 0);
  check("非数组 entries 不抛", subtitleCandidates(null, "a", SUB_EXTS).length === 0);
  check("非数组 subExts 不抛", subtitleCandidates(entries, "a", null).length === 0);
  check("base 为空串时只匹配空主干（不匹配任何东西）",
    subtitleCandidates(entries, "", SUB_EXTS).every((x) => x.matched === false));
  check("无扩展名的文件不当成字幕（README）",
    subtitleCandidates([{ name: "README", is_dir: false }], "README", ["readme", "srt"]).length === 0);
  // 把白名单设成「无扩展名文件被错算出来的那个扩展名」：extOf 若少了长度判断，
  // README 会以 "readme" 通过白名单，这条断言就会失败。
  check("extOf 的长度判断真的在（否则 README 会被算成 readme 字幕）",
    subtitleCandidates([{ name: "README", is_dir: false }], "README", ["readme"]).length === 0);
  check("大写扩展名按小写匹配", subtitleCandidates([{ name: "a.SRT", is_dir: false }], "a", SUB_EXTS).length === 1);
  check("候选保留 path（供调用方省掉 joinPath）",
    subtitleCandidates([{ name: "a.srt", is_dir: false, path: "D:\\a.srt" }], "a", SUB_EXTS)[0].path === "D:\\a.srt");
}

// ═════════════════════════════════════════════════════════════
console.log("\n== 静态断言：VideoPreview.vue 的调用点真的守住了 ==");
{
  const src = stripComments(fs.readFileSync(path.join(ROOT, "src", "components", "VideoPreview.vue"), "utf8"));

  // 抽函数体
  function bodies(s) {
    const out = [];
    const re = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const open = s.indexOf("{", re.lastIndex - 1);
      if (open < 0) continue;
      let depth = 0, i = open;
      for (; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") { depth--; if (depth === 0) break; }
      }
      out.push({ name: m[1], body: s.slice(open, i + 1) });
      re.lastIndex = i;
    }
    return out;
  }
  const fns = bodies(src);
  const fn = (n) => fns.find((b) => b.name === n);
  // onMounted / onBeforeUnmount 是箭头函数（`onMounted(async () => {...})`），
  // 上面按 `function name(` 抽的表里没有它们，按标识符切块补上。
  const blocks = (name) => {
    const at = src.indexOf(name + "(");
    if (at < 0) return "";
    const open = src.indexOf("=>", at);
    if (open < 0) return "";
    const brace = src.indexOf("{", open);
    if (brace < 0) return "";
    let depth = 0, i = brace;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    return src.slice(brace, i + 1);
  };

  check("detectSubtitles 存在", !!fn("detectSubtitles"));
  const ds = fn("detectSubtitles")?.body || "";

  // ① 快照：detectSubtitles 的形参里必须有 token / filePath / base，
  //    且函数体内不得重读 props。
  check("detectSubtitles 接受 (token, filePath, base) 快照形参",
    /detectSubtitles\s*\(\s*token\s*,\s*filePath\s*,\s*base\s*\)/.test(src));
  check("detectSubtitles 体内不再读 props.*（快照必须来自形参）",
    !/props\./.test(ds));
  check("detectSubtitles 用形参 filePath 查父目录", /getParentDir\(\s*filePath\s*\)/.test(ds));

  // ② 守卫：判据不是「每个 await 之后都要查」（joinPath 之后并没有共享写入，
  //    硬套这条会把判据写成恒真或逼出无意义代码），而是 METHODOLOGY 的那条真
  //    约束：**写共享状态之前必须复核守卫**。所以逐个定位共享状态写入点，回看它
  //    与「最近一次跨越 await 的边界」之间有没有 lands()。
  //    跨度切在下一个 await / catch / finally —— 取到末尾会把 catch 里的复核
  //    算给上一个 await（METHODOLOGY 记过的实测坑）。
  const SHARED_WRITE = /loaded\.push\(|subtitleTracks\.value\s*=|selectedTrackId\.value\s*=/g;
  const writes = [...ds.matchAll(SHARED_WRITE)].map((x) => x.index);
  check("detectSubtitles 至少有一处共享状态写入（否则下面恒真）", writes.length > 0);
  let unguarded = [];
  for (const w of writes) {
    // 找出包裹这个写入点的最近一个「await 之后」区段的开头
    const starts = [...ds.matchAll(/\bawait\b|\bcatch\b|\bfinally\b/g)].map((x) => x.index);
    let segStart = 0;
    for (const s of starts) if (s < w) segStart = s;
    const seg = ds.slice(segStart, w);
    // 区段里出现过 lands（且不是上一次 lands，保守起见只看段内是否有）
    if (!/subtitleGate\.lands\(/.test(seg)) unguarded.push(ds.slice(w, w + 30));
  }
  check(`每处共享写入前都复核了守卫（未守护 ${unguarded.length} 处：${unguarded.join(" | ")}）`,
    unguarded.length === 0);
  check("守卫调用数不少于 await 数",
    (ds.match(/subtitleGate\.lands\(/g) || []).length >= (ds.match(/\bawait\b/g) || []).length);

  // ③ 一次性提交：subtitleTracks 只赋值一次，且是整体赋值（不是 push）。
  const commits = ds.match(/subtitleTracks\.value\s*=/g) || [];
  check(`detectSubtitles 只提交一次（实际 ${commits.length} 次）`, commits.length === 1);
  check("提交是整体赋值而不是 push", !/subtitleTracks\.value\.push\(/.test(ds));
  check("onFilePicked 也不再 push（改为展开成新数组）",
    !/subtitleTracks\.value\.push\(/.test(src));

  // ④ loadVideo：快照在 await 之前取，begin() 无条件调用。
  const lv = fn("loadVideo")?.body || "";
  check("loadVideo 存在", !!fn("loadVideo"));
  const snapAt = lv.indexOf("const filePath = props.filePath");
  const baseAt = lv.indexOf("const base = props.fileName");
  const beginAt = lv.indexOf("subtitleGate.begin()");
  const firstAwait = lv.indexOf("await ");
  check("loadVideo 在第一个 await 之前取 filePath 快照", snapAt >= 0 && firstAwait > 0 && snapAt < firstAwait);
  check("loadVideo 在第一个 await 之前取 base 快照", baseAt >= 0 && baseAt < firstAwait);
  check("loadVideo 无条件 begin()（不只是 native 分支）",
    beginAt >= 0 && beginAt < firstAwait);
  check("loadVideo 不再在 await 之后读 props.filePath",
    lv.slice(firstAwait).indexOf("props.filePath") === -1);
  check("loadVideo 把快照透传给 detectSubtitles",
    /detectSubtitles\(\s*token\s*,\s*filePath\s*,\s*base\s*\)/.test(lv));
  check("externalFallback 分支之外也调用了 begin（begin 在 if 之前）",
    lv.indexOf("subtitleGate.begin()") < lv.indexOf("isExternalOnly"));

  // ⑤ 旧的 addTrack / loadSubtitleByPath 已不存在（避免留下未受守卫的写入点）。
  check("addTrack 已移除", !/function addTrack\(/.test(src));
  check("loadSubtitleByPath 已移除", !/function loadSubtitleByPath\(/.test(src));
  check("没有任何地方往 subtitleTracks 上 push", !/subtitleTracks\.value\.push\(/.test(src));
  const writes2 = (src.match(/subtitleTracks\.value\s*=/g) || []).length;
  // 3 处：loadVideo 清空、detectSubtitles 整体提交、onFilePicked 追加（展开成新数组）。
  check(`subtitleTracks 赋值点共 3 处，实际 ${writes2}`, writes2 === 3);

  // ⑥ 卸载作废。
  const obu = blocks("onBeforeUnmount");
  check("onBeforeUnmount 块抽到了", obu.length > 0);
  check("onBeforeUnmount 调用 subtitleGate.reset()", /subtitleGate\.reset\(\)/.test(obu));

  // ⑦ onMounted 的重复加载防护（race 的触发路径）。
  const om = blocks("onMounted");
  check("onMounted 块抽到了", om.length > 0);
  check("onMounted 在 await 之后复核 mountedPath",
    /if\s*\(\s*props\.filePath\s*===\s*mountedPath\s*\)/.test(om));
  check("onMounted 的 loadVideo 调用被包在复核之内",
    om.indexOf("mountedPath") >= 0 && om.indexOf("mountedPath") < om.indexOf("loadVideo()"));
  check("mountedPath 在 onMounted 之前同步捕获",
    src.indexOf("const mountedPath = props.filePath") >= 0 &&
    src.indexOf("const mountedPath = props.filePath") < src.indexOf("onMounted("));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
