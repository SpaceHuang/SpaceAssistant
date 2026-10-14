# agent-sdk 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）；冲突时以 `git log` 为准。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-19 | — | Agent Core 契约路径重构落地：Invocation 契约 + Core 端口、规则随调用传入、fact 归位 | `agent-core-contract-path-refactor-plan.md`（已归档，旧称） | 契约物理文件收敛进 SDK 包内，宿主只剩兼容转发 |
| 2026-09-30 | `1f6e7940` | 消息事实落库归还 Core：桌面/远程统一走同一生产链路 | `message-fact-production-pipeline-refactor-plan.md`（已归档） | 渲染进程不再自持 `ToolCallRecord`；生产 owner 清理待复审 |
| 2026-10-08 | `6d2a3f41` | 冻结上下文候选（`fix(agent-sdk): freeze context candidate`） | [`context.md`](./context.md)（现状） | 上下文替换边界收紧 |
| 2026-10-08 | `8e3c5d12` | 重试查询返回源 turn | `failed-turn-continuation-experience-plan.md`（已归档） | 续跑依据明确 |
| 2026-10-11 | `f4e8bdff` | 请求快照不再内嵌完整 messages 正文（P2a） | — | 快照体积与内存下降 |
| 2026-10-13 | `c5c2ccb7` | turn 级取消传导补全：中止信号接进工具执行（Phase 1） | `chat-turn-cancel-tool-conduction-fix-plan.md`（已归档） | 取消不再停在模型层；G1/G6 红基线 4 条为本机实测真值 |
| 2026-10-13 | `e89de026` | 恢复中止审计：`turn.cancel` / `llm.cancel` 打点与投影白名单（Phase 2） | 同上 | 取消过程可审计 |
| 2026-10-13 | `4ce5dc9f` | 放宽模型 turn 预算与循环检查 | `agent-context-token-cost-optimization-plan.md`（已归档） | 长任务不易被预算提前截断 |
| 2026-10-14 | `a01a6d49` | 超时 turn 的执行隔离：超时不再连累同批其它工具调用 | `mcp-timeout-turn-failure-isolation-plan.md`（已归档） | 计划尚未收口，实现先落地 |
| 2026-10-14 | `b26bce20` | 强化续跑恢复与 UI 行为 | — | 续跑恢复更稳 |

## 存疑（文档与记录不一致）

- `mcp-timeout-turn-failure-isolation-plan.md` 自述「修订版尚未复评」，实际 `a01a6d49` 已实现并合入（2026-10-14）——**状态滞后，以代码为准**。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- packages/agent-sdk/src electron/toolChatLoop.ts
git log --date=short --format='%ad %h %s' -- docs/develop/agent-sdk
```
