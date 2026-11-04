# 构建：唯一的前端测试套件没挂到任何 npm script，lint 也不在 build 前

> 来源：`TODO.md` 第 90 行 · 章节 P2 — 可维护性 / 重复实现 / 测试缺口 · 第 23 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **构建：唯一的前端测试套件没挂到任何 npm script，lint 也不在 build 前** — `package.json:5-11`。`scripts/rename-rules-check.mjs` 有 102 条断言、覆盖 `renameRules`/`renameRunner` 全部边界，但**没有任何 npm script 引用它** —— 改坏重命名逻辑时没有任何自动关卡会拦住。更讽刺的是 `lint-imports.js` 的文件头写着「这两个 bug 都在本项目发生过」，但 `build` 脚本是裸的 `vite build`。TODO 里反复出现的「项目无 type-check/lint/test 脚本」至今成立。修法：加 `"test"` / `"check"` / `"prebuild"`。
