# safety-approval —— 安全、确认与审批

> 定位：策略与档位、确认/审批链路、脚本与路径安全、fail-open。
> 主要代码域：`electron/capabilities/`、`electron/confirmation/`、`electron/writeSafety/`、`electron/pathSecurity.ts`、`electron/scriptSecurity*`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状与设计文档（留主题目录）

本主题的现役设计口径分布在三处（跨目录引用一律带路径）：

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| `tool-confirmation-top-level-design-v2.md` | `docs/requirement/safety-approval/` | 确认与授权机制顶层设计（四轮评审，可进入 P0） |
| `security-policy-single-entry-requirement.md` | `docs/requirement/safety-approval/` | 安全策略单一入口（口径仍在生效） |
| `confirmation-answerer-and-auto-approval-design.md` | `docs/develop/architect/` | 回答者与自动审批设计 |
| `interface/safety-approval.md`（已并入 agent-sdk） | `docs/develop/agent-sdk/safety-approval.md` | SDK 侧许可端口契约 |

## 在途（in-flight）

- [approval-agent-shortest-path-plan.md](./in-flight/approval-agent-shortest-path-plan.md) —— v2 修订
- [security-approval-experience-improvement-plan.md](./in-flight/security-approval-experience-improvement-plan.md) —— 待复评
- [security-approval-skill-v2.1-improvement-plan.md](./in-flight/security-approval-skill-v2.1-improvement-plan.md) —— 待评审
- [run-shell-agent-safe-boundary-hardening-plan.md](./in-flight/run-shell-agent-safe-boundary-hardening-plan.md) —— 加固计划在途

## 归档（已完成迭代）

见 [`../archive/safety-approval/`](../archive/safety-approval/)（6 件）：

| 文档 | 结论 |
| --- | --- |
| `desktop-ask-rule-tier-unification-plan.md` | 已实施并闭环：分支已合入 main（`c96acc2e`） |
| `desktop-auto-approval-plan.md` | 已实施完成（分支 `codex/desktop-auto-approval`） |
| `desktop-fail-open-to-user-plan.md` | 已实现（§10 第 3–6 步全部落地） |
| `script-security-parser-treesitter-upgrade-plan.md` | P0–P3 全部 29 项任务完成 |
| `script-security-parser-upgrade-golden-review.md` | 金标准评审（过程产物） |
| `tool-confirmation-framework-implementation-plan.md` | 框架部分已落地（v8 可进入 P0） |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/confirmation electron/capabilities electron/writeSafety
rg -n '<策略档位符号>' electron/confirmation electron/capabilities
```
