# 修：`dev.bat` / `dev.sh` 选 Node 取字典序第一个 → 永远用最旧的那个，而不是最新的

> 来源：`TODO-done.md` 第 404 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 5 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修：`dev.bat` / `dev.sh` 选 Node 取字典序第一个 → 永远用最旧的那个，而不是最新的** — `dev.bat:30-36` + `dev.sh:60-81`。**两个启动器都有此缺陷**（TODO 原文只记了 `.bat`）。WorkBuddy 管理的多个版本目录用 `for /d %%v in ("...\versions\*")`（bat）与 `for dir in ".../versions"/*`（sh）遍历，两者**都按字典序产出**且**命中第一个就定型** → `22.12.0` 排在 `22.22.2` 之前，永远被选中。实测真实目录序 `22.12.0 22.22.2-6 24.0.0 9.1.2` → 旧逻辑选中**次旧**的那个。这不是 inconsequential：jsdom 30 要求 node `^22.22.2`，在 22.12.0 上 `undici/lib/interceptor/decompress.js` 调用 node 22.15+ 才有的 `zlib.createZstdDecompress` → **整个测试套件在 import 阶段崩溃**（已用降级 jsdom 绕开，见 `INTERNALS.md`）。⚠️ 真正的问题在于**任何新依赖都会更早撞上这个版本下限**，且症状是运行时崩溃而非安装时报错、`undici` 还声明着 `engines: >=20.18.1`（纸面完全受支持）。**engines 是声明不是保证**。
  - ✅ **已修**：版本决策抽到 `scripts/pick-node.js`（按 `engines.node` 过滤后取**最新**；PATH 优先 → 版本管理器目录；诊断走 stderr、stdout 只有一行给两个启动器捕获），`package.json` 补上 `engines.node: ">=22.12.0"`，配 `scripts/node-pick-check.mjs`（99 条断言 + 4 次变异验证）。**附带查出并修掉一个静默失效**：初版 `realIo()` 漏了 `readFile`，`readEngines` 的 TypeError 被 `catch {}` 吞掉 → engines 永远读成空串、过滤代码从未执行而测试全绿。⚠️ `dev.bat` 的 batch 语法未能端到端验证（cmd.exe 被沙箱封禁），只做了静态检查。
  - 📌 **后续（2026-10-16 晚）**：`dev.bat` / `scripts/check.bat` / `scripts/check.ps1` 已删除，`dev.sh` 是唯一启动器（四份探测逻辑各写一遍且互相漂移）。`cargo-check.sh` 顺带改为动态定位（原写死 MSVC/SDK 版本号与本机绝对路径），两个 `.sh` 的 MSVC 探测由 `ls -r | head -1`（取字典序最小）改为 `sort -V | tail -1`。
