# 定时任务独立工作目录与模型配置开发计划

日期：2026-10-03  
依据：[`docs/requirement/scheduled-task-output-directory-model-requirements.md`](../requirement/scheduled-task-output-directory-model-requirements.md)  
性质：实施计划。每项以代码、测试或可检查产物作为完成判据。

## 1. 目标与范围

实现每个自动化任务独立持有工作目录、模型服务和思维强度。运行时配置从任务记录解析，不继承桌面当前 Profile 或模型；创建表单可把当时桌面工作目录、模型和思维强度预填为初始值，保存后形成任务自己的配置。

覆盖任务存储与迁移、IPC 校验、目录选择与模型设置 UI、运行配置快照、执行路径贯通、安全审核上下文、运行历史可追溯及回归测试。手动立即运行和定时触发共用同一配置解析入口。

安全边界：任务目录改变路径归属判断的工作区根，不改变 automation lane 的授权策略。特别是 `write_file` 仍由 `automation-write-deny` 锁定拒绝；此计划不得移除此规则、改写工具权限或增加目录内自动写入豁免。

## 2. 现状事实与实现约束

| 编号 | 现状 | 影响 |
| --- | --- | --- |
| C1 | `AutomationTask` 有 `modelOverride`，数据库有 `model_override`；没有任务工作目录、服务 ID、思维强度 | 需扩展共享契约和迁移，保留旧模型值 |
| C2 | `runButlerTask` 入口读取任务后先排队准入，`butlerInvoker.ts` 创建会话时读取 `getActiveWorkDirProfileId()` | 任务启动前的排队期间可发生桌面切换/任务编辑；实际执行配置应在取得准入后重新读取 |
| C3 | `runButlerModelTurn` 中消息构造、butler event sink、部分调用参数直接使用 `getWorkDir()`；工具调用 `workDir` 经 `resolveWorkDirForSession`；`buildWorkspacePorts` 通过会话 Profile 快照工作区 | 仅给任务表加路径字段不够；所有执行与安全路径必须使用同一份 task root |
| C4 | `invocationAssembler.ts` 将 `materials.resolveWorkDir()` 传给 `runApprovalAgent` 的 `workDir/getWorkDir/resolveWorkDirForSession` | 若 Butler invocation 的 workspace root 正确，审批 Agent 可复用；否则仍会继承桌面 Profile |
| C5 | `probeReadPathFact` / `probeWritePathFact` 以 `workDir` 计算路径归属；automation 对工作区外写入有 `automation-outside-write-deny`；`write_file` 有 `automation-write-deny` 锁定拒绝 | 路径根修正不能被实现成授权放宽；分别验证路径归属与工具最终裁决 |
| C6 | 任务设置 UI 在 `ButlerTaskSettings.tsx`；CRUD 由 `butlerIpc.ts` / `taskStore.ts`；IPC 错误是 `{ok:false,error}` | 新增字段须通过共享类型、preload API、IPC、store、UI 全链路，且显示主进程验证错误 |
| C7 | 思维强度类型为 `AgentReasoningEffort = off / low / medium / high / max`；模型能力字段有 `supportsThinking`；会话记录也有 thinking effort 既有机制；legacy 全局 bool key 是 `config.thinkingEnabled` | 任务模型能力必须按 catalog ID 由主进程验证，不能只依赖 UI 过滤或名称查找 |
| C8 | 当前 DB schema version 为 32；任务表由 V15 migration 创建 | 增加新版本、增量迁移；不得回写旧任务的活动 Profile 或覆盖既存 `model_override` |

## 3. 数据与行为决策

1. 新任务字段：`work_dir TEXT`、`model_id TEXT`、`model_service_id TEXT`、`reasoning_effort TEXT`。现有 `model_override` 的实际语义是 provider-facing 模型名（`ModelEntry.name`，现由 `resolveLlmCredentialsForModel` 按 name 查找），不能把它重解释为 `ModelEntry.id`。新增 `model_id` 存稳定的产品目录 ID；`model_override` 对新任务保留为模型请求名/旧代码兼容镜像，不作为服务查找主键。
2. 模型路由的单一契约：持久配置身份为 `(model_id, model_service_id)`；目录项通过 `ModelEntry.id` 精确取得，其 `name` 是发给 provider 和 invocation route 的模型名；服务必须明确启用且 `supportedModelIds` 包含该 `model_id`，并有凭据。凭据解析按 `(model_id, service_id)` 精确取服务，不能先按名称 `find` 第一条。provider route 使用同一目录项的 `name`、所选 service 的 endpoint 和 credentialRef。run 快照及用量记录同时保留 `modelId`、`providerModelName`、`serviceId`、route identity，四处不得独立重新选择。
3. 运行记录增加 `config_snapshot_json TEXT`（或等价的有类型列），至少记录实际 `workDir`、model catalog ID、provider model name、service ID、provider route identity、请求思维强度和运行时最终思维强度/降级信息。快照在准入后完成配置解析时形成；任务编辑不改变已开始运行的快照。
4. 新建表单可用桌面当前值预填，但存储时写入明确的绝对目录、catalog model ID、service ID、思维强度；保存后不得保留“跟随当前 Profile/模型”的动态引用。
5. 旧任务兼容语义：只要任务 `work_dir IS NULL`，在每次运行**取得准入并重新读取任务后**，一次性捕获当时活动 Profile 的规范绝对路径，冻结进该次 run 快照和 session workspace；不回填任务行。准入排队期间切换 Profile 时采用准入后的 Profile；session 创建后切换 Profile 不影响本次运行。若没有活动 Profile、profile path 缺失或路径校验失败，本次失败且不 fallback。兼容期不按日期到期，直到用户显式保存任务目录；仅编辑其他字段不退出兼容。
6. 旧任务模型兼容语义：`model_override` 是 provider model name。若有值，运行时按完全相等的 name 找目录候选；唯一 catalog entry 时解析一次当前可用 service 并冻结 pair 到 run；零候选或多个 catalog entry 时失败，提示用户编辑任务消除歧义。若 `model_override` 为空，准入后捕获当时桌面当前 model/service 并冻结到本次 run，不回填任务行；没有有效当前配置时失败。两种 legacy 情况下，只要 `reasoning_effort IS NULL`，统一在准入后用 `resolveGlobalThinkingEffort(config.thinkingEffort, config.thinkingEnabled)` 解析桌面当前全局思维强度；`config.thinkingEnabled` 是现有 legacy 布尔键。排队期间变化取准入后值，开始执行后冻结，不回填任务行。若所选模型 `supportsThinking === false` 且请求档位非 `off`，沿用现有运行时能力规则降为 `off`，同时在 requested/effective 快照及 `agent.profile.reasoning_degraded` 事件中留痕，不因能力不匹配改选模型/服务。旧模型兼容行为直到用户显式保存任务级 model/service pair；编辑其他字段不退出兼容。

## 4. 阶段与任务清单

### 阶段 A：共享类型、数据库迁移与任务存储

**A1. 扩展共享任务类型**

- 文件：`src/shared/automationTaskTypes.ts`
- 动作：给 `AutomationTask` / `AutomationTaskInput` 增加兼容旧行可缺省的 `workDir`、`modelId`、`modelServiceId`、`reasoningEffort`；保留 `modelOverride` 表示 provider model name；为 `AutomationTaskRun` 增加可读配置快照结构/字段。
- 完成判据：新字段可由 renderer 和 electron 共用；旧任务对象可不含目录/model ID/service/effort；`reasoningEffort` 使用 `AgentReasoningEffort` 联合类型，不复制一份字符串联合定义；注释明确 `modelOverride` 是名称而非 catalog ID。

**A2. 增加数据库增量迁移**

- 文件：`electron/database/schema.ts`、`electron/database/migrations.ts`、相关 schema migration 测试
- 动作：新增 schema v33（若开发时版本已推进，则使用下一个版本）；为 `automation_tasks` 增加 `work_dir`、`model_id`、`model_service_id`、`reasoning_effort`；为 `automation_task_runs` 增加 `config_snapshot_json`。所有新列允许旧行保持 NULL。
- 完成判据：从 v32 数据库升级后版本正确；旧行目录/model_id/service/effort 仍为 NULL，既有 `model_override` 字符串逐字不变；重复初始化不会重复报错或丢数据；从新建空库可直接创建任务及运行记录。

**A3. Store 读写任务配置**

- 文件：`electron/butler/taskStore.ts`、`electron/butler/taskStore.test.ts`
- 动作：更新 row mapper、create、update、查询字段；支持显式设置/清除工作目录与模型服务/思维强度；NULL 仍映射为旧任务未配置状态。
- 完成判据：测试覆盖新建、读取、更新、清除可选字段、旧 NULL 行往返、保留原 `modelOverride`；任务列表与单条读取返回同样字段。

**A4. Store 记录运行配置快照**

- 文件：`electron/butler/taskStore.ts`、`src/shared/automationTaskTypes.ts`、对应测试
- 动作：扩展插入/更新 run API。run 在准入前创建时快照允许为 NULL；取得准入、重读任务并成功解析配置后更新快照。准入拒绝时保持 NULL；准入后配置解析失败时记录 `resolutionStatus: failed` 及成功解析的非敏感部分（如有）和 error，不记录密钥。非法 JSON 读取时安全降级，不使任务列表崩溃。
- 完成判据：测试断言 run claim 初始 snapshot 为 NULL；准入拒绝后仍 NULL；准入后解析成功可更新完整快照；解析失败有失败状态/错误且不含密钥；旧运行行无快照时仍可读取。

### 阶段 B：目录选择、模型解析与 IPC 校验

**B1. 增加目录选择 IPC**

- 文件：`electron/butler/butlerIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`、对应 IPC 测试
- 动作：通过主进程原生目录选择器提供 `butler:choose-workdir`；renderer 只能请求选择，最终路径仍由主进程在 create/update 校验。
- 完成判据：用户取消时返回明确的 cancelled 结果且不改配置；选择目录时返回绝对路径；未经验证的 renderer 路径不能绕过 create/update 路径验证；新 API 类型完整贯通 preload。

**B2. 实现任务目录校验函数**

- 文件：建议新增 `electron/butler/taskConfigValidation.ts` 及测试
- 动作：对新建/显式保存的任务目录校验字符串非空、绝对路径、规范化、目录存在且可访问；处理软链接按现有 workdir 安全约束规范化/拒绝。提供独立的 legacy run 解析入口，按 §3.5 仅在取得准入后捕获当前 Profile 路径，不把该兼容路径写回 task。
- 完成判据：显式目录的相对路径、空值、文件路径、不存在路径、不可访问路径返回稳定错误码/消息且无 fallback；legacy task 可通过单独分支解析；两条路径有不同且明确的测试标签。

**B3. 建立模型候选和服务路由解析**

- 文件：`src/shared/llmModelConfig.ts`、`electron/llmServiceResolver.ts`、`src/shared/domainTypes.ts` 相关 selector 测试
- 动作：定义跨层候选契约 `{ modelId: ModelEntry.id, providerModelName: ModelEntry.name, serviceId, serviceName, supportsThinking, enabled }`；实现精确 pair validator/resolver。current desktop defaults 必须解析成同一 pair；fallback 默认候选也返回完整 pair。
- 完成判据：相同 `ModelEntry.name`、不同 model ID 和/或 service ID 的候选都可分别保存；验证器只在服务 active、支持目标 model ID、凭据存在时返回 pair；禁用/不支持/无凭据时失败；服务列表排序变化不改变显式 pair 的结果。

**B3a. 扩展凭据解析器支持稳定 pair**

- 文件：`electron/llmServiceResolver.ts`、`electron/llmServiceResolver.test.ts`
- 动作：新增按 `(modelId, serviceId)` 解析的入口，先 `models.find(m => m.id === modelId)`，再要求指定 service 存在、处于可用集合且 `supportedModelIds` 含 modelId，最后只从该 service 取 endpoint/key；不得调用名称查找再择服务的旧路径。保留旧 `resolveLlmCredentialsForModel(name, options)` 给存量调用方。
- 完成判据：两个同名模型不同 ID、两个 service 都声明相同模型、显式服务禁用/撤 key、服务排序变更都有定向用例；显式 pair 永不取另一个 service；旧 API 行为测试不回归。

**B3b. 确保模型能力按 catalog ID 解析**

- 文件：`electron/runtime/invocationAssembler.ts`、`electron/runtime/invocationAssembler.test.ts`（或现有相邻能力测试）
- 动作：扩展 invocation materials，传递已由主进程 pair resolver 验证的 catalog `modelId`（或等价不可变能力快照）；reasoning 能力检查通过 `ModelEntry.id` 精确查能力，不得对 automation path 使用 `find(m => m.name === materials.model)`。若传递 `supportsThinking`，必须由可信主进程解析结果构造，不能接收 renderer 值。
- 完成判据：两个 `ModelEntry` 的 provider name 相同但 catalog ID 不同、`supportsThinking` 相反；分别选择两个 ID 时降级结果正确；调换 `readStoredModels` 顺序后结果不变；automation 路径没有按 name 重选能力的回退分支。

**B4. 主进程校验模型和思维强度**

- 文件：建议扩展 `taskConfigValidation.ts`；`electron/butler/butlerIpc.ts` 与单测
- 动作：create/update 校验 `model_id + model_service_id` 对应关系、provider model name 镜像一致性、服务可用性、reasoning effort 枚举及模型 thinking 能力；run 时对新格式任务重验同一 pair。legacy model 按 §3.6 单独映射，不伪装成显式 pair。新任务必须提交稳定 pair。
- 完成判据：伪造 renderer payload 的无效/不匹配 pair、镜像名称不一致、非法 effort、unsupported + non-off 均返回 `{ok:false,error}`；合法 pair 可保存；运行时服务禁用或凭据无效形成结构化失败且未调用 provider；legacy 分支测试证明确切唯一映射和歧义失败。

**B5. 扩展 Butler CRUD IPC 契约**

- 文件：`electron/butler/butlerIpc.ts`、`src/shared/api.ts`、`electron/preload.ts`、IPC 测试
- 动作：create/update 读写 `workDir/modelId/modelOverride/providerModelName/modelServiceId/reasoningEffort`；新任务 `modelOverride` 与 model ID 对应的 `ModelEntry.name` 一致；update 支持未提供字段与显式字段更新的区分；字段错误映射到明确错误消息。
- 完成判据：create 缺少必需任务目录或稳定模型 pair 被拒绝；update 未传字段不清除原值；旧任务兼容字段只有显式保存新 pair 后才退出兼容；新 pair 往返后四元身份（catalog ID、provider name、service ID、effort）一致；已有 schedule/delivery 更新行为不变。

### 阶段 C：设置界面

**C1. 预加载当前值并处理旧任务空值**

- 文件：`src/renderer/components/Config/ButlerTaskSettings.tsx`、butler IPC API
- 动作：新建表单加载当前桌面工作目录、桌面当前 model/service/reasoning effort 作为可修改初始值；旧任务编辑时保留 NULL 呈现，并提示需设置独立目录，不自动写入当前 Profile。
- 完成判据：新建打开表单时默认值来自当前配置；旧任务打开表单不发生后台保存或值回填；取消编辑不改变数据库。

**C2. 增加任务工作目录控件**

- 文件：`ButlerTaskSettings.tsx`、相应 config i18n 资源、`src/renderer/i18n/types.ts`（按项目生成流程）
- 动作：显示路径、浏览选择、支持重新选择；保存前 renderer 基础校验并展示主进程错误；任务卡片显示可读路径摘要，完整路径可查看。
- 完成判据：创建任务不能在无目录时保存；编辑目录后保存并刷新显示新值；长路径不撑坏列表布局且可访问完整路径；所有新增用户文案来自 i18n。

**C3. 增加模型和思维强度控件**

- 文件：`ButlerTaskSettings.tsx`、config i18n、模型候选 API/selector 测试
- 动作：按 service 分组列出 pair 候选；新建预选当前桌面 model ID/service ID/effort；依模型 `supportsThinking` 动态过滤 effort；切换模型或 service 后若原档位不支持，归为 `off` 并在 UI 可见。
- 完成判据：同名模型可区分 ID 和服务；不可用模型不在新建候选中；不支持 thinking 时不能选择非 off；无需额外费用提示；编辑保存后列表/再次编辑值一致。

**C4. 将配置提交并呈现字段级失败**

- 文件：`ButlerTaskSettings.tsx`、相应组件测试
- 动作：create/update payload 传递全部配置；把主进程错误显示在相关字段或表单内；保存失败保留表单输入。
- 完成判据：模拟目录/model 校验失败时弹窗仍打开、用户输入保留、错误可见；成功后关闭并刷新；enabled/schedule/delivery 的既有 CRUD 用例仍通过。

### 阶段 D：执行快照与自动化工作区贯通

**D1. 准入后重新读取任务配置并解析兼容值**

- 文件：`electron/butler/butlerInvoker.ts`、`electron/butler/butlerInvoker.test.ts`
- 动作：claim run 后取得 admission ticket，再重读 task。显式 task workDir/model pair 原样解析；legacy workDir NULL 在此刻捕获活动 Profile path；legacy model 与 effort 按 §3 规则解析。取得且验证的 `(modelId, serviceId, providerModelName, supportsThinking, requestedEffort, effectiveEffort)` 形成不可变 `ResolvedAutomationRunConfig`，写入 run snapshot 后才创建 session。该对象是此 run 后续 session、受信 turn 配置、accepted turn、invocation 和 provider request 的唯一绑定输入；禁止后续从桌面当前配置重新解析。
- 完成判据：排队期间 profile/模型/effort 切换时 legacy task 只捕获准入后的值；显式配置 task 不受切换影响；legacy task 行仍为 NULL；目录无效/旧模型名有歧义/pair 不可用时失败且不创建 session；准入拒绝时 run 快照保持 NULL；配置解析后的 snapshot 可追溯且用于下游各阶段。

**D2. 创建不依赖桌面 Profile 的 automation 会话**

- 文件：`electron/butler/butlerInvoker.ts`、必要时 `electron/database/operations.ts` / `domainTypes.ts`
- 动作：automation session 仍保留 ownership/visibility；新任务工作目录由 task snapshot 显式绑定。legacy NULL task 使用 D1 捕获的 `legacyResolvedWorkDir` 仅绑定本次 run/session，不回写任务。不得调用 `getActiveWorkDirProfileId()` 决定显式任务工作目录。若 session 当前只有 `workDirProfileId` 表达空间归属，为其增加固定 workDir 表达/映射机制，不能借用一个可能改变路径的 Profile ID。
- 完成判据：显式任务目录 T 在 Profile A/B 下均解析 T；legacy task 在准入后捕获的 T1 即使 session 创建后切到 B 仍解析 T1；任务行不被回填；无 active profile / profile path 时 legacy run 失败。

**D3. 统一执行链的工作区根**

- 文件：`electron/butler/butlerInvoker.ts`、`electron/runtime/invocationAssembler.ts`、`electron/workDirManager.ts` 或 `src/shared/agent/workspace.ts`（按最终 workspace 方案）、`electron/butler/butlerSessionEvents.ts`
- 动作：从任务运行快照取唯一 `taskWorkDir`，传给消息历史 workspace root、工具 `workDir`、workspace snapshot tracker、resolveWorkDir、session event location、文件树刷新和安全路径探测相关材料。不得一部分取任务目录、一部分取 `getWorkDir()`。
- 完成判据：代码审查可找到单一 taskWorkDir 来源；运行中切换活动 Profile，所有上述入口的观测值仍为任务目录；任务配置更新不改变已开始调用。

**D4. 增加无自动改绑的 automation 受信 turn 配置入口**

- 文件：`electron/turnExecutionConfig.ts`、`electron/turnExecutionConfig.thinkingEffort.test.ts`
- 动作：新增 `resolvePinnedAutomationTurnExecutionConfig(db, session, resolvedRunConfig)`（或等价独立、强类型 API），供 automation 专用。输入包含已验证 catalog `modelId`、`serviceId`、provider model name、endpoint/credential identity、requested effort 和 effective effort。按 model ID 精确读取 `ModelEntry` 并确认 name/能力与快照一致；显式按 service ID 校验服务仍可用且支持该 ID。此入口不得走通用 resolver 中“模型不可用则重绑优选模型”的分支，不得按 `ModelEntry.name` 重新选择 model entry；错误时返回失败，不改写 session model/service，不生成 accepted turn，不发 provider 请求。全局配置只允许用于 D1 的 legacy 值解析，进入此入口后不再读取桌面当前 model/effort。
- 完成判据：有效 pair 返回与输入相同的 model/service/provider name 与 requested/effective effort；撤销或禁用 pair 后返回指定配置失效错误、没有 fallback model、session 字段不变、accepted turn 未创建；两个同名不同能力 ID 反转 models 顺序后能力结果不变；桌面 model/effort 值变化不影响 resolver 输出。

**D4a. 将固定配置贯穿 session、accepted turn 与 provider 请求**

- 文件：`electron/butler/butlerInvoker.ts`、`electron/runtime/invocationAssembler.ts`、session / accepted turn 配置相关模块、相关集成测试
- 动作：取得 D4 的受信配置后，用同一 `ResolvedAutomationRunConfig` 创建/更新 task session 的 model、service 和显式 thinking effort；创建 accepted turn 时将相同 pair 和 requested/effective effort 写入 config；构造 invocation 时传相同 catalog model ID/能力快照；provider route 使用同一 provider model name、endpoint、credentialRef。自动化路径不得调用会按 name 选模型或在服务失败时自动重绑的桌面兼容入口。
- 完成判据：run snapshot、session、accepted turn、invocation、provider route 和实际 provider request 的 model/service/effort 字段逐项等于同一固定配置；在 D1 配置解析之后、turn 配置校验之前禁用模型/service 时，结果是明确失败、无改绑且 provider 请求次数为 0；同名不同能力模型反转目录顺序时结果仍由所选 ID 决定；执行中切换桌面默认模型/effort 不影响当前 run。

**D5. 记录运行与会话配置快照**

- 文件：`electron/butler/butlerInvoker.ts`、`electron/butler/taskStore.ts`、历史记录相关类型/API
- 动作：配置解析成功后、会话创建前写入 workDir（含 legacy 来源标记）、modelId、providerModelName、serviceId、route identity、requested effort、effective effort/degraded 信息；任务历史读取显示该次快照。产物内容和命名仍由具体任务业务逻辑负责。
- 完成判据：成功/失败 run 均有符合解析阶段语义的快照；准入失败快照为 NULL；准入后解析失败含失败状态与错误；编辑任务不会改写既有 run；历史展示使用 run 快照，不从任务当前配置推算目录或模型。

### 阶段 E：安全审核上下文与权限边界

**E1. 将任务工作区传入安全审核 Agent**

- 文件：`electron/runtime/invocationAssembler.ts`、`electron/confirmation/approvalAgent.ts`、相关测试
- 动作：审批 Agent 收到本次 automation invocation 的 taskWorkDir，并让其只读工具的 workspace snapshot / resolveWorkDir 指向同一目录；不从 approval hidden session 绑定或查询桌面 active Profile。
- 完成判据：集成测试中外层 automation task root 为 T、桌面 active profile 为 P；审批 Agent 的 workspace root 与只读探测根为 T，且 Profile 切换不能使其变成 P。

**E2. 验证路径归属基于任务目录**

- 文件：`electron/confirmation/toolCallGate.ts`、`electron/confirmation/extractors/readPathFacts.ts`、`writePathFacts.ts` 相关测试
- 动作：验证相对路径按 taskWorkDir 解析；任务目录内目标标记为 workdir 区域；另一个桌面 Profile 内的路径不会因它是当前 Profile 而被当成任务内路径。
- 完成判据：探针/门控测试断言目标的 normalized path 与 zone；在 task root 外但 desktop profile 内的写目标仍按 automation 外部目标规则处理。

**E3. 保持既有 automation 权限策略**

- 文件：`electron/confirmation/automationLane.test.ts`、`electron/confirmation/toolCallGate.test.ts`、必要时规则定义文件（原则上不修改规则）
- 动作：新增回归用例证明 taskWorkDir 只改变路径事实，不新增授权；保留 locked `automation-write-deny`、`automation-shell-deny`、目录外写拒绝和 automation cache lane 隔离。
- 完成判据：`write_file` 在任务目录内仍命中 `automation-write-deny`；`run_shell` 仍命中 `automation-shell-deny`；工作区外写入仍由现行规则拒绝；本次 diff 不弱化规则 floor/locked 标记，不新增目录白名单绕过。

**E4. 验证审批触发类工具的边界**

- 文件：`electron/confirmation/approvalAgent.test.ts`、`electron/confirmation/automationLane.test.ts`
- 动作：对 automation 中可能进入 require-confirm/审批 Agent 的工具，分别验证审批 Agent 看见 taskWorkDir、目录内外事实正确、审批结果仍受现有风险矩阵/授权上限约束。
- 完成判据：目录内只改变 zone/上下文，不会令高危操作越过 `maxAuthorization='low'`、risk threshold 或 locked deny；桌面缓存/审批结果不被 automation 继承。

### 阶段 F：历史兼容、错误与界面可追溯

**F1. 旧任务兼容行为可见**

- 文件：`ButlerTaskSettings.tsx`、`electron/butler/butlerInvoker.ts`、i18n、测试
- 动作：旧任务无 `work_dir` 时在编辑界面展示未设置状态；不在加载/迁移时自动写入当前目录；提供设置后保存成为任务独立工作区。
- 行为：兼容运行持续到用户显式保存任务工作目录为止，不设日历到期日；编辑名称/提示词/触发时间/model 等其他字段不退出目录兼容。
- 完成判据：加载旧任务不会改变数据库；仅编辑其他字段仍保持 `work_dir IS NULL`，每次运行均按“取得准入后捕获当前 Profile”规则；显式设置并保存后下一次运行使用新目录且不再读取当前 Profile。

**F1a. 旧任务空思维强度兼容行为可见且冻结**

- 文件：`electron/butler/butlerInvoker.ts`、`electron/turnExecutionConfig.ts` 或其共享解析入口、`ButlerTaskSettings.tsx`、测试
- 动作：旧任务 `reasoning_effort IS NULL` 时，准入后从桌面全局 `config.thinkingEffort` 与实际 legacy `config.thinkingEnabled` 解析 effort；有/无 `model_override` 使用同一来源。写入 run requested effort，并写入 session 和 accepted turn 的显式 effort；所选 model 能力不支持时按 §3.6 降为 `off` 并留痕。编辑页显示实际继承状态；打开或取消编辑不回填 task。
- 完成判据：覆盖 `model_override` 有值且 effort NULL、无值且 effort NULL；在 admission 排队期间将全局 effort 从 low 改为 high，run 使用 high；开始模型调用后再改全局 effort，当前 run 仍保持 high；task effort 仍 NULL；unsupported model 的 requested=high、effective=off 且 degraded 记录完整。

**F2. 失败原因与任务运行状态一致**

- 文件：`butlerInvoker.ts`、`taskStore.ts`、`ButlerTaskSettings.tsx` / run history UI、测试
- 动作：目录失效、legacy 无活动 Profile、旧模型名无候选/多候选、模型/service pair 禁用、凭据失效、effort 能力不匹配分别写入 run error；区分配置验证失败与模型请求失败。
- 完成判据：每种错误可由 run 查询；UI 展示非空且可理解原因；显式目录/pair 解析失败不会降级到桌面值，legacy 兼容读取仅按 §3 规定的一次性捕获语义执行。

**F3. 历史读取使用运行快照**

- 文件：任务运行历史查询/API/UI（如现有历史视图）；无历史视图则至少在 `AutomationTaskRun` 返回快照
- 动作：暴露每次运行目录/model/service/effort，目录长路径可展开/复制；不展示完整产物内容或密钥。
- 完成判据：运行完成后编辑任务配置，旧 run 详情仍显示旧值；迁移前旧 run 的快照字段为空时 UI 使用明确“旧记录无快照”状态。

### 阶段 G：完整回归与交付关闭

**G1. Butler 配置层定向测试**

- 命令：`npx vitest run electron/butler/taskStore.test.ts electron/butler/butlerIpc.test.ts`（按实际文件名调整）
- 完成判据：命令退出码为 0；新增迁移、CRUD、校验用例均执行；失败输出中无未解释错误。

**G2. 运行链与 Profile 隔离测试**

- 命令：`npx vitest run electron/butler/butlerInvoker.test.ts`
- 完成判据：配置在准入时冻结；Profile A 创建、Profile B 运行仍使用任务目录 A；定时和手动入口配置相同；历史快照符合本次实际执行值。

**G3. 安全审核及权限回归测试**

- 命令：`npx vitest run electron/confirmation/automationLane.test.ts electron/confirmation/approvalAgent.test.ts electron/confirmation/toolCallGate.test.ts`
- 完成判据：任务根传递测试通过；目录内写入不改变 locked deny；外部路径分类符合现有规则；审批 Agent 的风险/授权上限不变。

**G4. 跨层类型与本地化检查**

- 命令：`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`
- 完成判据：三命令均退出码为 0；preload/API 与共享类型一致；新增 UI 字符串无硬编码。

**G5. 全套测试与构建验证**

- 命令：`npm test`、`npm run build`（按仓库阶段门要求选择实际需要的完整验证）
- 完成判据：命令退出码为 0；若失败，开发计划不得标为完成，记录首个失败用例、首个错误及相关代码栈。

**G6. 需求验收矩阵逐项关闭**

- 动作：按需求 §7 的 7 条逐项链接实现和测试证据，任何未覆盖项标为未完成并注明阻塞。
- 完成判据：七条均有明确测试/代码证据；安全边界项明确证明权限没有被目录设置放宽；无“手工检查正常”这类不可复核描述。

## 5. 核心端到端验收矩阵

| 场景 | 准备 | 预期结果 | 证据位置 |
| --- | --- | --- | --- |
| 桌面 Profile 切换 | Profile A 下保存任务目录 T；切到 Profile B 后触发 | invocation、workspace snapshot、审批 Agent、路径探测均使用 T | Butler invoker 集成测试 + approval agent 测试 |
| 运行中改任务配置 | 任务开始时目录/model 为 T1/M1；运行中保存 T2/M2 | 当前 run 快照和调用仍为 T1/M1；下一 run 为 T2/M2 | invoker 快照测试 |
| 排队时改配置 | run 已排队但 admission 未返回时改任务配置 | admission 成功后从数据库重读并采用新配置 | invoker admission 控制测试 |
| 任务目录失效 | 保存目录后删除目录，再运行 | run 明确失败，不回退到当前桌面 Profile | 路径校验 + invoker 测试 |
| 模型路由不可用 | 禁用所选 service/model 或撤掉凭据 | run 明确失败，不使用其他 service/model，不调用 provider | config validation + invoker 测试 |
| 任务目录内 write_file | automation 在 task root 内调用 write_file | 仍由 `automation-write-deny` 拒绝 | `automationLane.test.ts` |
| task root 外写 | 目标在任务目录外，可能位于桌面当前 Profile | 按 automation 外部写规则处理，不因桌面 Profile 而视为任务内 | path facts + gate 测试 |
| 不支持 thinking 的模型 | 为模型提交 high/max | IPC 主进程拒绝；UI 同时不可选 | IPC 校验测试 + renderer 测试 |
| 旧数据迁移 | v32 库含有 modelOverride 的旧任务 | 新目录/model_id/service/effort 字段为 NULL，modelOverride（provider model name）逐字保留；设置页提示补配置 | migration + taskStore + UI 测试 |
| 旧任务目录兼容 | 旧任务目录 NULL；Profile A 下触发但在准入队列期间切换到 B | 准入后捕获 B 的路径到本次 run/session；不回填 task；会话建立后再切换 Profile 不漂移 | admission race + workspace integration tests |
| 旧任务目录无来源 | 旧任务目录 NULL 且无有效 active profile/path | run 失败并记录原因，不建 session、不 fallback、不回写 task | legacy resolver + invoker tests |
| 旧任务无模型 override | task 的 model_override NULL | 准入后捕获桌面当前的 model/service/effort pair；该 run 固定；不回填 task | legacy model resolver tests |
| 旧模型名重复 | 多个 model catalog entry 有相同 provider name | legacy 自动映射失败并要求编辑选择具体 pair，不按数组首项猜路由 | resolver + invoker tests |
| pair 路由稳定性 | 存储 model catalog ID 与 service ID 后调整 service 顺序 | 仍按指定 model ID/service ID 拿凭据、endpoint，并发送同一 provider model name | resolver + provider route integration test |
| 同名模型能力选择 | 两个 catalog ID 的 provider name 相同、`supportsThinking` 相反，反转目录顺序 | selected catalog ID 决定 requested/effective effort 和 degraded 记录，数组顺序无影响 | invocationAssembler capability test |
| 旧任务固定模型、空 effort | `model_override` 有值、`reasoning_effort` NULL；排队时改变桌面全局 effort | 准入后捕获全局 effort，写入 run/session/accepted turn；运行开始后桌面变化不影响本次；模型不支持时显式降至 off 并留痕 | legacy reasoning + invoker + accepted turn tests |
| Automation pinned turn config | task pair 解析后撤销/禁用 service，或修改桌面默认模型 | 受信 turn 解析失败且不改绑；session/accepted turn/run snapshot/provider request 不出现其他 model/service；桌面默认变化不影响有效已冻结 pair | `turnExecutionConfig.thinkingEffort.test.ts` + Butler integration |

## 6. 显式不做事项

- 不将任务目录配置转成写入授权；不移除/软化 `automation-write-deny`、`automation-shell-deny` 或其他 locked 规则。
- 不令自动化任务跟随桌面 Profile；创建时的桌面目录只作为初值，任务保存后没有联动。
- 不规定具体任务必须产出文件，不统一规定文件命名、覆盖和目录分层；这些由具体任务业务逻辑决定。
- 不把模型 API key 或完整产物内容写入任务配置或对外通知。

## 7. 交付关闭条件

- 阶段 A–G 每个任务均有可复核证据；无未勾选阻塞项被标记完成。
- 需求 §7 的验收项逐条映射到 §5 矩阵或具体测试名称。
- Profile 隔离、安全审核工作区与工具权限三个结论分别验证；不得用“路径在任务目录内”替代“工具获准执行”的判据。
