# docs/develop 归档总索引

> 归档件一律 `git mv` 搬迁：**文件名不改、内容不改**（`git log --follow` 可追史）；仅 `D` 类（已废弃）在头部补一行指向取代者。
> 搬迁日期：2026-10-14（首轮，整理分支 `codex/docs-consolidation`）｜2026-10-29 归位批（`main` `f99aab2f`，见「2026-10-29 根下归位」节）

## 旧路径 → 新路径 规则

| 情形 | 旧路径 | 新路径 |
| --- | --- | --- |
| 已完成迭代原件（B 类） | `docs/develop/<文件名>` | `docs/develop/archive/<主题>/<文件名>` |
| 已废弃（D 类） | 同上 | 同上 |
| 阶段件 / 证据 | 同上 | 同上 |

逐件映射（原路径 + 主题 + 去向 + 判定依据）见 [`../_consolidation/docs-inventory.tsv`](../_consolidation/docs-inventory.tsv)：按「原路径」列查行，取「主题」「去向」两列即可推出新路径。

## 归档分布

| 主题 | 件数 | 说明 |
| --- | --- | --- |
| `agent-sdk/` | 20 | 生命周期改进/契约矩阵/上下文与 token 成本/驱动权限/失败 turn 续跑；核验更正补入 + merge 补入（AGENTS.md 指令计划）+ 2026-10-29 去重迁入 1 件（重名旧稿，现行版在 [`../agent-sdk/`](../agent-sdk/) 主题目录） |
| `storage-session/` | 67 | 存储重构全套阶段件（`a*`/`c*`/`i*`/`r*`/`m3`）、profile 采样、迁移与清理计划、消息事实证据；核验更正补入 + merge 补入（存储占用页修复计划） |
| `tools-mcp/` | 19 | run_shell 生命周期/方言/Windows 宿主、grep/rg、browser、subagent、MCP 集成与延迟加载 |
| `safety-approval/` | 25 | 桌面自动审批、ask 档位统一、fail-open、脚本安全 parser 升级与金标准评审；核验更正补入；**2026-10-29 补入安全策略三阶段过程件 15 件**（Phase 0–5 记录、等价/闭合矩阵、隐藏改判扫描、源码与策略基线、候选清单、实施口径、计划两版） |
| `im-remote/` | 5 | 远程私聊安全测试计划与发布说明、意图 Track 开发方案；核验更正补入 |
| `desktop-ui/` | 21 | 聊天列表渲染性能三件套与复测门禁、流式抖动、composer、多会话、工作区清理；核验更正补入 |
| `platform-eng/` | 13 | 云 main 恢复 7 件（含 3 个 `.tsv`）、分叉接入 2 件、测试套件清理审计 + merge 补入（死代码清理 3 件） |
| **合计** | **170** | 另有 2 个 0 字节空文件直接删除（不进归档）｜核验更正补入 17 件 + merge 补入 5 件 + 2026-10-29 去重迁入 1 件 + 2026-10-29 根下归位迁入 15 件 |

## 2026-10-29 根下归位（`docs/develop/` → 主题目录 / 归档）

`docs/develop/` 根下长期平铺 23 篇文档（违反「主题即二级目录」）。逐篇按判定分流：

| 原路径 | 现路径 | 判定 |
| --- | --- | --- |
| `docs/develop/security-policy-{baseline,policy-baseline,candidate-inventory,phase0-test-record,phase1-test-record,phase2-test-record,phase3-test-record,phase4-test-record,phase5-test-record,phase1-equivalence-matrix,execution-closure-matrix,final-decision-scan,three-stage-development-decisions}.md` | `docs/develop/archive/safety-approval/` 同名 | B（过程产物：基线快照 / 阶段记录 / 矩阵 / 扫描） |
| `docs/develop/security-policy-three-stage-architecture-development-plan.md`（根下最终版，含 Phase 0–5 完成记录） | `docs/develop/archive/safety-approval/` 同名 | B（迭代已收口） |
| `docs/develop/safety-approval/in-flight/security-policy-three-stage-architecture-development-plan.md`（早期稿，被上条取代） | `docs/develop/archive/safety-approval/security-policy-three-stage-architecture-development-plan-2026-10-15-draft.md` | B（**同名冲突，加 `-2026-10-15-draft` 后缀；原名如上**） |
| `docs/develop/safety-approval/in-flight/security-policy-three-stage-architecture-decision-summary-draft.md` | **原地保留**（`docs/develop/safety-approval/in-flight/`） | 历史抽取件；因 `docs/rules/document-writing-guide-sources.md` 引用它作人类决策层规则验证样本而保留，头部已标注「所属计划已收口、正文不再更新」 |
| `docs/develop/security-policy-{three-stage-architecture-contract,tool-facts-contract,execution-subjects,approval-invalidation,invariant-registry-design,audit-field-map,locked-floor-classification,remote-rule-mapping}.md` | `docs/develop/safety-approval/` 同名 | A（现行契约 / 规格，留主题目录） |
| `docs/develop/agent-long-task-stability-improvement-plan.md` | `docs/develop/agent-sdk/agent-long-task-stability-improvement-plan.md` | A（现行方案，留主题目录） |

## 注意

归档件正文中的相对链接按**搬迁前布局**（`docs/develop/`，深度 2）书写；搬迁到 `archive/<主题>/`（深度 3）后，指向代码目录（如 `../../electron/`）与 `docs/review/`（未入库）的链接会失效。按「归档件内容零改动」原则**不做回改**；需要点击时请以本索引 + `docs-inventory.tsv` 反查，或用 `git log --follow` 定位原件。
