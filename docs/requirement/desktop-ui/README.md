# desktop-ui（需求侧）—— 聊天界面、composer、文件面板、设置与托盘

> 定位：桌面交互与工作区的需求口径入口。实现侧见 [`../../develop/desktop-ui/`](../../develop/desktop-ui/)。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 按模块汇总当前生效口径（聊天消息、composer、上下文占用、文件面板/查看器、文档导入、工作目录、设置与外壳、会话与列表、搜索）。
- [product_requirement.md](./product_requirement.md) —— 产品需求总纲（A 类，留本目录）。
- [remove-plan-mode-requirement.md](./remove-plan-mode-requirement.md) —— **移除 Plan 模式**（A 类，现行口径）：Plan 模式 4 篇旧需求据此废弃。

## 在途（in-flight）

**当前无在途项。** 新增时先 `mkdir -p in-flight/`，再在本节登记。

## 归档

- 需求原件 → [`../archive/desktop-ui/`](../archive/desktop-ui/)（37 件，需求侧最大；含 Plan 模式 4 篇已废弃件与社交图文生成器两篇）。
- 已废弃（D 类）清单见 [`../archive/INDEX.md`](../archive/INDEX.md)「已废弃（D 类）清单」。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- src/renderer/components src/renderer/services src/renderer/store
rg -n 'planMode|removePlanMode' src/renderer electron
```
