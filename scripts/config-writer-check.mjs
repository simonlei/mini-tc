// 验证 configWriter 的落地顺序。直接 `node scripts/config-writer-check.mjs` 跑。
//
// 判据：每组断言都必须在「去掉串行化」或「让失败污染后续」的实现下失败。
// 全绿但抓不住退化的测试等于没测试。

import { createConfigWriter } from "../src/configWriter.js";

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

// ── 一个「文件系统」替身 ──
//
// 权威状态是 files 这个 Map，断言一律对着它查，而不是对着调用序列 ——
// 后者只是在复刻自己的实现。
function fakeBackend({ delayMs = 0, failOn = null } = {}) {
  const files = new Map();
  const started = [];
  const finished = [];
  // Per-name in-flight counters. A single global counter would count
  // *different* names running in parallel as concurrency — which is required
  // behaviour, so measuring it globally would make this stub report a
  // violation every time the design worked.
  const inFlightFor = new Map();
  const maxConcurrentFor = new Map();

  const write = (name, body) => {
    started.push(name);
    const now = (inFlightFor.get(name) || 0) + 1;
    inFlightFor.set(name, now);
    maxConcurrentFor.set(name, Math.max(maxConcurrentFor.get(name) || 0, now));
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        inFlightFor.set(name, inFlightFor.get(name) - 1);
        if (failOn && failOn(name, body)) {
          finished.push(name);
          reject(new Error(`boom:${body}`));
          return;
        }
        files.set(name, body);
        finished.push(name);
        resolve(`saved:${body}`);
      }, delayMs);
    });
  };

  return { write, files, started, finished, maxConcurrentFor };
}


// ── 1. 同一 name 严格按调用顺序落地 ──
console.log("同一 config name 的顺序");
{
  const b = fakeBackend({ delayMs: 5 });
  const save = createConfigWriter(b.write);

  // 连发三次，全部 resolve 之后再断言最终状态。
  await Promise.all([
    save("theme", "dark"),
    save("theme", "light"),
    save("theme", "solarized"),
  ]);

  check("最终状态是最后一次调用", b.files.get("theme") === "solarized");
  check("落地顺序等于调用顺序",
    JSON.stringify(b.finished) === JSON.stringify(["theme", "theme", "theme"]));
}

// ── 2. 「最后一次赢」在乱序完成的实现下会被抓住 ──
//
// 反例：把每笔写都立刻发出去，不排队。延迟必须**随 body 变长而变短**，
// 这样先发的「1」最后才落地 —— 顺序反了，最终状态就是过期值。
// （第一版把延迟写成 body.length * 5，结果先发的反而先完成，反例
// 自己没成立，测试抓不到任何东西。构造反例时必须先确认它真的会失败。）
console.log("乱序完成时仍以最后一次为准");
{
  const files = new Map();
  const finished = [];
  const write = (name, body) =>
    new Promise((resolve) => {
      const delay = (10 - body.length) * 8; // "1"→72ms, "12"→64ms, "123"→56ms
      setTimeout(() => {
        files.set(name, body);
        finished.push(body);
        resolve();
      }, delay);
    });
  const save = createConfigWriter(write);
  await Promise.all([save("tabs", "1"), save("tabs", "12"), save("tabs", "123")]);

  // 前置条件：先确认这个「无串行化」的反例真的会产生乱序，否则下面的断言
  // 证明不了任何东西。
  const naive = new Map();
  const naiveWrite = (body) =>
    new Promise((resolve) =>
      setTimeout(() => {
        naive.set("tabs", body);
        resolve();
      }, (10 - body.length) * 8)
    );
  await Promise.all([naiveWrite("1"), naiveWrite("12"), naiveWrite("123")]);
  check("反例前提：无串行化确实会落地过期值", naive.get("tabs") === "1",
    `反例最终状态 ${naive.get("tabs")}，说明延迟设置没能制造乱序`);

  check("串行化后落地顺序等于调用顺序",
    JSON.stringify(finished) === JSON.stringify(["1", "12", "123"]),
    `实际 ${JSON.stringify(finished)}`);
  check("串行化后最终状态是最后一次调用", files.get("tabs") === "123",
    `实际 ${files.get("tabs")}`);
}

// ── 3. 同一 name 绝不并发 ──
console.log("同一 name 不并发");
{
  const b = fakeBackend({ delayMs: 2 });
  const save = createConfigWriter(b.write);
  await Promise.all([
    save("bookmarks", "a"), save("bookmarks", "b"), save("bookmarks", "c"),
    save("bookmarks", "d"), save("bookmarks", "e"),
  ]);
  check("同一 name 的最大并发数为 1", b.maxConcurrentFor.get("bookmarks") === 1,
    `实际 ${b.maxConcurrentFor.get("bookmarks")}`);
  check("全部落地", b.finished.length === 5);
}

// ── 4. 不同 name 不互相阻塞 ──
//
// 这是设计要求，不是性能优化：payload 只有几 KB，代价在 IPC 往返，
// 让 bookmarks 等 theme 只会凭空加延迟。与 loadConfig 并行同一理由。
console.log("不同 name 仍然并行");
{
  const b = fakeBackend({ delayMs: 10 });
  const save = createConfigWriter(b.write);
  const t0 = Date.now();
  await Promise.all([save("bookmarks", "x"), save("theme", "y"), save("tabs", "z")]);
  const elapsed = Date.now() - t0;
  check("三个不同 name 各自只并发 1 次",
    b.maxConcurrentFor.get("bookmarks") === 1 &&
    b.maxConcurrentFor.get("theme") === 1 &&
    b.maxConcurrentFor.get("tabs") === 1);
  check("总耗时约等于单次而非三次", elapsed < 25, `实际 ${elapsed}ms`);
}

// ── 5. 一笔失败不得卡死该 store 的后续写入 ──
//
// 这是本模块最容易写坏的一处：链上存 rejected promise 的话，
// 之后每一笔都会跟着 reject，磁盘满一次就再也不会持久化了 ——
// 正是这套机制要消除的「静默失效」。
console.log("失败不污染后续");
{
  let shouldFail = true;
  const b = fakeBackend({
    failOn: () => shouldFail,
  });
  const save = createConfigWriter(b.write);

  const first = save("theme", "will-fail");
  // Await the rejection itself rather than racing a timer against it — the
  // promise chain adds microtask hops, so any tick-based wait would be testing
  // the event loop's scheduling, not the writer.
  let firstRejected = false;
  await first.then(
    () => { firstRejected = false; },
    () => { firstRejected = true; }
  );
  check("失败的那笔确实 reject 了", firstRejected);
  check("失败时不得写入文件", !b.files.has("theme"));

  shouldFail = false;
  await save("theme", "recovered");
  check("后续写入仍能落地", b.files.get("theme") === "recovered");

  // 再失败一次也不能 wedge。
  shouldFail = true;
  await save("theme", "fails-again").then(() => {}, () => {});
  shouldFail = false;
  await save("theme", "still-fine");
  check("反复失败也不会永久卡死", b.files.get("theme") === "still-fine");
}

// ── 6. 每笔调用拿到的是自己那笔的结果 ──
console.log("返回值归属");
{
  const b = fakeBackend({ delayMs: 1 });
  const save = createConfigWriter(b.write);
  const [r1, r2] = await Promise.all([save("theme", "one"), save("theme", "two")]);
  check("第一笔拿到自己的结果", r1 === "saved:one", `实际 ${r1}`);
  check("第二笔拿到自己的结果", r2 === "saved:two", `实际 ${r2}`);
}

// ── 7. 构造器契约 ──
console.log("构造器契约");
{
  let threw = false;
  try {
    createConfigWriter(null);
  } catch {
    threw = true;
  }
  check("缺少 write 回调时立刻报错", threw);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);