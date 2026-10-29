# safety-approval 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-17 | — | 审批回答者最短路径 v2 修订（吸收评审 B1/B2 与 N1–N8） | `approval-agent-shortest-path-plan.md`（已归档） | 原判「在途」；核验更正：分支已合入（`c725896e`，2026-09-18） |
| 2026-09-18 | `6db05ab0` | 确认 Skill v2：双维裁决 + 防误拒 + 注入举证 + 解析安全默认 | `security-approval-skill-v2.1-improvement-plan.md`（已归档） | `parseApprovalVerdict` 见 `src/shared/confirmation/approvalVerdict.ts` |
| 2026-09-25 | `b9b68d74` | security-approval-skill-v2.1 分支合入 | 同上 | 原判「在途」，核验更正为已实现 |
| 2026-10-14 | — | 核验更正：`security-approval-experience-improvement-plan.md` 已实现 | 同上（已归档） | 证据：`CallAdmissionGate` 见 `electron/runtime/callAdmissionGate.ts` |
| 2026-09-19 | `c96acc2e` | ask 档位统一实施并闭环（Q1–Q11 决策落地） | `desktop-ask-rule-tier-unification-plan.md`（已归档） | 档位语义统一，仅 desktop lane |
| 2026-09-20 | — | 脚本安全 parser 升级 P0–P3 全部 29 项任务完成 | `script-security-parser-treesitter-upgrade-plan.md`（已归档） | 解析器口径收敛 |
| 2026-09-24 | — | 桌面 fail-open 到用户（§10 第 3–6 步全部落地） | `desktop-fail-open-to-user-plan.md`（已归档） | 服务故障时的降级策略定型 |
| 2026-10-10 | `594cc94c` | 恢复桌面 fail-open 行为（`fix(confirmation): restore desktop fal…`） | 同上 | 回归修复 |
| 2026-10-12 | `a347c5f1` | 澄清审批归属（IM 安全文档口径） | — | 渠道归属明确 |
| 2026-10-13 | `af5d4459` | 写入目标范围复检：父目录身份与许可执行器一致 | — | 写入范围钉死，防替换 |
| 2026-10-13 | `1547b5b7` | 符号链接写入类型不匹配上报 | — | 错误可见 |
| 2026-10-15 | `6ec720af` | 建立安全策略三阶段架构源码基线（Phase 0：基线、阶段契约、候选清单、策略矩阵） | `security-policy-three-stage-architecture-development-plan.md`（已归档）、`security-policy-*-test-record.md`（已归档） | 三阶段（facts / policy / final-check）责任边界落纸，作为后续 Phase 的对照基准 |
| 2026-10-15 | `e79e5aaf` | 引入版本化工具 facts，gate 与审批 provenance 接线（Phase 1） | 同上 | facts 只报告观察与覆盖度、不产出 verdict；`InvocationFactsSnapshot` 落地 |
| 2026-10-15 | `dec8954d` | 集中策略决策与审批检查，remote/IM 分支归一为共享规则（Phase 2） | `security-policy-remote-rule-mapping.md`（本目录） | 统一 Policy Engine 成为唯一裁决点；remote 不再保留第二条最终裁决 |
| 2026-10-15 | `78e51e62` | 登记系统不变量并启用登记完整性门禁（Phase 3） | `security-policy-invariant-registry-design.md`（本目录） | `src/shared/security/systemInvariantRegistry.ts` + `npm run check:system-invariant-registry` |
| 2026-10-16 | `e1ec50a5` | IM dispatch final-check 绑定策略、执行批准对象版本化摘要（Phase 4） | `security-policy-execution-subjects.md`（本目录） | `executionSubject.ts` / `executionAuthorizationCheck.ts`；对象变化不执行且不改写原 decision |
| 2026-10-16 | `df47283c` | 关闭三阶段源码计划：隐藏改判二次扫描归零（Phase 5） | `security-policy-final-decision-scan.md`（已归档） | 源码闭环；正式安装包、生产数据与真实 IM/MCP 渠道仍为外部待验 |
| 2026-10-29 | —（本批文档整理） | 归位与状态更正：8 篇现行契约由 `docs/develop/` 根下移入本目录、15 件过程件归档（决策摘要抽取件保留在 in-flight，供 `docs/rules` 引用）；README 原「三阶段未实施」更正为「已收口」 | `../archive/safety-approval/`（映射见 `../archive/INDEX.md`） | 消除「双入口」与状态滞后；断言核验本轮未重跑（待按 `docs-guide` §6.5 重跑） |

## 存疑

- `security-approval-experience-improvement-plan.md`（在途）自述「已针对评审阻断项修订，待复评；本文不代表功能已实现」——需与 `af5d4459`/`1547b5b7`（confirmation 修复）逐项对齐，确认哪些条目已落地。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/confirmation electron/capabilities electron/writeSafety
```
