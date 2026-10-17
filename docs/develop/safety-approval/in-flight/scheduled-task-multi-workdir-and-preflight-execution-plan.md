# 定时任务多工作目录与预检执行计划

> 状态：进行中（E-01、E-02 已完成；执行方案其余任务继续推进）  
> 技术规格：[定时任务多工作目录与预检开发方案](./scheduled-task-multi-workdir-and-preflight-development-plan.md)  
> 需求与 AC 真源：[需求评审稿](../../../review/2026-10-17-scheduled-task-multi-workdir-and-preflight-requirement-review.md)  
> 计划规则：验收与不变量只引用技术方案中的 `INV-*` 和需求中的 `AC-*`；本文件只维护任务、依赖、证据与进度。

## 第 0 层：执行摘要【人必读】

**目标：** 通过可分段验收的实现，把多个明确授权目录、提交前预检、安全审核 Agent 多根识别和跳过运行历史接入现有定时任务链路。

**执行顺序：** 契约/基线 → 数据迁移与目录校验 → 主进程提交门禁 → 多根安全执行链 → 表单和历史 → 启动恢复/兼容集成 → 最终关闭。

**源码阶段可在当前环境验证：** 本地 Vitest、migration fixture、mock LLM、mock scheduler、renderer component、typecheck、i18n 和 incremental build。详见技术方案 §2.10。

**外部验收不阻塞源码：** 真实模型分析质量、真实安全审核 Agent、macOS/Windows 窗口与键盘辅助技术、真实 IM channel、打包升级/回退。

## 1. 准备与执行边界

### 第二轮阻断核销（2026-10-17）

| 评审项 | 对应执行项 | 出口证据 |
|---|---|---|
| R2-01 目标逻辑模型 | E-04、E-07、E-10 | exact/collection/output 各有解析与运行期判例；缺失输出允许；动态输入集合成员变化允许；歧义/越界失败；策略写拒绝保留。 |
| R2-02 旧任务无 binding 兼容 | E-02、E-03、E-07、E-10 | v0 旧任务按需求稿兼容运行；缺 roots 失败；阻断编辑不变；成功编辑/启用原子切换 v1；renderer 不能伪造 v0。 |
| R2-03 补跑游标恢复 | E-09、E-10 | skipped 游标停在最近补跑 slot；claim 与跨 slot 同事务；claim 前后退出均恢复；running 不转 skipped 或重放。 |
| R2-04 DAG 与任务边界 | E-01～E-10 | E-02a 独立于 E-05 完成；E-07 的 provider/store 前置齐全；类型收紧独立在 E-05 后；完成判据无后置产物。 |

该表记录本轮修订对应的执行证据，不代表任务已实施。

### 第三轮阻断核销（2026-10-17）

| 评审项 | 对应执行项 | 出口证据 |
|---|---|---|
| R3-01 恢复游标完整生命周期 | E-02、E-03、E-09、E-10 | 创建/迁移/普通 tick/改期/停用/启用/删除/重启转移表；正常运行历史不被重记为 skipped；pending 与调度变更入口的事务规则明确；随机操作序列含调度修改。 |
| R3-02 预创建 claim 真实续接 | E-03、E-07、E-09、E-10 | E-03 提供 queued→running CAS 与终态清 pending primitive；E-07 验真实 invoker 消费同一 runId；E-09 仅验证 scheduler port 交付既有 runId；E-10 验 scheduler 到真实 invoker 无重复插入且竞争仅一方进入 Agent。 |

E-09 的 mock/port 证据不宣称真实 invoker 已续接；跨层真实执行证据归 E-07/E-10。

### 开工决策记录（2026-10-17）

| 决策 | 用户选择 | 执行影响 |
|---|---|---|
| D-2 预检模型调用 | A：使用任务当前选定模型；不可用时阻断 | E-04 按技术方案调用无工具权限分析器；提交额外请求可能产生服务费用并发送任务文本 |
| D-3 会话事件位置 | A：应用私有 `{userData}/automation-sessions/<taskId>` | E-07 仅作为内部事件/session 根，绝不并入任务授权 roots |

### 第四轮阻断核销（2026-10-17）

| 评审项 | 对应执行项 | 出口证据 |
|---|---|---|
| R4-01 pending 期间配置编辑与运行快照隔离 | E-03、E-05、E-07、E-09、E-10 | 活动 run 未终结时保存新 roots/prompt 成功；running snapshot/facts/审批根不变；queued claim 与编辑竞争由 transaction 顺序决定，queued→running CAS 冻结当时 revision；queued 时调度改动返回冲突，running 时改期/启停新建 generation；旧终态只清理身份匹配的 pending；长运行跨槽位保持串行且不覆盖 pending。 |

### 1.1 开工复核

- 先运行技术方案 §2.1 的事实卡命令并记录当前 `git rev-parse HEAD`；若实现接口已变化，先更新技术方案和本计划依赖，不直接照旧路径开工。
- 检查 `git status --short`，保留所有既有用户改动；基线调查已见一个与本工作无关的未跟踪目录 `llm-wiki.migrated-20261015-135757/`，不得纳入或清理。
- P0 验证依赖就绪：`node_modules` 存在、`npm exec vitest -- --version` 成功、目标套件能启动；若失败先登记环境故障，不能将其算作目标行为 RED。

### 1.2 阶段检查点

| 检查点 | 依赖证据（产出任务） | 通过条件 | 不通过处理 |
|---|---|---|---|
| G0 兼容契约冻结 | E-01；技术方案 D-2、D-3 已裁决 | 可选过渡类型、adapter、目标 facts/binding、状态与 migration 映射契约通过静态评审；D-2/D-3 已明确 | 停止 P1，修订技术方案/此计划 |
| G1 存储安全 | E-02、E-03 | v0/v1 binding schema、recovery state 往返通过；高版本库拒绝降级；备份恢复可执行；旧空目录不回退 Profile | 不开始预检 IPC；修正迁移/存储 |
| G2 提交门禁 | E-02a、E-03、E-04、E-05 | 旧单根和新多根请求均经预检；阻断零写入、通过恰好一次写入、一次性时间语义正确 | 不接 UI save flow |
| G3 安全根集合 | E-06、E-07 | run snapshot、事实、策略 trace、审核 Agent 所见 roots 完全一致；原 locked deny 仍在 | 不进入 UI 发布集成；修订安全契约 |
| G4 可操作界面 | E-08、E-09 | 已批准归属卡下完成宽窗/窄窗、键盘清单、失败保留与历史可查 | 修 UI，不改变已冻结后端契约 |
| G5 全量源码关闭 | E-10 | 所有本机相关测试、类型、i18n、构建、边界审查完成 | 留在源码关闭前；外部验收另列 |

## 2. 依赖 DAG（唯一真源）

| 任务 ID | 动作 | 依赖 | 目标文件/模块 | 需求 AC | 技术不变量 |
|---|---|---|---|---|---|
| E-01 | 定义兼容期类型与目标/recovery contracts | — | shared types、adapter contracts；方案/计划 | AC-01、03、05、07、11、16 | INV-01、02、05、07、10–13 |
| E-02 | schema v103：目录、preflight version/binding、recovery state、run phase | E-01 | `schema.ts`、`migrations.ts`、`taskStore.ts` run columns、migration tests | AC-01、07、11、16 | INV-02、10、12、13 |
| E-03 | taskStore adapter、binding persistence 与完整调度代次/claim transaction primitives | E-01、E-02 | `taskStore.ts`、`taskConfigValidation.ts`、recovery/binding transaction tests | AC-01、08、09、11、15、16 | INV-01、02、10、12、13 |
| E-02a | 分批迁移生产者到 workDirs，保持兼容期可编译 | E-01、E-03 | IPC/UI/run callers、shared types、compat tests | AC-01、05、07、11 | INV-01、02、05 |
| E-04 | 实现受限 facts provider 与 exact/collection/output resolver | E-01、E-03、D-2 选择 A | `taskPathFacts.ts`、resolver、preflight tests/model wrapper | AC-03、04、05、14 | INV-05、06、11 |
| E-05 | 接通 create/update/enable 的预检与原子保存门禁 | E-02a、E-03、E-04 | `butlerIpc.ts`、tests、`preload.ts`、shared API | AC-05、06、06a、12 | INV-05、09、11、13 |
| E-05a | 门禁接通且调用方迁移后收紧必填 workDirs 类型 | E-02a、E-05 | shared types、all callers、typecheck | AC-01、05、07、11 | INV-01、02、05 |
| E-06 | 让路径 facts 对多个根作并集分类 | E-03、E-01 | path facts、gate、policy tests | AC-02、03a、09、10、14 | INV-02、03 |
| E-07 | 运行时按 binding kind 重验、续接既有 claim 并贯穿 roots 到审批 Agent | E-03、E-04、E-05、E-05a、E-06、D-3 选择 A | invoker、resolver runtime、assembler、approval/projection tests | AC-01a、01b、03a、07、08、09、10、11、16 | INV-01、03、04、08、11、12、13 |
| E-08 | 实现宽编辑表单、候选清单和门禁反馈 | E-05、E-05a、E-09 | Butler UI/styles/i18n/tests | AC-01、03、04、05、06、12、13、14 | INV-05、06、09 |
| E-09 | 按调度代次恢复 missed slots 并向内部端口分派既有 claim | E-02、E-03 | scheduler/recovery、taskStore transaction port、history API/tests | AC-07、16 | INV-07、08、12 |
| E-10 | 完成集成验收与源码关闭 | E-02、E-02a、E-03～E-09、E-05a | related tests、typecheck/i18n/build、review evidence | AC-01–16 | INV-01–13 |

任务范围与依赖一旦变化，先更新本表；不在正文另写第二份 DAG。

## 3. 任务登记

### E-01 定义兼容期共享类型、adapter 与提交结果契约

- **依赖：** 无。
- **目标文件：** `src/shared/automationTaskTypes.ts`；必要时 `src/shared/api.ts`；本执行计划和技术方案。
- **动作与产物：** 暂时保留 `workDir?` 并新增 `workDirs?`；增加唯一 adapter `getAutomationTaskWorkDirs()`、历史 snapshot 兼容读法、`PreflightReport`、目标绑定和结构化写入结果，以及 `failed/skipped` 稳定原因契约。此阶段不把 `workDirs` 改为必填。
- **完成判据：** 未迁移生产者仍能编译；adapter 只将明确旧单根转数组，缺失不从 Profile 补值；类型区分保存成功、预检阻断、校验错误和分析器不可用；没有默认工作目录。
- **验证命令：** `npm run typecheck:shared` 与现有主进程/渲染进程 typecheck。
- **可执行环境：** 本机。
- **证据：** `src/shared/automationTaskTypes.test.ts` 5 项通过；`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 均通过（首次 build 因缺失锁定的 pi-ai 包失败；按 lockfile 恢复 `0.87.1` 后通过）。RED：移除 `getAutomationTaskWorkDirs()` 后运行 `npm exec vitest run src/shared/automationTaskTypes.test.ts`，2 个 adapter 用例因函数缺失失败；恢复实现后 5 项全通过。GREEN：新增兼容共享契约与 adapter。G0 两项决策记录见本节上表。
- **状态：** - [x]

### E-02 增加 v103 目录、预检版本及恢复状态 schema

- **依赖：** E-01。
- **目标文件：** `electron/database/schema.ts`、`electron/database/migrations.ts`、相关 migration tests。
- **动作与产物：** 增加 `work_dirs_json`、`preflight_version DEFAULT 0`、`target_bindings_json NULL`、任务 `task_revision`/`schedule_generation`、带 generation/cursor/pending run 身份的 `automation_task_recovery_state` 表，以及 run phase/revision/generation/slot/可空 snapshot 字段；queued 未消费时 snapshot 为空，queued→running CAS 时与 task revision 一起原子冻结。旧任务迁移 workDir 到数组并标记 v0，旧 queued/running run 标记 legacy-unknown，cursor 从 `automation_tasks.next_run_at` 初始化；保留旧列。回退需恢复升级前备份。
- **完成判据：** schema fixture 升级正确；旧任务 binding 为空且 version=0；旧活动 run 变为可收敛的 legacy-unknown；缺目录不写 active Profile；游标初始化后迁移重跑稳定；高版本拒绝和备份恢复协议通过 fixture。
- **验证命令：** `npm exec vitest run electron/database/migrations*.test.ts`（选取受影响的 migration suites）；`npm run build:electron:incremental`。
- **证据：** `electron/database/migrations.automationPreflight.test.ts` 覆盖旧根/空根映射、v0/null binding、旧活动 run 收敛标记、恢复游标初始化、幂等、104 高版本拒绝、注入失败事务回滚及 v102 备份恢复后再次升级；与 `migrations.mainSchemaCompatibility.test.ts`、`migrations.wikiProjects.test.ts` 合并 11 项通过。`npm run build:electron:incremental` 通过。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-02a 逐层迁移生产者并保持兼容类型

- **依赖：** E-01、E-03 的兼容存储接口。
- **目标文件：** `electron/butler/butlerIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`、`ButlerTaskSettings.tsx`、`butlerInvoker.ts` 及其调用点。
- **动作与产物：** 只按 renderer 输入→IPC→store→run snapshot 迁移调用方到兼容 adapter 输出；旧单根输入规范化为 `workDirs`，本任务不接入预检、不改变运行语义、不收紧类型。
- **完成判据：** E-01、E-03 的 adapter/interface 可用，现存调用方迁移后可独立编译；旧单根输入转换正确；缺失目录不从 Profile 补值。旧请求预检由 E-05 验收，公共类型收紧由 E-05a 验收。此任务所有证据均来自 E-01/E-03 和本任务自身，不依赖 E-05。
- **验证命令：** 各小步执行 `npm run typecheck:shared`、`npm run typecheck:renderer`；主进程步骤执行 `npm run build:electron:incremental`。
- **证据：** 每步变更文件与编译记录、`rg workDir` 调用点清单、旧 IPC 转换测试。
- **可执行环境：** 本机。
- **状态：** - [ ]

### E-03 让 taskStore 和目录校验读写 canonical roots

- **依赖：** E-01、E-02。
- **目标文件：** `electron/butler/taskStore.ts`、`electron/butler/taskConfigValidation.ts`、新增/对应 tests、`src/shared/automationTaskTypes.ts`。
- **动作与产物：** 实现目录数组校验、adapter、`target_bindings_json` 映射和 task transaction；实现 `preflight_version` 读写、v0→v1 原子转换；分离 `task_revision` 与 `schedule_generation`。普通配置编辑可在 queued/running pending 期间通过预检后原子保存，只更新 task revision，不变更 running snapshot、cursor 或 pending；queued claim 尚无 snapshot，queued→running CAS 在同一事务读取并冻结当时 task revision/config。编辑先于 CAS 则 queued run 用新配置，CAS 先于编辑则 run 固定旧配置、编辑只供后续 run。queued pending 时改期/启停返回 `schedule-pending`，running pending 时改期/启停允许创建新 generation 并重算 cursor，但保留旧 run 的 pending 身份；删除在任一非终态 run 存在时冲突。正常 tick 在同一事务创建 queued run、推进 `automation_tasks.next_run_at` 和 cursor；长运行跨槽时不覆盖 pending，cursor 停在首个未核销槽位。实现 skipped/claim/pending 同步事务 primitives，终态按 `runId + pending_schedule_generation` 条件清除。提供 `claimDueSlotAndAdvance`、`transitionClaimToRunning(runId, taskId, slot, generation)`（CAS 同时冻结 snapshot）和 `finalizeClaimAndClearPending` 条件更新/CAS。新契约不从 `work_dir` 或 Profile 回退。
- **完成判据：** roots 往返与并发冲突正确；v0 空 binding 可读、v1 binding 必须与 task revision 一起写；阻断不改任务；运行中的 roots/prompt 编辑保存成功且旧 snapshot 不变；queued 编辑/CAS 竞争结果符合事务先后且 snapshot revision 与赢家一致；cursor 与 next_run_at 的每类转移同成同败；抢占 runId 只能有一个 queued→running 成功者；旧 run 终态不能清除不匹配 pending 或覆盖新 generation；长运行跨多个 slot 不覆盖 claim；transaction rollback fixture 证明无部分状态。兼容 adapter API 可供 E-02a 使用。
- **验证命令：** `npm exec vitest run electron/butler/taskStore.test.ts electron/butler/taskConfigValidation.test.ts`；`npm run build:electron:incremental`。
- **证据：** `taskStore.test.ts` 覆盖多根/legacy round-trip、显式空集合、taskRevision/scheduleGeneration 与 recovery cursor、v0→v1 bindings 持久化；`taskConfigValidation.test.ts` 覆盖 canonicalize/dedupe/fail-whole-set；`butlerIpc.test.ts` 覆盖多根更新。三套测试共 33 项通过；`npm run build:electron:incremental`、`npm run typecheck:shared`、`npm run typecheck:renderer` 通过。仍未覆盖 queued/running pending 冲突、claim CAS 冻结 snapshot、终态身份清理及完整 recovery cursor 生命周期；任务保持进行中。
- **可执行环境：** 本机。
- **状态：** - [～]

### E-04 实现无工具权限的结构化目标预检

- **依赖：** E-01、E-03；技术方案 D-2 选择 A。若 D-2 选择 B，先修订需求与本计划，本任务不得按当前规格实现。
- **目标文件：** 新增 `electron/butler/taskPathFacts.ts`、目标 resolver、`taskPreflight.ts` 与测试；使用主进程模型路由/client 注入方式。
- **动作与产物：** 实现受限 provider 与 exact/collection/output 结构化 resolver，产出 binding proposal；调用无工具权限的目标分析器并聚合目录候选。持久化字段与事务 API 属于 E-02/E-03，正式提交写入由 E-05 承担。
- **完成判据：** 唯一与歧义布局结果不同；不存在的输出子路径通过祖先授权检查；collection 在 selector 范围内允许新增成员；普通文件原子替换不构成绑定变化；越界/不完整 coverage fail closed；分析器无工具权限。超时、模型不可用、无效 JSON 阻断。
- **验证命令：** `npm exec vitest run electron/butler/taskPreflight.test.ts electron/butler/taskConfigValidation.test.ts`；分析器纯逻辑用固定 fixture，不访问外网。
- **证据：** 判例矩阵、facts coverage/digest、proposal 结构与无工具能力断言。
- **可执行环境：** 本机 mock；真实模型质量为外部验收。
- **状态：** - [ ]

### E-05 将 create/update/enable 门禁留在主进程

- **依赖：** E-02a、E-03、E-04。
- **目标文件：** `electron/butler/butlerIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`、`electron/butler/butlerIpc.test.ts`。
- **动作与产物：** create/update IPC 将 legacy 单根和新多根输入经 adapter 规范化，在同一 handler 捕获请求时间、校验、预检并原子保存字段与 `preflight_version=1`/bindings；阻断不写。v0 task 主动启用需通过预检后在一个事务升级为 v1 并启用。新增 request fingerprint/version conflict 保障。
- **完成判据：** 旧单根请求确实调用新 preflight；blocker/超时无 insert/update；通过只写一次；编辑或启用阻断时旧 task、旧 v0 状态不变；成功编辑/启用时 task fields、bindings、version 与启用状态原子一致；新建无 legacy 参数；renderer 不能传 v0；一次性时间使用请求到达时刻且不在预检完成后重算。
- **验证命令：** `npm exec vitest run electron/butler/butlerIpc.test.ts electron/butler/taskOnce.test.ts`；`npm run typecheck:shared`。
- **证据：** IPC 调用计数、数据库前后快照、once 时间边界结果。
- **补充完成判据：** 运行中的 roots/prompt 编辑通过预检后可保存；它不改 running snapshot；queued claim 在 run-start CAS 时使用该事务可见的最新 revision。
- **可执行环境：** 本机。
- **状态：** - [ ]

### E-05a 在门禁接通后收紧 workDirs 类型

- **依赖：** E-02a、E-05。
- **目标文件：** shared task types、preload/API、所有 renderer/main task producers 和 consumers。
- **动作与产物：** 全仓调用点迁移且新旧 IPC 兼容转换已由 E-05 覆盖后，将公共 `AutomationTask`/input 的 `workDirs` 改为必填，移除公共 `workDir`；数据库旧列仅保留 migration/恢复用途。
- **完成判据：** E-02a 的兼容调用迁移已通过；E-05 的旧单根 payload 预检行为已通过；收紧提交本身包含最后剩余调用迁移并通过 shared/renderer typecheck 与 electron incremental build。无断言、空数组占位或 Profile fallback。
- **验证命令：** `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental`。
- **证据：** `rg workDir` 调用点清单、旧 IPC 转换用例和三项编译记录。
- **可执行环境：** 本机。
- **状态：** - [ ]

### E-06 让路径 facts 对多个根作并集分类

- **依赖：** E-03、E-01。
- **目标文件：** `electron/confirmation/extractors/readPathFacts.ts`、相关写路径 facts、`electron/confirmation/toolCallGate.ts` 及相邻测试、共享 policy tests。
- **动作与产物：** 所有 path fact 输入改为 task roots 集合；根内任意目标标识 inside-workdir；未知/敏感/系统/链接逃逸保留现有更严格分类；automation locked policy 继续通过 Policy Engine 和 trace 管理。
- **完成判据：** 各根、父子根、交换顺序、重复根、symlink escape、路径不存在、权限拒绝、敏感位置均有边界测试；除范围并集事实外，无策略放宽；policy trace 有稳定 rule ID。
- **验证命令：** `npm exec vitest run electron/confirmation/extractors/readPathFacts.test.ts electron/confirmation/extractors/writePathFacts.test.ts electron/confirmation/toolCallGate.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/defaultRules.contract.test.ts`。
- **证据：** path fact 输入输出对照 + Policy Engine trace assertion；若新增不可配置约束，附 registry entry 与 `npm run check:system-invariant-registry`。
- **可执行环境：** 本机。
- **状态：** - [ ]

### E-07 将同一根集合贯穿运行快照、执行链与安全审核 Agent

- **依赖：** E-03、E-04、E-05、E-05a、E-06；技术方案 D-3 选择 A。若选择 B，先修订授权的数据位置契约和目标文件清单。
- **目标文件：** `electron/butler/butlerInvoker.ts`、`electron/butler/taskStore.ts` run phase transition、`electron/runtime/invocationAssembler.ts`、`electron/confirmation/approvalAgent.ts`/路径材料端口、`electron/chatMessageBuild.ts`、共享结果 projection 与 tests。
- **动作与产物：** 拆分外部新触发 claim 与主进程内部 `executeClaimedRun(runId)`。queued claim 只固定 runId/taskId/slot/generation；入口校验身份后，在唯一 queued→running CAS 事务中读取当前 task revision 并冻结 roots、bindings 和执行配置。CAS 后只加载该 snapshot，不从可变 task 行重建当前 run 配置；不再 insert 第二条 run、不接受 renderer 提供 runId。正常 tick 和恢复分派共用该入口。v1 按 snapshot 中的 exact/collection/output binding 动态构造 selection，v0 遵循旧提示词语义。传递 snapshot roots 给工具 facts、审批 Agent 和 final-check；修正单根 workspaceRoot 隐式依赖。
- **完成判据：** v1 分别按 exact/collection/output 语义重验；越界、不完整扫描、新歧义或无效祖先在 executor 前失败，动态集合成员变化和逻辑路径上的原子替换按契约通过。v0 旧任务无 bindings 时按需求稿 legacy 语义运行；缺 roots 失败；成功编辑/启用后 v1。运行中保存新 roots 后，当前 run snapshot/facts/审批 roots 不变，后续 run 使用新 roots。snapshot、facts、审批 Agent roots 逐项相同；tool policy deny 是 failed，不是 skipped。直接调用既有 runId 实际进入 invoker 一次，不插入第二条 run；重复/并发消费者最多一个通过 CAS 并进入 Agent；running 后进程退出由恢复逻辑收敛为 interrupted 且不重放。
- **验证命令：** `npm exec vitest run electron/butler/butlerInvoker.test.ts electron/butler/butlerSessionEvents.test.ts electron/confirmation/automationLane.test.ts electron/chatMessageBuild.test.ts` 与新增 roots integration tests；必要时 `npm run check:system-invariant-registry`。
- **证据：** 端到端同值对拍、布局变更前后 facts/binding 对照与 executor 未调用断言。
- **可执行环境：** 本机 mock Agent/模型；真实审批 Agent 语义为外部验收。
- **状态：** - [ ]

### E-08 实现表单、授权清单与提交反馈

- **依赖：** E-05、E-05a、E-09。
- **目标文件：** `src/renderer/components/Config/ButlerTaskSettings.tsx`、对应测试、`src/renderer/styles.css`、`src/renderer/i18n/resources/zh-CN/config.json`、`en-US/config.json`、生成的 i18n types。
- **动作与产物：** 按已批准归属卡加宽 Modal，宽屏双栏/窄窗单栏；目录列表显示完整路径并可增删；提交触发 preflight，pass 自动保存，blocked 保留输入及候选清单；勾选加入 form roots；历史中的 skipped/failed 显示清楚。
- **完成判据：** checkbox 默认未选、Tab/Space 可用、路径/用途进 accessible name，长路径可读；检查期间防重复提交；编辑失败内容保留；enable 阻断时打开编辑表单显示报告并保持停用；响应式布局无横向溢出；所有新增文案走 i18n。
- **验证命令：** `npm exec vitest run src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm run typecheck:renderer`；`npm run i18n:generate-types`；`npm run i18n:check`。
- **证据：** component interaction tests + 手动宽/窄窗口和键盘检查记录。
- **可执行环境：** 本机自动测试；视觉/辅助技术平台验收外部。
- **状态：** - [ ]

### E-09 原子恢复错过槽位并恢复补跑 claim

- **依赖：** E-02、E-03。
- **目标文件：** `electron/butler/taskStore.ts`、`taskScheduler.ts`、recovery state schema/store tests；history query API、delivery guard tests。
- **动作与产物：** 使用 `schedule_generation` 与首个未核销槽位 cursor；覆盖创建/迁移/正常 tick/改期/停用/启用/删除/重启转移，并排除已有 run 的槽位。scheduler 在事务建立 pending claim 后，只通过内部 scheduler port 把同一个 `runId` 交给 invoker adapter；启动恢复与在线分派使用同一稳定键。普通配置编辑不改变 running snapshot；queued run 在 queued→running CAS 时冻结当前 task revision。queued pending 时调度变更冲突；running pending 时允许重设 schedule generation/cursor，但不覆盖旧 pending；同一 task 串行运行，长运行跨槽时 cursor 停在首个未核销槽位，旧 run 终态后恢复处理。E-09 不实现也不声称真实 invoker 消费：本任务用 spy port 验证只交付既有 runId、不会新建第二 claim；真实入口由 E-07，跨层验收由 E-10。旧 legacy-unknown 活动记录收敛为 interrupted，不依赖 client_id 推断。running 只可终结/中断，绝不转 skipped 或重放。提供稳定 history query 和 skipped 原因。
- **完成判据：** 正常在线多次执行后重启无重复 skipped；活动运行期间配置编辑成功且 running 快照不变；queued claim 与编辑并发时 CAS 冻结事务顺序中最后提交的配置；queued pending 时改期/停用/启用冲突，running 时调度变更建立新 generation，旧终态不清除不匹配 pending 或改写新 cursor；删除在任一非终态 run 时冲突；长运行跨槽不覆盖 pending，终结后从 cursor 恢复；skipped 后/claim 前退出时 cursor 指向补跑槽位；claim 后退出时恢复器只分派同一 runId；run-start 后退出成为 interrupted 且不重跑；终态与清除匹配 pending 同事务；旧 legacy-unknown 活动记录不被误判为 missed claim；跨重启覆盖无遗漏、无重复；history API 返回稳定原因且 skipped 不触发 delivery。随机操作序列包含配置编辑、调度修改、启停、删除、重启、claim 与退出。历史 UI 由 E-08 展示。
- **验证命令：** `npm exec vitest run electron/butler/taskScheduler.test.ts electron/butler/butlerDelivery.test.ts electron/butler/taskStore.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`。
- **证据：** DB history rows、事务退出注入、随机全生命周期序列不变量断言、scheduler port spy、delivery spy。界面状态/原因断言归 E-08。
- **可执行环境：** 本机。
- **状态：** - [ ]

### E-10 完成重启恢复、兼容、集成验收与源码关闭

- **依赖：** E-02、E-02a、E-03、E-04、E-05、E-05a、E-06、E-07、E-08、E-09。
- **目标文件：** 上述变更涉及的全部模块和定向测试；本计划的证据栏。
- **动作与产物：** 对 R2-01～R2-04、R3-01～R3-02 执行故障注入和集成复核；验证备份恢复回退协议、v0/v1 目标路径分支、恢复游标完整生命周期、预创建 claim 到真实 invoker 的续接、DAG 前置证据和阶段编译；执行相关回归与最终 renderer/shared type/i18n/electron build。
- **完成判据：** 技术方案 §2.8 所有 AC 有测试或外部验收记录；第二、三轮阻断关闭证据齐全；数据库不承诺直接降级打开；跳过与运行失败区分明确；正常 tick/恢复竞争只有一个消费者进入 Agent，且使用原 runId；安全阶段、rule/invariant ID 与验证命令登记完整。
- **验证命令：** `npm run test:related -- electron/butler/taskScheduler.ts electron/butler/taskStore.ts electron/butler/taskConfigValidation.ts electron/butler/butlerIpc.ts electron/butler/butlerInvoker.ts electron/confirmation/extractors/readPathFacts.ts electron/confirmation/extractors/writePathFacts.ts electron/confirmation/toolCallGate.ts electron/runtime/invocationAssembler.ts electron/chatMessageBuild.ts src/renderer/components/Config/ButlerTaskSettings.tsx src/shared/automationTaskTypes.ts src/shared/claudeToolHistory.ts src/shared/agentToolResult.ts src/shared/processResultProjection.ts`；`npm run typecheck:shared`；`npm run typecheck:renderer`；`npm run i18n:check`；`npm run build:electron:incremental`。按 `AGENTS.md` 不在开发循环中运行全量 `npm test`；最终验收/提交前再按仓库策略执行。
- **证据：** 命令记录、AC→测试映射、migration fixture、security decision trace、未验证外部项列表。
- **可执行环境：** 源码关闭为本机；外部项独立记录。
- **状态：** - [ ]

## 4. 外部验收（不阻塞源码关闭）

| 编号 | 项目 | 验收人/环境 | 证据 |
|---|---|---|---|
| X-01 | 真实模型对需求歧义判例的一致性、延迟、超时行为 | 产品/测试环境中的真实模型服务 | 判例集结果和请求时延记录；不能用一次通过代替稳定性结论 |
| X-02 | 安全审核 Agent 对跨多个用户授权目录不再误判工作目录外，且仍拒绝集合之外目标 | 真实审批模型 + 本地隔离目录 | 输入 roots、decision trace、executor 未调用/调用证据 |
| X-03 | 宽屏双栏、窄窗口回退、中文长路径与键盘辅助技术 | macOS/Windows 桌面包 | 截图、操作记录、键盘可达性清单 |
| X-04 | 数据库升级/旧版本回退 | 打包应用副本 + v102 数据副本及升级前备份 | 新版迁移成功；旧版打开升级库被高版本保护拒绝；恢复升级前备份后旧版启动成功；再次升级结果可读；列明升级后数据不包含在旧备份中的损失边界 |
| X-05 | 跳过无特殊通知、运行历史可见；本期不触发 IM 特殊通知 | 配置真实飞书/微信账号的验收环境 | skipped event / delivery journal 对照 |

## 5. 开发进度记录

本节只记录实际进度，不改变技术方案中的验收或契约。开始实现后，每个任务状态变化时更新相应登记项，并在任务下注明验证证据；没有证据不得勾选完成。

