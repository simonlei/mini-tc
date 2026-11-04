# 收敛：`shell_execute_elevated` 只解码了 1223，其余错误码原样抛给用户；`delete_with_admin` 静默吞掉全部结果

> 来源：`TODO.md` 第 69 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 5 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **收敛：`shell_execute_elevated` 只解码了 1223，其余错误码原样抛给用户；`delete_with_admin` 静默吞掉全部结果** — `lib.rs:1263-1275` / `1499-1505`。ShellExecuteW 的失败返回值就是 Win32 错误码，最常见的几个都有明确含义：2/3（文件路径错）、5（策略禁用提权或文件被独占锁）、31（`.msp` 没装补丁程序），全被丢给用户猜「提权启动失败 (code=5)」。另 `delete_with_admin` 的 `Remove-Item -ErrorAction SilentlyContinue` + 启动即返回 → 提权删除失败**没有任何错误、日志或 UI 提示**，用户只看到文件还在、反复重试；且 `-Recurse -Force` 对指向目录的 symlink 会**遍历并删除链接目标的内容**，与 `delete_permanently` 明确做了 symlink 安全分支的策略不一致，还是提权那条更危险。修法：`elevate_error_text(code)` 覆盖常见码；提权脚本改 `-ErrorAction Stop` + 结果标记文件 + 有界轮询。
