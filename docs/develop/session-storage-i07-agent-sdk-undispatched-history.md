# I-07 Agent SDK 未派发工具 History 集成记录（2026-10-05）

## 结论

I-07 完成，下一步为 I-08 Butler task-level model-service/workDir snapshot/resolver。

直接复用了 `origin/main` 提交 `51193571` 的代码与测试补丁：Agent SDK 并发调度的 denial-drain、fatal stop 的未领取槽位显式 `tool-call-not-dispatched` History 结算与密集结果物化、dispatch failure diagnostics；同时接入 main 的 confirmation batch 保护、Desktop observer diagnostics 和 assembler 日志。未重构 SDK。

## 与存储分支的集成处理

- SDK 核心、SDK 测试、confirmation port、Desktop observer 及其测试可三方应用 main 原补丁。
- `electron/agentLogger/types.ts` 与 `electron/runtime/invocationAssembler.ts` 已包含存储分支改动；仅将 main 补丁中的三个 diagnostic event 名称和 observer diagnostic callback 合并进去，保留现有 storage 字段/逻辑。
- 不复制 main 的历史计划与 review 文档版本；本记录归档本分支集成验收。
- 真实功能测试由 fake provider + MemoryHistory/隔离 SQLite 驱动，没有调用模型服务或触碰用户 profile。

## 验收

- Agent SDK turn suite：125 项通过，包含拒绝后 drain、fatal sibling、队列屏障和恢复行为。
- Desktop observer、confirmation port、invocation assembler：3 文件 / 72 项通过。
- canonical transcript projection 与 SQLite Agent History：2 文件 / 286 项通过，覆盖 `tool-call-not-dispatched` 的 canonical 读取/投影与损坏边界。
- `npm run typecheck:agent-sdk`、`npx tsc -p tsconfig.electron.json --noEmit`、`git diff --check` 通过。

集成前的独立 red reproduction 曾在下一轮 `model-request-started` History 写入处失败，错误指出消息数组索引 `[4]` 非 canonical JSON（由稀疏工具结果槽造成）；直接应用 main 修复后，上述 main SDK suite 全绿。临时 reproduction 已撤回，没有保留重复测试。
