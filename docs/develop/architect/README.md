# 架构文档索引

> 定位：本目录存放 SpaceAssistant 的**架构层文档** —— 理想态、演进规划、具体方案与外部对照研究。实施类计划文档不在这里（见 §5）。
> 状态：待评审 ｜ 基线：工作区 HEAD ｜ 整理日期：2026-09-12

**一句话**：Agent 能力应当是**一个内核（Core）加若干装配层与驱动源**。这一组文档回答五件事：产品要支撑什么形态、架构上分成哪几块、今天差在哪、为什么选择改造而不是重写、外部实现是怎么做的。

**怎么读**：第一次了解先看 §2 的顺序；只想知道某个设计为什么这么定，直接看 §3 的关系图再跳到对应文档。

---

## 1. 目录里有什么

| 文档 | 类型 | 一句话 | 状态 |
| --- | --- | --- | --- |
| `product-architecture-design.md` | **基线**（理想态） | 产品架构全景：六块主干与判据、进程边界、Driver / Runtime / Core / Safety / Storage 的边界与对外接口、今天与理想态的偏差清单、Agent SDK 化的差距对照（§11） | 待评审 |
| `agent-core-roadmap.md` | **规划** | 业务预期、架构方向、当前问题、工作块划分与优先级、待拍板清单 | 待评审 |
| `rewrite-vs-refactor-cost-assessment.md` | **决策记录** | 改造与重写的成本对比、证据与建议（为什么走「原地换心」而不是推倒重写） | 待评审 |
| `agent-sdk-shape-decision.md` | **决策记录** | Agent SDK 的物理边界：同进程库 / 独立服务 / 库加托管子进程的收益与开发代价，结论是按同进程库推进 | 已拍板 |
| `confirmation-answerer-and-auto-approval-design.md` | **方案**（块 2） | 确认回答者可插拔与自动审批 Agent 的具体设计 | 待评审 |
| `three-products-architecture-benchmark-summary.md` | **参考研究**（汇总） | 把三家对照拉平到六块基线上，给差异、优劣、收敛点与修订建议覆盖核查 | 参考 |
| `codex-architecture-comparison-and-learnings.md` | 参考研究 | 对照 Codex（Rust 多 crate + 协议化 app-server） | 参考 |
| `dsh-architecture-comparison-and-learnings.md` | 参考研究 | 对照 DeepSeek Harness（Cordis 插件树 + seam） | 参考 |
| `claude-code-architecture-comparison-and-learnings.md` | 参考研究 | 对照 Claude Code（单进程 + 终端宿主） | 参考 |

**决策记录的位置**：`rewrite-vs-refactor-cost-assessment.md` 不改写基线，它回答的是推进方式 —— 为什么是改造而不是重写。结论（原地换心、先锁契约后换实现）与 `agent-core-roadmap.md` §5 的推进顺序一致。

**基线与参考研究的分工**：基线与规划是**我们的结论**，可以直接用来排期与拍板；三篇对照只是**证据与备选做法**，不改变既有结论，其中明确写了「我们不必照搬的」部分。

---

## 2. 推荐阅读顺序

| 目的 | 读什么 |
| --- | --- |
| 第一次了解整体架构 | 本文 §3 的关系图 → `product-architecture-design.md` §1 – §2（目标、不变量、全景与六块） |
| 要动手做某一块 | `agent-core-roadmap.md` §5（工作块）→ §9（方案清单）→ 对应方案文档 |
| 想知道某个设计为什么这么定 | `three-products-architecture-benchmark-summary.md` §6（分歧与我们的选择）→ §8（修订建议覆盖核查） |
| 想评估某条外部做法的可信度 | 对应那篇对照文档的 §2（逐维度对比）与 §6（一句话总结） |
| 想知道为什么是改造而不是重写 | `rewrite-vs-refactor-cost-assessment.md`（结论、口径、成本对比与陷阱） |
| 想知道 SDK 是库还是服务 | `agent-sdk-shape-decision.md`（结论、改造面口径、三种形态的收益与代价、升级信号） |
| 要拍板还没定的事 | `agent-core-roadmap.md` §8、`three-products-architecture-benchmark-summary.md` §8「需要裁决」 |

---

## 3. 文档之间的关系

```text
   业务预期 / 工作块                理想态基线                    落地
  agent-core-roadmap  ───方向───▶  product-architecture-design  ───▶  confirmation-answerer-
        ▲                                  ▲                          and-auto-approval-design
        │                                  │ 修订建议                  （块 2；块 1 / 3 / 4 待写）
        │                                  │
        └──────────────┬───────────────────┘
                       │
        three-products-architecture-benchmark-summary
                       ▲
                       │ 汇总对照
        ┌──────────────┼──────────────┐
     codex            dsh         claude-code
   （外部实现对照研究，非基线）
```

读法：**下游（参考研究）只能提修订建议，不能改写基线** —— 每条建议是否被采纳、落在哪一节，都在汇总文档 §8 里有据可查。

---

## 4. 引用约定

- **不带前缀的 `§N`** 指 `product-architecture-design.md`；**`roadmap §N`** 指 `agent-core-roadmap.md`；**`本文 §N`** 指当前文档自己。
- **本目录内引用同级文档用裸文件名**，不加目录前缀，如 `agent-core-roadmap.md`；**引用本目录之外的文件必须带路径**，如 `docs/develop/context-injection-refactor-plan.md`。
- **行号是当次摸排的快照**，会随代码演进失效；证据应当能由命令复现（`rg -n '<符号>' <文件>`），行号只作辅助。这条约定写在 `product-architecture-design.md` §10 开头。
- 三篇对照文档记录了**外部仓库的取样方式与已知偏差**（例如 Claude Code 的源码归档含 React Compiler 编译产物、DSH 未逐行审计），引用其结论前先看文首的「证据来源」。

---

## 5. 与实施类计划文档的关系

本目录只放架构层内容。具体实施计划仍在 `docs/develop/` 下，两者的对应关系见 `agent-core-roadmap.md` §6，其中主要几篇是：

| 计划文档 | 与架构的关系 |
| --- | --- |
| `docs/develop/context-injection-refactor-plan.md` | 上下文装配的重构目标；基线要求裁剪与注入规则与它同源，不允许第二份装配逻辑 |
| `docs/develop/tool-confirmation-framework-implementation-plan.md` | 策略引擎与确认通道的骨架；块 2 方案是它「接口预留」的落地 |
| `docs/develop/builtin-subagent-development-plan.md` | 走独立子进程 + 私有 RPC，与 in-process 嵌套执行域是两条路线，按场景分流 |
| `docs/develop/message-fact-persistence-core-refactor-plan.md` | 驱动权迁移的基础 |
| `docs/develop/background-task-execution-layer-technical-design-v3.md` | **目标保留、方案降级为参考**（它用外挂 Codex CLI 绕过 Core 的解耦问题） |