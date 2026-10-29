# safety-approval —— 安全、确认与审批

> 定位：策略与档位、确认/审批链路、脚本与路径安全、fail-open。
> 主要代码域：`electron/capabilities/`、`electron/confirmation/`、`electron/writeSafety/`、`electron/pathSecurity.ts`、`electron/scriptSecurity*`
> 核对基线：`main` `17236274`（2026-10-14）｜2026-10-29 整理：只做结构归位与状态更正，**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 现状与设计文档（留主题目录）

本主题有**一份现状文档** + **8 篇安全策略三阶段契约**（见下节）+ 三处现役设计口径（跨目录引用一律带路径）：

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| [确认与审批-现状.md](./确认与审批-现状.md) | **本目录** | **现状文档**：策略内核（`decide` / package / floor）、工具闸门与调用准入、审批回答者（3 轮 · haiku · 授权上限 low）、通道与延迟/异步审批、执行许可（读/写 permit + 路径租约）、决策缓存与安全审计、迁移收口 —— **尚未纳入安全策略三阶段架构（见下节契约），属已知漂移，待重跑 baseline 时补写** |
| [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) | **本目录** | **核验记录**：现状文档 20 条断言逐条复算（20/20 一致） |
| `tool-confirmation-top-level-design-v2.md` | `docs/requirement/safety-approval/` | 确认与授权机制顶层设计（四轮评审，可进入 P0） |
| `security-policy-single-entry-requirement.md` | `docs/requirement/safety-approval/` | 安全策略单一入口（口径仍在生效） |
| `confirmation-answerer-and-auto-approval-design.md` | `docs/develop/architect/` | 回答者与自动审批设计 |
| `interface/safety-approval.md`（已并入 agent-sdk） | `docs/develop/agent-sdk/safety-approval.md` | SDK 侧许可端口契约 |

## 安全策略三阶段架构：现行契约与规格（2026-10-29 由 `docs/develop/` 根下归位）

| 文档 | 内容 | 与代码的对照 |
| --- | --- | --- |
| [security-policy-three-stage-architecture-contract.md](./security-policy-three-stage-architecture-contract.md) | 阶段契约：facts / policy / final-check 的输入输出、失败类别、禁止副作用 | 与 `AGENTS.md`「安全逻辑变更规范」同口径（阶段 facts / policy / final-check / invariant） |
| [security-policy-tool-facts-contract.md](./security-policy-tool-facts-contract.md) | `ToolFacts` 共享契约：字段、生产者、消费者、缺省/失败语义 | `src/shared/confirmation/types.ts`、`invocationFactsSnapshot.ts` |
| [security-policy-execution-subjects.md](./security-policy-execution-subjects.md) | 执行批准对象绑定规格（`execution-subject-v1`） | `src/shared/security/executionSubject.ts` |
| [security-policy-approval-invalidation.md](./security-policy-approval-invalidation.md) | 审批失效与策略并发协议（依赖指纹、重新核验） | `src/shared/policy/policyDecision.ts`（`dependencyFingerprint`） |
| [security-policy-invariant-registry-design.md](./security-policy-invariant-registry-design.md) | 系统不变量登记表设计（ID、owner、范围、审计、测试引用） | 实际落点 `src/shared/security/systemInvariantRegistry.ts`；**本文正文提到的 `src/shared/confirmation/` 是旧路径（漂移），以代码为准** |
| [security-policy-audit-field-map.md](./security-policy-audit-field-map.md) | 安全决策与执行审计字段映射（**审计字段真源**） | `electron/confirmation` 的 `policy.decision` / `policy.execution-veto` 等事件 |
| [security-policy-locked-floor-classification.md](./security-policy-locked-floor-classification.md) | locked 内置规则分类盘点（产品策略 vs 系统约束） | `src/shared/policy/defaultRules.ts` |
| [security-policy-remote-rule-mapping.md](./security-policy-remote-rule-mapping.md) | Remote IM 统一规则映射（旧分支 → 稳定 rule ID） | `electron/remote/remoteToolPolicy.ts` |

> 这 8 篇是**现行契约/规格**（A 类），保留在主题目录；同批的 Phase 0–5 测试记录、源码基线快照、候选清单、验收矩阵、闭合矩阵、隐藏改判扫描与实施口径属**过程产物**（B 类），已归档至 [`../archive/safety-approval/`](../archive/safety-approval/)。
> 核验命令（2026-10-29 实跑）：`rg -n 'SYSTEM_INVARIANT_REGISTRY' src/shared/security/`、`rg -n 'execution-subject-v1|ExecutionSubjectEnvelope|dependencyFingerprint' src/shared/`。

## 在途（in-flight）

- [tool-review-cache-execution-plan.md](./in-flight/tool-review-cache-execution-plan.md) —— **进行中**：按 [工具调用安全审核性能调研.md](./工具调用安全审核性能调研.md) 推进会话审核范围缓存，明确本机源码关闭与外部验收边界。
- [custom-policy-full-control-development-plan.md](./in-flight/custom-policy-full-control-development-plan.md) + [custom-policy-full-control-execution-plan.md](./in-flight/custom-policy-full-control-execution-plan.md) —— **开发方案与执行清单草稿（未实施）**：自定义套餐开放全部现有策略动作、统一多规则裁决、旧停用状态迁移与执行派发生效边界；执行前置条件含界面归属卡负责人审批。
- [denial-diagnosability-and-auto-approved-write-facts-improvement-plan.md](./in-flight/denial-diagnosability-and-auto-approved-write-facts-improvement-plan.md) —— **草稿（决策已定，未实施；已按两轮评审 R-1 / R-2 / R-3 修订）**：拒绝原因可诊断性（模型侧只收到 `POLICY_DENY`）+ 免确认写入审计事实失真（`autoApprovedWrite` 全 0 / 错对象）优化计划（2026-10-17，基线 `8c7dce0e`，评审复核 `1f22be0f`）；决议 **D1=C**（人话 + 粗类别）、**D2=A**（修好记录：权威目标 + 执行器产出统计）、**D3=B**（统一文案映射机制，本期只填有证据的一条）。评审报告：`docs/review/2026-10-17-denial-diagnosability-and-auto-approved-write-facts-improvement-plan-review.md`（R-1 假行数、R-2 历史丢解释）、`…-review-v2.md`（R-3 收尾依赖闭合，已把 A-05 依赖改为 A-04）。
- [automation-task-document-output-improvement-plan.md](./in-flight/automation-task-document-output-improvement-plan.md) —— **草稿（未实施、待裁决）**：定时任务在绑定工作目录内创建新文档，并在显式要求文件时校验产物；D-1 决定是否开放受限写入，D-2 决定是否增加显式文件交付要求。
- [scheduled-task-multi-workdir-and-preflight-development-plan.md](./in-flight/scheduled-task-multi-workdir-and-preflight-development-plan.md) —— **草稿（未实施；按 2026-10-17 第四轮开发方案评审 R4-01 修订，待复审）**：多授权目录、exact/collection/output 目标解析、v0/v1 旧任务兼容、预检门禁，以及区分 task revision 与调度代次、保留运行快照的跳过/补跑状态机。
- [scheduled-task-multi-workdir-and-preflight-execution-plan.md](./in-flight/scheduled-task-multi-workdir-and-preflight-execution-plan.md) —— **未开始（计划草稿；已按第四轮评审修订）**：以无环 DAG 拆分 schema/store、兼容调用迁移、目标解析与门禁、类型收紧、运行安全链和原子恢复验收。

> 当前 `in-flight/` 含以上在途方案；归档件见 `../archive/safety-approval/`。

> **2026-10-29 更正（原判 C 有误）**：安全策略三阶段架构计划原被本 README 记为「草稿（未实施）」，实际已于 2026-10-15～16 完成 Phase 0–5 源码闭环 —— `6ec720af`（基线）→ `e79e5aaf`（versioned tool facts）→ `dec8954d`（统一策略决策与审批检查）→ `78e51e62`（invariant registry 与门禁）→ `e1ec50a5`（IM dispatch final-check）→ `df47283c`（源码计划关闭）；`src/shared/security/{systemInvariantRegistry,executionSubject,executionAuthorizationCheck}.ts` 与 `src/shared/policy/policyDecision.ts` 均在册，`npm run check:system-invariant-registry` 是仓库门禁。两版计划已归档，**现行契约见上节**。
> 同目录的 [security-policy-three-stage-architecture-decision-summary-draft.md](./in-flight/security-policy-three-stage-architecture-decision-summary-draft.md) 是该计划的**历史抽取件**，因 `docs/rules/document-writing-guide-sources.md` 引用它作人类决策层规则验证样本而保留，正文不再更新。

> **2026-10-14 两轮核验更正（原判 C 有误）**：`approval-agent-shortest-path-plan.md`（`c725896e`）、`security-approval-skill-v2.1-improvement-plan.md`（`b9b68d74` + `6db05ab0`）、`security-approval-experience-improvement-plan.md`（`CallAdmissionGate` 见 `electron/runtime/callAdmissionGate.ts`）、`run-shell-agent-safe-boundary-hardening-plan.md`（redaction/sanitize 链路见 `electron/agentLogger/*`）。

## 归档（已完成迭代）

见 [`../archive/safety-approval/`](../archive/safety-approval/)（25 件）：

> **2026-10-29 补入 15 件**：安全策略三阶段架构的过程件（`security-policy-phase0..phase5-test-record.md`、`-phase1-equivalence-matrix.md`、`-execution-closure-matrix.md`、`-final-decision-scan.md`、`-baseline.md`、`-policy-baseline.md`、`-candidate-inventory.md`、`-three-stage-development-decisions.md`）与计划两版（根下最终版 + in-flight 早期稿，早期稿为避同名冲突加 `-2026-10-15-draft` 后缀，原名见 `archive/INDEX.md`）。

| 文档 | 结论 |
| --- | --- |
| `desktop-ask-rule-tier-unification-plan.md` | 已实施并闭环：分支已合入 main（`c96acc2e`） |
| `desktop-auto-approval-plan.md` | 已实施完成（分支 `codex/desktop-auto-approval`） |
| `desktop-fail-open-to-user-plan.md` | 已实现（§10 第 3–6 步全部落地） |
| `script-security-parser-treesitter-upgrade-plan.md` | P0–P3 全部 29 项任务完成 |
| `script-security-parser-upgrade-golden-review.md` | 金标准评审（过程产物） |
| `tool-confirmation-framework-implementation-plan.md` | 框架部分已落地（v8 可进入 P0） |

## 核验记录

- [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) —— 基线 `17236274`；断言逐条带可复现命令，含「矛盾与时间线检查」「无法核验项」「抽样复核建议」。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/confirmation electron/capabilities electron/writeSafety
rg -n '<策略档位符号>' electron/confirmation electron/capabilities
```
