# tools-mcp（需求侧）—— shell / 文件 / grep / browser / subagent / MCP

> 定位：工具能力与外部接入的需求口径入口。实现侧见 [`../../develop/tools-mcp/`](../../develop/tools-mcp/)。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 按工具族汇总当前生效口径（shell 契约与输出编码、文件工具、工具可靠性、browser、subagent、MCP）。
- [tools-requirement.md](./tools-requirement.md) —— 工具能力总纲（A 类，留本目录）。

## 在途（in-flight）

**当前无在途项**；在途方案（`run_shell` 方言误判与致命中断）登记在开发侧 [`../../develop/tools-mcp/in-flight/`](../../develop/tools-mcp/in-flight/)。

## 归档

- 需求原件 → [`../archive/tools-mcp/`](../archive/tools-mcp/)（17 件：shell 输出与编码、grep/文件读取、browser、subagent、MCP 系列、`run_shell` 调用理由等）。
- 旧路径 → 新路径：见 [`../archive/INDEX.md`](../archive/INDEX.md)。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/shell electron/mcp electron/browser electron/tools
rg -n 'deferredToolLoading|browserAct|runShellJustification' electron src/shared packages/agent-sdk/src
```
