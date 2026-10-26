# 自定义安全策略完整可配置开发计划

- **日期：** 2026-10-22
- **状态：** 开发方案草稿，尚未开始源码实施
- **需求基线：** [自定义安全策略完整可配置需求](../../../requirement/safety-approval/custom-policy-full-control-requirement.md)
- **需求评审：** [第一轮评审](../../../review/2026-10-22-custom-policy-full-control-requirement-review.md)、[第二轮评审](../../../review/2026-10-22-custom-policy-full-control-requirement-review-v2.md)
- **源码基线：** `109a938404124235d632e4cdbd4f9e06eaa48728`
- **执行任务清单：** [自定义安全策略完整可配置执行计划](./custom-policy-full-control-execution-plan.md)

> 该计划只规格化已评审需求，不表示需求已实现。实现必须遵守需求 AC-1–AC-22；需求与计划有冲突时先修订需求并重新评审，不由实现阶段自行取舍。

## 本轮评审核销（2026-10-22）

| 评审项 | 处理 | 对应计划位置 |
|---|---|---|
| B1 规则覆盖只含 invocation | **计划关闭条件已满足：** 补全 invocation/ingress/exposure 规则矩阵、消费点与动作合同；负责人确认入口消息获批后继续处理、exposure 对象获批后才暴露，并同步需求 AC-21/AC-22。运行时消费者实现与测试由 T3 完成。 | F-03、INV-01、多规则裁决契约、D-INGRESS、Phase 0–1 |
| B2 claim 与 executor 进入窗口 | 指明 claim 不等于进入；T6 在 `onDispatchClaimed` 异步窗口后复核 revision，并将 stale 调用交回 T5；不预设锁或死锁问题。 | 策略版本与派发线性化 §4、T6 |
| B3 失效后原调用如何继续 | 明确由 `deferredResumeCoordinator` 及盘点出的 desktop caller 接收变化并重新 gate，要求旧结果替换、新结果继续及一次性 resume 测试；不新增恢复队列。 | Phase 3、T5 |
| B4 API 删除先于 caller 迁移 | **计划关闭条件已满足：** T4 保留短期兼容 shim，T7 迁移 renderer，T8 才删除旧 API/handler；T4 增加兼容 caller/type 验收。 | Phase 2/4/5、T4/T7/T8 |
| B5 桌面事务与异步审计 | 收窄 INV-07：策略与 revision 同库事务；desktop 异步文件审计为事务外记录，保存成功由策略提交决定，审计失败不反报未保存。 | INV-07、Desktop 保存与审计契约、T4 |

评审报告原结论列出两项明确阻断（B1、B4）和三项任务补充（B2、B3、B5）。本轮已在计划及需求中关闭 B1/B4 的文档条件；B2/B3/B5 分别作为 T6/T5/T4 的实施前规格与验收。无死锁结论；若后续实现引入锁，只检查实际锁协议的等待关系。

## 第 0 层：决策摘要

### 目标

用户在自定义套餐下能够调整界面列出的每条规则，并看到自己的选择确实决定相应操作是被禁止、直接执行、由本人批准或交由自动审核。原有系统锁定、逐次确认和真人必批逻辑不能在用户选择动作后从其他代码路径悄悄恢复。

### 主要改动

1. 把各链路的规则动作选项扩大到需求规定的完整动作矩阵；将逐次确认默认语义清楚呈现在规则说明中。
2. 用统一多规则裁决顺序替代当前分散在 locked deny、`humanRequired`、逐次确认、自动审核和首条规则返回路径中的隐式优先级。
3. 清除独立停用状态，将存量停用规则按需求迁移成 `allow` 动作覆盖，并使迁移后的规则与任何同动作规则完全同等裁决。
4. 策略快照或规则动作保存后，使待审批、待审核和批准但尚未进入执行器的调用失效并按新策略重新判定；执行器开始处理与最终授权核验共享唯一派发边界。
5. 修改安全策略页与现有 IPC、快照、审计接线，使用户看到的动作、保存结果和运行时行为一致。

### 已批准的界面归属卡

**状态：已获项目负责人批准（2026-10-22）。** 批准范围：沿用现有安全策略设置界面与布局，只开放自定义模式下原来写死、不可设置的规则动作；不新增入口、页签、页面或独立面板，也不重排现有设置结构。

| 项 | 提议 |
|---|---|
| 放哪个入口 | 保持现有安全策略设置入口及其当前位置；用户仍在原有规则设置区域编辑动作。 |
| 形态 | 现有布局与规则组织不变；原来锁定只读的规则动作控件开放为可编辑，并沿用现有动作编辑与恢复默认交互。 |
| 样式来源 | 沿用现有设置页组件、样式和主题 token；不新增组件库或局部视觉变量。 |
| 新增还是改造 | 仅改造现有设置界面中 locked 规则的可编辑状态和必要说明；不新增入口、页签、页面或独立面板，不重排现有设置结构。 |
| 成本 | 用户可以直接调整原先不能编辑的规则动作；须通过现有界面说明与反馈表达保存、冲突及迁移结果，并复核中英文文案长度。 |

**批准记录：** 项目负责人于 2026-10-22 明确回复“批准上方界面归属卡：确认批准”。按随后澄清，界面范围进一步明确为“现有设置界面不变，原来写死不可设置的规则现在可以设置”。界面实现仍须执行交互设计指南 I8 的方案期和实现后 `$impeccable` 检查，检查仅覆盖本卡批准的改动范围。

### 决策项

| ID | 决策 | 状态与影响 |
|---|---|---|
| D-UI | 批准上方界面归属卡 | **已批准（2026-10-22）。** UI 仅开放现有界面中原锁定规则的动作配置，按卡中范围实施；不新增页面或改变现有设置布局。 |
| D-INGRESS | 确定 ingress/exposure 规则选为“人工批准”时的批准对象与继续点 | **已确认（2026-10-22）。** 项目负责人确认：入口消息批准后才进入处理；工具/能力批准后才暴露。已同步写入需求 AC-21/AC-22。 |

除已记录的 D-INGRESS 外，本计划不增加需求外的产品取舍。规则动作、停用迁移、审批生命周期和多规则优先级均沿用需求已明确取值。

## 第 1 层：方案概要

### 1. 范围

**包含：** 桌面、微信、飞书自定义规则；动作验证、运行时策略解析、规则判定、多规则优先级、旧停用数据迁移、IM 策略快照 revision、执行前重判与派发边界、设置 UI、i18n、设置审计及相应回归测试。

**不包含：** 新规则条件编辑器；变更规则事实提取条件；自动审核模型或阈值设计；开放 automation 链路（需求动作矩阵不包含该链路）；改变执行器工具可用性、外部账号授权和操作系统能力；改变已经进入执行器的操作。

### 2. 需求外扩声明

本方案没有把下列事项作为需求外新增功能：

| 交付面 | 需求依据 |
|---|---|
| 规则动作选择、每条规则恢复默认、默认确认说明、迁移说明、IM 共享提示 | 需求第 1 层 §2，第 2 层 AC-1、AC-7–AC-9、AC-17 |
| 规则动作裁决及 `humanRequired` / 逐次确认遵循用户动作 | 需求第 1 层 §2–§4，第 2 层 AC-2–AC-6、AC-10–AC-12 |
| 旧停用设置迁移与取消独立启停状态 | 需求第 0 层决策、需求第 1 层 §2，第 2 层 AC-7–AC-10 |
| 保存版本变化后的审批失效、重判和派发边界 | 需求第 1 层 §3–§4，第 2 层 AC-13–AC-18 |
| 设置审计变更前后动作且不记录正文/敏感参数 | 需求第 1 层 §2，第 2 层 AC-20 |

UI 归属卡是 I8 对既有界面改动的准入材料，不扩展产品行为。任何新增存储字段、IPC 变更、用户可见配置或外部渠道行为均须能映射到上表；无法映射的先修订需求。

## 第 2 层：现状事实卡

基线均为源码 commit `109a938404124235d632e4cdbd4f9e06eaa48728`。以下为编写方案时核对的事实；实施开工时按执行计划重新运行检索命令确认基线没有漂移。

| ID | 代码事实 | 对方案的约束 | 复核命令 |
|---|---|---|---|
| F-01 | `PolicyAction` 包含 `deny / allow / ask / auto-evaluator / confirm-every-time`；规则另有 `locked`、`humanRequired`、`answerer`。 | UI 可配置动作需映射为四个产品动作；默认 `confirm-every-time` 保留默认行为标注，不作为第五个可选动作。 | `rg -n "PolicyAction|humanRequired|locked" src/shared/confirmation/types.ts` |
| F-02 | `LANE_PROFILES` 当前桌面选项为 deny/allow/ask/auto-evaluator，IM 为 deny/allow/ask；override 校验拒绝 locked，并且 `confirm-every-time` 不在用户覆盖动作域。 | 扩大 validator 时须覆盖所有规则、所有受支持动作、跨 lane 错误输入及 IPC 主进程复核。 | `rg -n "availableActions|validateRuleOverride|rule is locked" src/shared/policy/policyPackages.ts` |
| F-03 | invocation `decide()` 与 `decideIngress()` 是不同消费者；入口规则当前只产出 allow/deny，暴露规则由工具目录/能力组装消费，不能假设它们都进入 invocation engine。 | 所有设置页展示的规则按 `when` 分类追到实际消费点。invocation 按完整命中集合裁决；ingress 的 ask 在消息进入常规处理前形成待批准对象；exposure 的 ask 在工具/能力暴露前形成待批准对象。拒绝阻止对应阶段，allow 继续对应阶段。具体批准载荷与已有消费者在 T0/T3 逐项对照，不新增通用审批框架。 | `rg -n "decideIngress|when:.*ingress|when:.*exposure|im-no-wechat-send|ingress-direct-other-deny|ingress-feishu-group-deny" src/shared/policy electron src/renderer/components/Config/ToolsSecuritySettingsTab.tsx` |
| F-04 | 默认规则动作可通过 `resolvePolicyRules` 变换；用户覆盖会移除旧 `askUnless`、`configRequires` 和 `requiresContext` 门控。 | 用户显式动作仍应替代同一规则默认门控；默认恢复应重新载入默认门控。 | `rg -n "userOverride|askUnless|configRequires|resolvePolicyRules" src/shared/policy/policyPackages.ts` |
| F-05 | 桌面覆盖存于 `policy_rules`；桌面套餐与 `disabledRuleIds` 另存 configs。IM 的套餐、覆盖、停用列表存在共享版本化快照，微信/飞书映射至 `im` revision；当前 IM runtime 在解析套餐后仍应用 snapshot 覆盖。 | 迁移须同时覆盖旧桌面与 IM 存储；微信与飞书共享迁移结果；实现需求 AC-9 时须确保非自定义套餐呈现套餐动作、仅 custom 使用逐条 override。 | `rg -n "DISABLED_POLICY_RULE_IDS|disabledRuleIds|policy_rules|policyBehaviorVersion|validatedOverrides|withOverrides" electron/confirmation/policyRulesRuntime.ts electron/confirmation/policyRuleStore.ts electron/confirmation/imPolicyStore.ts electron/ipc/policyIpc.ts` |
| F-06 | IM 快照提交使用 `expectedRevision`，并在同一 SQLite 事务递增授权 epoch、使待办失效、撤销授权及审计。 | IM 策略写入应复用该提交边界；若改变快照格式须版本化读取/迁移并测试旧版本恢复。 | `rg -n "commitImPolicySnapshot|expectedRevision|policy_authorization_epochs|invalidated" electron/confirmation/imPolicyStore.ts` |
| F-07 | 桌面安全 IPC 保存规则覆盖/启停、flush、推送授权变化和记录设置审计；规则覆盖旧路径没有 `expectedRevision`。 | 要实现界线一致性，桌面写入需要可比较的策略授权版本，并把变化通知连接到运行中 admission / prepared calls；不能只依赖 UI 刷新。 | `rg -n "security:set-rule-override|security:set-rule-enabled|publishAuthorizationChange|recordSettingsChange" electron/ipc/securityIpc.ts` |
| F-08 | Agent SDK 提供 `ExecutionAdmissionCoordinator.beginDispatch`，通过授权验证与 permit claim 建立派发线性化点；Electron 注册工具在 executor 进入前重新核验授权版本。 | 将策略 revision 纳入授权版本；在执行器调用边界检测版本漂移并退回策略 gate。不能在最终检查层重新计算风险。 | `rg -n "beginDispatch|currentAuthorizationVersion|validatePrepared|markEntered" packages/agent-sdk/src electron/tools/registeredAgentTurnTools.ts electron/runtime/invocationAssembler.ts` |
| F-09 | `ToolsSecuritySettingsTab` 对 locked 条目呈现只读；部分 locked deny 用独立 `security:set-rule-enabled`；IM 使用 `policy:write` revision 快照。 | UI 修改须在获批归属卡下统一动作编辑、reset、IM revision 冲突处理及迁移状态呈现。 | `rg -n "r.locked|toggleRuleEnabled|changeRuleAction|policy:write|rule-enabled" src/renderer/components/Config/ToolsSecuritySettingsTab.tsx` |
| F-10 | Hosted/审批 Agent 子调用可携带 `policyRuleFloor`；`intersectPolicyRulesWithFloor` 限制子调用不能比父授权更宽，装配时以父 floor 与 child rules 求交。 | 保留“子调用不扩大父授权”的既有调用范围约束；但 floor 的动作必须来自当前用户有效策略，不能在旧审批重判时把已被用户修改的默认 locked 动作再次施加。revision 变化时刷新父 floor 后重算交集。 | `rg -n "policyRuleFloor|intersectPolicyRulesWithFloor" electron/runtime/invocationAssembler.ts electron/confirmation/approvalAgent.ts src/shared/policy/policyFloor.ts electron/confirmation/policyFloor.test.ts` |
| F-11 | `validatePolicyRulesFloor` 目前以默认 locked 规则为动作宽度底线；`evaluateToolCallGate` 在 `decide()` 前对所有 lane 执行该校验，locked 规则改成 allow 会先被拒绝。 | 自定义用户链路中必须取消“默认动作不可放宽”的 floor 判定；保留规则身份/匹配条件结构校验，并为 automation 保留既有非用户可配置行为。不得以系统 invariant 登记普通 policy action。 | `rg -n "validatePolicyRulesFloor|isActionWider|底线校验" src/shared/policy/policyFloor.ts electron/confirmation/toolCallGate.ts electron/confirmation/policyFloor.test.ts` |

### 状态所有权矩阵

| 状态 | 唯一真源 / writer | 读取与生效位置 | 提交与失效边界 |
|---|---|---|---|
| 规则默认定义与匹配条件 | `DEFAULT_POLICY_RULES` 代码 | shared policy resolver / engine | 代码发布；本需求不编辑规则条件 |
| 桌面用户套餐与动作覆盖 | 安全设置 IPC；沿用 `policy_rules` 与现有套餐配置 | desktop runtime resolver | 主进程在同一 DB 事务递增 `policy_authorization_epochs.desktop` 并写配置，提交后发布变化 |
| IM 用户套餐与动作覆盖 | IM versioned policy snapshot | `policyRulesRuntime` / IM gate | `commitImPolicySnapshot` revision + epoch 单事务提交；只在 custom 解析用户动作覆盖，其他套餐遵循套餐动作 |
| legacy disabled IDs | 迁移期间只读旧存储；迁移完成后无独立 writer | migration only | 与 allow 动作覆盖同一提交；完成后旧值删除或清空并可审计 |
| 待审批/待审核授权 | 现有 confirmation / deferred stores | approval resume、recheck gate | 策略 revision 变化后撤销旧批准或审核结果并重判 |
| 执行派发 claim | Agent SDK execution admission | RegisteredTool/Executor 边界 | 最新策略版本核验和派发 claim 形成唯一线性化点 |
| 设置审计 | desktop 现有 settings security audit；IM `policy_audit_events` | 设置审计页面与查询 | 策略提交后调用现有审计记录；desktop 异步文件写入不属于策略 DB 事务，记录失败按现有审计日志错误处理单独处理，不反向更改策略保存结果；不得记录正文或敏感参数 |

桌面与 IM 两种策略存储的字段位置可以不同，但产品状态语义和调用版本契约必须一致。新增的桌面 revision 必须由主进程单一 writer 持有，不能由 renderer 自增或由正在被核验的 permit 自证。

## 第 3 层：行为模型与不变量

### 不变量

| ID | 不变量 | 需求追溯 | 主要验证 |
|---|---|---|---|
| INV-01 | 自定义套餐中设置页展示的每条适用规则（invocation、ingress、exposure）都能选所属 lane 的完整动作矩阵；`locked`、`humanRequired`、默认 `confirm-every-time` 及 floor 不缩减选项。动作在各自实际消费点生效：ingress ask 暂存消息并请求批准后才进入常规处理；exposure ask 暂不暴露对应工具/能力，批准后才暴露。 | AC-1–AC-6、AC-21–AC-22 | validator × lane × when × rule 合同；入口消息消费者与工具暴露消费者测试；批准前后对象/状态断言；IPC 接受所有适用规则覆盖 |
| INV-02 | 用户对某规则的最终动作是该规则唯一动作来源；该规则的旧 `humanRequired`、`confirm-every-time` 与快捷门控不能在动作解释后再次升级为真人批准。 | AC-2–AC-5 | 初判、缓存、自动审核与确认记忆交叉测试 |
| INV-03 | 多规则结果唯一为 deny > ask(user) > auto-evaluator > allow；排序和动作来源不改变结果。 | AC-6、AC-10–AC-12 | 规则排列全排列与组合矩阵测试 |
| INV-04 | 旧 disabled 规则迁移为与普通显式 allow 完全相同的覆盖，不携带“迁移来源优先级”。 | AC-7–AC-10 | migration fixtures + old-disable × co-match cross product |
| INV-05 | 策略 revision 变化后，尚未进入执行器的调用不使用旧批准或旧审核结果派发。 | AC-13–AC-18 | policy-write × recheck × beginDispatch barrier race tests |
| INV-06 | final-check 只核验已批准的身份、对象、授权代次、permit、执行材料和策略 revision；不重新计算业务风险。 | AC-15–AC-18 | SDK boundary tests：revision drift → not-dispatched；稳定 revision → executor can enter |
| INV-07 | 策略内容与其 revision/epoch 在持久化提交中一致；只有该提交成功才报告策略保存成功。策略审计沿用现有审计记录机制，在正常成功路径记录变更元数据；事务外日志写入失败不得把已提交策略谎报为未保存，也不得包含敏感负载。 | AC-13–AC-20 | transaction rollback、revision conflict、审计成功/失败反馈及脱敏测试 |
| INV-08 | 用户可见状态和实际 runtime snapshot 同源；成功反馈只在持久化成功后出现。 | AC-1、AC-7–AC-9、AC-19 | renderer + IPC integration |
| INV-09 | 日志记录动作变更元数据，不包含消息正文、token、secret、调用参数明文。 | AC-20 | audit serialization/redaction tests |
| INV-10 | 嵌套审批/工具调用不得扩大其父调用当前有效的授权范围；父策略 revision 变化后，子调用 floor 必须由新策略重建，不能沿用会覆盖新用户选择的旧规则动作。 | 需求第 1 层 §3–§4 | parent/child floor intersection + policy-change recheck tests |

### 多规则裁决契约

1. invocation 裁决输入是同一调用所有条件已满足且事实匹配成功的规则动作集合。入口与暴露不是 invocation 的附属分支，分别在事件进入处理链和工具/能力发布前消费。Ingress `ask` 暂存该消息并请求批准，批准后才进入常规处理；exposure `ask` 保持目标工具/能力未暴露，批准后按原机制暴露。Deny 阻止对应阶段，allow 继续对应阶段；IM 不提供自动审核动作。此语义由项目负责人于 2026-10-22 确认并写入需求 AC-21/AC-22。T0 列全规则 ID、when、lane、消费者、动作域和测试落点。
2. 对所有用户可配置规则，gate 不得在策略动作消费前按默认 locked action width 二次拒绝；规则身份与 `when/match` 完整性仍需校验，automation 保持当前用户不可配置边界。
3. invocation 先收集所有命中动作，再依 INV-03 选唯一结果；不得先遇到 allow/auto 就提前返回而漏掉更高优先级规则。
4. `confirm-every-time` 默认动作在未覆盖时映射为人工批准，并带逐次打断说明；显式用户动作会替代该规则默认语义。
5. `humanRequired` 只在无用户覆盖时表达默认人工批准；覆盖后按有效动作，不再作为规则外 veto。真正执行不变量与策略决定分开；嵌套 `policyRuleFloor` 使用父调用当前有效策略。
6. 自动审核只用于桌面 invocation；在 invocation 中仅当没有 deny/ask 时运行，不越过更高优先级动作。
7. invocation 决策 trace 记录参与规则、来源、有效动作与胜出理由；ingress/exposure trace 记录对应阶段对象、动作、批准状态与继续/阻止结果。

### 策略版本与派发线性化

1. 每个会改变生效规则的提交都递增持久化授权 epoch：desktop 使用 `policy_authorization_epochs.desktop`，wechat/feishu 使用 `policy_authorization_epochs.im` 与 snapshot revision。桌面当前生效授权版本还可包含规则快照指纹，但 epoch 防止 A→B→A 后旧批准因指纹相同被复活。
2. 进入审批时绑定调用事实、审批对象和策略 revision。revision 改变时旧审批请求/批准结果/自动审核结果失效，调用回到 gate 按最新规则重新判定。
3. 执行器开始处理是唯一用户可见生效边界。Prepared authorization 的策略 revision 与当前 revision 不一致时，不得 `markEntered` 或调用 executor；复核期间需重建由父调用传递的 `policyRuleFloor`，保证嵌套交集使用最新用户动作。
4. `claim` 不等于执行器已开始；当前 `onDispatchClaimed` 与 executor invocation 之间的异步窗口必须由 T6 的实施选择明确覆盖：窗口内新策略提交成功时，再次读取当前 revision 并拒绝旧 executor 进入，交回 T5 的 gate/recheck；若 executor 已同步进入调用边界后才提交，则不追溯撤销。实现沿用现有版本核验和失效通知即可，不预设锁、服务或强制原子事务。T6 用屏障测试分别验证“claim 后暂停→保存→恢复”和“executor 进入后保存”两种顺序，断言旧 executor 零调用或已开始不伪称撤销。
5. final-check 不调用 `decide()`，也不读取策略内容重新算风险；检测 revision 漂移只返回稳定的 authorization-stale 结果，由 gate 重新做 facts/policy 流程。

## 第 4 层：实现契约、阶段与回退

### 契约落点

| 契约 | 目标责任位置 | 错误/结果要求 |
|---|---|---|
| UI 动作到内部动作映射 | `policyPackages.ts` 的 lane action domain 与 UI view model | 当前链路不支持的枚举、未知 ruleId、非法 lane 返回稳定 validation error；支持动作不受 locked 拒绝 |
| 自定义动作解析 | `resolvePolicyRules` + `policyRulesRuntime` | 用户覆盖移除同规则旧条件门控；恢复默认还原规则定义和默认说明 |
| 多规则结果 | `policyEngine.decide` 及 trace | 单一 decision 与胜出 rule；deny/ask/auto/allow 顺序固定；不依赖数组顺序。用户链路不做默认 locked action floor veto；嵌套 floor 使用父调用当前有效用户策略，不复用过期默认动作 |
| Desktop 保存 | `securityIpc` + `policy_authorization_epochs.desktop` | 套餐、rule override/reset 校验 expectedRevision；同一 SQLite 事务写规则/套餐与 epoch；提交后发布变化通知并调用现有设置审计记录。策略提交是保存成功依据；异步文件审计属于事务外记录，失败不得反向报告策略未保存 |
| IM 保存 | `policyIpc` + `commitImPolicySnapshot` | 延续 expectedRevision conflict；快照、epoch、待审批失效、审计原子更新 |
| disabled migration | desktop legacy config + IM snapshot migration | 旧 disabled IDs 对应规则转为 `allow` 覆盖；该 ID 的旧 disabled 状态优先转换为 allow（当前有效旧 UI 不允许此规则另存动作覆盖）；其他规则覆盖及套餐保持不变；重复运行幂等；迁移失败时旧状态仍可恢复 |
| 非自定义套餐解析 | `policyRulesRuntime` | custom 套餐使用用户逐条动作覆盖；strict/standard/loose 只使用套餐动作，覆盖保留但暂不生效，切回 custom 后恢复 |
| 调用 revision binding | policy runtime → approval/recheck → execution admission | stale revision 不派发；更新策略后重新走完整 gate；final-check 不做业务风险判定 |
| 安全设置界面 | `ToolsSecuritySettingsTab`，受 D-UI 审批约束 | 写入成功再展示新动作；冲突刷新 snapshot；reset 只改目标规则；IM 显示共享域 |
| 审计 | desktop 现有 settings security audit；IM `policy_audit_events` | 正常写入记录 before/after action、lane/domain、revision、timestamp、actor；不含正文/调用输入。Desktop DB commit 与异步文件 append 不承诺同一事务；保存反馈只反映策略持久化结果，审计失败沿用现有日志错误处理并单独记录/诊断 |

### 分阶段方案

| 阶段 | 交付边界与输入 | 产出与出口证据 | 回退实体 |
|---|---|---|---|
| Phase 0 基线与契约核对 | 输入：需求 AC-1–22、源码基线；不改运行代码。逐行核对设置页全部规则种类（invocation/ingress/exposure）、三个 lane 的动作矩阵及消费点、disabled 数据、全部批准与派发 caller。 | F 卡校准、旧数据样例、界面批准及视觉基线状态、规则 ID×when×lane×consumer×action×测试矩阵、API/错误矩阵；所有展示规则均有消费语义。 | 仅文档，无运行数据变化。 |
| Phase 1 动作可配置与策略消费 | 输入：Phase 0 全量规则消费矩阵。开放各 when/lane 的动作 validator/resolve；invocation 统一多规则裁决；ingress/exposure ask 接到各自批准前置点；保留 automation 原约束及嵌套授权交集；暂保留旧 disabled 与旧 toggle API 兼容。 | INV-01–04、INV-10；每类 when 至少一个真实消费者测试，且每条展示规则映射到对应合同，包含需求 AC-21/AC-22。 | 回退 Phase 1 代码；不触碰旧 disabled 数据。 |
| Phase 2 规则存储与旧停用迁移 | 输入：Phase 1 action domain。Desktop 与 IM API 支持自定义 override/reset；迁移 disabled IDs 为普通 allow；非 custom 忽略覆盖。新 rule-enabled API 暂不删除：保留短期兼容适配，将旧 disabled 写入映射为 allow override、旧 enable 写入映射为恢复默认；runtime 不再读取独立 disabled 状态。 | migration fixtures、重复启动幂等、事务失败/冲突、旧 API 兼容 caller 测试；仅 custom 读取逐条覆盖。T4 可在 T7 之前独立编译验收。 | 使用各域迁移前快照回滚；旧 API 兼容适配可随 T4 一并回退，不保留双重运行时状态。 |
| Phase 3 版本化失效与派发边界 | 输入：Phase 2 revision-aware writes。覆盖 desktop Hosted SDK、其他 RegisteredTool、IM/deferred 调用。说明当前策略变化通知由谁驱动原调用重入 gate，及如何替换旧等待审批；T6 单独补 claim→executor 窗口处理。 | INV-05–07；旧审批失效、无审批后继续、新审批重发、迟到旧批准拒绝的正常运行集成测试；dispatch 屏障测试。 | 回退实体为策略快照/授权 epoch 与 pending authorization；沿用现有调用取消/恢复语义，不新增本期未要求的持久化恢复队列。 |
| Phase 4 安全策略 UI | 前置：D-UI 批准、Phase 1 action contract、Phase 2 新写入契约完成。改造既有页面控件并迁移 renderer 到新 action API；在此阶段验收通过前保留旧 API 兼容适配。 | AC-1、AC-7–AC-9、AC-19、AC-21–AC-22；renderer + IPC tests、i18n/typecheck；本机自动布局检查与真实窗口证据分开登记。 | 回退 UI/i18n 文件；T4 兼容 API 保持可用，用户动作不丢失。 |
| Phase 5 兼容接口收尾与集成关闭 | 输入：Phase 1–4 均已通过；删除旧 rule-enabled API/handler/类型和兼容代码；完成 AC/INV 跨域矩阵、回滚演练、安全审查。 | 新 UI 不再引用旧通道的静态搜索与类型检查；AC-1–AC-22 测试、审计与迁移证据。 | 删除前可恢复 T4/T7 已提交版本；若删除后回退，整体回退到包含兼容 shim 的一致版本。 |

### 失败与回退规则

- 策略内容与 revision 的事务写入失败：不报告成功，运行时按最后已提交 revision 决策。事务外审计文件写入失败不改变已提交策略及保存结果，按现有审计日志错误处理路径记录/诊断。
- expected revision 冲突：拒绝本次写入，返回当前 revision，由设置页重新读取后再写。
- 迁移中遇到未知 ruleId、非法 snapshot 或数据库损坏：事务整体回滚，保留旧 disabled 状态，不清理 legacy source；记录脱敏迁移失败类别，不尝试猜测动作。若 disabled ID 对应未来/未知规则，停止该迁移批次并显式诊断，不得静默删 ID；其他已知项仍须由事务策略统一提交或整体回滚。
- 策略版本无法读取、授权版本 unavailable 或 recheck 无法完成：不得沿用旧许可派发；按现有 fail-closed/stale authorization 路径收束并报告。
- 版本变化取消待审批时，旧请求必须无法再批准或 resume；重复/迟到批准应返回稳定的 stale/invalidated 结果，且 executor 零调用。
- 回滚实现版本不能只切回旧代码：先停止写入，处理/撤销所有新 revision 下 pending 授权；必要时恢复数据库备份/历史快照；复核后才允许旧代码启动。

### 排除方案

| 方案 | 结论 | 原因 |
|---|---|---|
| 只删除 UI 的锁图标/禁用属性 | 排除 | 主进程 validator、policy engine floor、旧停用存储仍能拒绝或覆盖用户选择，AC 不成立。 |
| 为 locked deny 继续保留独立启停开关 | 排除 | 会保留第二种动作控制，且无法满足全动作可配置和恢复默认语义。 |
| 旧停用规则继续存储为 disabled 状态但 UI 隐藏 | 排除 | 规则仍不参与决策，直接执行动作与存储真相分裂。 |
| 按规则数组顺序遇到第一个动作即返回 | 排除 | 用户改排序/默认规则位置会改变优先级，无法满足 deny/ask 优先于 allow。 |
| 只在审批完成时核对 revision | 排除 | 审批后到 executor dispatch 之间仍存在策略变更窗口；不满足 AC-15。 |
| final-check 重新执行业务策略判断 | 排除 | 混淆 facts/policy/final-check 责任；容易二次计算风险或造成决策审计不一致。 |

## 验收映射

需求 AC 是唯一产品验收真源；下表说明主验证面，不替代执行计划的任务清单。

| 需求 AC | 主要验证面 | 计划阶段 |
|---|---|---|
| AC-1 | lane×rules×actions 可编辑矩阵及 validator/renderer | Phase 1、4 |
| AC-2–AC-6 | 自定义覆盖规则 default/locked/humanRequired/confirmEveryTime 行为 | Phase 1、5 |
| AC-7–AC-10 | Desktop/IM disabled migration、reset、package round trip、多规则 deny/ask 优先 | Phase 2、5 |
| AC-11–AC-12 | 同时命中动作集合的裁决矩阵 | Phase 1、5 |
| AC-13–AC-14 | 等待人工/自动审核时旧结果失效并重判 | Phase 3、5 |
| AC-15–AC-18 | 已批准/已核验、执行器开始前后的 revision race 与不确定结果 | Phase 3、5 |
| AC-19 | 写入失败、冲突、renderer 未误报成功 | Phase 2、4、5 |
| AC-20 | before/after/revision audit，无敏感负载 | Phase 2、5 |
| AC-21–AC-22 | ingress 消息批准后处理；exposure 对象批准后暴露 | Phase 1、5 |

## 当前环境与外部验收边界

| 可在当前环境完成的源码验证 | 需真实桌面 / 外部渠道才可完成的验收 |
|---|---|
| Vitest 单测和 integration harness：规则矩阵、迁移、expectedRevision、recheck/dispatch barrier、IPC/renderer。 | Electron 桌面设置中切换动作、立即发起调用、观察等待中审批的取消与重发。 |
| `npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run build:electron:incremental`。 | 真实飞书和微信 owner 账号下共享 IM 策略、异步待办撤销、迟到审批回复及工具不派发。 |
| `npm run i18n:check`、安全边界定向测试、`npm run check:system-invariant-registry`（若本次调整 registry/安全登记相关）。 | 发布包/存量用户真实旧 disabled 数据升级、应用重启与回退演练；需要备份副本，不能以单测替代。 |
| 本地 transaction rollback、并发 barrier 和 executor spy。 | macOS/Windows 两端安全设置布局与 Electron 内部 node:sqlite 真机启动检查（若发布平台覆盖）。 |

外部验收缺失不得阻塞源码实现或源码关闭，但不能宣称真实渠道/存量升级/跨平台发布验收已完成。启用/发布门槛必须单独记录这些外部证据。

## 实施门禁

1. Phase 0 完成完整规则/写入者/调用者盘点；D-UI 与 D-INGRESS 均已批准，Phase 1 覆盖所有展示规则动作。
2. 每一安全逻辑阶段写明 `facts / policy / final-check / invariant` 归属。仅改变策略决定的逻辑归 `policy`；最终检查只核验批准对象与 revision。确需新增不可配置 invariant 时先登记 owner、依据、范围、审计与测试，不得把 locked 策略规则登记成 invariant 绕过用户配置。
3. 每阶段按仓库纪律先跑合并的定向测试；阶段收尾才执行 `npm test`，提交该阶段后进入下一阶段。不得逐步循环跑全量测试。
4. 发布前须更新本主题 README 状态与 history；本方案在实现期间不维护任务勾选状态，任务进度只在配套执行计划维护。
