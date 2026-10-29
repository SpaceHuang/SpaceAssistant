# platform-eng（需求侧）—— i18n 与工程治理

> 定位：工程支撑类需求口径入口。实现侧见 [`../../develop/platform-eng/`](../../develop/platform-eng/)（`release-guide.md`、`i18n-sync-guide.md`、`testing-guide.md`、`tech_design.md`）。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 当前生效口径。
- [i18n-architecture-requirement.md](./i18n-architecture-requirement.md) —— 多语言架构需求规格（A 类，留本目录）：`zh-CN` 是翻译 key 的真实来源，类型从资源推导。

## 在途（in-flight）

**当前无在途项**（开发侧 CI 可靠性方案见 [`../../develop/platform-eng/in-flight/`](../../develop/platform-eng/in-flight/)）。

## 归档

- 需求原件 → [`../archive/platform-eng/`](../archive/platform-eng/)（1 件：后台任务机制移除）。
- 旧路径 → 新路径：见 [`../archive/INDEX.md`](../archive/INDEX.md)。

## 取证命令

```text
npm run i18n:check
git log --date=short --format='%ad %h %s' -- src/renderer/i18n scripts package.json
```
