# 工作目录边界与策略分层：需求实现追踪矩阵

- **需求：** [工作目录边界与沙箱策略分层需求](../requirement/session-d961cc51-workdir-boundary-and-sandbox-policy-layering-requirement.md)
- **技术方案：** [缺口分析与后续技术方案](./session-d961cc51-boundary-policy-layering-gap-analysis-and-followup-plan.md)
- **更新日期：** 2026-09-26
**状态：** 阶段 A～D 已实施并通过用户代码评审；Windows/Linux 平台 CI 尚待运行。

本文逐条记录需求 D-1～D-11 对应的生产实现、策略规则、回归证据与结论。单元测试证明其列出的代码路径；只有标注“集成”的测试才证明跨层链路。未在当前平台运行的结果明确标为未验证。

## 1. D-1～D-11 追踪表

| 需求 | 生产实现与策略规则 | 回归/集成证据 | 结论 |
| --- | --- | --- | --- |
| **D-1 工作目录边界统一** | 读取：`electron/confirmation/extractors/readPathFacts.ts`、`electron/confirmation/toolCallGate.ts`、`electron/confirmation/readPermitExecutor.ts`；写入：`writePathFacts.ts`、`writeExecutionPermit.ts`、`writePermitExecutor.ts`；shell 路径与效果事实进入 gate。 | `electron/confirmation/toolCallGate.test.ts` 覆盖读写路径分区、lane 与规则；`readReadIntegration.test.ts` 覆盖 gate→permit→真实读取 executor；`remoteWritePermit.integration.test.ts` 覆盖远程许可消费时仍受 workDir 限制。 | 已实现并有跨层测试。Shell 是命令效果/路径事实与策略确认，不宣称 OS 级文件沙箱。 |
| **D-2 越界事实进入策略与审批材料** | `toolCallGate.ts` 把路径目标、`path-outside-heuristic` 与 `command-effect` 加入 `ContentFacts.signals`；`agentChannel.ts` 从结构化 signals 派生确认线索。 | `toolCallGate.test.ts` 检查 shell 与文件路径信号及审计 `pathZones`；`electron/confirmation/extractors/shellEffectFacts.test.ts` 检查 shell 效果分类；`shellAnalyzer.test.ts` 检查命令、路径、连接符和重定向事实。 | 已实现；shell 的路径分析仍是保守启发式，未解析语法不得推断为只读。 |
| **D-3 沙箱/策略/参数错误可区分** | `readPathFacts.ts`、`writePathFacts.ts` 对缺失、目标类型、身份和探测错误分别建模；`writeFileAutoApproval.ts` 使用分类事实；读取/写入诊断及 `policy.execution-veto` 使用 `input`、`policy`、`mechanism`、`environment`、`integration-violation` 分类。 | `writeFileAutoApproval.test.ts`、`readPathFacts.test.ts`、`writePathFacts.test.ts`、`readPermitExecutor.test.ts`、`writePermitExecutor.test.ts`、`executionVetoAudit.test.ts`。 | 已实现；许可不匹配和策略拒绝属于 policy，批准后的 identity/type 变化属于机制 veto。 |
| **D-4 用户指令作为持久路径授权** | 无持久路径授权记忆。策略规则直接决定普通非敏感只读目标；敏感和系统目标逐次真人确认。 | `toolCallGate.test.ts` 覆盖普通读取、locked 敏感/系统规则及确认；`readConfirmationFlow.test.ts` 覆盖确认登记绑定与一次性消费。 | **按产品决议不实现**。原需求描述的问题仍不属于本轮已实现能力；以后启用需另行评审授权范围、期限、撤销和记忆资格。 |
| **D-5 重试惩罚/拒绝次数递增** | 不按重试次数惩罚或收紧规则；不把 Agent 通过变为长期授权。 | `readConfirmationRegistry.test.ts`、`readConfirmationFlow.test.ts` 覆盖拒绝/取消/超时/重放不产生许可；策略对同一事实确定性应用，不读取拒绝次数。 | **按产品决议不实现**。既有工具错误停止机制只为可用性保护，不是拒绝后的风险惩罚。 |
| **D-6 路径安全机制与策略分层** | `pathSecurity.ts` 保留路径解析、符号链接/硬链接、类型、原子写等机制；`readPathFacts.ts` / `writePathFacts.ts` 产出策略可消费事实；默认规则集中在 `src/shared/policy/defaultRules.ts`。 | `pathSecurity.test.ts`、`readPathFacts.test.ts`、`writePathFacts.test.ts`、`policyEngine.test.ts`。 | 已实现。执行器只对许可目标做机制性复核；拒绝关联到原策略决策并产生 veto。 |
| **D-7 快通道与额外信任根不再代替策略判定** | 写快通道消费 `WritePathFact`；wiki raw 目标在 gate 生成 `wiki-raw-target` 并由 `wiki-raw-write-deny` 锁定规则裁决；桌面读取规则使用 effective rules。 | `toolCallGate.test.ts` 中 strict/custom ask/deny、wiki raw、custom sensitive path 用例；`builtinExecutors.autoApprove.test.ts` 与 `writeFileAutoApproval.test.ts`。 | 已实现；wiki raw 不再依赖 executor 单独读取配置后做第二次策略拒绝。 |
| **D-8 检查时机前置产事实、后置守执行** | 读取目录只在 permit 校验后枚举；read/grep/list_directory 生产 executor 调用 `resolveReadPermitTarget`，不回退到 `resolveSafeReadPath`；写执行仍保留原子提交及身份复核。 | `readReadIntegration.test.ts` 检查获批前不枚举、获批后真实执行；`readExecutionBoundary.test.ts`、`readPermitExecutor.test.ts`；`safeAtomicWrite.test.ts`。 | 已实现。静态检索未发现产品读取 executor 调用旧 `resolveSafeReadPath`。 |
| **D-9 shell 只读性事实进入决策** | `shellEffectFacts.ts` 仅将完整解析、无危险重定向/参数的白名单命令标为 `read-only`；其他结果为 `mutating` 或 `unknown`，由 gate 信号和策略规则消费。 | `shellEffectFacts.test.ts` 覆盖重定向、部分解析、危险参数、写命令与 shell gate；`toolCallGate.test.ts` 覆盖 strict/custom 不被目录外只读 shortcut 覆盖。 | 已实现；unknown 不等于只读放行。 |
| **D-10 策略批准后的执行 veto 可关联且有审计** | `recordPolicyExecutionVeto()` 统一记录 `requestId`、`toolUseId`、工具、决策规则、zone、哈希 factId、失败类别和 caseId；读取、写入、工作目录切换及飞书读取机制失败接入审计。 | `readReadIntegration.test.ts` 实测策略决策→身份变化→真实 executor veto；`remoteWritePermit.integration.test.ts`、`readFeishuAttachmentExecutor.test.ts`、`executionVetoAudit.test.ts`。 | 已实现并有集成证据；绝对路径不会写入安全审计事件。 |
| **D-11 横向执行通道核查** | 写/编辑：write facts、permit 与原子写；shell/script：结构化事实和策略；`switch_work_dir`：profile-target fact 与 locked remote deny；wiki raw：gate fact/rule；Feishu：入站下载登记、media fact、许可执行；WeChat：发送/回复的附件路径事实、locked 越界/未知 deny、executor 工作目录边界复核及 execution-veto 审计；MCP/toolkit/browser 使用既有 gate 决策。 | 写/编辑：`toolCallGate.test.ts`、`remoteWritePermit.integration.test.ts`、`writePermitExecutor.test.ts`；shell/script：`shellEffectFacts.test.ts`、`scriptPathFacts.test.ts`、`scriptRunner.test.ts`；切换目录：`toolCallGate.test.ts`、`tools/workDirExecutors.test.ts`；wiki/Feishu：`toolCallGate.test.ts`、`feishuInboundPipeline.test.ts`、`readFeishuAttachmentExecutor.test.ts`；WeChat：`toolCallGate.test.ts`、`tools/weChatToolExecutor.test.ts`；MCP/toolkit：`toolCallGate.test.ts`、`toolCallGate.ports.test.ts`、`mcpToolExecutor.test.ts`、`toolkitTool.test.ts`。 | 已完成静态通道核查与本机可运行的测试。WeChat 附件 gate 与 executor 有定向回归测试；execution-veto 在 tool loop 中按关联 gate fact 记录。未连接 MCP 服务时，MCP 结论限于调用转发/策略测试和执行器静态核查；不声称真实服务端到端实测。 |

## 2. 决议与范围边界

- **Q-1 / 普通目录外只读：** 交由策略规则决定；桌面 standard 默认放行，strict/custom 可要求确认或拒绝。敏感与系统目录优先于普通 zone，按规则要求真人确认；automation 对需要真人确认的目标拒绝。
- **D-4 / D-5：** 不增加长期路径记忆或重试次数惩罚。普通非敏感外部只读使用确定性策略，不依赖 Agent 每次重判。
- **Shell：** 项目不提供 OS 级隔离。shell 的路径/效果事实用于策略输入和确认线索，分析不完整时保持 `unknown`，不把事实提取描述成文件沙箱。
- **执行边界：** 保留身份、类型、I/O、取消、预算和原子提交等机制检查；这些检查失败时不改写先前策略决策，满足条件时记录 execution veto。

## 3. 平台与交付验证状态

| 平台/门禁 | 证据 | 状态 |
| --- | --- | --- |
| macOS | 本机 `process.platform=darwin`；`realpath('/var/log')=/private/var/log`；`readPathFacts.test.ts` 与 `toolCallGate.test.ts` 中 macOS `/var/log` 用例无 skip guard 命中。 | 本机验证 |
| Windows | 当前非 Windows 主机；Windows 路径与 policy 分支有平台无关测试，但没有 Windows runner 的执行记录。 | 待 Windows CI |
| Linux | 当前非 Linux 主机；没有 Linux runner 的执行记录。 | 待 Linux CI |
| 全量 Vitest | `npm test -- --reporter=dot`：730 个测试文件，729 passed / 1 skipped；5574 项测试，5470 passed / 104 skipped；退出码 0，耗时 167.55 秒。 | 通过 |
| macOS `/var` 边界 | `process.platform=darwin`；`realpath('/var/log')=/private/var/log`；`npx vitest run electron/confirmation/extractors/readPathFacts.test.ts electron/confirmation/toolCallGate.test.ts --maxWorkers=4 --reporter=dot`：2 个文件、121 项通过。 | 本机通过 |
| renderer 类型 | `npm run typecheck:renderer`。 | 通过 |
| shared 类型 | `npm run typecheck:shared`。 | 通过 |
| Electron 类型 | `npx tsc -p tsconfig.electron.json --noEmit --incremental false`。 | 通过 |
| i18n | `node --import tsx scripts/i18n-check.ts`：检查通过；提示 1598 处既有硬编码中文（547 source / 1051 tests），未阻断。 | 通过 |
| diff 格式 | `git diff --check`。 | 通过 |

阶段 A～D 的实现与验收已完成，阶段 D 评审已通过。此结论限于已记录的实现和 macOS 验证；Windows/Linux 平台尚未实际运行，须在对应 CI 完成后更新平台结论。
