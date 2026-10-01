# 开发交付说明：MCP 工具延迟加载（Deferred Tool Loading）

对应需求：`docs/requirement/mcp-deferred-tool-loading-requirement.md`（v1.8）
分支：`feat/mcp-deferred-tool-loading`（worktree `.worktrees/mcp-deferred`）

## 交付范围

按需求 §9 分阶段计划完成 **Phase 1–3 全部内容**（TDD 推进，每阶段独立提交）；Phase 4（Anthropic 原生 Tool Search Tool 适配、remote lane 支持）按需求为「可选、另行评审」，未实施。

| 提交 | 阶段 | 内容 |
|---|---|---|
| 30ee5150 | Phase 1 | 核心机制（默认 off，零行为变化） |
| 1aef2cca | Phase 2 | 策略与设置 UI（默认值维持 off） |
| f02be149 | Phase 3 | 计量与观测 |
| 99220290 | 验收收尾 | tool_search 元数据/设置文案补齐 |
| 4fa75c8a | 评审修复 | 评审（docs/review/20261002-mcp-deferred-tool-loading-code-review.md）P1/P2/P3 全项：FR11 快照准入放宽运行时接线（含 >64 工具真实路径用例）、索引 trim 过滤、package-lock 还原、常量复用、FR13 探针 O(N)、safetyGate 显式委托 |

## 需求覆盖对照（§5 功能需求）

- **FR1/FR4**：「MCP 工具索引」区块（`src/shared/toolCatalogPrompt.ts`，order 45，头部计数「共 N / 已列出 K」、预算截断、截断检索提示；索引是截断视图非准入名单）。
- **FR2**：`tool_search` 元工具（定义入 `builtinToolDefinitions`、执行器 `electron/tools/toolSearchTool.ts`：分词 OR 召回、空 query 分页遍历保底、32 KiB 溢出响应、描述原文返回、schema 永不截断、只读自动放行、桌面 lane 门控）。
- **FR3（A 方案）**：`computeEffectiveTools` 产出 `deferredToolNames`，经 handoff 链传入 `hostedAgentTurnHost`，`capabilities.define` 并入 known+authorized（门禁簿记零上下文成本；SDK 分发/审批/执行零改动）。
- **FR5/FR6**：`ToolsConfig.mcpDeferredLoading`（auto/always/off，**交付默认 off** 灰度起点）+ `mcpDeferredSchemaBudgetBytes`（16 KiB）；`McpServerProfile.alwaysLoad` 按服务覆盖（computeDeferredPlan 规则 2：alwaysLoad 永远 eager）。
- **FR7**：`buildToolCapabilityConventionHint` 延迟分支 + compat 名口径（tool_search 无点号恒等）。
- **FR8**：turn 维度 `deferred` 加性字段（toolCount/indexChars/eagerEquivalentChars）+ 节省量按轮日志 `mcp.deferred_savings`；`summarizeToolDeclarations` 天然只含广告面。
- **FR9**：tool_search 显示名「工具检索（MCP）」（`shared/toolCallLabel.ts`，带 query 附检索词）。
- **FR10**：设置页三档 Select + 每服务「始终全量加载」开关 + i18n（`config.mcp.*` 命名空间，O12），`npm run i18n:check` 通过。
- **FR11**：延迟档快照准入放宽（偏执上限 512/1 MiB，`MCP_DEFERRED_PARANOID_MAX_*`）——**评审修复后运行时已接线**：`buildSnapshotFromDb` 增 `admission` 参数，`invocationAssembler` 读 `materials.toolsConfig.mcpDeferredLoading`（与 plan 计算同一事实源）传 `deferred`/`standard`；白名单为唯一门槛；**白名单上限（512）= 偏执上限 → 延迟模式快照层 `budgetDropped` 恒空不变量由配置层保证（O2），并有 >64 工具走真实快照路径的装配级用例固化（10.1.12）**。
- **FR12①**：`computeBudgetDiagnostics`（snapshot/eager/executor 三源合并）经 `mcp:list` 载荷扩展 `budgetDiagnostics` 下发，设置页按 source 分组渲染。
- **FR12②**：被拒文案区分——SDK deny 决策补 `userMessage` 透传（最小扩展）；`REGISTERED_TOOL_NOT_FOUND` 在 hosted 组装层映射为结构化拒绝（先解除 pending）：预算裁剪名单内=「预算未注入」，其余=「服务不可用/已变更」；turn 不再因幻名整体失败。
- **FR13**：装配期快照清洗 `sanitizeMcpSnapshotForExecutors`（全档位一致；坏条目快照层剔除 + `executorDropped` 诊断 + warn 日志；off 档降级偏离已显式声明）。
- **FR14**：alwaysLoad 持久化链路五处覆盖（写 strict schema / 读 schema / 类型 / writeInputToProfile / mcpDrafts）+ 往返测试。
- **模式冻结（R7）**：plan 每 invoke 重算（快照纯用户触发式刷新的现状下无中途翻转面）；`contextWindowId` 冻结属预防性加固，随 list_changed 接线一并评估。
- **SDK 改动补充（评审 P3-3）**：新增 `SafetyGatePort = Pick<SafetyGate, 'evaluate' | 'authorize' | 'discardPermit'>`，turn.ts 的 ports.safetyGate 类型放宽为该端口（实例赋值兼容）；FR12② 的拒绝文案包装为显式委托对象，消除原型链包装的脆弱性。

## 关键设计事实（评审对照）

- **off 档逐字节兼容**：tool_search 仅在延迟计划生效时进广告面（§6.5 规则 4），eager 档从 builtin 广告面剔除，保住现状请求形态；auto-eager 与 off 同用 `trimMcpToolsForBudget` descriptor 口径（O3）。
- **O4 回退**：tool_search 被 lane/开关/allowedTools/trim 剔出广告面 → 延迟计划整体失效回退 eager（`deferredDegradedToEager` + `mcp.deferredDegradedToEager` warn 日志，不进 wire 面）。
- **B4 wire 面零污染**：deferredUnsurfaced 只落 agentLogger 事件 + `ToolCallResultPersisted.deferredUnsurfaced`（sessionLedger 投影），发给 provider 的工具结果块不含自定义字段（端到端断言）。
- **SDK 改动说明**：需求约束「SDK 零改动」有两处最小必要偏离（均为 FR12② 文案区分的机制要求，向后兼容）：`SafetyPolicyDecision` deny 分支加可选 `userMessage`；turn.ts 在 prepareTool 抛 `ToolDeniedError` 时先 `markNotDispatched`（与 safetyGate deny 路径一致，防 invocation 终态挂起）。

## 验证结果

- 新增测试 9 文件（effectiveTools.deferred / toolSearchTool / toolCatalogPrompt / skillPrompt.deferred / invocationAssembler.deferred / toolChatLoop.deferred / mcpIpc.persist / budgetDiagnostics / usageAttribution.deferred），加上各阶段定向回归与评审修复用例，分支累计定向测试全绿（评审修复面定向组 359 passed）。
- **全量 `npm test`（评审修复后复验，834 文件 / 7577 用例）：42 failed / 7508 passed / 27 skipped**。失败文件清单（13 个）与基线 commit 386e04b6 完全一致——均为基线/环境失败（run_shell side-effect 依赖真实 shell spawn、临时目录/路径别名类，已在基线逐文件复现），与本需求改动无关。
- `npm run build:electron:incremental`、`npm run typecheck:renderer`、`npm run i18n:check` 全部通过。

## 待真机验收（§10.2，需真实 API Key / 真实 MCP 服务）

1. 模型遵循度（≥80% 首选检索）与兜底触发率——**默认档位切 auto 的前置门槛**（§9 灰度计划）。
2. 三档节省量化（usage 归因面板读 `deferred` 维度与 `mcp.deferred_savings` 日志）。
3. 缓存命中率不劣化（request_header 指纹）。
4. 设置页两处开关交互、tool_search 卡片展示、远程 IM 无回归。
5. 大体量 server（>64 工具）索引可读性与检索命中率。
6. 检索返回体校准（`mcp.tool_search_result` 的 truncated 触发率、`mcp.deferred_unused_surfaced` 占比）。

真机验收通过后，单独提交将 `DEFAULT_TOOLS_CONFIG.mcpDeferredLoading` 切为 `'auto'`（§9），发布说明需声明存量超阈值配置的行为翻转与 `off` 回退路径（§7.3）。
