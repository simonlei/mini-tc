// 排序对比测试：native (C# FileEntryComparer) vs 跨平台 (FileList.vue)
//
// 用法: node scripts/sort-compare.mjs [目录]
// 默认目录: D:\BaiduNetdiskDownload
//
// 它做两件事：
//   1. 用真实的跨平台算法（JS localeCompare，numeric:true, sensitivity:base）排序
//   2. 用对 native FileEntryComparer.CompareNames 的忠实移植排序
// 然后逐条对比两个结果，报告任何不一致。
//
// 注意：native 的 NativeCompare 是对 FileEntryComparer 的逐行移植，用来定位
// 算法层面的差异。真正的 native 二进制行为由 win-native 项目自身保证。

import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "D:\\BaiduNetdiskDownload";

if (!fs.existsSync(dir)) {
  console.error(`目录不存在: ${dir}`);
  process.exit(2);
}

// ── 读取真实条目 ──
const raw = fs.readdirSync(dir, { withFileTypes: true })
  .map((d) => ({ name: d.name, is_dir: d.isDirectory() }))
  .filter((e) => e.name !== ".."); // 忽略父目录行（两边都不在列表里）

console.log(`目录: ${dir}`);
console.log(`条目数: ${raw.length}（目录 ${raw.filter((e) => e.is_dir).length} / 文件 ${raw.filter((e) => !e.is_dir).length}）\n`);

// ════════════════════════════════════════════════════════════════════
// A) 跨平台参考实现（逐字移植自 src/components/FileList.vue sortedEntries）
// ════════════════════════════════════════════════════════════════════

function cpNameClass(name) {
  const ch = name.replace(/-/g, "")[0];
  if (!ch) return 2;
  if (ch >= "0" && ch <= "9") return 0;
  if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) return 1;
  return 2;
}

function cpCompare(a, b) {
  // 目录优先（col === "name" 时）
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  const ca = cpNameClass(a.name);
  const cb = cpNameClass(b.name);
  if (ca !== cb) return ca - cb;
  const ka = a.name.replace(/-/g, "");
  const kb = b.name.replace(/-/g, "");
  let cmp = ka.localeCompare(kb, undefined, { numeric: true, sensitivity: "base" });
  if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return cmp;
}

// ════════════════════════════════════════════════════════════════════
// B) native 移植实现（逐字移植自 win-native FileEntryComparer.cs）
//    文本段比较器 TextComparer 用 Intl.Collator(undefined,{sensitivity:"base"})
//    对应 C# 的 StringComparer.Create(CurrentCulture, IgnoreCase|IgnoreNonSpace)
//    （无 numeric —— 数字段由 CompareDigits 单独处理，与 C# 一致）
// ════════════════════════════════════════════════════════════════════

const textCollator = new Intl.Collator(undefined, { sensitivity: "base" });

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function nativeNameClass(name) {
  for (const ch of name) {
    if (ch === "-") continue;
    if (ch >= "0" && ch <= "9") return 0;
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) return 1;
    return 2;
  }
  return 2;
}

function stripHyphens(v) {
  return v.includes("-") ? v.replace(/-/g, "") : v;
}

function compareDigits(l, lo, ll, r, ro, rl) {
  while (lo < l.length && l[lo] === "0") {
    lo++;
    ll--;
  }
  while (ro < r.length && r[ro] === "0") {
    ro++;
    rl--;
  }
  if (ll !== rl) return ll < rl ? -1 : 1;
  for (let k = 0; k < ll; k++) {
    const c = l[lo + k] < r[ro + k] ? -1 : l[lo + k] > r[ro + k] ? 1 : 0;
    if (c !== 0) return c;
  }
  return 0;
}

function nativeNaturalCompare(left, right) {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const lc = left[i];
    const rc = right[j];
    const lDigit = isDigit(lc);
    const rDigit = isDigit(rc);
    if (lDigit && rDigit) {
      let li = i;
      let ri = j;
      while (li < left.length && isDigit(left[li])) li++;
      while (ri < right.length && isDigit(right[ri])) ri++;
      const cmp = compareDigits(left, i, li - i, right, j, ri - j);
      if (cmp !== 0) return cmp;
      i = li;
      j = ri;
    } else if (lDigit !== rDigit) {
      return lDigit ? -1 : 1;
    } else {
      let li = i;
      let ri = j;
      while (li < left.length && !isDigit(left[li])) li++;
      while (ri < right.length && !isDigit(right[ri])) ri++;
      const cmp = textCollator.compare(left.slice(i, li), right.slice(j, ri));
      if (cmp !== 0) return cmp;
      i = li;
      j = ri;
    }
  }
  const lRem = left.length - i;
  const rRem = right.length - j;
  return lRem < rRem ? -1 : lRem > rRem ? 1 : 0;
}

function nativeCompareNames(left, right) {
  const classLeft = nativeNameClass(left);
  const classRight = nativeNameClass(right);
  if (classLeft !== classRight) return classLeft - classRight;
  const keyLeft = stripHyphens(left);
  const keyRight = stripHyphens(right);
  const cmp = nativeNaturalCompare(keyLeft, keyRight);
  return cmp !== 0 ? cmp : nativeNaturalCompare(left, right);
}

function nativeCompare(a, b) {
  // 跳过 IsParent 行（这里没有 ".."）
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1; // 目录优先
  return nativeCompareNames(a.name, b.name);
}

// ════════════════════════════════════════════════════════════════════
// 排序 + 对比
// ════════════════════════════════════════════════════════════════════

const stable = (cmp) => (x, y) => {
  const c = cmp(x, y);
  return c !== 0 ? c : x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
};

const cpOrder = [...raw].sort(stable(cpCompare)).map((e) => e.name);
const nativeOrder = [...raw].sort(stable(nativeCompare)).map((e) => e.name);

console.log("=== 跨平台排序 (FileList.vue localeCompare) ===");
cpOrder.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2, " ")}. ${n}`));

console.log("\n=== native 排序 (FileEntryComparer 移植) ===");
nativeOrder.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2, " ")}. ${n}`));

// 找差异
const mismatches = [];
for (let i = 0; i < cpOrder.length; i++) {
  if (cpOrder[i] !== nativeOrder[i]) {
    mismatches.push({ pos: i + 1, cp: cpOrder[i], native: nativeOrder[i] });
  }
}

console.log("\n=== 对比结果 ===");
if (mismatches.length === 0) {
  console.log("✅ 两套算法对真实目录的排序结果完全一致。");
  process.exit(0);
} else {
  console.log(`❌ 发现 ${mismatches.length} 处位置不一致（同一位置两边名字不同）：`);
  for (const m of mismatches) {
    console.log(`  位置 ${m.pos}: 跨平台="${m.cp}"  |  native="${m.native}"`);
  }
  process.exit(1);
}
