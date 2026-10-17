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
| 2026-10-17 | `c3f6292e` | 拒绝解释可诊断性与自动批准写入事实改进（源码实施及本机定向验收） | `in-flight/denial-diagnosability-and-auto-approved-write-facts-improvement-plan.md` | 拒绝文本三处同源；写入统计来自实际执行结果；真机/IM E-1..4 留作非阻塞验收 |

## 存疑

- `security-approval-experience-improvement-plan.md`（在途）自述「已针对评审阻断项修订，待复评；本文不代表功能已实现」——需与 `af5d4459`/`1547b5b7`（confirmation 修复）逐项对齐，确认哪些条目已落地。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/confirmation electron/capabilities electron/writeSafety
```
