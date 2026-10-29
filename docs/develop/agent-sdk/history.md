# agent-sdk 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）；冲突时以 `git log` 为准。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-07-17 | `7a9b5c05` | 落地 b344321 重构：修复歧义 claim 与自动建会话 | `b344321-current-code-refactor-plan.md`（已归档） | 原判「在途」，2026-10-14 核验更正为已实现 |
| 2026-09-11 | `91e939ef` | 上下文注入重构：新增 prompt assembly 与上下文投影 | `context-injection-refactor-plan.md`（已归档） | 新增 `src/shared/promptAssembly.ts`（`buildPromptAssembly` / `renderPrompt`） |
| 2026-09-11 | `d96bd70b` | 从 Core 注入**有预算**的技能目录（技能正文不再全塞 system） | 同上 | `skillCatalog` 见 `promptAssembly.ts` / `llmSystemPrompt.ts` |
| 2026-09-11 | `b5eaada1` | system prompt 改走装配器渲染 | 同上 | `llmSystemPrompt.ts:95` 调 `renderPrompt(buildPromptAssembly(...))` |
| 2026-09-16 | `9dfc46d1` | 上下文注入重构合入 main | 同上 | WP0–WP5 门禁满足（`ContextMeter` 见 `src/shared/contextMeter.ts`，`compaction_*` 见 `electron/sessionEvents.ts`） |
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
| 2026-09-05 | `958f93c8` | Agent Loop 单路径重构分支合入 | `agent-loop-single-path-refactor-plan.md`（已归档） | 原判「在途」，核验更正为已实现 |
| 2026-10-03 | `51193571` | 工具派发中止与 transcript 空洞安全化 | `tool-dispatch-slot-abort-and-transcript-hole-improvement-plan.md`（已归档） | 同上；`requestObservation` 见 `packages/agent-sdk/src/turn.ts` |
| 2026-10-27 | `4718e532` | 让自动压缩的触发比例可配置：默认 80%、范围 60–90%，并消除三处字面量 | [`in-flight/context-compaction-summary-quality-plan.md`](./in-flight/context-compaction-summary-quality-plan.md) | 常量 `CONTEXT_COMPACTION_TRIGGER_RATIO` 单一定义；预算对象与决策指纹共用同一变量，钳制引用同一常量 |
| 2026-10-28 | `8cf7de55` | 模型设置页新增自动压缩阈值项（滑块 + 范围校验 + 保存） | 同上 | 阈值从配置文件进入用户可调界面 |
| 2026-10-28 | `e15f3c5c` | 自动压缩改用结构化摘要（七栏目 + 执行事实），并补取消、迟到丢弃与无收益跳过 | 同上 | 自动压缩不再只留 1200 字截断；系统操作卡片出现 `skipped` / `cancelled` / `failed` 与对应原因码。方案中 `AC-10`/`AC-15`/`AC-16`/`AC-17`/`AC-20`/`AC-21` 仍未核实 |

## 存疑（文档与记录不一致）

- `mcp-timeout-turn-failure-isolation-plan.md` 自述「修订版尚未复评」，实际 `a01a6d49` 已实现并合入（2026-10-14）——**状态滞后，以代码为准**。
- `in-flight/context-compaction-summary-quality-plan.md` 曾自述「在途草稿，未实施」，但 `4718e532`、`8cf7de55`、`e15f3c5c` 已实现阶段 1、3 与阶段 2 主体（2026-10-27/28）。2026-10-29 已按 `docs-guide` §3.0 更正为「实施中」——**状态滞后，以代码为准**；阶段 2 的验收仍未逐项闭合，不得当作已完成引用。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- packages/agent-sdk/src electron/toolChatLoop.ts
git log --date=short --format='%ad %h %s' -- docs/develop/agent-sdk
```
