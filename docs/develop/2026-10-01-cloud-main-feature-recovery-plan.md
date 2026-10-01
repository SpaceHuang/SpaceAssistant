# 云端 main 功能恢复计划（8dad0284 → 当前 main）

日期：2026-10-01
当前基线：`main` / `origin/main` `4e3d44fdd5d5493e3debc3b3e527ac6c32862aed`
功能来源：原云端 tip `8dad02848c44692bafa7f61271bc6e3d6f406216`
来源可达性：`8dad0284` 是合并提交 `5debe7919d57dbf26835bbf5b4b715ff083d889c` 的第二父提交，仍在当前 `main` 历史中；来源提交和对象可用于对照。
工作区注意：计划编写时存在三处未提交修改：`docs/develop/interface/README.md`、`docs/develop/interface/model-provider.md`、`docs/develop/interface/turn-loop.md`。实施时必须保留，不纳入功能恢复提交。

## 1. 目标与范围

从来源树 `8dad0284` 相对当前基线 `4e3d44f` 的差异中，恢复被分叉收敛时排除的产品能力。按功能依赖拆分，逐项用 TDD 移植、验证和提交。来源树只作为功能和行为证据；不直接把 46 个提交整体合并或 cherry-pick。

当前 main 已保留并继续维护 agent-sdk/Hosted Runtime、turn-scoped cancellation、canonical History、现有 Token 用量统计骨架和版本 `0.2.2`。恢复实现必须接入这些当前边界，不回退到旧 `toolChatLoop`、旧 `agent-core` 包或旧数据库布局。

本计划覆盖三组从当前文件树中排除的功能：

1. `run_script` 路径提取、规则档位、审批解释和脚本信任记忆。
2. Token 用量内容归因，包括按内容来源拆分的输入估算、输出类型归因、查询和界面。
3. ripgrep 不可用时的安全 JavaScript grep 降级，以及开发环境 ripgrep 准备和可理解的不可用诊断。

实施遵守 TDD：每个未覆盖的契约先加测试并在当前基线上运行，记录真实红灯后再改生产代码。若来源行为在当前基线已经等价实现且测试已通过，则记录为“已存在”，不为了制造红灯而改代码；只对缺失行为补测试和最小实现。

取消链路和 `0.2.2` release 元数据已在基线中，不重复恢复。历史文档、评审稿和知识文档不作为产品功能自动导入；只纳入实现所需且仍适用的需求/设计依据。任何额外功能、设置页或数据字段都必须能对应到来源树的明确能力和验收要求。

## 2. 来源差异与恢复判定

以提交树对比而不是当前工作区文件状态为准：

```bash
git diff --name-status 4e3d44fdd5d5493e3debc3b3e527ac6c32862aed 8dad02848c44692bafa7f61271bc6e3d6f406216
git log --reverse --format='%H%x09%P%x09%s' 2c2611c6..8dad0284
```

逐个来源提交记录完整 SHA、父提交、主题、变更文件、对应功能组、拟恢复/适配/保留/排除结论及验收测试。相对基线的每个文件都必须归入一项；merge commit 同时记录第一父 tree diff 与第二父分支内容，避免仅按提交主题推断功能。

| 功能组 | 主要来源提交 | 当前恢复决策 | 当前架构适配边界 |
|---|---|---|---|
| 脚本路径事实提取 | `2af615d8`、`3402a671`、`4f710b67`、`3b46cda2`、`2d483650`、`c98dd85f`、`fd583b72`、`75050bf7`、`8129f2a5`、`ac97b559` | 恢复，经安全回归后纳入 | 使用当前 confirmation extractor、execution permit 和 tool gate；不恢复旧 tool loop。 |
| 规则档位与按规则覆盖 | `01428d7b`、`b6c83c25`、`c96acc2e`、`419ede3a` | 恢复安全边界清楚的档位/覆盖能力；规则语义逐条验收 | 保持默认拒绝、路径授权、审批和撤权不变量；不照搬放宽后的默认策略。 |
| 审批原因与脚本信任记忆 | `df55acd0`、`7f745500`、`3402a671`、`ac97b559` | 恢复经审查的可解释反馈与脚本指纹信任 | 信任必须绑定来源定义的会话/脚本身份，审批后内容变化必须失效；不得绕过当前 permit/revocation。 |
| Token 内容归因 | `fdbeb9a4`、`af39ba67`、`9cf59fc9`、`6234f8eb`、`dab9fbe9`、`ff6a5cde`、`5d39d28d`、`7c609287`、`773e11d7` | 恢复，经 schema、SDK usage 和隐私审查后纳入 | 将旧循环采集接入当前 SDK turn/step usage recorder；遵守当前 schema v27、History、去重和取消语义。 |
| grep fallback、诊断与 dev ripgrep 准备 | `e9d58480`、`7657c546`、`877900c1`、`7a82e9f2`、`7e520a73`、`1d4cab51`、`6fad2cb6` | 恢复 fallback/诊断/dev 支持；已保留的取消实现只做兼容验证 | fallback 只处理 ripgrep 不可用；保留当前授权范围、敏感路径过滤、AbortSignal 和子进程终止契约。 |
| 取消、日志清理、release | `4bb8c0cb`、`440404c6`、`7de673f3`、`81a797ea`、`a06c966c`、`98857144`、`ae2bc6be` | 已在当前基线，验证后不重复移植 | 仅在回归测试证明缺失时修复当前实现；不覆盖 SDK 架构。 |
| `8dad0284` 的 loose policy 登记 | `8dad0284` | 有条件评审；默认不带入 broad `allow` 结果 | 必须通过阶段 3 的逐规则安全证明；不得为让静态测试通过而放宽未知脚本/未建模调用的执行权限。 |

表中来源提交是定位线索，不代替逐提交 tree 审核。若完整清单发现其他产品行为，先追加功能组和可验证验收项，再开始相应实现；未分类差异不得进入提交。

## 3. 全局不变量

1. 当前 `agent-sdk`、Hosted Runtime、TurnRuntime 和 provider 边界保持为执行主路径；不恢复或平行维护旧 `toolChatLoop`。
2. 用户拒绝、撤权、取消、超时和 provider 失败仍按当前执行许可与 History 终态契约结算；新功能不得为方便实现而旁路这些边界。
3. 脚本分析无法理解、解析失败或执行对象变化时不扩大权限。信任记录失效时回到正常审批，不自动放行。
4. 精确 usage 仅来自 provider 实际用量事实；估算归因另行标记 estimator/version，不伪造 usage、不与协议回报混算、不折算金额。
5. grep fallback 不把取消、超时、权限拒绝、文件身份变化或真实搜索错误当成 ripgrep 不可用；不得绕过读许可、敏感路径排除或搜索范围边界。
6. 保留当前 SDK 和产品依赖闭包；源树 lockfile/package scripts 只能按功能需要逐项适配，不整体覆盖。
7. 所有改动单独分组提交。暂存时按文件/补丁精确选择，不用 `git add -A`；不改写或提交计划编写前已有的三处接口文档修改。

## 4. 实施流程与完成判定

### 阶段 0：冻结基线、工作区和来源清单

1. 记录 `git status --short --branch`、当前 HEAD、`origin/main`、来源 SHA、来源所在 merge commit/tree、`git rev-list --left-right --count origin/main...main`。
2. 记录三处既有接口文档修改的 diff 摘要和 blob 基线，实施前后保持逐字节一致；不得 stash、restore、reset 或暂存这些文件。
3. 生成来源提交清单及 `4e3d44f..8dad0284` 文件差异清单；对每一条 product-code diff 指派本计划功能组和恢复结论。
4. 对比当前架构入口、表结构版本、usage 记录形状、审批权限模型和 grep 执行入口；记录每组需适配的当前 owner 和测试文件。

**验收：** 来源 SHA 可读且是 `5debe791` 的第二父；完整来源提交和文件清单归档到实施记录；所有差异有唯一归属；三处既有文档 diff 有基线；本阶段不改生产代码。

### 阶段 1：脚本路径事实提取（先锁定安全契约）

1. 先将来源 `scriptPathFacts` 的探针转为当前 extractor 的回归测试，覆盖来源中已修复的赋值、字典/解构、嵌套调用、条件、lambda 默认值、walrus、decode/global 透传等脚本形式。
2. 加入反向安全用例：动态目标、歧义别名、未建模调用、解析错误、跨工作区路径、符号链接/替换文件不能生成比当前更宽的 permit。
3. 在当前 [`electron/confirmation/extractors/scriptPathFacts.test.ts`](/Users/space/Documents/Develop/SpaceAssistant/electron/confirmation/extractors/scriptPathFacts.test.ts) 先运行红灯，记录实际失败断言；再移植最小 parser/IR 改动。
4. 复用当前 `buildReadExecutionPermit`、写许可和执行前身份复验；禁止仅因提取器“猜到路径”就跳过现有授权流程。

**验收：** 测试逐项证明真实目标集合与解析置信度；有效脚本的原假阳性用例从红转绿；所有歧义/恶意用例继续 fail closed；`scriptPathFacts.test.ts`、`readPermitExecutor.test.ts`、`toolCallGate.test.ts` 通过；没有旧 `toolChatLoop` 接线。

### 阶段 2：安全档位和按规则覆盖

1. 在 policy package/engine 测试中先固定每个档位对每个 ruleId 的有效动作表，包括 allow、ask、deny 的优先级和显式覆盖顺序。
2. 测试未知脚本、未建模调用、危险副作用、目标身份变化、跨会话信任、invalid override 等反例；“loose”也不得越过必须确认/拒绝的安全底线。
3. 红灯通过后移植当前 `ruleActionOverrides` 类型、解析/校验和 policy evaluator 行为；只迁移确有当前设置入口的配置数据，不复制云端 `toolChatLoop` API。
4. 恢复桌面安全设置中的规则档位和规则覆盖控件，补齐中英文资源、加载/保存失败处理和渲染状态测试。
5. 单独检查 `8dad0284` 对 `script-unmodeled-path-ask` 的 loose allow：测试必须证明其精确生效范围不会覆盖其他未建模规则、默认档位或当前 permit floor。若无法证明，保留该规则为 ask/deny，并在实施记录中明确拒绝恢复该一项策略放宽；不得把“CI 通过”当作放宽理由。

**验收：** `policyPackages.ruleOverrides.test.ts`、`policyEngine.test.ts`、`policyFloor.test.ts` 和 `ToolsSecuritySettingsTab.test.tsx` 中每个档位/覆盖分支都有正反断言；缺省设置不意外放宽；用户可保存再读取且不丢弃无关配置；安全 floor 测试全过；unsafe loose allow 有单独明确结论。

### 阶段 3：审批解释与脚本指纹信任

1. 先为审批原因展示增加契约测试：命中具体 policy rule、因分析不确定要求人工确认、目标变化导致重新确认等情形都有稳定、脱敏的解释字段。
2. 先测试 trust 生命周期：只由用户显式批准后创建；身份包含来源定义的脚本指纹/作用域；脚本字节、目标或规则身份变化使 trust 失效；取消/拒绝不创建 trust；撤权立即失效；会话间隔离。
3. 红灯后移植当前 confirmation persistence/decision cache 边界；不得持久化脚本文本、敏感参数或 prompt；用户确认卡片文案必须经过 i18n。
4. 执行许可必须在调用前重新核对当前事实、授权版本和脚本内容摘要。恢复范围沿用云端原有模型：精确脚本内容摘要绑定当前会话；不额外引入云端没有的分析器版本字段。未知原因不能明确归类、分析结果缺失或动态执行时保持 fail-closed，不提供脚本内容记忆。

**验收：** `approvalAgent.test.ts`、`toolCallGate.test.ts`、`persistentConfirmationCommit.test.ts`、`ScriptConfirmCard.test.tsx` 及新增信任存储测试通过；脚本变化、规则变化、会话切换和 revoke 各有独立断言；审计日志不含脚本正文或凭据；信任不能授权新路径/新副作用。

### 阶段 4：归因纯逻辑和可得性契约

1. 以来源需求（Git 对象 `8dad0284` 中的 `docs/requirement/agent-token-usage-content-attribution-requirement.md`）与实现 `usageAttribution.ts` 为依据，在当前 `src/shared` 先新增纯函数测试。
2. 固定输入归因块、固定/增量成本、输出 thinking/body/tool-args 估算、工具声明/工具返回归因、估算版本标记和来源缺失时的 unknown/omitted 表示。
3. 固定可守恒的归一化公式与舍入容差；精确 provider usage 与估算来源拆分分栏展示，不把估算补写进精确 usage，不作金额换算。
4. 用本地真实序列化样本验证归因输入来自已存在的当前 SDK/History/SessionEvent 数据，不读取 prompt 或凭据日志作为“事实源”。
5. 将混合数据区间覆盖率定义为纯逻辑契约：筛选条件（时间、会话、模型、应用版本等）与总览 KPI 完全相同；分母是筛选区间全部 `usage_step_facts` 的精确归一化输入量，分子是同区间内归因列非 `NULL` 且 estimator version 与本次展示版本一致的精确输入量；未归因量为分母减分子。没有精确输入量的行不得以 0 补入分子或分母。
6. estimator version 不同的归因块不得合并。查询按版本分组或要求显式选择版本；同一报表中若存在多个版本，分别显示各版本可归因子集及覆盖率，不能把版本混合后的构成和声称与总量守恒。

**验收：** `src/shared/usageAttribution.test.ts` 覆盖来源需求 §10 中每个指标与边界；覆盖率纯逻辑/查询 fixture 分别覆盖 0%、部分覆盖、100%、历史归因列 `NULL`、当前 estimator version 不匹配及多个 estimator version 并存；使用同一筛选条件时归因分母与总览精确输入 KPI 完全一致，分子只计入可归因子集，未归因量等于分母减分子；版本混合时不得跨版本求和；固定种子样本结果稳定；各估算块合计仅与对应可归因子集在定义容差内；无来源时不虚构 0 或 token 记录；`estimatorVersion` 必须和估值一同保留。

### 阶段 5：当前 SDK usage 采集和 SQLite 迁移

1. 盘点当前 schema v27 中 `usage_stats`、step/turn facts、History 与 recorder 的实际字段/事务；输出 v27 → 下一版本增量迁移草案，不能复用云端 schema v19 的版本号或覆盖 migration 链。
2. 新增数据库迁移测试：空库、v27 fixture、重复打开、迁移中断回滚、旧值保留、删除会话的级联/保留策略。
3. 在 `agentSdkUsageRecorder`/`invocationAssembler` 当前 step/turn usage owner 加回归测试，要求每次真实 provider usage 最多记一次；取消前无 usage 不写零值；重复投影不重复入账；失败/取消维持当前终态。
4. TDD 接入 attribution snapshot/message skeleton 和 tool result 关联字段。扩展采用可空/版本化字段，不新增 SessionEvent 类型；写入与 turn commit 应遵守现有事务/提交 owner，不允许半回合被当作已提交归因。
5. 只为当前 runtime 可提供的来源采集字段；对需求承认原理上不可得的部分明确显示估算/不可知，不以启发式伪装成精确值。
6. 为桌面、远程 IM、Butler 三条入口各建一条可在本机执行的集成测试：从各自真实的当前入口装配 invocation/ports，经当前 SDK usage recorder 写入测试 SQLite；不得只 mock recorder 或只断言传给 `runToolChatSession` 的参数。桌面使用 `electron/claudeStreamHandlers.ts` 的入口，远程使用 `electron/remote/imRemoteAgent.ts` 的入口（IM 收发依赖可用适配器替身，生产装配和 SQLite writer 必须真实），Butler 使用 `electron/butler/butlerInvoker.ts` 的 `lane: 'automation'` 入口。
7. 每条链路测试完成后直接查询 SQLite：至少一条对应 `usage_step_facts` 行的输入归因列非 `NULL`，且同一 turn 的 `usage_turn_facts` 中 `tools`、`toolSource`、`toolResults` 列非 `NULL`；断言行的 `session_id` / `turn_id` / `step_id` 彼此关联正确、无重复或孤儿事实。远程链路必须以 SQLite 为证据，不能以 `events.jsonl` 或台账事件替代。

**验收：** 新 migration 从 v27 可升级到新版本且升级幂等；旧数据库的已有 turn/usage 完整不变；新增字段可空且不会改变历史报表；`agentSdkUsageRecorder.test.ts`、`usageStatsRecorder.test.ts`、`usageStatsFacts.test.ts`、三条 lane 的 SQLite 集成测试及 migration 测试通过；无 usage 的 abort/失败断言为无记录，实际 usage 不多不少一条；三条 lane 均满足上述 SQLite 归因列和工具维度列断言。另须完成来源需求 AT17 的真实远程收发验收：使用真实飞书或微信账号发起远程回合，确认回合完成后直接查询该运行所用 SQLite 数据库，验证 `usage_step_facts` 输入归因列及对应 `usage_turn_facts` 工具维度列非 `NULL`，并核对 session/turn 关联。记录渠道、日期、脱敏后的 session/turn 标识、查询结果和验收人；不得以本机适配器替身测试或 `events.jsonl` 代替。若真实环境暂不可用，将 AT17 标记为 `待完成`，阶段 5 不得标记完成，且不得报告归因恢复已完整验收。

### 阶段 6：归因查询、API 和界面

1. 在 `usageStatsAttributionQueries.test.ts` 先为跨会话/单会话查询、时间范围、模型、应用版本、删除会话及无归因旧记录建立红灯。
2. 增加只读聚合查询，明确估算字段与精确 usage 的 join key；校验 session/turn ownership，不以共享 requestId 作为唯一归因身份。
3. 同一查询返回归因覆盖率、可归因输入量、未归因输入量及按 estimator version 分组的归因构成；所有字段复用总览筛选条件。旧行或 estimator version 不匹配的行计入未归因缺口，不补 0；存在多个版本时不得跨版本混算。
4. 经 shared API/preload 暴露最小读取接口；类型测试锁定跨进程契约，不能通过 renderer 直接访问 SQLite。
5. 恢复 UsageStats 构成视图和 ContextUsageRing 构成 tooltip；图表、洞察卡片、表格均显示精确/估算标记和 estimator version；覆盖率低于 100% 时明确显示覆盖率及“另有 X tokens 无可归因数据”；覆盖率为 0% 时显示来源要求的空态和原因，不显示构成图；中英文资源齐全；不新增需求之外的设置入口。
6. 从 fake query 开始测空态/旧记录/混合版本，再接真实 SQLite query；UI 不应在归因不可得时显示伪精确值或误导性 0。

**验收：** 查询、IPC/preload、type test、UsageStats drawer 和 ContextUsageRing 聚焦测试全过；查询/UI 集成测试覆盖 0%、部分覆盖、100% 和 estimator version 混合，并验证 KPI、归因分子、未归因量及筛选条件一致；跨会话相同 requestId 不串数据；旧安装数据库打开页面不崩溃；中英文严格 i18n 门禁通过；成本视图不含金额；bundle 中存在对应资源和视图组件。

### 阶段 7：grep JavaScript fallback、诊断与开发准备

1. 扩展当前 `grepExecutor` 行为测试，先证明“ripgrep unavailable 时失败”这一红灯，再锁定只在 unavailable 时切换 JS fallback。
2. 覆盖 fallback 的文本/正则、多行、大小写、glob、hidden、输出模式、context/head limit、目录/单文件目标、超大文件和编码输入。
3. 覆盖敏感路径排除、显式路径许可、workdir 边界、符号链接/文件身份变化；fallback 结果必须与当前 permit 事实兼容。
4. 对 abort/timeout/权限拒绝/身份变化/真实 ripgrep exit error 逐项断言：这些路径不得自动降级成 JS 搜索。
5. 仅在 fallback 测试通过后，恢复开发态 ripgrep 准备脚本和 unavailable 文案；目标平台下载参数、校验和、文件权限及失败提示各自有脚本测试。不替换现有 `pack:mac` / `pack:win` prepare 行为。

**验收：** `grepFallback.test.ts`、`grepScopeExecutor.test.ts`、`builtinExecutors.pathAlias.test.ts` 与新增当前 Hosted executor 集成测试全过；安全范围正反用例齐全；fallback 不生成虚假成功结果，取消/超时测试不会触发 fallback；dev prepare 对目标平台产出可执行且校验正确的二进制；ripgrep 有效时原路径行为不变。

### 阶段 8：全量兼容、打包与恢复闭环

按顺序执行：

```bash
npx vitest run electron/confirmation/extractors/scriptPathFacts.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/persistentConfirmationCommit.test.ts
npx vitest run src/shared/policy/policyPackages.recovery.test.ts src/shared/policy/policyPackages.test.ts src/shared/policy/policyPackages.scope.test.ts src/shared/policy/policyEngine.test.ts electron/confirmation/policyFloor.test.ts electron/confirmation/approvalAgent.test.ts src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx src/renderer/components/Chat/ScriptConfirmCard.test.tsx
npx vitest run src/shared/usageAttribution.test.ts electron/runtime/agentSdkUsageRecorder.test.ts electron/usageStats/usageStatsRecorder.test.ts electron/usageStats/usageStatsAttributionQueries.test.ts electron/claudeStreamHandlers.hostedIntegration.test.ts electron/butler/butlerInvoker.test.ts electron/remote/imRemoteAgent.usageAttribution.integration.test.ts electron/database/usageStatsFacts.test.ts
npx vitest run electron/tools/grepFallback.test.ts electron/tools/grepScopeExecutor.test.ts electron/tools/builtinExecutors.pathAlias.test.ts
npm run typecheck:shared
npm run typecheck:renderer
npm run typecheck:agent-sdk
npm run typecheck:agent-provider-pi-ai
npm run check:agent-sdk
npm run i18n:check:strict
npm test
npm run build
npm run pack:mac
```

当前 checkout 的三个 lane SQLite 集成测试分散在桌面 `electron/claudeStreamHandlers.hostedIntegration.test.ts`、Butler `electron/butler/butlerInvoker.test.ts` 与远程 `electron/remote/imRemoteAgent.usageAttribution.integration.test.ts`；因此阶段 8 第三条测试命令使用这三个实际文件，不引用不存在的汇总测试路径。grep unavailable fallback 的 Hosted gate 集成位于 `electron/confirmation/readReadIntegration.test.ts`。

### 阶段 7：grep fallback、诊断与开发准备（本机完成）

日期：2026-10-01。当前 checkout 已有 `grepFallbackJs`、scope planner、ripgrep manifest/download 校验和 `prepare:rg`；缺少的是 production grep executor 在不可用状态的路由。新增执行器测试先把原 unavailable 失败契约改为 walk 成功并观察红灯，再仅对 resolver/availability/spawn 返回的 unavailable 分支调用 JS fallback。abort、timeout、权限拒绝、身份漂移和真实 rg 非成功退出保持原终态，不转成 fallback；fallback 前后复核 permit 文件身份，报告 `searchScope.engine = walk`，范围继续由相同 `planGrepInvocation` 生成。新增 regex/case/glob/context、多行/count、head limit、大文件/二进制用例及 Hosted gate→生产 executor 集成用例。

阶段 7 聚焦 8 个文件 60 项通过。开发态 arm64 `prepare:rg` 命中缓存；staging 二进制 SHA-256 与 manifest 一致、权限 755，执行版本为 ripgrep 14.1.1。`ripgrepPrepareSecurity`、`ripgrepDownloadSecurity` 与诊断/进程契约测试均包含在聚焦回归中。

### 阶段 8：兼容、构建和打包（本机验收完成）

日期：2026-10-01。按当前 checkout 实际测试路径依次完成阶段回归组：阶段 1/安全 gate 146 项；策略、安全 floor 与 UI 170 项；归因纯逻辑、迁移、SDK recorder 及桌面/Butler/远程 SQLite 集成 230 项；grep fallback/scope/Hosted read gate 31 项通过。阶段 3 新增 extractor、gate、policy、approval-port 聚焦回归 231 项。SDK/provider 类型检查、shared/renderer 类型检查和 `check:agent-sdk` 均通过。

全量回归期间发现并修复了测试历史版本断言（schema v28）、轻量迁移 fixture 缺少两张 usage 表的兼容处理，以及漂移 History 原因由 `POLICY_DENY` 细化为 `FACTS_CHANGED` 后的过期断言。v28 部分 usage schema 仍触发事务失败并回滚；两张 usage 表都缺失的轻量 fixture 可跳过 attribution DDL。

严格 i18n 检查器改为解析 TypeScript/TSX 语法节点，只把运行时字符串和 JSX 文案计为硬编码内容，不再把中文注释当成界面文案。随后将 renderer 中 118 个实际中文字符串片段迁入中英文 `runtime` 资源，并补充中英文切换、插值、格式化单位及浏览器摘要语言切换测试。`npm run i18n:check:strict` 通过：生产代码 0 条硬编码中文；测试文件的 941 条中文测试数据/断言按现有门禁规则提示但允许。资源 key 对齐检查通过。

阶段 8 四组顺序回归分别通过 146、170、230、31 项。最终 `npm test`：814 个测试文件通过、1 个跳过；7164 项通过、106 项跳过（共 7270）。SDK attribution 每次 attempt 只准备一次的回归测试曾先红（同一次调用实际准备两次），在阶段 4 事实层提交中修复后转绿。shared、renderer、agent SDK、两个 provider 的类型检查和 `check:agent-sdk` 均通过。

`npm run build` 通过；Vite 报告 main bundle 3180.50 kB（gzip 879.65 kB）、三个 >500 kB 的 chunk 警告及两个 ineffective dynamic import 警告。

`npm run pack:mac` 通过，生成 `release/SpaceAssistant-0.2.2.dmg` 与 `release/SpaceAssistant-0.2.2-arm64.dmg`。两个 DMG 的 `hdiutil verify` CRC 均有效；app 主程序分别识别为 x86_64/arm64。两个包内 ripgrep 均通过 manifest SHA-256、架构、可执行权限和许可证检查；tree-sitter 7 项资源校验通过；归因、安全与 runtime 双语资源进入构建产物。macOS app 为 ad-hoc 签名，环境没有 Developer ID 证书。asar 未发现 `agent-core`；现有当前架构 `toolChatLoop` 兼容装配仍在基线入口使用，没有移植云端旧 loop。

阶段 5 的 AT17 已于 2026-10-01 使用真实微信远程回合完成，验收记录见阶段 5 实施记录。阶段 3 的脚本指纹会话信任已按云端行为补齐，详见下方阶段 3 续记。严格 i18n 门禁通过：生产代码 0 条硬编码中文；941 条测试数据/断言中的中文按门禁现行规则允许。提交顺序和无代码差异的组别记录见下方。

打包只在所有功能和全量门禁通过后执行；检查 x64/arm64 DMG 均由当前源码生成、版本和资源正确、归因/安全 UI 文案进入构建产物、ripgrep/fallback runtime assets 符合打包契约。该计划不要求在本机手工启动 Windows；CI 提供的 Windows job 若触发则记录结果。

**验收：** 上述本机命令均通过；测试数量和构建警告已记录；SQLite migration 新旧 fixture 均通过；桌面、远程、Butler 三条链路的本机集成用例均查询 SQLite 并通过归因列、工具维度列及身份关联断言；AT17 真实微信收发和 SQLite 查询通过；包内关键文件/资源可验证；没有排除的旧 `agent-core`/旧 loop 文件被重新带入；三处既有接口文档修改仍原样保留；恢复代码按功能组提交，阶段 8 与本计划验收完成。

## 5. 建议提交分组

按依赖顺序拆分，只有对应阶段验收通过后才提交该组：

实施结果（按恢复依赖顺序）：阶段 1 提取器和阶段 7 准备/事实实现均已存在于基线，按计划运行回归后无需产生空提交。阶段 2 提交 `3f3620da`；阶段 3 审批解释提交 `7ffca482`，脚本指纹会话信任由本次后续功能提交补齐；阶段 4 提交 `b0b09baf`（包含 attribution exactly-once 的红绿回归）；阶段 5/6 提交 `fef080a0`；阶段 7 fallback 提交 `a8fbd537`。计划与来源清单在代码验收后单独归档。完整 SHA 以实施记录的 Git 历史为准。

1. `fix(security): restore script path fact extraction` — extractor/IR 及安全回归。
2. `feat(security): restore rule-level policy controls` — 档位、规则覆盖和设置页。
3. `feat(security): restore explainable script trust` — 审批解释和受限 trust lifecycle。
4. `feat(usage): restore attribution schema and SDK recording` — 新 migration、当前 SDK 采集和事实层。
5. `feat(usage): restore attribution queries and views` — query/API/renderer/i18n。
6. `feat(grep): restore scoped JavaScript fallback` — fallback 和错误分流测试。
7. `chore(grep): restore development ripgrep preparation` — dev 环境准备脚本、校验和诊断。

阶段 3 会话信任单独作为安全功能提交，并通过精确内容、会话隔离、动态执行拒绝记忆和撤权测试后才纳入完成结论。

## 6. 排除项和暂停条件

- 不把 `8dad0284` 相对共同祖先的整个树覆盖到当前 main；尤其不恢复旧 `toolChatLoop`、旧 `agent-core` 包和其 package/tsconfig/boundary scripts。
- 不恢复会移除当前 Hosted MCP、SQLite canonical History、session transcript、当前 agent-sdk provider 闭包或本地 workdir/profile 逻辑的删除/重命名。
- 不复制云端 v19 数据库 migration；当前 schema 为 v27，归因字段必须使用下一个兼容版本。
- 不自动接纳 `script-unmodeled-path-ask` 在 loose 档的 broad allow；若产品语义确需此例外，先有精确 scope、威胁分析、负向测试和单独评审结论。
- 不恢复只针对旧循环/旧架构的测试、开发文档草稿、评审产物和依赖；需要的测试必须迁移到当前 owner。
- 遇到没有唯一 turn/session identity 的归因写入、估算与精确值混写、脚本 trust 无法绑定执行对象、grep fallback 越过 permit、或迁移无法安全覆盖 v27 数据时暂停该子项并补设计，不以宽松兼容绕过。

## 7. 总体验收表

| 阶段 | 完成判定 | 必要证据 |
|---|---|---|
| 0 来源与工作区 | 完成 | 基线/source SHA、逐提交与文件清单、当前三处文档 diff 保留证明 |
| 1 脚本路径提取 | 完成 | false-positive 红绿、恶意/歧义 fail-closed、permit 身份验证 |
| 2 规则档位 | 完成 | action precedence 表、policy floor、设置持久化/i18n、loose allow 单独结论 |
| 3 审批解释与 trust | 完成 | 审批解释、脚本 SHA-256 身份、内容变化/会话隔离/撤权/拒绝写入测试、脱敏证据 |
| 4 归因算法 | 完成 | 指标矩阵、守恒/估算版本/不伪造事实测试；0%/部分/100% 覆盖率定义和版本混合测试 |
| 5 usage 事实层 | 完成 | v27→v28 迁移、SDK exactly-once、无 usage 不记零值；桌面/远程/Butler 本机入口各自写入 SQLite 的证据；AT17 真实微信收发后 SQLite 归因列及工具维度列验收记录（见阶段 5 实施记录） |
| 6 查询和 UI | 完成 | IPC ownership、跨会话隔离、同筛选 KPI 与覆盖率、0%/部分/100% 和版本混合呈现、精确/估算区分、i18n |
| 7 grep fallback/dev | 完成 | scope/security parity、仅 unavailable 降级、取消/超时不降级 |
| 8 集成与包 | 完成 | 全量测试、类型/边界/i18n/build、macOS 双架构包产物检查 |

只在阶段 0–8 的完成证据齐全、AT17 真实远程收发验收通过、所有组提交均已检查且无未解释的产品差异时，才报告功能恢复计划完成。AT17 因环境不可用而未执行时，状态必须为 `待外部验收`，不能将归因恢复或本计划报告为全部完成。推送、发布或替换用户安装包需另行按当时授权执行；本计划本身只定义本地恢复与可审查提交。

## 8. 实施记录

### 阶段 6：归因查询、API 与界面（本机完成）

日期：2026-10-01。增加只读区间查询并复用总览输入 KPI 的过滤条件；归因归并使用 `session_id + turn_id` 与 step 行配对，不以共享 requestId 作为身份键。新增最新单会话 step 查询，通过 preload/shared API 暴露给 ContextUsageRing；如果最新精确 step 没有有效归因快照，返回 `null`，不会回退展示更旧 step 的构成。空 JSON 或没有正估算权重的快照不构成归因证据，保留在未归因缺口内。

归因抽屉包含 estimator version 选择、覆盖率/缺口、估算构成、趋势和工具维度；0% 时显示无归因原因且不渲染构成视图。ContextUsageRing 在既有 tooltip 分隔线后显示精确输入、估算标识、estimator version 和覆盖率/缺口；原圆环 `usedRatio` 与现有 tooltip 行不变。新增 SQLite、API 类型、抽屉和 ContextUsageRing 用例；归因与界面聚焦用例 66 项通过，shared/renderer 类型检查、常规 i18n 检查通过。`i18n:check:strict` 仍因仓库现有 589 条源文件硬编码中文失败，本次归因文案均为双语资源并已生成类型。

阶段 6 不依赖阶段 5 的真实外部收发验收。AT17 真实微信验收已于上方阶段 5 记录完成。阶段 8 全部本机门禁也已于 2026-10-01 通过；恢复代码已按 §5 依赖顺序提交，记录见第 5 节。

### 阶段 8：逐路径复核后的最终重验（完成）

日期：2026-10-01。对恢复计划原先标记未逐项核对的 405 个路径完成语义复核，另将前序 111 个功能路径按当前工作树重新核对；结论见 `docs/develop/2026-10-01-cloud-main-516-path-audit.tsv`。发现的真实问题均按 TDD 处理，包括 ripgrep 开发提示旧断言，以及 arm64 Electron 框架签名失败与双架构打包的磁盘峰值问题。

最终按阶段 8 顺序重跑：四组回归分别为 226、176、233、44 项；shared、renderer、agent-sdk、pi-ai provider 类型检查、SDK 边界和严格 i18n 均通过；`npm test` 819 个文件通过、1 个跳过，7294 项通过、106 项跳过；`npm run build` 与 `npm run pack:mac` 通过。pack:mac 现在顺序生成 x64/arm64 DMG，中间清理 x64 解包 app 以控制磁盘峰值。两份 DMG CRC 有效，app 架构与 ad-hoc 签名正确，包内 ripgrep 哈希/许可和双语用量资源核对通过；asar 不含 `agent-core`。

云端 tip 后续版本仍没有配置为远端分支：`origin` 只有共同基线 `main`。shell plan 快照和 Butler 投递两项差异已在审计底表列为外部版本核实，不影响当前本地恢复和阶段验收结论。

### 阶段 5：usage 事实层与 AT17 真实微信验收（完成）

日期：2026-10-01。用户在真实微信远程会话发起测试消息；开发版应用接收并完成回合。直接查询本次运行使用的 SQLite：session `31ba46de…f743a626`、turn `dda125d4…f585-4597-b379-248ca9cf0d86`，二者通过 `turns.session_id` 一致关联；该 turn 为 `terminal / completed`，对应微信来源会话。`usage_step_facts` 有 2 行，2 行均 `attribution_json` 与 `estimator_version` 非 NULL；`usage_turn_facts` 有 1 行且 `tool_attribution_json` 非 NULL，回合记录包含 1 次工具调用。查询以 `session_id + turn_id` 同时核对，不记录或披露消息正文。验收人：用户发起真实微信消息，Codex 直接查询运行数据库并核对结果。

至此阶段 5 的 AT17 真实环境验收已通过；本机 SQLite 集成用例和 v27→v28 迁移证据见前述测试记录。该结论关闭 AT17 外部验证项。

### 阶段 3：脚本指纹会话信任补齐

日期：2026-10-01。按 TDD 先新增 extractor、policy、gate、审批 fallback 和 SQLite 生命周期测试，确认旧实现无法区分未知调用与动态执行、无法按精确脚本内容提供会话记忆；随后实现并转绿。`ScriptPathFacts` 增加 `unknownReason`，只将已分类且无动态执行的 `unmodeled-call` 纳入有限会话记忆；动态执行、缺失分析、结构错误、未分类未知和危险脚本继续锁定为每次人工确认/拒绝。

`run_script` 的精确信任身份是执行代码 UTF-8 字节的 SHA-256，并与当前 session ID 组成缓存键。内容增删一个空格或换 session 均重新确认；未知提取结果抑制路径记忆，避免路径相似误复用脚本信任。执行许可继续在调用前复核当前事实与授权版本。只在人类明确批准并选择“记住本会话此脚本”时写入现有 decision cache；写入端验证该键确为本次决策提供的选项。取消、拒绝、agent 代答、动态执行、未分类未知均不创建此记忆；清除记忆后重新确认。记录只存摘要和会话范围，不存脚本正文或凭据，设置页双语显示为“本会话相同脚本 / Same script in this session”。

云端来源逻辑使用按脚本正文 hash 的本会话信任；没有分析器版本键。本实现因此遵守来源的身份模型，并以当前 permit 重验、未知原因分类、动态脚本锁定来保持安全边界，没有额外宣称跨版本复用安全。审批解释保留稳定规则 ID、双语未知原因和 `FACTS_CHANGED` 回放。阶段 3 聚焦测试、SQLite 写入/命中/变更/session/revoke 集成、全量测试、类型检查和 i18n 均通过。
