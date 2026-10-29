# agent-sdk（需求侧）—— SDK 契约、runtime 准入、模型与用量

> 定位：Agent SDK 的需求口径入口。实现侧见 [`../../develop/agent-sdk/`](../../develop/agent-sdk/)。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 当前生效口径汇总（token 用量、LLM 服务与模型配置、上下文预算、思考强度、API Key 授权、tool_use/tool_result 配对）。
- [agent-runtime-admission-policy-requirement.md](./agent-runtime-admission-policy-requirement.md) —— runtime 准入策略（A 类，留本目录）：准入与 turn 生命周期对齐，已决策并按实际运行数据复查。

## 在途（in-flight）

**当前无在途项。** 需要新增时先 `mkdir -p in-flight/`（空目录不入库），再在本节登记一行状态。

## 归档

- 需求原件 → [`../archive/agent-sdk/`](../archive/agent-sdk/)（13 件：模型服务与配置、思考强度、token 用量、API Key 授权、工具配对等）。
- 旧路径 → 新路径：见 [`../archive/INDEX.md`](../archive/INDEX.md) 与 [`../../develop/_consolidation/docs-inventory.tsv`](../../develop/_consolidation/docs-inventory.tsv)。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- packages/agent-sdk electron/driver electron/llmServiceResolver.ts electron/usageStats
rg -n 'admission|thinkingEffort|usageStats' packages/agent-sdk/src electron/llmServiceResolver.ts
```
