# agent-sdk baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- packages/agent-sdk/src`（开工点即基线，窗口为空）
> 流程见 [`../_consolidation/docs-consolidation-rules.md`](../_consolidation/docs-consolidation-rules.md) §3.0

| 断言 | 文档出处 | 命令 | 实测 | 判定 | 处置 |
| --- | --- | --- | --- | --- | --- |
| A1 SDK 拥有 turn loop，并有单一上下文规划器 | [`turn-loop.md`](./turn-loop.md)、[`context.md`](./context.md) | `rg -n 'planContextReplacement' packages/agent-sdk/src` | 命中 7 处（`turn.ts` 6、`invocation.ts` 1） | 一致 | — |
| A2 上下文端口与 fence/evidence 能力模型存在 | [`context.md`](./context.md) | `rg -n 'ContextPort\|ContextFence\|ContextSnapshot' packages/agent-sdk/src/context.ts` | 命中 | 一致 | — |
| A3 超时 turn 的执行隔离已实现 | `archive/agent-sdk`…（原 `mcp-timeout-turn-failure-isolation-plan.md`） | `git log --date=short --format='%ad %h %s' --grep='isolation' -30` | `2026-10-14 a01a6d49 fix(agent): isolate timed out turn execution` | **漂移**（文档自述「修订版尚未复评」） | 按代码更正；`history.md` 已记「状态滞后」 |
| A4 turn 级取消传导补全（Phase 1/2）已落地 | `archive/agent-sdk/chat-turn-cancel-tool-conduction-fix-plan.md` | `git log --format='%h %s' --all --grep='取消传导\|cancel' -20` | `c5c2ccb7`（Phase 1）、`e89de026`（Phase 2） | 一致 | — |
| A5 model turn 预算已放宽 | `archive/agent-sdk/agent-context-token-cost-optimization-plan.md` | `git log --format='%h %s' --grep='turn budget'` | `4ce5dc9f feat(agent): extend model turn budget and loop checks` | 一致 | — |

## 无法核验项

- **Runtime 设计系列**（[`runtime/`](./runtime/) 01–10）自述「计划稿（未开工）」：属**设计稿**而非现状描述，不参与一致性判定；若后续开工，需按 §5.2 逐条重核。

## 抽样复核建议（用户抽 3 条）

A1、A3、A4 —— 命令可直接复制执行，结果可复算。
