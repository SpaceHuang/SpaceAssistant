# 桌面自动审批（回答者并入规则动作）开发计划

> 状态：**已实施完成**（分支 `codex/desktop-auto-approval`，TDD 推进；实施记录见 §13）
> 基线：main（`approval-agent-shortest-path` 代码已合并；上游文档已入库，见 §12 前置）
> 上游：`docs/develop/approval-agent-shortest-path-plan.md`、`docs/develop/architect/confirmation-answerer-and-auto-approval-design.md`（I1–I5）
> 范围：**仅桌面链路**。wechat / feishu 回答者改造不在本轮。

---

## 1. 结论与定位

把「未命中规则与缓存时由谁回答」从**独立配置的回答者**，改为**由规则动作直接决定**：

| 动作 | 谁处理 |
| --- | --- |
| 禁止 | 直接拒绝 |
| 放行 | 不问、直接放行 |
| 询问 | 人工确认（现状） |
| 自动 | 先跑确定性预判快通道，定不了 → **审批 Agent** |

**「自动」= 交给审批 Agent**；交付 Agent 前允许系统做性能优化（快通道）。因此上一轮设想的两件东西**取消**：

1. **不新增「回答者」设置面**——已被「动作」吸收，`config.confirmAnswerers` 不向用户暴露。
2. **不采用「非 user 回答者不得 loose」约束**——见 §4 决策 1。

一句话：**desktop 的 `standard` 档，把「询问」显示并执行为「自动」。**

---

## 2. 模型

### 2.1 档位挂在链路上

**档位不是跨链路共享的全局枚举**。每条链路自带「提供哪几档 + 可编辑动作域 + 每档动作变换」，跨链路**不对齐**；同名档位在不同链路是不同的东西。

基线动作 = `DEFAULT_POLICY_RULES` 声明的动作（`deny` / `allow` / `ask` / `auto-evaluator`）。

| 链路 | 可选档位 | 用户可选 | custom 可编辑动作域 | standard | strict | loose |
| --- | --- | --- | --- | --- | --- | --- |
| desktop | strict/standard/loose/custom | ✅ | **4 态**（deny/allow/ask/auto-evaluator） | 非 locked `ask→auto`，`auto-evaluator` 保持 | 非 locked `allow`/`auto-evaluator`→`ask` | 非 locked `ask→allow`，`auto-evaluator` 保持 |
| wechat | strict/standard/loose/custom | ✅ | **3 态**（deny/allow/ask） | 恒等（现状） | 非 locked `allow`→`ask` | 非 locked `ask→allow` |
| feishu | 同上 | ✅ | **3 态** | 恒等（现状） | 同 wechat | 同 wechat |
| automation | **仅 standard** | ❌ | 不适用（无可编辑档） | 恒等（其唯一 ask 为 locked；回答者=agent 由 lane 决定，等价现状） | — | — |

**变换的普遍例外（不可变换集，§2.2）**：`deny`、`confirm-every-time`、`locked` 条目、`extraction-failed` 兜底——**任何档位都不变换**（放宽与收紧都不）。

> **B1 修订（关键）**：`locked` **不参与任何档位变换**，与 `policyPackages.ts:10-11`「locked 在任何套餐下都不可被调松/改写」的既有语义一致。`ask→auto` 是**调松**（人工 → LLM 裁决），不得作用于 locked ask。desktop lane 上实际存在的 locked ask 均为高敏感项，保持人工：
>
> | 规则 | 位置 | 保持人工的理由 |
> | --- | --- | --- |
> | `toolkit-act-ask` | `defaultRules.ts:251-256` | 能力集合变更（如 `action.mcp.add`）。交 Agent 裁决 = **审批 Agent 自我批准给 Agent 加装新工具**，构成提权回路 |
> | `lark-high-impact-ask` | `:209-214` | lark-cli 高影响子命令 |
> | `lark-unknown-ask` | `:217-222` | 子命令无法分类（信息不足），恰是最不该由 LLM 替人拍板的场景 |
>
> 这与决策 3（`confirm-every-time` 不变换）同源：**「必须真人」语义的条目，都不因档位而换成 Agent。**

### 2.2 回答者由动作派生（不再按 lane 查配置表）

- `effectiveAction = 'ask'` → `require-confirm(answerer = lane === 'automation' ? 'agent' : 'user')`
- `effectiveAction = 'auto-evaluator'` → 跑快通道；定不了 → `require-confirm(answerer='agent')`
- `allow` → `auto-allow`；`deny` → `deny`

**automation 的回答者恒为 agent**（无人可问，无 user 档），等价 P2-6 现状。automation 的唯一 ask（`automation-default-confirm`）本身是 locked（不变换），靠本条 lane 规则落 agent。

**wechat/feishu 无 `auto-evaluator` 条目**（默认规则集中 `auto-evaluator` 仅 `desktop-auto-approve` 与 `shell-precheck-auto-allow`，均 `match.lane=['desktop']`，有 lint 强制；且 B2 修订后 custom 也不放开）→ standard 恒等下**不产 agent 回答者**，零行为变化。

### 2.3 预判快通道（「自动」内部）

| 工具 | 快通道（确定性、无 LLM） |
| --- | --- |
| `run_shell` | 现有 shell 预检（信任命令 / 安全命令）→ 命中即放行 |
| `write_file` / `edit_file` | 现有 `evaluateFileToolAutoApproval`（`electron/tools/writeFileAutoApproval.ts:61`，基于 `autoApproveMaxBytes` / `autoApproveMaxEditChars`）→ 命中即放行 |
| 其余 | 无快通道，直接交 Agent |

快通道路径保留，只是不再由「`desktop-auto-approve` 规则 + `confirmMode` 门控」承载，而是「自动」动作的内建步骤。

---

## 3. 与既有实现的关系（supersede 点）

| 既有 | 处置 | 理由 |
| --- | --- | --- |
| `desktop-auto-approve` 规则（`defaultRules.ts:91-97`） | **删除** | standard 的通用 `ask→auto` 已覆盖其能力 |
| `confirmMode` 门控（`toolCallGate.ts:197-202`） | **删除** | 唯一决策层消费者即上述规则 |
| `FileConfirmMode` / `ToolsConfig.confirmMode` | **彻底清理**（§5.7） | 决策层 + 展示层双面清理 |
| `AUTO_EVALUATOR_EDITABLE_ACTIONS` 特例（`policyPackages.ts:50`） | **删除**，改为**按 lane 的动作域**（§5.2 / B2） | 动作域不能对所有 lane 一视同仁 |
| `validatePolicyPackageForLane`（非 user 禁 loose） | **删除**，改为 `isPackageAvailableForLane` | 见决策 1 |
| `DEFAULT_CONFIRM_ANSWERER` / `resolveLaneAnswererPolicy`（`answererConfig.ts:16-21/36`） | **收缩** | 语义并入链路档位表；仅保留 fail-closed 兜底最小内核 |
| `applyCustomForNonUserAnswerer`（`policyPackages.ts:104-107`）及 loose 运行时 guard（`:141-142`） | **替换为按 lane profile 的等价运行时防护**（§5.2 / M2） | 纵深防御不应只剩入口一层 |
| `settingsSecurityModel.toRuleViews` 的 confirmMode 派生（`:61-66`） | **删除**，改为按链路档位算**生效动作** | — |
| `defaultRules.lint.test.ts` 的 desktop-only auto-evaluator 断言（`:61-67`） | **保留**（`shell-precheck-auto-allow` 仍在） | — |

---

## 4. 已锁定决策

1. **不做「非 user 不许 loose」约束**。旧论证（「无人监督 + 自动放行 = 最坏组合」）不成立：`loose` 会把 `ask` 直接翻成 `allow`，根本不走到回答者；对同一批操作，`desktop+loose+agent` 与 `desktop+loose+user` 行为相同。套餐是用户显式选择（standard 为默认），以用户决策为准。automation 无 loose 是**它不提供这一档**，不是校验拦截。
2. **`confirmMode` 彻底清理**（非惰性保留）：删门控 + 删字段/类型 + 删展示层消费 + 删测试夹具，需 DB 迁移（§5.7）。
3. **`confirm-every-time` 不变换**：始终人工逐次确认。
4. **本轮仅桌面**；wechat/feishu **零行为变化**（standard 恒等 + custom 3 态），为头号硬回归。
5. **顺手补桌面授权证据**（§6）。
6. **fail-open-to-user（审批失败降级回人工确认卡）本轮不做**：桌面有人在场，先按 fail-closed。
7. **`locked` 不参与档位变换**（B1 修订，§2.1）。
8. **`extraction-failed` 不变换**（M3 修订，§2.1）：事实提取失败 = 输入畸形/对抗性，「信息不足 → 问人」比「交 LLM」更安全，符合 I4 的 fail-closed 精神（desktop/IM 落人工；automation 经 lane 规则落 agent）。

> 决策 7、8 使 standard 的精确表述为：**除 `deny` / `confirm-every-time` / `locked` / `extraction-failed` 外，非 locked `ask → auto`。**

---

## 5. 变更清单

### 5.1 类型（`src/shared/confirmation/types.ts`）

- `Decision.require-confirm` 增加 **`answerer: 'user' | 'agent'`**。
- `ConfirmAnswererPolicy` / `ConfirmAnswererMap`：降级为内部 fail-closed 兜底（仅 `deny` 档保留）。
- 文档化 `PolicyAction.auto-evaluator` = 自动（快通道 + Agent）。

### 5.2 策略层

- **`src/shared/policy/policyPackages.ts`**
  - 新增 `LANE_PROFILES: Record<ExecutionLane, { availablePackages; userSelectable; availableActions; transforms }>`（§2.1 表）。
  - **删除内部变换函数 `applyStrict`（:73）/`applyLoose`（:79）**（未导出），改为**按 lane 取变换**；`resolvePolicyRules` 入参带 `lane`。导出 `effectiveActionFor(lane, pkg, baselineAction)` 供渲染端复用（显示=实际）。
  - **B2 修订**：`validateRuleOverride`（:58）与 `applyCustom`（:84）**带 lane 参数**——动作域按 `LANE_PROFILES[lane].availableActions`；`auto-evaluator` 仅 desktop（+ automation 内部）可用，**wechat/feishu 拒绝**（IPC 校验 + 引擎双层）。§2.1 与 §5.5 措辞统一。
  - **M2 修订（纵深防御）**：删除 `applyCustomForNonUserAnswerer` 与 loose 运行时 guard，替换为**按 lane profile 的等价运行时防护**：`resolvePolicyRules` 对「档位不在 `availablePackages`」→ 视为 `standard` 并落告警；`applyCustom` 过滤掉不在 `availableActions` 的覆盖。**入口校验（IPC）+ 运行时防护（引擎）双层保留**。
  - 删除 `validatePolicyPackageForLane`，新增 `isPackageAvailableForLane(lane, pkg)`。
  - 删除 `AUTO_EVALUATOR_EDITABLE_ACTIONS` 特例（:50）。
- **`src/shared/policy/policyEngine.ts`**
  - 第 4 步：命中有效 `auto-evaluator`、预判未裁决 → `require-confirm(answerer='agent', ruleId)`（不再交还默认表问人）。
  - 第 6 步 `ask` → `require-confirm(answerer = lane==='automation' ? 'agent' : 'user')`。
  - `applyDefault` / `extraction-failed`：**不变换例外**——`extraction-failed` 恒落人工（automation 例外见 §2.2）；`default-write-execute-ask` 照常参与变换（desktop standard → auto）。实现：引擎 deps 增 `transformAction`（或 `laneProfile`），并识别「不变换例外」。
  - `requireConfirm` 增 `answerer` 参数。
- **`electron/confirmation/policyRulesRuntime.ts`**
  - `loadEffectivePolicyRules` 按 lane profile 变换；移除 `resolveLaneAnswererKind` 依赖。
  - `normalizePolicyPackages`：按 lane 可用集合收敛（automation 强制 standard）。

### 5.3 主进程装配

- **`electron/toolChatLoop.ts`**
  - 通道装配在 **:1819-1897**（`resolveLaneAnswererPolicy` 调用 :1821）：改用 `gate.decision.answerer`（`require-confirm` 才有）。
  - 桌面 `answerer='agent'` → 复用既有 `agentChannelFactory` → `AgentChannel`（定义在 **`electron/confirmation/agentChannel.ts`**，非 `channels.ts`）。
  - 缓存写入闸在 **:2054 / :2096**：`confirmAnswererKind` 由 decision 派生（I3），非 user 不写缓存。
  - **M1 修订**：**:1753** 的 diff 预览条件 `confirmMode==='diff'||'auto'` **改为由「本次确认的回答者是否为人类」驱动**（`answerer==='user'`；agent 路径不需要卡片 diff）。这是 `confirmMode` 决策层之外的**存量消费者**，随 §5.7 一并处理。
  - 桌面链路透传 `taskDigest`（§6）。
- **`electron/confirmation/channels.ts`**：`resolveConfirmChannel` 的 `answererPolicy` 改为「本次决定的回答者」入参（保持二维解析形状）；`DenyChannel` 保留为 config-error 兜底。
- **`electron/confirmation/answererConfig.ts`**：收缩——删除 `DEFAULT_CONFIRM_ANSWERER` 与 `resolveLaneAnswererPolicy`；保留 `deny` 兜底最小逻辑。
- **`electron/appIpc.ts`**
  - `security:set-policy-package`：改用 `isPackageAvailableForLane`；移除 `resolveLaneAnswererKind` / `validatePolicyPackageForLane`。
  - **`security:get-settings-model`（:1316，非 `security:get-model`）**：`buildSettingsSecurityModel` 不再传 `confirmMode`。
  - `security:set-rule-override`：加 lane 维度校验（B2）。
  - `config:set` 中 `tools.confirmMode` 的变更审计分支（:1679-1696）：随退役移除。

### 5.4 规则数据

- **`src/shared/policy/defaultRules.ts`**：删除 `desktop-auto-approve`；更新第 4 步段注释。
- **`src/shared/policy/defaultRules.lint.test.ts`**：`shell-precheck-auto-allow` 的 desktop-only 断言保留。

### 5.5 设置面

- **`electron/confirmation/settingsSecurityModel.ts`**：`toRuleViews`（:50-70）去 `confirmMode` 派生；**按 lane 计算生效动作**（standard 下 desktop 的询问行 → 显示「自动」）。
- **`src/shared/confirmation/settingsCenter.ts`**：`SecuritySettingsModelPayload.confirmMode` 删除；`rules` 保留基线动作，渲染端用 `effectiveActionFor` 算生效动作。
- **`src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`**
  - 规则动作下拉：动作域**按 lane**（desktop 4 态 / wechat/feishu 3 态，B2）；**显示当前 lane + 档位下的生效动作**（non-custom 只读）。
  - **特判口径修正**：渲染端现有特判是 `defaultAction === 'auto-evaluator'`（:213-218），**不是按 id**；改为按 lane 动作域 + 生效动作。
  - 档位选项按 `availablePackages`（automation 本就不展示）。
  - `loose` 二次确认文案改为「该链路『询问』→『放行』」。
- **i18n**：`toolsSecurity.policy.*` 新增/改少量文案（「自动」含义、档位差异），运行 `i18n:generate-types`。

### 5.6 审批执行链（§6 配套）

- **`electron/confirmation/approvalAgent.ts`**：授权上限**参数化**（`APPROVAL_MAX_AUTHORIZATION` :169 硬编码 → `runApprovalAgent` 接受 `maxAuthorization`，缺省仍 `low`；消费点 :346）。
- **`buildApprovalTaskDigest`（`electron/butler/butlerInvoker.ts:44-49`）提取为共用模块**（如 `src/shared/approvalTaskDigest.ts`），供 butler 与桌面链路复用。

### 5.7 `confirmMode` 彻底清理（M1）

**生产代码（15 处文件）**：

| 文件 | 处置 |
| --- | --- |
| `src/shared/domainTypes.ts`（`FileConfirmMode`、`ToolsConfig.confirmMode`、`DEFAULT_TOOLS_CONFIG`） | 删类型与字段（破坏性：所有 `ToolsConfig` 构造点需改） |
| `electron/confirmation/toolCallGate.ts`（:197-202 门控、:315 config 袋） | 删除 |
| `electron/toolChatLoop.ts`（:1753 diff 预览 + 另 1 处） | 改用回答者条件（§5.3 M1） |
| `electron/appIpc.ts`（get-settings-model、config:set 审计等） | 移除字段与审计分支 |
| `electron/confirmation/settingsSecurityModel.ts`（7 处） | 随派生删除 |
| `src/shared/confirmation/settingsCenter.ts`（1 处） | 删载荷字段 |
| `src/renderer/components/Config/{ConfigModal,configModalSnapshot,ToolsSettingsTab}.tsx`（3+2+1） | 移除透传/快照 |
| `src/renderer/services/resolveMessageToolsInteractive.ts`（5 处：`ToolsInteractiveScalars.confirmMode`） | 删字段 |
| `src/renderer/components/Chat/{ToolCallCard,WriteConfirmCard,ChatView,ChatBubble}.tsx`（3+6+3+2） | 删 prop；`WriteConfirmCard.resolveDiffContent` 去掉 `'direct'` 分支 |

**测试夹具（约 20 个文件，~90 处）**：`ToolCallCard.test.tsx`（35）、`toolCallGate.test.ts`（11）、`configModalSnapshot.test.ts`（7）、`toolDecisionMatrix.test.ts`（6）、`resolveMessageToolsInteractive.test.ts`（6）、`settingsSecurityModel.test.ts`（4）、`ToolsSecuritySettingsTab.test.tsx`（4）、`weChatCommandRouter.test.ts`（4）、`mcpToolExecutor.test.ts`、`browserExecutor.test.ts`、`builtinExecutors.autoApprove.test.ts`、`butlerInvoker(.taskDigest).test.ts`、`automationLane.test.ts`、`toolChatLoop.locale.test.ts`、`chatRunnerService.test.ts`、`sessionModelBinding.test.ts`、`visionModelRouting.test.ts`、`ToolsSettingsTab.autoApprove.test.tsx` 等。

**DB 迁移**：老用户 `tools` JSON 含 `confirmMode` 值——新增一次性迁移删除该键（或读取时忽略）；`'direct'` 用户的行为变化 = **写确认卡始终展示 diff**（原 `'direct'` 语义消失，UI 早已无入口）。

---

## 6. 桌面授权证据（决策 5）

**问题**：裁决为 `risk × authorization` 双维。桌面链路当前**不透传 `taskDigest`**（`claudeStreamHandlers.ts:391`、`imRemoteAgent.ts:128` 均无；仅 `butlerInvoker.ts:269` 传），且授权上限硬编码 `low`。直接用会导致 **desktop/standard 下 high-risk 动作被大量误拒**。

**改动**（小）：

1. **透传 `taskDigest`**：桌面链路把**当前 turn 的用户消息**（或摘要）经 `args.approvalTaskDigest` 传入，复用提取后的 `buildApprovalTaskDigest`，进线索包「已声明的任务（可信证据）」段（围栏之外，`approvalAgent.renderCluePack`）。
2. **放宽授权上限**：按 lane/档位传 `maxAuthorization`——desktop 允许到 `high`；automation 维持 `low`。
3. Skill v2 授权评分与反过度解读条款（已在 main）无需改。

---

## 7. 测试与验收

### 7.1 硬回归（最关键）

- **wechat / feishu 零行为变化**：standard 恒等 + custom 3 态；`channels.test.ts`、`imChannel.test.ts` 等全绿。
- **automation 零行为变化**：唯一 ask（locked）经 lane 规则落 agent，等价 P2-6。
- **I3**：agent 裁决不写 `decision_cache`（三道闸 + 锚点用例）。
- **I4**：不可用 / 超时 / 不可解析 / config-error 全 fail-closed，`cause` 与 `agent-deny` 可区分。
- **I5**：审批会话内 `require-confirm` → `deny(cause=recursion-blocked)`（与 lane 无关，加桌面回归）。
- **B1**：desktop standard 下 `toolkit-act-ask` / `lark-high-impact-ask` / `lark-unknown-ask` **仍落人工**（断言 answerer='user'）。
- **B2**：wechat/feishu custom 提交 `auto-evaluator` 覆盖被拒（**IPC 层 + 引擎层各一用例**）；不致产 AgentChannel。

### 7.2 新增

- **档位变换逐格**：`LANE_PROFILES` × 各基线动作 → 期望有效动作（4 lane × 4 档）。
- **回答者派生**：`ask→user`（automation→agent）、`auto-evaluator→agent`。
- **端到端（mock provider + 内存 DB）**：desktop/standard 下 `write_file`（大文件）/ `browser` act / `mcp-tool` → AgentChannel（approve / deny 双路径）；`run_shell` 信任命令走快通道**不调用** Agent。
- **M3**：`extraction-failed` 落人工（desktop）。
- **设置页**：standard 下「询问」行显示「自动」；strict「询问」；loose「放行」；custom desktop 4 态 / 远程 3 态。
- **授权维度**：有/无 `taskDigest` 的裁决差异；desktop `high` / automation `low`。
- **`confirmMode` 清理**：字段删除后无消费者；`'direct'` 迁移后写卡始终展示 diff。
- **套餐集合**：automation 不接受 strict/loose。

### 7.3 验收边界

| 当前环境可验收 | 需真机 / 真实 LLM |
| --- | --- |
| 档位变换、回答者派生、快通道、I3–I5、B1/B2、端到端链路 | 裁决质量（误拒率）——**抽样人工评审** |

### 7.4 预期改写（非「零改动回归」）

收缩 `answererConfig` / `resolvePolicyRules` 签名后，以下测试属**预期改写**而非零改动回归：`automationLane.test.ts`（依赖 `DEFAULT_CONFIRM_ANSWERER.automation`）、`policyPackages.test.ts`、`toolDecisionMatrix.test.ts`、`toolCallGate.test.ts`、`toolChatLoop.approvalAgent.test.ts`、`settingsSecurityModel.test.ts`。计划实现时须在提交信息中区分「改写后全绿」与「零改动回归」。

---

## 8. 明确不做（本轮）

- wechat / feishu 回答者与通道改造。
- 审批失败 fail-open-to-user（降级回人工确认卡）。
- 审计页按 actor 筛选、`priorVerdicts` 成本优化。
- 「永远人工」例外集（如需，交 Skill 的 critical 无条件 deny）。
- `config.confirmAnswerers` 的用户可见设置项。

---

## 9. 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| 误拒率高（授权证据不足） | §6 透传 taskDigest + 放宽上限 | desktop standard 变换改回恒等（一行） |
| `confirmMode` 彻底清理触及 ~50 文件、拉大改动面 | 独立提交；生产代码与测试夹具分批 | 单点 revert |
| `'direct'` 用户行为变化（始终展示 diff） | 迁移说明；UI 早已无入口 | 恢复字段（若必须） |
| 桌面「记住我的选择」弱化（agent 裁决不落缓存） | 预期；审计可见 | — |
| 档位变换表与渲染端不一致 | 变换表放 `src/shared`，两端同源 | — |

---

## 10. 提交切分

1. **P0 纯函数与类型**：`LANE_PROFILES` + `effectiveActionFor` + `answerer` 类型 + 引擎产出 answerer + 不变换例外（locked/extraction-failed）+ 单测（desktop 生效前零行为变化）。
2. **P1 桌面生效**：desktop standard `ask→auto` + 装配接线 + `taskDigest` + 授权上限；删 `desktop-auto-approve` / `confirmMode` 门控。**业务语义变化点，单独提交可回退**。
3. **P2 设置面**：显示生效动作、动作域按 lane（B2）、i18n、快照清理。
4. **P3 清理（B2/M2/§5.7）**：`answererConfig` 收缩、`validatePolicyPackageForLane` 删除、运行时防护替换、`confirmMode` 全量清理（生产 + 夹具 + 迁移）、文档更新。

---

## 11. 评审响应对照

| 项 | 级别 | 处置 |
| --- | --- | --- |
| B1 locked ask 被 standard 变换调松 | 阻断 | **采纳保守方案**：locked 不参与变换（§2.1 / 决策 7）；`toolkit-act-ask` 保持人工 |
| B2 custom 动作域未按 lane 收敛 | 阻断 | 动作域按 lane（§2.1 / §5.2 / §5.5）；IPC + 引擎双层拒绝用例（§7.1） |
| M1 confirmMode「无消费者」不成立 | 重要 | §5.3 增 `toolChatLoop.ts:1753` 处置；§5.7 全量清理（决策 2 改为彻底清理） |
| M2 运行时纵深防护去向 | 重要 | §5.2：以按 lane profile 的运行时防护替换 `applyCustomForNonUserAnswerer` + loose guard，保留双层 |
| M3 extraction-failed 交 Agent 缺论证 | 重要 | **列入不变换例外**（§2.1 / 决策 8），落人工 |
| M4 上游文档未入库 | 重要 | §12 前置：开工前先提交 |
| 事实错误 1 IPC 通道名 | 建议 | §5.3 修正为 `security:get-settings-model` |
| 事实错误 2 applyStrict/applyLoose 措辞 | 建议 | §5.2 改为「内部变换函数（未导出）」 |
| 事实错误 3 模块归属 | 建议 | §5.3/§5.6 修正（`AgentChannel` → `agentChannel.ts`；`buildApprovalTaskDigest` → `butlerInvoker.ts`，提取共用） |
| 事实错误 4 行号区间 | 建议 | §5.3 修正为 :1819-1897 / :2054 / :2096 |
| 事实错误 5 confirmMode 唯一消费者限定 | 建议 | §3 加限定（决策层唯一） |
| 事实错误 6 渲染端特判口径 | 建议 | §5.5 修正为 `defaultAction==='auto-evaluator'` |
| 事实错误 7 测试名单含义 | 建议 | §7.4 新增「预期改写」清单 |

---

## 12. 前置（M4）——已完成

`docs/develop/approval-agent-shortest-path-plan.md`、`docs/develop/architect/confirmation-answerer-and-auto-approval-design.md` 与本计划原先均为 git **未跟踪**状态（`git ls-files` 为空），基线引用会断链。已于提交 `20d31edf` 一并入库，M4 关闭。

> 注：评审报告 `docs/review/desktop-auto-approval-plan-review.md` **不入版本控制**——`docs/review/` 目录被 `.gitignore` 忽略（项目约定：评审报告为本地过程产物）。因此 M4 的范围仅限 `docs/develop/` 下的设计/计划文档。

---

## 13. 实施记录（2026-09-19，分支 `codex/desktop-auto-approval`）

按 §10 提交切分完成，全部阶段 TDD（先写/改写测试到目标态再实现）：

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| P0 | `e40af8e0` | `LANE_PROFILES` + `effectiveActionFor` + `Decision.require-confirm.answerer` + 引擎产出 answerer + 不变换例外（locked/deny/confirm-every-time/extraction-failed）。desktop 变换未接线，零行为变化 |
| P1 | `f64567d2` | desktop standard `ask→auto` 生效 + toolCallGate/toolChatLoop 装配接线 + `taskDigest` 桌面透传 + `maxAuthorization`（desktop high / automation low）+ 删 `desktop-auto-approve` / confirmMode 门控 |
| P2 | `7cb45bef` | 设置面生效动作显示（`effectiveActionFor` 两端同源）+ custom 动作域按 lane + standard/loose 档位文案（i18n zh/en） |
| P3 | `99ab0c42` | confirmMode 全量清理（生产 ~15 文件 + 测试夹具 19 文件 + `confirmModeRetirementMigration` DB 迁移）；`answererConfig` 整文件退役；`validatePolicyPackageForLane` 删除 + `isPackageAvailableForLane`；B2 IPC 层 lane 校验（`validateRuleOverride` 带 lane、`set-policy-package` 档位可用性） |

### 实施中的关键设计决策（相对计划的偏差与发现）

1. **standard 档在规则集层恒等**：desktop 的 `ask→auto-evaluator` 不在 `resolvePolicyRules` 预变换规则集，而由引擎**产出时**经 `deps.transform`（= `effectiveActionFor` 同源）解释。原因（测试先行发现）：规则集预变换会把 ask 条目提升到引擎第 4 步（auto-evaluator 段），破坏 `mcp-readonly-allow` 必须先于 `mcp-tool-ask` 命中的顺序语义（defaultRules 注释明示）。产出时变换保持规则顺序与「首条命中即返回」不变。
2. **askUnless 门控放行先于动作解释**：`larkCliWriteRequiresConfirm=false` 等开关满足时，无论生效动作是 ask 还是「自动」都直接放行——档位不接管已放行的调用（phase2 回归测试锚定）。
3. **引擎第 4 步级联保留 + 末次命中落 Agent**：多个基线 auto-evaluator 条目依次尝试快通道（M3 级联），全部未裁决由末次命中条目产 `require-confirm(answerer='agent')`（不再交还默认表问人）。
4. **confirmMode 迁移**：`runConfirmModeRetirementMigrationOnce`（版本门控 + 事务 + 损坏 JSON fail-safe），`'direct'` 用户行为变化 = 写确认卡始终展示 diff。
5. **mcpConfirmPolicyMigration 适配**：automation 仅提供 standard 档，迁移不再将其置 custom（写入也会被 `normalizePolicyPackages` 收敛）。

### 评审修复（代码评审 v1，`docs/review/desktop-auto-approval-code-review-v1.md`）

修复提交 `2894c166`：

- **H1**（合并前必须）：信任写入与 pending 确认挂钩——`tool:confirm-response` 四个信任分支要求 registry 存在 pending（agent 裁决路径无 waiter，残留卡片信任点击被拒并落告警）；`confirm-requested` 载荷携带 `autoAnswerer`，agent 路径渲染只读「自动审批中」卡且不发浮动确认通知。
- **H2**（合并前必须）：`toolCallGate` 增 `fileAutoApproved` 显式结果字段，`toolChatLoop` 不再匹配已删除的 `desktop-auto-approve` ruleId；e2e 锚定 `file.auto_approve` 审计与 `autoApprovedWrite` meta。
- **H3**（合并前必须）：`serializeToolCallsForDb` 与 `tool_call` JSONL 事件对 `toolkit.call` 入参按展示侧同口径净化，凭据明文不落 `messages.tool_calls` / 事件台账 / 会话备份。
- **中 1/2/4/5/6**：审批裁决 `reasonSummary`/`evidenceCount` 落审计；用量统计过滤 internal/hidden 会话；URL 内嵌凭据打码；`action.session.read` 拒绝 internal/hidden 会话；`updateServerStatus` 纳入 secret 写锁。
- **低项**：normalize 收敛告警、`policy.decision` 记 `answerer`、`readLanePackage` 死导出、taskDigest 代理对切割、UsageTrendChart 真实 0%、desktop loose run_shell 锚定测试、孤儿 `config.confirmAnswerers` 键清理。
- **H4 产品签署**：存量未配置套餐桌面用户升级后「询问」默认变为「审批 Agent 自动裁决」（含 `browser-act-danger-ask` 危险表单/支付类浏览器操作）——**产品确认维持默认自动，不做默认关闭、不额外锁定高危条目**（2026-09-19 签署）。升级告知（release notes / 首次启动提示）由产品发布流程负责，不在本分支代码范围。
- **R1/N1 复验修复（v2 报告）**：`assistant_chunk` 的 `tool_call_delta.partialJson`（入参原文流式分片，chunk 拼接可还原凭据）在两个 JSONL sink（桌面 `claudeStreamHandlers` / automation `butlerSessionEvents`）落盘前剥离（`sessionEvents.stripPartialJsonForPersist`，partialJson 无任何重放消费者）；`sanitizeUrlCredentials` 收敛到 shared 单份正确实现（userinfo `***:***` + 凭据 query 打码）并接入 `capabilityParamSanitize` 的 endpoint/url 分支（electron 侧死代码删除）；`updateServerStatus` 的 6 个调用点（mcpIpc ×3、mcpOauthService ×3）补 await；用量写入侧同步跳过 internal/hidden 会话（中 2 完整闭环——审批 Agent 内部回合开销不进事实表）。
- 未修复转跟进批次：中 3（用量回填主线程分片）、中 7（保留期设置出口）、其余低项（死 i18n key 精确核对、`config.confirmAnswerers` 之外的清理等）。

### 验收边界（§7.3）

- 已验收：档位变换逐格（4 lane × 4 档 + 例外）、回答者派生、快通道、I3/I4/I5、B1（locked ask 保持人工）、B2（IPC + 引擎双层）、端到端 gate 决策链路、迁移幂等——全部自动化测试（electron + renderer 双项目）。
- 需真机/真实 LLM 抽样评审：审批 Agent 裁决质量（误拒率）——后续按 §7.3 人工抽样。
