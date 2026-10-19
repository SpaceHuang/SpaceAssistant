# 定时任务多工作目录与预检执行计划

> 状态：E-01～E-15g 已完成
> 技术规格：[定时任务多工作目录与预检开发方案](./scheduled-task-multi-workdir-and-preflight-development-plan.md)  
> 需求与 AC 真源：[需求评审稿](../../../review/2026-10-17-scheduled-task-multi-workdir-and-preflight-requirement-review.md)  
> 计划规则：验收与不变量只引用技术方案中的 `INV-*` 和需求中的 `AC-*`；本文件只维护任务、依赖、证据与进度。

## 第 0 层：执行摘要【人必读】

**目标：** 预检后向用户展示可理解的权限清单和覆盖状态；若预算停止但独立总结与主机校验成功，用户仍可确认已列权限，主进程保存授权记录并把部分覆盖事实一并交给安全审核 Agent。后续运行冻结该记录；清单外权限不因此获批。本地 Git 历史查询根据仓库 facts 和任务模型的权限需求完成目标绑定，执行阶段继续经过现有 Shell 安全边界。

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
| D-4 目录职责拆分 | 必选结果输出目录 + 可空授权读写目录；旧 workDirs 只迁移为授权目录 | 新任务必须选择结果输出目录；旧任务未编辑保持 legacy 运行，首次编辑须明确选择 |
| D-5 归档默认 | 每日→日期；间隔定时→日期小时；一次性→直接；用户可改 | 使用本机 `scheduledFor` 确定归档路径；同日/小时运行共享目录 |
| D-6 无人值守写入 | 文件工具只允许写本次预检绑定且位于本次归档目录的结果 | 新增稳定 Policy Engine rule；输出目录不授权读取；任务级 Shell 权限由 D-7 定义 |
| D-7 任务级访问授权 | 预检展示资料读写、结果写入、需要时的 Shell 完整命令与工作目录、投递权限；执行超时不进入清单或授权校验，由 Agent 按运行情况选择；用户确认后由主进程留存授权事实，任务表单不再单独勾选 Shell | E-12a～E-12d 完成授权与 Git 基础；E-13a～E-13c 补齐清单、一次性确认记录、运行快照和审核 Agent 输入；E-14 将执行超时从授权边界剥离；不新增 Git 工具 |

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
| G0 兼容契约冻结 | E-01；D-2～D-7 已裁决 | 既有 v0/v1 契约与补充 outputDir/organization/authorizedDirs、主进程授权记录、一次性确认和运行期审核事实边界均已记录 | 停止补充实现，修订技术方案/此计划 |
| G1 存储安全 | E-02、E-03 | v0/v1 binding schema、recovery state 往返通过；高版本库拒绝降级；备份恢复可执行；旧空目录不回退 Profile | 不开始预检 IPC；修正迁移/存储 |
| G2 提交门禁 | E-02a、E-03、E-04、E-05 | 旧单根和新多根请求均经预检；阻断与预检通过但未确认均零写入；预检通过只暂存一次性确认票据和权限清单；用户明确确认后恰好一次提交票据绑定快照；一次性时间语义正确 | 不接 UI save flow |
| G3 安全根集合、结果写入与 Shell 授权 | E-06、E-07、E-11b～E-11d、E-12a～E-12d、E-13a～E-13b、E-14 | 输出目录仍不进入读取授权；文件工具写入仍要求预检绑定；Shell 仅在版本匹配的主进程用户确认记录冻结到 run snapshot，且通过危险/路径/完整度/unsupported 检查后可达；授权精确匹配命令与工作目录，timeout 不参与授权判断；审核 Agent 收到宿主事实 | 不进入 UI 集成；修订 facts、policy 或 final-check |
| G4 可操作界面 | E-08、E-09 | 已批准归属卡下完成宽窗/窄窗、键盘清单、失败保留与历史可查 | 修 UI，不改变已冻结后端契约 |
| G5 全量源码关闭 | E-10、E-11f、E-12d、E-13c、E-15c、E-15g | 所有本机相关测试、类型、i18n、构建、边界审查完成 | 留在源码关闭前；外部验收另列 |

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
| E-11a | 冻结拆分目录类型、默认归档与 v104 迁移契约 | E-10；D-4、D-5 | shared task types、schema/migration/store types、migration tests | AC-01、07、11、13 | INV-14、15 |
| E-11b | 实现计划时刻归档目录解析和输出 binding 规则 | E-11a | output directory helper、target resolver/preflight tests | AC-03、04、08、14 | INV-15 |
| E-11c | 接入只允许绑定结果路径的自动化写策略 | E-11b；D-6 | facts producer、policy rules、tool final-check、security boundary tests | AC-03a、08、09、10 | INV-15、16 |
| E-11d | 将拆分配置与 runOutputDir 贯穿存储、IPC 和运行链 | E-11a～E-11c | taskStore、scheduler snapshot、butler IPC/invoker/assembler tests | AC-01、01a、05、07、11 | INV-14～16 |
| E-11e | 设置表单、动态默认、摘要与中英文文案 | E-11a、E-11d | ButlerTaskSettings、styles、i18n、renderer tests | AC-01、05、13 | INV-14、15 |
| E-11f | 补充阶段集成验收并关闭结果目录拆分 | E-11a～E-11e | related tests、typecheck/i18n/build、security review | AC-01–16 | INV-14～16 |
| E-12a | 持久化任务级访问权限并冻结到 run snapshot | E-11d；D-7 | shared task types、schema/migration、taskStore、Butler IPC、store/migration/IPC tests | AC-17 | INV-17 |
| E-12b | 提供本地 Git 仓库 facts 并增强目标预检 | E-12a、E-04 | `taskPathFacts.ts`、preflight/analyzer、local Git prompt and clarification tests | AC-17 | INV-17 |
| E-12c | 接通授权 Shell 策略与任务设置表单 | E-12a、E-12b | tool gate、invocation assembler、policy rules、invariant registry、Butler UI/i18n/tests | AC-17 | INV-16、17 |
| E-12d | 集成验证并关闭访问授权扩展 | E-12a～E-12c | related tests、typecheck/i18n/build、system invariant check、review and plan status | AC-17 | INV-16、17 |
| E-13a | 由主进程生成权限清单并在保存前展示给用户 | E-12b | Butler IPC/preflight、`ButlerTaskSettings`、zh-CN/en-US、IPC/component tests | AC-17 | INV-17 |
| E-13b | 用户确认后持久化主进程授权记录并传给安全审核 Agent | E-12a、E-13a | preload/API、taskStore、claim snapshot、invocation assembler、AgentChannel/approval prompt tests | AC-17 | INV-17 |
| E-13c | 核验一次性票据、任务版本失效边界并完成阶段验证 | E-13a、E-13b | IPC/store/security/UI regression、typecheck/i18n/build/invariant checks、方案与执行计划 | AC-17 | INV-17 |
| E-14 | 将 run_shell 执行超时从任务授权中剥离 | E-13a～E-13c | preflight、授权记录/parser/matcher、automation gate、Butler UI/i18n、system invariant 与对应测试、方案/计划 | AC-17 | INV-17 |
| E-15a | 定义隔离 Mock runner、拟调用轨迹与运行预算 | E-04、E-13a～E-13c、E-14 | `taskPreflightMockRunner.ts`、轨迹类型、预算边界测试、开发方案 §2.3 | AC-17 | INV-17 |
| E-15b | 接入所选模型与全部工具的纯 Mock dispatcher | E-15a | `taskPreflightModelAnalyzer.ts`、工具映射与 Mock adapter、analyzer tests | AC-17 | INV-17 |
| E-15c | 验证零真实副作用、预算终止和确认门禁 | E-15a、E-15b | executor/process/MCP/network/delivery spies、preflight/IPC tests、门禁验证 | AC-17 | INV-17 |
| E-15d | 分离 Mock 演练与权限总结会话 | E-15a～E-15c | 模型请求、轨迹核验和预算测试、需求与开发方案 | AC-17 | INV-17 |
| E-15e | 移除独立的小额输出 token 截断 | E-15a～E-15d | Mock runner/analyzer、模型配置和截断提示 tests | AC-17 | INV-17 |
| E-15f | 定位并修复预检模型请求失败 | E-15e | analyzer/IPC/preflight/UI 与日志分类 tests | AC-17 | INV-17 |
| E-15g | 让预算停止后的部分清单进入用户复核并传递覆盖事实 | E-15d、E-15f | preflight、授权记录/store snapshot、approval Agent、UI、边界 tests、需求/方案/计划 | AC-17 | INV-17 |

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
- **证据：** RED：移除执行端 Profile 路径回退后，原有“无 Profile”测试 fixture 暴露了活动 Profile 仍能补根的缺口；补充“任务无存根、Profile 有路径也失败”断言。GREEN：`butlerInvoker.test.ts` 51 项通过，覆盖执行快照记录 canonical `workDirs`/`preflightVersion`/`taskRevision`/target bindings、旧任务根缺失失败、活动 Profile 不补值；`butlerIpc.test.ts` 与 `ButlerTaskSettings.test.tsx` 合并 25 项通过，覆盖旧单根更新规范化为 `workDirs`、默认值不含 Profile 根、新建请求提交数组根及取消目录选择不填值。`npm run build:electron:incremental`、`npm run typecheck:renderer`、`npm run typecheck:shared` 与 `git diff --check` 通过。`rg -n "workDir|workDirs"` 确认 preload/shared API 通过共享任务 DTO 推导，无单独旧目录通道；IPC 对旧 `workDir` create/update 请求显式转换为根数组。`ButlerTaskSettings` 新建不再自动预填 Profile 工作目录。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-03 让 taskStore 和目录校验读写 canonical roots

- **依赖：** E-01、E-02。
- **目标文件：** `electron/butler/taskStore.ts`、`electron/butler/taskConfigValidation.ts`、新增/对应 tests、`src/shared/automationTaskTypes.ts`。
- **动作与产物：** 实现目录数组校验、adapter、`target_bindings_json` 映射和 task transaction；实现 `preflight_version` 读写、v0→v1 原子转换；分离 `task_revision` 与 `schedule_generation`。普通配置编辑可在 queued/running pending 期间通过预检后原子保存，只更新 task revision，不变更 running snapshot、cursor 或 pending；queued claim 尚无 snapshot，queued→running CAS 在同一事务读取并冻结当时 task revision/config。编辑先于 CAS 则 queued run 用新配置，CAS 先于编辑则 run 固定旧配置、编辑只供后续 run。queued pending 时改期/启停返回 `schedule-pending`，running pending 时改期/启停允许创建新 generation 并重算 cursor，但保留旧 run 的 pending 身份；删除在任一非终态 run 存在时冲突。正常 tick 在同一事务创建 queued run、推进 `automation_tasks.next_run_at` 和 cursor；长运行跨槽时不覆盖 pending，cursor 停在首个未核销槽位。实现 skipped/claim/pending 同步事务 primitives，终态按 `runId + pending_schedule_generation` 条件清除。提供 `claimDueSlotAndAdvance`、`transitionClaimToRunning(runId, taskId, slot, generation)`（CAS 同时冻结 snapshot）和 `finalizeClaimAndClearPending` 条件更新/CAS。新契约不从 `work_dir` 或 Profile 回退。
- **完成判据：** roots 往返与并发冲突正确；v0 空 binding 可读、v1 binding 必须与 task revision 一起写；阻断不改任务；运行中的 roots/prompt 编辑保存成功且旧 snapshot 不变；queued 编辑/CAS 竞争结果符合事务先后且 snapshot revision 与赢家一致；cursor 与 next_run_at 的每类转移同成同败；抢占 runId 只能有一个 queued→running 成功者；旧 run 终态不能清除不匹配 pending 或覆盖新 generation；长运行跨多个 slot 不覆盖 claim；transaction rollback fixture 证明无部分状态。兼容 adapter API 可供 E-02a 使用。
- **验证命令：** `npm exec vitest run electron/butler/taskStore.test.ts electron/butler/taskConfigValidation.test.ts`；`npm run build:electron:incremental`。
- **证据：** RED/GREEN：multi-root store/validator、trusted v1 binding、queued CAS、pending mutation、due claim、skipped recovery 用例均先确认旧行为失败后实现。`taskStore.test.ts` 覆盖 roots/legacy 往返、显式空集合、taskRevision/scheduleGeneration、v0→v1 bindings、queued 编辑后单次 CAS 冻结最新快照、运行期间编辑不改变快照、queued schedule conflict、running 新 generation 保留旧 pending、终态只清同 run/generation、due claim/nextRun/cursor 同事务、pending 防重入、missed-window 完整终态/幂等及创建/claim 故障注入回滚；`taskConfigValidation.test.ts` 覆盖 canonicalize/dedupe/fail-whole-set；`butlerIpc.test.ts` 覆盖多根更新及稳定冲突返回。三套测试共 41 项通过；`npm run build:electron:incremental`、`npm run typecheck:shared`、`npm run typecheck:renderer` 通过。E-03 完成。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-04 实现无工具权限的结构化目标预检

- **依赖：** E-01、E-03；技术方案 D-2 选择 A。若 D-2 选择 B，先修订需求与本计划，本任务不得按当前规格实现。
- **目标文件：** 新增 `electron/butler/taskPathFacts.ts`、目标 resolver、`taskPreflight.ts` 与测试；使用主进程模型路由/client 注入方式。
- **动作与产物：** 实现受限 provider 与 exact/collection/output 结构化 resolver，产出 binding proposal；调用无工具权限的目标分析器并聚合目录候选。持久化字段与事务 API 属于 E-02/E-03，正式提交写入由 E-05 承担。
- **完成判据：** 唯一与歧义布局结果不同；不存在的输出子路径通过祖先授权检查；collection 在 selector 范围内允许新增成员；普通文件原子替换不构成绑定变化；越界/不完整 coverage fail closed；分析器无工具权限。超时、模型不可用、无效 JSON 阻断。
- **验证命令：** `npm exec vitest run electron/butler/taskPreflight.test.ts electron/butler/taskConfigValidation.test.ts`；分析器纯逻辑用固定 fixture，不访问外网。
- **证据：** RED：新增 `taskPathFacts.test.ts`、`taskTargetResolver.test.ts`、`taskPreflight.test.ts`、`taskPreflightModelAnalyzer.test.ts` 后，目标模块缺失时各自以 `Cannot find module` 失败。GREEN：`TaskPathFactsProvider` 限定已选 roots，symlink 不跟随，深度/每根/总量限额产生 coverage 标记，权限错误 fail closed，规范化 entries 生成 digest；resolver 覆盖唯一/歧义 basename、绝对路径越界、目标类型、output 最近根内祖先、逃逸、symlink 祖先、固定 collection selector 与 incomplete coverage；`runTaskPreflight` 覆盖 empty target blocker、incomplete facts、模型错误、坏 schema、timeout abort；Anthropic adapter 通过任务当前 model/service 调 `resolveLlmCredentialsForPair`，请求没有 `tools`，response JSON 结构校验失败 closed。四个相关测试文件共 16 项通过。`npm run build:electron:incremental`、`npm run typecheck:shared`、`git diff --check` 通过。真实模型语义质量为计划声明的外部验收，未用于源码关闭判据。
- **可执行环境：** 本机 mock；真实模型质量为外部验收。
- **状态：** - [x]

### E-05 将 create/update/enable 门禁留在主进程

- **依赖：** E-02a、E-03、E-04。
- **目标文件：** `electron/butler/butlerIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`、`electron/butler/butlerIpc.test.ts`。
- **动作与产物：** create/update IPC 将 legacy 单根和新多根输入经 adapter 规范化，在同一 handler 捕获请求时间、校验、预检并原子保存字段与 `preflight_version=1`/bindings；阻断不写。v0 task 主动启用需通过预检后在一个事务升级为 v1 并启用。新增 request fingerprint/version conflict 保障。
- **完成判据：** 旧单根请求确实调用新 preflight；blocker/超时无 insert/update；通过只写一次；编辑或启用阻断时旧 task、旧 v0 状态不变；成功编辑/启用时 task fields、bindings、version 与启用状态原子一致；新建无 legacy 参数；renderer 不能传 v0；一次性时间使用请求到达时刻且不在预检完成后重算。
- **验证命令：** `npm exec vitest run electron/butler/butlerIpc.test.ts electron/butler/taskOnce.test.ts`；`npm run typecheck:shared`。
- **证据：** `electron/butler/butlerIpc.test.ts` 覆盖旧单根更新、blocker/不可用零写入、通过后 v1 + binding 持久化、once 到达时间边界与并发 taskRevision 冲突；`electron/butler/taskStore.test.ts` 覆盖期望修订号条件提交；`npm exec vitest run -- electron/butler/butlerIpc.test.ts electron/butler/taskStore.test.ts --reporter=dot`（41 项通过）；`npm run build:electron:incremental` 通过。
- **补充完成判据：** 运行中的 roots/prompt 编辑通过预检后可保存；它不改 running snapshot；queued claim 在 run-start CAS 时使用该事务可见的最新 revision。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-05a 在门禁接通后收紧 workDirs 类型

- **依赖：** E-02a、E-05。
- **目标文件：** shared task types、preload/API、所有 renderer/main task producers 和 consumers。
- **动作与产物：** 全仓调用点迁移且新旧 IPC 兼容转换已由 E-05 覆盖后，将公共 `AutomationTask`/input 的 `workDirs` 改为必填，移除公共 `workDir`；数据库旧列仅保留 migration/恢复用途。
- **完成判据：** E-02a 的兼容调用迁移已通过；E-05 的旧单根 payload 预检行为已通过；收紧提交本身包含最后剩余调用迁移并通过 shared/renderer typecheck 与 electron incremental build。无断言、空数组占位或 Profile fallback。
- **验证命令：** `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental`。
- **证据：** `AutomationTask`/`AutomationTaskInput` 已将 `workDirs` 收紧为必填且不再暴露 `workDir`；DB 旧列只在 store adapter 读取 legacy row 并转换为数组，IPC 只在旧 payload 边界适配；renderer 读取/展示 canonical 数组。`npm exec vitest run -- electron/butler/taskStore.test.ts electron/butler/butlerIpc.test.ts electron/butler/taskScheduler.test.ts electron/butler/taskStore.armNextRun.test.ts electron/butler/enableByDefault.test.ts --reporter=dot`（61 项通过）；`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 均通过。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-06 让路径 facts 对多个根作并集分类

- **依赖：** E-03、E-01。
- **目标文件：** `electron/confirmation/extractors/readPathFacts.ts`、相关写路径 facts、`electron/confirmation/toolCallGate.ts` 及相邻测试、共享 policy tests。
- **动作与产物：** 所有 path fact 输入改为 task roots 集合；根内任意目标标识 inside-workdir；未知/敏感/系统/链接逃逸保留现有更严格分类；automation locked policy 继续通过 Policy Engine 和 trace 管理。
- **完成判据：** 各根、父子根、交换顺序、重复根、symlink escape、路径不存在、权限拒绝、敏感位置均有边界测试；除范围并集事实外，无策略放宽；policy trace 有稳定 rule ID。
- **验证命令：** `npm exec vitest run electron/confirmation/extractors/readPathFacts.test.ts electron/confirmation/extractors/writePathFacts.test.ts electron/confirmation/toolCallGate.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/defaultRules.contract.test.ts`。
- **证据：** `readPathFacts.test.ts` 覆盖第二根命中、父子根、根顺序/重复、近似前缀边界及敏感/系统优先；`writePathFacts.test.ts` 覆盖多根写 scope；`toolCallGate.test.ts` 覆盖可信 task roots 进入 read/write facts；原有 symlink 逃逸、路径缺失/权限错误边界保持通过；五个指定 suites 共 290 项通过；`npm run build:electron:incremental` 通过。未新增策略规则或系统 invariant。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-07 将同一根集合贯穿运行快照、执行链与安全审核 Agent

- **依赖：** E-03、E-04、E-05、E-05a、E-06；技术方案 D-3 选择 A。若选择 B，先修订授权的数据位置契约和目标文件清单。
- **目标文件：** `electron/butler/butlerInvoker.ts`、`electron/butler/taskStore.ts` run phase transition、`electron/runtime/invocationAssembler.ts`、`electron/confirmation/approvalAgent.ts`/路径材料端口、`electron/chatMessageBuild.ts`、共享结果 projection 与 tests。
- **动作与产物：** 拆分外部新触发 claim 与主进程内部 `executeClaimedRun(runId)`。queued claim 只固定 runId/taskId/slot/generation；入口校验身份后，在唯一 queued→running CAS 事务中读取当前 task revision 并冻结 roots、bindings 和执行配置。CAS 后只加载该 snapshot，不从可变 task 行重建当前 run 配置；不再 insert 第二条 run、不接受 renderer 提供 runId。正常 tick 和恢复分派共用该入口。v1 按 snapshot 中的 exact/collection/output binding 动态构造 selection，v0 遵循旧提示词语义。传递 snapshot roots 给工具 facts、审批 Agent 和 final-check；修正单根 workspaceRoot 隐式依赖。
- **完成判据：** v1 分别按 exact/collection/output 语义重验；越界、不完整扫描、新歧义或无效祖先在 executor 前失败，动态集合成员变化和逻辑路径上的原子替换按契约通过。v0 旧任务无 bindings 时按需求稿 legacy 语义运行；缺 roots 失败；成功编辑/启用后 v1。运行中保存新 roots 后，当前 run snapshot/facts/审批 roots 不变，后续 run 使用新 roots。snapshot、facts、审批 Agent roots 逐项相同；tool policy deny 是 failed，不是 skipped。直接调用既有 runId 实际进入 invoker 一次，不插入第二条 run；重复/并发消费者最多一个通过 CAS 并进入 Agent；running 后进程退出由恢复逻辑收敛为 interrupted 且不重放。
- **验证命令：** `npm exec vitest run electron/butler/butlerInvoker.test.ts electron/butler/butlerSessionEvents.test.ts electron/confirmation/automationLane.test.ts electron/chatMessageBuild.test.ts` 与新增 roots integration tests；必要时 `npm run check:system-invariant-registry`。
- **证据：** `taskTargetResolver.test.ts` 覆盖 exact 新歧义 fail、collection 新成员允许、output 尚不存在允许和 task revision 不匹配 fail；`butlerInvoker.test.ts` 覆盖同一 queued run 并发消费仅一方通过 CAS、执行同一 runId、sessionLedger history projection/recovery 指向私有 automation-sessions；`butlerSessionEvents.test.ts` 覆盖任务私有目录与 symlink 边界；共享结果 projection、Claude history 与 approval lane 覆盖多根传递。计划指定 7 个 suites 共 125 项通过，`taskStore.test.ts` + `taskScheduler.test.ts` 43 项通过；`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental`、`npm run check:system-invariant-registry` 通过。真实审批 Agent 语义为外部验收。
- **可执行环境：** 本机 mock Agent/模型；真实审批 Agent 语义为外部验收。
- **状态：** - [x]

### E-08 实现表单、授权清单与提交反馈

- **界面归属卡（待项目负责人批准）：**
  1. **入口：** 设置页既有「定时任务」Tab 的新建/编辑表单；任务列表和编辑入口已在此，授权范围属于任务配置，不进入聊天区或全局安全设置。
  2. **形态：** 改造现有编辑 Modal：宽屏左右双栏、窄窗单栏；工作目录为可增删的完整路径列表；预检候选与阻断原因在表单内联展示，checkbox 默认不勾选；历史沿用现有历史 Modal 并标出 skipped/failed 原因。
  3. **样式来源：** 沿用 Ant Design Form/Modal/Checkbox/Alert/List、现有 Butler task card、`--sa-*` token 与设置页间距；不新增设计 token、设置项或独立导航。
  4. **新增还是改造：** 只改造现有定时任务表单、列表和历史弹窗，不创建新页面/面板，不改变既有入口。
  5. **成本：** 用户需区分任务工作目录与预检提出的候选授权目录；需覆盖待检查/通过/阻断/失败/保存中状态及中英文长路径，增加表单交互与 history reason 的 i18n 和组合测试。
- **依赖：** E-05、E-05a、E-09。
- **目标文件：** `src/renderer/components/Config/ButlerTaskSettings.tsx`、对应测试、`src/renderer/styles.css`、`src/renderer/i18n/resources/zh-CN/config.json`、`en-US/config.json`、生成的 i18n types。
- **动作与产物：** 按已批准归属卡加宽 Modal，宽屏双栏/窄窗单栏；目录列表显示完整路径并可增删；提交触发 preflight，pass 自动保存，blocked 保留输入及候选清单；勾选加入 form roots；历史中的 skipped/failed 显示清楚。
- **完成判据：** checkbox 默认未选、Tab/Space 可用、路径/用途进 accessible name，长路径可读；检查期间防重复提交；编辑失败内容保留；enable 阻断时打开编辑表单显示报告并保持停用；响应式布局无横向溢出；所有新增文案走 i18n。
- **验证命令：** `npm exec vitest run src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm run typecheck:renderer`；`npm run i18n:generate-types`；`npm run i18n:check`。
- **证据：** `ButlerTaskSettings.test.tsx` 21 项通过：目录增删及连续异步选择、预检阻断保留输入/候选默认未选/勾选后二次提交、启用阻断保持停用并打开编辑、skipped 原因本地化；保存前目录必填、失败不关窗。`npm run i18n:generate-types` 与 `npm run i18n:check` 通过（0 条源代码硬编码中文）；`npm run typecheck:renderer` 通过。样式在 `.butler-task-editor__grid` 使用两栏并于 `max-width:720px` 单栏，路径以 `overflow-wrap:anywhere` 换行；`impeccable detect` 对目标文件未发现新增阻断项，config-settings.css 的设计系统 advisory 均落在既有行。桌面实际宽/窄窗口与键盘辅助技术验收列为 X-03。
- **可执行环境：** 本机自动测试；视觉/辅助技术平台验收外部。
- **状态：** - [x]

### E-09 原子恢复错过槽位并恢复补跑 claim

- **依赖：** E-02、E-03。
- **目标文件：** `electron/butler/taskStore.ts`、`taskScheduler.ts`、recovery state schema/store tests；history query API、delivery guard tests。
- **动作与产物：** 使用 `schedule_generation` 与首个未核销槽位 cursor；覆盖创建/迁移/正常 tick/改期/停用/启用/删除/重启转移，并排除已有 run 的槽位。scheduler 在事务建立 pending claim 后，只通过内部 scheduler port 把同一个 `runId` 交给 invoker adapter；启动恢复与在线分派使用同一稳定键。普通配置编辑不改变 running snapshot；queued run 在 queued→running CAS 时冻结当前 task revision。queued pending 时调度变更冲突；running pending 时允许重设 schedule generation/cursor，但不覆盖旧 pending；同一 task 串行运行，长运行跨槽时 cursor 停在首个未核销槽位，旧 run 终态后恢复处理。E-09 不实现也不声称真实 invoker 消费：本任务用 spy port 验证只交付既有 runId、不会新建第二 claim；真实入口由 E-07，跨层验收由 E-10。旧 legacy-unknown 活动记录收敛为 interrupted，不依赖 client_id 推断。running 只可终结/中断，绝不转 skipped 或重放。提供稳定 history query 和 skipped 原因。
- **完成判据：** 正常在线多次执行后重启无重复 skipped；活动运行期间配置编辑成功且 running 快照不变；queued claim 与编辑并发时 CAS 冻结事务顺序中最后提交的配置；queued pending 时改期/停用/启用冲突，running 时调度变更建立新 generation，旧终态不清除不匹配 pending 或改写新 cursor；删除在任一非终态 run 时冲突；长运行跨槽不覆盖 pending，终结后从 cursor 恢复；skipped 后/claim 前退出时 cursor 指向补跑槽位；claim 后退出时恢复器只分派同一 runId；run-start 后退出成为 interrupted 且不重跑；终态与清除匹配 pending 同事务；旧 legacy-unknown 活动记录不被误判为 missed claim；跨重启覆盖无遗漏、无重复；history API 返回稳定原因且 skipped 不触发 delivery。随机操作序列包含配置编辑、调度修改、启停、删除、重启、claim 与退出。历史 UI 由 E-08 展示。
- **验证命令：** `npm exec vitest run electron/butler/taskScheduler.test.ts electron/butler/butlerDelivery.test.ts electron/butler/taskStore.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`。
- **证据：** `taskStore.test.ts` + `taskScheduler.test.ts` + `butlerDelivery.test.ts` 共 61 项通过：queued claim 在启动时原 runId 续接；run-start 后重启原子 interrupted 且清理匹配 pending、不重放；在线 completed 槽位重启不重复 skipped；missed-window skipped 事务完整/幂等；once 成功后停用；随机 120 步配置/改期/启停/claim/退出序列逐步断言 generation、cursor、pending identity、client_id 唯一和 skipped 原因；delivery 谓词拒绝 skipped。taskStore 故障注入验证 claim 和 recovery 状态事务回滚；mock scheduler port 未插入第二条 claim。`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 和 `git diff --check` 通过。界面状态/原因断言归 E-08。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-10 完成重启恢复、兼容、集成验收与源码关闭

- **依赖：** E-02、E-02a、E-03、E-04、E-05、E-05a、E-06、E-07、E-08、E-09。
- **目标文件：** 上述变更涉及的全部模块和定向测试；本计划的证据栏。
- **动作与产物：** 对 R2-01～R2-04、R3-01～R3-02 执行故障注入和集成复核；验证备份恢复回退协议、v0/v1 目标路径分支、恢复游标完整生命周期、预创建 claim 到真实 invoker 的续接、DAG 前置证据和阶段编译；执行相关回归与最终 renderer/shared type/i18n/electron build。
- **完成判据：** 技术方案 §2.8 所有 AC 有测试或外部验收记录；第二、三轮阻断关闭证据齐全；数据库不承诺直接降级打开；跳过与运行失败区分明确；正常 tick/恢复竞争只有一个消费者进入 Agent，且使用原 runId；安全阶段、rule/invariant ID 与验证命令登记完整。
- **验证命令与结果：** 执行计划原 `npm run test:related -- ...` 扫描持续高 CPU 且长时间不输出汇总，终止后用明确测试文件集合等价覆盖；`npm exec vitest run -- electron/butler/taskScheduler.test.ts electron/butler/taskStore.test.ts electron/butler/taskConfigValidation.test.ts electron/butler/butlerIpc.test.ts electron/butler/butlerInvoker.test.ts electron/confirmation/extractors/readPathFacts.test.ts electron/confirmation/extractors/writePathFacts.test.ts electron/confirmation/toolCallGate.test.ts electron/runtime/invocationAssembler.test.ts electron/chatMessageBuild.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx src/shared/claudeToolHistory.test.ts src/shared/agentToolResult.test.ts src/shared/processResultProjection.test.ts`：14 files / 485 tests passed。最终 `npm test`：1094 files passed、1 skipped；10,413 tests passed、111 skipped。另通过 `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`、`npm run build:electron:incremental`、`npm run check:system-invariant-registry`、`git diff --check`。
- **证据：** AC→测试映射按技术方案 §2.8：AC-01/01a/02/15→`taskStore`、task config validation、path facts；AC-01b/03a/10→`butlerInvoker`、invocation/approval roots tests，locked policy trace 断言 `automation-readonly-allow` / `automation-write-deny`；AC-03/14→resolver exact/collection/output 和运行期 binding tests；AC-04/05/12→IPC contract + Butler renderer blocked/retry tests；AC-06/06a/06b→once constraints、taskOnce/scheduler tests；AC-07/11→v0/v1 invoker + migration fixture（缺 roots 失败、不回退 Profile）；AC-08/09→path security / CAS snapshot / target binding tests；AC-13→renderer interaction + X-03 外部视觉验收；AC-16→scheduler history、delivery guard、history UI。`migrations.automationPreflight.test.ts` 验证 v102→v103、旧根迁移 v0、旧 queued/running 标 legacy-unknown、高版本拒绝、注入失败回滚、备份恢复后再次升级及数据完整。安全阶段为 facts / policy / final-check / invariant；规则决策 trace 保持共享 Policy Engine 的稳定 rule ID `automation-readonly-allow`、`automation-write-deny`；系统不变量登记检查 5 registrations / 9 test references 均通过。最终全量过程中首次发现并修复旧缺根 fixture、once 终态停用与迁移版本断言；最终全量 10,413 项通过。先前 `test:related` 未取得汇总，不作为通过证据。真实模型判例质量/延迟、真实审批 Agent、打包 DB 回退、桌面键盘与 IM 渠道留在 X-01～X-05，不阻塞源码关闭。
- **可执行环境：** 源码关闭为本机；外部项独立记录。
- **状态：** - [x]

### E-11a 冻结拆分目录类型、默认归档与 v104 迁移契约

- **依赖：** E-10；用户已裁决 D-4、D-5。
- **目标文件：** `src/shared/automationTaskTypes.ts`、`electron/database/schema.ts`、`electron/database/migrations.ts`、`electron/butler/taskStore.ts`、对应 shared/migration/store tests、技术方案与执行计划。
- **动作与产物：** 新增 `authorizedDirs`、`outputDir`、`outputOrganization` 字段契约；新建任务输出目录和策略必填、授权目录可空。DB v104 增加兼容旧行的 nullable 输出列；旧目录仅映射到 authorizedDirs，不推断输出位置；历史快照继续可读。默认策略函数按 daily/interval/once 返回 daily/hourly/direct。
- **完成判据：** TDD 先补 DTO、默认策略、存储往返和 v103→v104 migration 失败用例，再实现；迁移可重复/回滚；旧任务字段保持旧语义；schema/store 能表达空授权目录和 nullable 的 legacy 输出字段。新建 IPC 对输出字段的必填门禁由 E-11d 验收。
- **验证命令：** 执行中登记 `automationTaskTypes`、migration、taskStore 和默认策略的明确 Vitest 文件集合；涉及类型时运行 `npm run typecheck:shared`。
- **证据：** RED：新增迁移、store 往返和 schedule 默认值用例分别因版本仍为 103、字段未回读、默认策略函数不存在而失败。GREEN：`npm exec vitest run electron/database/migrations.automationPreflight.test.ts electron/butler/taskStore.test.ts src/shared/automationTaskTypes.test.ts --reporter=dot`：3 files / 44 tests passed；`npm run typecheck:shared`、`npm run build:electron:incremental`、`git diff --check` 通过。v103→v104 保留原 `work_dirs_json` 并将输出列置 NULL，重复 migration 不改变旧任务；store 可往返新输出字段和授权目录。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-11b 实现计划时刻归档目录解析和输出 binding 规则

- **依赖：** E-11a。
- **目标文件：** `electron/butler/taskOutputDirectory.ts`、`electron/butler/taskTargetResolver.ts`、`taskPathFacts.ts`、相关 tests。
- **动作与产物：** 将 direct/daily/hourly 模式映射为输出运行目录；按本机 `scheduledFor` 生成 `yyyymmdd` / `yyyymmdd-HH`。facts provider 只暴露输出根的目录根事实，不扫描其内容。输出 binding 使用相对输出路径，运行重验时重映射到 runOutputDir 并拒绝逃逸。
- **完成判据：** TDD 先写时区、跨日期边界、直接模式、根 fact 与输出路径逃逸用例；输出目录内容不能成为 exact/collection 输入 facts；输出绑定跨 run 可重映射且不能穿出归档目录。
- **验证命令：** 执行中登记目标 resolver/path facts/output helper 相关 Vitest 文件集合。
- **证据：** RED：归档 helper 缺失、facts 无 outputRoot、output-only task 被 NO_ROOTS 拒绝、模型输入未区分授权 roots 和写入根、绑定路径不能映射到归档目录；分两轮新增用例 8 项失败。GREEN：`npm exec vitest run electron/butler/taskOutputDirectory.test.ts electron/butler/taskPathFacts.test.ts electron/butler/taskTargetResolver.test.ts electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightReviewRegression.test.ts --reporter=dot`：6 files / 34 tests passed。覆盖本机计划日期/小时、空授权目录、输出根不扫描、相对目标和越界、output binding 向 runOutputDir 安全重映射与根重验；旧 v2 输出绑定兼容。`npm run typecheck:shared`、`npm run build:electron:incremental`、`npm exec tsc -- -p tsconfig.electron.json --noEmit --pretty false`、`git diff --check` 通过。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-11c 接入只允许绑定结果路径的自动化写策略

- **依赖：** E-11b；用户已裁决 D-6。
- **目标文件：** `src/shared/policy/defaultRules.ts`、`electron/confirmation/` facts/final-check、tool gate 与 policy boundary tests、`src/shared/security/systemInvariantRegistry.ts`。
- **动作与产物：** facts 阶段验证 write_file/edit_file 目标与本 run 预检 binding、归档目录的关系并发出稳定信号：文件 binding 精确匹配，目录 binding 仅覆盖其下的普通文件；Policy Engine 通过稳定 rule ID `automation-bound-output-write-allow` 仅允许该信号，同时保留 `automation-write-deny` 对未匹配写入的 locked 拒绝和 `automation-shell-deny`。系统不变量 `SYS-AUTOOUTPUT-001` 要求 automation 写许可携带 binding，即使策略配置停用 locked write deny 也不能派发未绑定写入。final-check 重核 binding 与目标；空授权目录不可回退到 outputDir。
- **完成判据：** TDD 覆盖文件型精确绑定与目录型子树绑定 allow；未绑定文件、目录 binding 外目标、未归档输出、授权资料目录写入、输出目录读取、run_shell 均在 executor 前拒绝；policy trace 显示稳定 rule ID。Policy rule 保持在共享 Policy Engine；执行端 binding 完整性登记为系统不变量。
- **验证命令：** `npm exec vitest run electron/butler/taskOutputDirectory.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/defaultRules.contract.test.ts src/shared/policy/defaultRules.lint.test.ts src/shared/policy/lockedFloorClassification.test.ts src/shared/security/systemInvariantRegistry.test.ts electron/confirmation/writeExecutionPermit.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/automationLane.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/tools/registeredAgentTurnTools.test.ts electron/tools/writePermitReapproval.integration.test.ts`；`npm run typecheck:shared`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run build:electron:incremental`；`npm run check:system-invariant-registry`；`git diff --check`。
- **证据：** RED：定向用例分别复现策略缺少 bound-output allow、无 binding 的 automation fallback permit 被接受、目录 binding 无匹配器/被 gate 拒绝，以及计划阶段 permit 拒绝未写 execution-veto 审计。GREEN：12 个测试文件 / 365 个用例通过；共享类型检查、阶段主进程增量构建、最终主进程 TypeScript 检查、系统不变量登记与 diff 检查通过。用例覆盖文件 binding 精确写入、目录 binding 子树文件写入、未绑定目标/授权资料写入拒绝、输出根读取拒绝、Shell 拒绝、签名 permit 传递及 executor 不调用；`SYS-AUTOOUTPUT-001` 覆盖 locked deny 配置停用后的 final-check。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-11d 将拆分配置与 runOutputDir 贯穿存储、IPC 和运行链

- **依赖：** E-11a～E-11c。
- **目标文件：** `electron/butler/taskStore.ts`、`butlerIpc.ts`、`taskScheduler.ts`、`butlerInvoker.ts`、`electron/runtime/invocationAssembler.ts`、调用方与相应 tests。
- **动作与产物：** 新 task/run snapshot 分别保存授权目录、输出目录、归档策略、scheduledFor、runOutputDir 和输出 bindings；claim 时冻结完整配置；运行时安全创建归档目录并进行 realpath/链接边界检查。读取 tools 与审批 Agent 只收到 authorizedDirs；写工具收到精确绑定的 runOutputDir。旧任务继续走 v0 legacy 分支。
- **完成判据：** TDD 覆盖存储往返、迁移旧行、运行 snapshot 冻结、并发 task 编辑、归档目录创建失败、empty authorizedDirs 不授权读取、旧 run 快照兼容；创建/编辑 IPC 对缺少 outputDir 拒绝；依 E-13 修订后的最终契约为预检通过仅暂存确认票据，用户确认后只保存一次。
- **验证命令：** `npm exec vitest run electron/butler/taskOutputDirectory.test.ts electron/butler/taskStore.test.ts electron/butler/butlerIpc.test.ts electron/butler/butlerInvoker.test.ts electron/butler/taskTargetResolver.test.ts electron/butler/taskPreflight.test.ts electron/runtime/invocationAssembler.test.ts electron/runtime/invocationAssembler.workspace.test.ts`；`npm run build:electron:incremental`；`npm run typecheck:shared`；`git diff --check`。
- **证据：** RED：新用例确认 run snapshot 不含拆分输出配置且空授权根不能启动；归档安全创建器不存在；IPC 仍允许旧任务无输出目录编辑，并在 `TARGET_UNCLEAR` 时保存禁用草稿。GREEN：8 个测试文件 / 216 个用例通过；覆盖排程槽归档快照、等待期配置更新后冻结最新版本、output-only 任务真实写入日期归档、输出根读取不触达 executor、归档普通文件冲突在建会话前拒绝、归档 helper 拒绝符号链接、创建/编辑缺输出配置拒绝、`TARGET_UNCLEAR` 不保存。主进程增量构建、共享类型检查与 diff 检查通过。输出根只进入写入事实；读取策略始终收到单独的 `authorizedDirs`，包括空数组。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-11e 设置表单、动态默认、摘要与中英文文案

- **依赖：** E-11a、E-11d；界面归属卡已由用户批准，已完成 Impeccable 检查点 A/B。
- **目标文件：** `src/renderer/components/Config/ButlerTaskSettings.tsx`、`src/renderer/components/Config/ButlerTaskSettings.test.tsx`、`src/renderer/theme/config-settings.css`、`src/renderer/i18n/resources/{zh-CN,en-US}/config.json`、`src/renderer/i18n/types.ts`、`src/shared/api.ts`、`electron/preload.ts`、`electron/butler/butlerIpc.ts`、`electron/butler/butlerIpc.test.ts`。
- **动作与产物：** 在现有定时任务编辑弹窗新增必选结果输出目录和三种归档模式；保留独立可空授权读写目录列表；说明生成结果写入输出目录，读取/修改资料需另加授权目录。创建时按任务 scheduleKind 动态给默认值，用户手动更改后不覆盖；编辑保留保存值。任务卡摘要展示输出位置和策略，不增加页面。
- **完成判据：** TDD 覆盖字段校验、三种选择、每天/间隔/一次性默认、用户手选、编辑回填、长路径/窄窗呈现及失败保留；i18n keys 中英文对齐，Ant Design 控件、已有目录选择器和 `--sa-*` 样式一致；Impeccable detector 无新阻断。
- **验证命令：** 组件定向 Vitest、`npm run i18n:generate-types`、`npm run i18n:check`、`npm run typecheck:renderer`、Impeccable detector。
- **证据：** RED：在结果目录控件和校验接入前，新建任务测试因缺少“结果输出目录”必填提示失败。GREEN：`npm exec vitest run src/renderer/components/Config/ButlerTaskSettings.test.tsx electron/butler/butlerIpc.test.ts` 通过，2 个文件 / 45 个用例；覆盖必选输出目录、授权目录可空、间隔/每天/一次性归档默认及手动选择保持、编辑回填、旧任务首次编辑拦截、长路径摘要、TARGET_UNCLEAR 不保存，以及单独输出目录选择 IPC。`npm run i18n:generate-types`、`npm run i18n:check`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run build:electron:incremental`、`git diff --check` 均通过。`npm run dev` 启动后检查了新建表单、必选/可选字段和系统目录选择器打开/取消；窄窗单列由 720px media query 处理。Impeccable detector 报告 8 个既有 advisory 均位于 `config-settings.css` 的其他样式区（第 406、1156、1157、1634、1635、1726、1817、1884 行），本任务新增样式区域无新阻断。
- **可执行环境：** 自动化在本机；真实桌面宽/窄窗和键盘验收列 X-06。
- **状态：** - [x]

### E-11f 补充阶段集成验收并关闭结果目录拆分

- **依赖：** E-11a～E-11e。
- **目标文件：** 所有 E-11 触及模块与本执行计划证据栏。
- **动作与产物：** 运行本阶段相关定向测试、类型/i18n/增量构建和安全边界检查；完成一次 final review；复核开发方案冲突声明、实际 schema 版本、迁移、task/run snapshot、policy trace、表单默认及旧任务兼容，逐项更新 E-11 状态与提交阶段。
- **完成判据：** 新功能 AC 与 INV-14～16 均有 RED/GREEN 证据；其他写入与 Shell deny；结果目录不能读取；所有计划行状态有对应 commit 与验证证据；最终无未提交变更。
- **验证命令：** `npm exec vitest run electron/database/migrations.wikiProjects.test.ts electron/database/taskControl.test.ts electron/confirmation/deferredExecutionResultStore.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/confirmation/securityActionIntentStore.test.ts`；`npm test`；`npm run typecheck:shared`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run build`；`git diff --check`。
- **证据：** RED/GREEN：最终全量测试初次发现 5 处既有迁移断言仍固定为 schema v103；改为读取 `DB_SCHEMA_VERSION`，并将 wiki migration 当前版本断言更新为 v104。5 个相关测试文件 / 21 项通过；共享默认归档 helper 与组件/共享类型测试 3 个文件 / 51 项通过。`npm test` 全量通过：1096 个测试文件通过、1 个跳过；10459 个用例通过、111 个跳过。`npm run typecheck:shared`、`npm run i18n:check`（0 个源代码硬编码中文，1443 个均在测试）、`npm run check:system-invariant-registry`（6 个登记、13 个测试引用）及 `npm run build` 均通过；`git diff --check` 通过。Final review 覆盖正确性、结构、策略与执行边界：输出根未进入读取授权；只有冻结的预检 binding 可匹配本次 runOutputDir；permit final-check 拒绝缺失、漂移或非绑定写入；automation 的其他写入与 Shell 仍为锁定拒绝；归档目录拒绝符号链接和非目录冲突。未发现需阻断问题。E-11a～E-11e 阶段提交：`accc4616`、`0d140f17`、`fac21b4e`、`d4099718`、`87e7ab9c`、`ebb532d9`；E-11f 收尾提交：`feb77fcf`、`b6848a33`。
- **可执行环境：** 源码本机；X-06 外部验收另列。
- **状态：** - [x]

### E-12a 持久化任务级访问权限并冻结到 run snapshot

- **依赖：** E-11d；用户已确认 D-7。
- **目标文件：** `src/shared/automationTaskTypes.ts`、`electron/database/schema.ts`、`electron/database/migrations.ts`、`electron/butler/taskStore.ts`、`electron/butler/butlerIpc.ts` 及迁移/store/IPC tests。
- **动作与产物：** 增加 `accessPermissions` 契约，内含 canonical 授权目录和允许的本地工具；schema v105 为 v104 数据增加该字段，旧任务工具清单为空；IPC 对工具权限做白名单校验；task revision 更新和 queued→running claim snapshot 同步冻结权限，目录投影始终由主进程规范化 roots 生成。
- **完成判据：** 目录和 `run_shell` grant 往返一致；旧任务不自动获得 Shell grant；伪造未知工具权限被 IPC 拒绝；用户变更后续 task revision 生效，已 claim snapshot 不变；v104→v105 migration 保留授权目录且工具权限为空。
- **验证命令：** `npm exec vitest run electron/database/migrations.automationPreflight.test.ts electron/butler/taskStore.test.ts electron/butler/butlerIpc.test.ts`。
- **证据：** GREEN：上述 3 个测试文件包含于 E-12 集成回归（10 files / 222 tests passed）；覆盖 v105 旧行迁移、访问权限字段往返、未知 capability 拒绝及 claim snapshot 冻结。新测试还断言输入的目录投影不能绕过 IPC/store 的 canonical directory 集合。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-12b 提供本地 Git 仓库 facts 并增强目标预检

- **依赖：** E-12a、E-04。
- **目标文件：** `electron/butler/taskPathFacts.ts`、`taskPreflight.ts`、`taskPreflightModelAnalyzer.ts`、对应 tests、`src/shared/automationTaskTypes.ts` 和预检 i18n 文案。
- **动作与产物：** facts 阶段通过不跟随链接的 `.git` marker `lstat` 检测所选授权 roots 中的工作树，并跳过 Git 内部元数据枚举；仓库列表进入 facts digest。预检模型输入明确包含 `accessPermissions` 和 Git roots：有本地 Shell grant 时将 Git 任务绑定到仓库目录；多个仓库列出歧义候选；缺少 grant 时返回本地 Shell 权限说明，不误报文件或目录缺失。预检仍无工具调用。
- **完成判据：** `.git` 目录、worktree `.git` 文件、嵌套仓库可识别；链接 `.git` 不跟随；仓库元数据不导致目录覆盖误报截断；Git query 在授权且无歧义时产出 exact directory binding；缺权限产出稳定、可读的权限 blocker；本机 Git facts 不推断 GitHub 推送时间。
- **验证命令：** `npm exec vitest run electron/butler/taskPathFacts.test.ts electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskTargetResolver.test.ts`。
- **证据：** RED：首轮 4 个目标用例在 4 个测试文件中失败（24 个既有用例通过），分别显示 facts 缺少 Git roots、分析器提示词未解释本地 Git 权限、预检没有访问授权输入、已授权 Shell 仍被 locked deny。GREEN：10 个相关测试文件合计 222 项通过；本任务覆盖 Git facts、worktree marker、模型提示词、Git 目录 binding 和缺权限说明。
- **可执行环境：** 本机；真实选定模型的判例质量继续列为现有外部验收 X-01。
- **状态：** - [x]

### E-12c 接通授权 Shell 策略与任务设置表单

- **依赖：** E-12a、E-12b。
- **目标文件：** `electron/confirmation/toolCallGate.ts`、`electron/runtime/invocationAssembler.ts`、`src/shared/policy/defaultRules.ts`、`systemInvariantRegistry.ts`、automation lane tests、`ButlerTaskSettings.tsx`、组件测试和中英文 i18n。
- **动作与产物：** 设置页把本地 Shell 作为任务级访问权限显式勾选；gate 只从 immutable run snapshot 产出权限 facts。无 grant 使用稳定 Shell deny；有 grant 时运行既有 Shell precheck，但不读写桌面信任缓存；locked policy 仍拒绝危险、敏感/系统位置、授权目录外路径、路径事实不完整、分析不完整和 unsupported 结构；只有满足授权且完整分析的调用进入授权 allow。
- **完成判据：** 表单新建默认不授予 Shell，编辑时读回并提交用户选择；旧任务仍无 grant；授权 shell 正常通过；无授权、dangerous precheck、unsupported、analysis/path facts incomplete、授权 roots 外路径均在 executor 前拒绝；授权不产生桌面 trusted command cache side effect；输出写入仍使用 D-6 binding；新不变量 `SYS-AUTOSHELL-001` 登记为权限事实来源约束，不代替 Policy Engine 做 allow/deny。
- **验证命令：** `npm exec vitest run electron/confirmation/automationLane.test.ts src/shared/policy/defaultRules.contract.test.ts src/shared/policy/policyEngine.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm run i18n:generate-types`；`npm run i18n:check`；`npm run typecheck:renderer`；`npm run typecheck:shared`。
- **证据：** GREEN：E-12 集成回归 10 files / 222 tests passed。automation lane 用例覆盖授权 allow、缺授权 deny、危险预检 deny 且不触碰 trust cache、unsupported deny 和根外路径 deny；renderer 用例覆盖显式勾选后携带 canonical 目录与 `run_shell` grant。中英文资源及生成类型已更新。
- **可执行环境：** 本机；实际桌面宽窄窗验收可复用已有 X-06 外部视觉验收。
- **状态：** - [x]

### E-12d 集成验证并关闭访问授权扩展

- **依赖：** E-12a～E-12c。
- **目标文件：** E-12 触及模块、技术方案和本执行计划。
- **动作与产物：** 执行全量测试及本地类型、i18n、增量构建、system invariant registry 检查；复核 migration 105、访问权限快照来源、Git facts/preflight、Shell policy ordering 和 UI payload；更新本任务及计划状态。
- **完成判据：** AC-17 与 INV-17 有 RED/GREEN 证据；旧任务无隐式 Shell grant；grant 只来自冻结任务 snapshot；危险/不完整/授权根外 Shell 不派发；文件工具结果写入仍受输出 binding 限制；本机集成门禁通过，diff 无空白错误。
- **验证命令：** `npm test`；`npm run typecheck:shared`；`npm run typecheck:renderer`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run build:electron:incremental`；`git diff --check`。
- **证据：** RED/GREEN：E-12a～E-12c 首轮目标用例先失败、实现后 10 个集成测试文件 / 222 项通过。阶段验收先发现 locked-floor 分类文档漏列 4 条 Shell 安全规则、wiki schema 版本断言仍为 104；补全策略分类并更新断言到 v105 后，两处定向回归 2 个文件 / 3 项全过。最终 `npm test` 全量通过：1096 个测试文件通过、1 个跳过；10471 个用例通过、111 个跳过。`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`、`npm run build:electron:incremental` 和 `npm run check:system-invariant-registry` 均通过；不变量登记 7 项、16 个测试引用；`git diff --check` 通过。复核确认 v105 旧任务迁移不授予 Shell，运行授权仅取自冻结 snapshot；危险、分析/路径事实不完整、unsupported、敏感/系统路径及授权根外命令由 locked policy 拒绝；文件工具结果写入仍要求本次 output binding。全量测试运行期间有既有 `MaxListenersExceededWarning`，最终退出码为 0。
- **可执行环境：** 本机；真实模型稳定性与桌面视觉继续作为外部验收，不阻塞源码关闭。
- **状态：** - [x]

### 2026-10-18 用户授权记录架构修订（E-13）

E-13 按用户明确要求修正 D-7 的授权所有权与确认交互。E-12 的 Shell 勾选实现由本修订替代：用户看到预检生成的权限清单，确认后才保存；授权记录由主进程创建并传入后续安全审核，不接受业务 Agent 或 renderer 自述。

### E-13a 由主进程生成权限清单并在保存前展示给用户

- **依赖：** E-12b。
- **目标文件：** `electron/butler/taskPreflight.ts`、`taskPreflightModelAnalyzer.ts`、`butlerIpc.ts`、`ButlerTaskSettings.tsx`、中英文 config 文案与对应测试。
- **动作与产物：** 主进程从规范化授权目录、结果目录与归档模式、预检所需本地 Shell 能力、投递配置构造权限清单；UI 用人话逐项显示，并提供“预检并查看权限”及“确认授权并保存”两个步骤。移除独立 Shell checkbox。预检未通过不得显示可确认清单，也不得写任务。
- **完成判据：** 任务保存前用户可读到完整权限范围；renderer 的权限字段不能替代主进程推导；Shell 只有在预检要求时出现在清单中；权限清单确认与任务保存关联同一候选配置。
- **验证命令：** `npm exec -- vitest run electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/butlerIpc.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm run i18n:check`；`npm run typecheck:renderer`。
- **证据：** RED/GREEN：renderer 回归断言不再显示独立 Shell 勾选项，主按钮先预检再展示逐项权限；IPC 回归检查权限清单与候选任务绑定且预检不直接写库。10 个相关测试文件 / 350 项通过。`npm run dev` 打开当前 worktree 后，人工检查新建表单可见必填结果输出目录、独立授权读写目录和“保存前先列出所需权限”的说明，主按钮为“预检并查看权限”。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-13b 用户确认后持久化主进程授权记录并传给安全审核 Agent

- **依赖：** E-12a、E-13a。
- **目标文件：** `electron/preload.ts`、`src/shared/api.ts`、`electron/butler/butlerIpc.ts`、`taskStore.ts`、`invocationAssembler.ts`、`agentChannel.ts`、`approvalAgent.ts` 与对应测试。
- **动作与产物：** 预检通过时主进程保存短时一次性确认票据与待提交任务快照。用户点确认后 renderer 只传票据 ID；主进程消费票据并生成带确认者、时间、任务版本、预检事实摘要和完整权限范围的记录，再事务保存任务。claim 时将记录冻结到运行快照并作为单独的宿主事实传给安全审核 Agent，不能混入业务 Agent 的不可信声明。
- **完成判据：** 没有确认票据时零写入；票据只能消费一次；renderer 不能提交记录内容或改权限范围；数据库任务和运行快照保留同一授权记录；安全审核 Agent 输入能看到记录 ID、版本和精确权限范围。
- **验证命令：** `npm exec -- vitest run electron/butler/butlerIpc.test.ts electron/butler/taskStore.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/approvalAgent.test.ts`。
- **证据：** RED/GREEN：IPC、store 与审核线索测试先复现直接写库/renderer 声明不应成为权限来源、运行审核线索缺授权记录；实现后同一 10 文件 / 350 项回归通过。`invocationAssembler.test.ts` 新增生产装配路径断言，冻结记录由 invocation materials 到达 AgentChannel；该用例单独通过（1 项）。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-13c 核验授权票据与任务版本失效边界并完成阶段验证

- **依赖：** E-13a、E-13b。
- **目标文件：** E-13 触及模块、`SYS-AUTOSHELL-001` 登记、技术方案和本执行计划。
- **动作与产物：** 覆盖过期/重放/并发 revision 变化、记录 revision 不匹配、renderer 伪造权限、Agent 自述和旧任务迁移边界；更新系统不变量登记和文档状态；运行 E-13 相关回归、全量测试、类型、i18n、构建、registry 与 diff 门禁。
- **完成判据：** 只有用户看过且确认的当前版本清单能产生宿主授权记录；旧或失配记录不进入工具能力和审核事实；记录是后续审核的客观事实，但不放宽具体命令的既有策略限制；阶段所有本机验收通过，文档与代码一致。
- **验证命令：** `npm exec -- vitest run electron/butler/butlerIpc.test.ts electron/butler/taskStore.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/approvalAgent.test.ts electron/confirmation/automationLane.test.ts electron/confirmation/toolCallGate.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm test`；`npm run typecheck:renderer`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run build:electron:incremental`；`git diff --check`。
- **证据：** RED/GREEN：新增 `taskStore.test.ts` 用例将 task revision 从 1 改为 2，初次 RED 观察过期记录仍产生 `run_shell`；按 revision fail closed 后 GREEN。安全复核发现预检在途时表单被编辑会回显旧权限清单，延迟响应 UI 用例先 RED，再由草稿代次校验丢弃所有旧响应后 GREEN；又发现无主进程授权记录的旧 v1 任务启用时会跳过确认，IPC 用例先 RED，再改为仅停用或当前版本已有记录的任务可直通后 GREEN。主干全量 `npm test` 通过：1096 个测试文件通过、1 个跳过；10480 项通过、111 项跳过（891.49 秒）。其后针对最后的启用门禁修正，`butlerIpc.test.ts` 与 `ButlerTaskSettings.test.tsx` 共 51 项通过，`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。全量测试之前，`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`（0 source Chinese）、`npm run check:system-invariant-registry`（7 registrations / 19 test references）及 `npm run build:electron:incremental` 通过。运行期间出现既有 `MaxListenersExceededWarning`，全量测试最终退出码为 0。UI detector 仅报告原有 `config-settings.css` 设计系统建议；本次新增样式使用 `--sa-*` tokens。
- **可执行环境：** 本机；真实模型质量、审核 Agent 的实际决策质量及 macOS/Windows 无障碍视觉继续由 X-01～X-03 验收。
- **状态：** - [x]

### E-14 将 run_shell 执行超时从任务授权中剥离

- **依赖：** E-13a～E-13c；用户明确要求执行超时按运行实际情况调整，不作为安全授权项。
- **目标文件：** `automationTaskTypes.ts`、`taskPreflightModelAnalyzer.ts`、`taskPreflight.ts`、`butlerIpc.ts`、`taskStore.ts`、`automationTaskPermissionMatch.ts`、`toolCallGate.ts`、Butler 设置界面/中英文资源、`SYS-AUTOSHELL-001` 及对应测试、技术方案和本执行计划。
- **动作与产物：** 授权契约、预检输出、用户权限清单与持久化记录只保留完整 Shell 命令文本（含参数）和工作目录；权限匹配不读取调用 timeout。兼容模型输出和旧授权记录中附带的 timeout 时忽略并剥离它。运行时仍按工具自身约束接收 Agent 选择的 timeout，并继续执行既有 Shell 安全预检。
- **完成判据：** 同一命令和工作目录用不同运行 timeout 时授权仍匹配；更改命令参数或工作目录仍不匹配；预检含 timeout 仍通过但产出权限不包含 timeout；权限确认卡与新授权记录不展示/持久化 timeout；旧记录附带任意 timeout 不使有效授权失效且读取后不再回显该字段。
- **验证命令：** `npm exec vitest run electron/butler/automationTaskPermissionMatch.test.ts electron/butler/butlerIpc.test.ts electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskStore.test.ts electron/butler/butlerInvoker.test.ts electron/confirmation/automationLane.test.ts electron/confirmation/toolCallGate.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm run typecheck:shared`；`npm run typecheck:renderer`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run build:electron:incremental`；`git diff --check`。
- **证据：** RED：实现前的回归测试在权限 matcher、IPC 权限清单、管家指令和 automation lane 共 4 项失败，分别复现超时变化导致拒绝、权限清单仍包含 timeout、运行指令要求固定 timeout。GREEN：上述 9 个测试文件 / 361 项通过，覆盖运行 timeout 变化仍匹配、精确命令和目录范围、预检/模型响应与旧记录均剥离 timeout、UI 不将 timeout 列入授权。`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`（0 个源代码硬编码中文）、`npm run check:system-invariant-registry`（9 registrations / 31 test references）、`npm run build:electron:incremental`、`git diff --check` 均通过。
- **可执行环境：** 本机。
- **状态：** - [x]

### E-15a 定义 Mock 演练端口、工具意图轨迹与硬预算

- **依赖：** E-04、E-13a～E-13c、E-14；需求 §5.6「Mock 演练隔离与时长限制」。
- **目标文件：** `electron/butler/taskPreflight.ts`、新增 Mock runner/类型与测试、开发方案 §2.3。
- **动作与产物：** 用 RED 测试先固定工具调用只到 Mock dispatcher、轨迹字段/“拟调用”语义、未知工具 fail closed、部分结果状态，以及可注入预算。定义主进程硬上限：5 次模型生成、12 次 Mock 调用、单次模型请求 20 秒、总预检 60 秒、每次最多 2,048 输出 token、累计最多 10,240 输出 token。
- **完成判据：** 纯逻辑 runner 能在无生产 executor 依赖下记录有序的工具名、完整安全参数和目标；未知/未注册 Mock 工具不能继续；任一预算耗尽后输出不可确认的部分报告且不保留可复用 Mock 状态。SDK 的自动重试边界由 E-15b 验证。
- **验证命令：** `npm exec vitest run electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskPreflight.test.ts`；`git diff --check`。
- **证据：** RED：新增 runner 测试先因模块缺失而失败。GREEN：计划中的 runner/preflight 命令通过 **2 files / 35 tests**；包含模型 adapter 契约的 3 文件定向命令通过 **3 files / 48 tests**。覆盖拟调用参数轨迹、目录 adapter fail closed、无法模拟结果、模型轮次/工具数/单次模型超时/总时限、迟到模型响应与超时后续调用的竞态、单轮和累计 token 预算。`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。SDK 自动重试和模型集成归 E-15b。
- **可执行环境：** 本机，固定模型 client 和虚拟时钟。
- **状态：** - [x]

### E-15b 接入所选模型与全部工具的纯 Mock dispatcher

- **依赖：** E-15a。
- **目标文件：** `electron/butler/taskPreflightModelAnalyzer.ts`、工具目录/Mock adapter 接口及对应测试。
- **动作与产物：** 模型收到任务当前可用的工具定义，并可返回普通文本或工具调用；模型调用由预算器循环驱动，关闭 SDK 自动重试以便请求次数和总耗时由主进程预算独占。文件、grep、Shell、脚本、MCP、网络、投递与动态注册工具一律映射到 Mock adapter，不能注入或回退到真实执行器。合并拟调用轨迹与现有 facts/目标分析结果；任何依赖真实工具结果的结论降为覆盖不完整。
- **完成判据：** 测试用可控模型响应验证多轮工具调用顺序与参数完整性；所有类别只返回合成结果；工具 schema 未映射、adapter 抛错或模拟无法支撑后续判断时 fail closed；没有创建任务会话、运行记录或授权票据。
- **验证命令：** `npm exec vitest run electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskPreflight.test.ts electron/butler/butlerIpc.test.ts`。
- **证据：** RED：多轮 `tool_use` 用例在旧 analyzer 不支持工具调用时失败。GREEN：`npm exec vitest run electron/anthropicClientFactory.test.ts electron/butler/butlerIpc.test.ts electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskPreflightNoSideEffects.test.ts electron/butler/taskStore.test.ts electron/confirmation/approvalAgent.test.ts` 通过 **8 files / 164 tests**。覆盖所选模型多轮工具调用、运行时工具目录与 MCP、零 SDK 自动重试、各类工具只收到合成结果、意图轨迹随用户确认持久化并交付安全审核 Agent。Electron `tsc`、shared/renderer 类型、i18n、system invariant registry（10 registrations / 36 test references）和 `git diff --check` 通过；增量构建归 E-15c。
- **可执行环境：** 本机 mock LLM、虚拟工具目录和 side-effect spy。
- **状态：** - [x]

### E-15c 验证零真实副作用、预算终止与确认门禁

- **依赖：** E-15a、E-15b。
- **目标文件：** E-15 触及模块、执行计划 §5。
- **动作与产物：** 以所有真实 executor/process/MCP/network/delivery 入口的 spy 验证零调用；覆盖模型轮次、Mock 调用数、单请求耗时、总耗时及 token 预算的边界与竞争；证明预算超限只产生部分、不可确认结果且任务/授权零写入。合并运行 E-15 定向测试、renderer/shared 类型、i18n、系统不变量与增量构建门禁。
- **完成判据：** 每类工具调用只可到达 Mock；所有预算严格小于等于既定上限；一旦越界无后续 Mock dispatch、无后台请求、无任务/授权保存；完整轨迹清楚标为“拟调用/模拟结果”，不能被审核 Agent 当作实际访问事实。
- **验证命令：** E-15 相关 Vitest；`npm run typecheck:shared`；`npm run typecheck:renderer`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run build:electron:incremental`；`git diff --check`。
- **证据：** `taskPreflightNoSideEffects.test.ts` 用 executor/进程/文件读写/MCP/网络/浏览器/投递入口 spy 验证零调用；runner 覆盖迟到模型响应、Mock 忽略 abort 后仍不得派发后续调用、轮次/调用数/单次和总时限/token 上限；IPC 和 preflight 测试证明不完整结果不写任务。8 个预检/授权相关文件 **164 tests**、`hostedAgentTurnHost` 的脚本撤权回归 1 项、Electron/shared/renderer 类型、i18n、系统不变量 registry 和 `git diff --check` 已通过；Electron 增量构建已通过。首次全量 `npm test` 发现 `hostedAgentTurnHost.test.ts` 的 run_script 撤权 fixture 缺少必需脚本哈希事实，补齐 fixture 后定向回归通过。最终全量 `npm test` 退出码 **0**：**1,099 个测试文件通过、1 个跳过；10,545 项通过、111 项跳过**（786.42 秒）。
- **可执行环境：** 本机；真实模型服务质量仍为外部验收。
- **状态：** - [x]

### E-15d 分离 Mock 演练与权限总结会话

- **依赖：** E-15a～E-15c；需求 §5.6「双阶段模拟与授权总结（会话补充，2026-10-19）」。
- **目标文件：** `electron/butler/taskPreflightModelAnalyzer.ts`、`electron/butler/taskPreflight.ts`、`electron/butler/butlerIpc.ts` 及相应测试、需求和开发方案。
- **动作与产物：** 先以 RED 测试固定模型总结不能新增轨迹外权限、不能漏掉轨迹中已模拟的 Shell 权限，并以 MCP 映射名核对服务和工具身份。第一阶段提示明确“不需完成真实任务”，预算只作为主机停止上限；第二阶段以全新、无工具、无第一阶段历史的模型请求汇总任务配置、轨迹、状态和停止原因。第二阶段从整次预检时限与 10,240 输出 token 总额中分别获得 20 秒和 2,048 token 的独立保留预算，演练阶段累计上限相应为 8,192 token；超限后仍总结部分轨迹，但标为不完整并维持不可确认/不可保存门禁。
- **完成判据：** 两阶段模型请求上下文互相隔离；第二阶段无工具且可收到完整/部分主机轨迹；主机逐项验证权限提案与已模拟调用的对应关系，任何新增、漏项或身份不匹配均 fail closed；已有“预算不完整不允许确认授权或保存任务”行为保持通过。
- **验证命令：** `npm exec vitest run electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskPreflight.test.ts electron/butler/butlerIpc.test.ts electron/butler/taskPreflightNoSideEffects.test.ts`；`npx tsc -p tsconfig.electron.json --noEmit`；`git diff --check`。
- **证据：** RED：3 个新增轨迹对照测试在旧实现中均失败，分别复现总结会话可编造 Shell 命令、漏掉轨迹中的 Shell 权限、将 MCP 权限指向未模拟的工具。GREEN：5 个定向测试文件 **76 项通过**，覆盖分离新会话、预算耗尽后总结部分 Shell 轨迹、权限与轨迹逐项对应以及零真实副作用；Electron TypeScript 编译检查和 `git diff --check` 通过。
- **可执行环境：** 本机 mock LLM、虚拟工具调用和主进程轨迹核验。
- **状态：** - [x]

### E-15e 移除独立的小额输出 token 截断

- **依赖：** E-15a～E-15d；用户明确指出预检代码额外设置的 2,048 token 输出上限会截断正常汇总。
- **目标文件：** `taskPreflightMockRunner.ts`、`taskPreflightModelAnalyzer.ts` 及其测试、`tool-confirmation-top-level-design-v2.md` §5.6、开发方案 §2.3。
- **动作与产物：** 第一阶段和独立总结阶段的 `max_tokens` 都取当前任务所选模型配置的 `maxTokens`；移除预检单轮固定小额和跨阶段累计 token 截断。继续由主机强制最多 5 次模型生成、12 次 Mock 调用、单次模型请求 20 秒、整次预检 60 秒。模型服务明确返回 `max_tokens` 截断时，向用户说明模型回复不完整，不混报为网络、服务不可用或权限校验错误。该任务修订并取代 E-15a/E-15d 中原记录的 token 数值限制，旧记录保留为实现历史。
- **完成判据：** 两阶段模型请求均按所选模型配置最大输出值发送；累计 token 数不额外截断 Mock 演练；生成次数、Mock 调用数、单请求和总时限边界保持有效；截断分类和用户提示准确。
- **验证命令：** `npm exec -- vitest run electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskPreflight.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run typecheck:shared`；`npm run typecheck:renderer`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run dev`；`git diff --check`。
- **证据：** RED：模型分析器测试要求使用配置的 16,384 token 时，旧实现实际请求 2,048；随后单纯调高到 4,096 仍未遵循模型配置。runner 回归亦确认累计/每轮输出限制仍收窄请求。GREEN：4 个定向测试文件 **95 项通过**，覆盖两个阶段遵循所选模型输出上限、不设累计 token 停止、首阶段截断与总结截断均准确分类、保留模型轮次/Mock 调用/时限门禁和用户提示。Electron TypeScript 检查、shared/renderer 类型、i18n（0 个源代码硬编码中文）、system invariant registry（10 registrations / 36 test references）及 `git diff --check` 全部通过。随后用 `npm run dev` 完成全量 Electron 构建并加载 renderer，Vite 返回 HTTP 200。
- **可执行环境：** 本机 mock LLM、runner 边界测试和 Electron 构建。
- **状态：** - [x]

### E-15f 定位并修复预检模型请求失败

- **依赖：** E-15e；用户报告输出上限调整后，保存失败转为“预检服务暂时无法完成请求”。
- **目标文件：** `electron/butler/taskPreflightModelAnalyzer.ts`、`electron/butler/taskPreflight.ts`、`electron/butler/butlerIpc.ts`、对应测试、`src/shared/automationTaskTypes.ts`、中英文 `config.json` 与生成的 i18n 类型。
- **动作与产物：** 以安全诊断日志定位请求阶段，日志只记错误类别、阶段、所选模型、输出上限和计数，不记任务内容、路径、凭据、完整服务地址或原始异常正文。大输出请求改用 SDK 流式接口；任务思维强度传给 Mock 演练，独立轨迹总结仍调用同一所选模型但关闭额外思考。提示词明确演练是采样，不必穷尽工具或权限；预算耗尽后仍把已有轨迹交给总结。将总结请求的单次超时与整次 60 秒超时分开分类，替换不准确的“缩小授权目录”建议。主机检测到模型请求读取输出 Git 仓库但该目录未获读取授权时，返回待用户确认的目录建议；不会自动扩大权限或保存授权。
- **完成判据：** 旧流式协议失败、总结超时分类错误、输出目录读请求被泛化为结果校验错误均有 RED 回归；真实开发界面将最后一种情形显示为具体读取授权说明和默认未选的路径建议；模型失败日志不泄漏敏感输入；工具目录与授权边界、用户选定模型输出上限及既有轮次/调用/时间预算约束保持有效。
- **验证命令：** `npm exec vitest run electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskPreflight.test.ts electron/butler/butlerIpc.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run typecheck:renderer`；`npm run typecheck:shared`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run dev`；`git diff --check`。
- **证据：** RED：384,000 输出配置经非流式请求触发服务端“需要流式请求”拒绝；摘要请求用 20 秒单请求超时被误映射成整次 60 秒超时；Shell 在输出 Git 仓库根目录的请求被主机拒绝后被误报为模型权限范围格式错误。相关测试先分别失败。GREEN：两模型阶段都改用流式请求；第一阶段任务强度按配置发送，独立摘要使用零思考强度；摘要超时显示为真实阶段及可操作建议。真实任务重试中，安全日志确认摘要阶段已返回，主机识别 `run_shell` 目录未授权并保持拒绝；界面显示“输出目录只用于写入”的说明及默认未选的项目根目录授权建议，没有保存任务或扩大权限。定向 **5 个测试文件 / 124 项通过**；Electron、renderer、shared 类型检查、i18n、系统不变量登记检查、`git diff --check` 通过；`npm run dev` 完成 Electron 构建并启动应用。
- **可执行环境：** 本机开发实例及 mock LLM；真实模型请求使用用户配置的 `deepseek-flash`，完整权限授权仍由用户在界面自行选择。
- **状态：** - [x]

### E-15g 让预算停止后的部分清单进入用户复核并传递覆盖事实

- **依赖：** E-15d、E-15f；用户明确说明预算用于停止 Mock 采样，采样后的独立会话仍应总结轨迹并交用户确认。
- **目标文件：** `electron/butler/taskPreflight.ts`、`taskPreflightMockRunner.ts`、`taskPreflightModelAnalyzer.ts`、`butlerIpc.ts`、`taskStore.ts`、`electron/confirmation/approvalAgent.ts`、`ButlerTaskSettings.tsx`、相关测试，以及需求、开发方案和本执行计划。
- **动作与产物：** 区分“主机预算正常停止采样”与“模拟环境或总结结果不可信”。预算停止且独立总结通过轨迹/参数核对时，生成显式 partial coverage 的权限复核；用户确认只授权清单列出的范围。coverage、权限和模拟轨迹由主进程保存并冻结到 run snapshot，安全审核 Agent 必须看到 coverage 状态；其他失败继续 fail closed。该任务修订并取代 E-15a、E-15c、E-15d 中“仅因预算不完整就禁止确认”的旧门禁。
- **完成判据：** 有效预算停止后的部分摘要可进入 UI 权限清单并明确提示覆盖不完整；用户确认后授权记录与 run snapshot 保留 `preflightCoverage=partial` 和轨迹；安全审核 Agent 的可信区明确获知覆盖不完整及清单外权限未获本次授权。无效摘要、轨迹与权限不匹配、未知工具、Mock adapter 失败仍不能确认或保存；任何真实 executor/process/MCP/network/delivery 都未调用；未列权限仍不匹配授权。
- **验证命令：** `npm exec vitest run electron/confirmation/approvalAgent.test.ts electron/butler/butlerIpc.test.ts electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskPreflightMockRunner.test.ts electron/butler/taskStore.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`；`npm run typecheck:shared`；`npm run typecheck:renderer`；`npm run i18n:check`；`npm run check:system-invariant-registry`；`npm run build:electron:incremental`；`git diff --check`。
- **证据：** RED：安全审核 Agent 线索包用例在记录带有 `preflightCoverage=partial` 时，未向审核 Agent 传递状态或说明未列权限不在确认范围内而失败。GREEN：7 个定向测试文件 **220 项通过**，覆盖部分预算结果可进入权限复核、确认后记录与 run snapshot 保留 coverage/trace、超过 Mock 调用上限的未派发调用仍进入权限核对，以及审核 Agent 收到 partial 状态并明确只确认列出权限。`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`（0 个源代码硬编码中文）、`npm run check:system-invariant-registry`（10 个登记 / 36 个测试引用）、`npm run build:electron:incremental` 和 `git diff --check` 均通过。最终 `npm test` 退出码 0：**1,099 个测试文件通过、1 个跳过；10,570 项通过、111 项跳过**（785.43 秒）。全量运行中曾有一次因系统临时目录空间不足失败；清理无占用的生成缓存后，受影响的 `butlerInvoker.test.ts` 57 项通过，随后全量测试通过。
- **可执行环境：** 本机 mock LLM、Mock 工具目录、任务 store 和审批线索包。
- **状态：** - [x]

## 4. 外部验收（不阻塞源码关闭）

| 编号 | 项目 | 验收人/环境 | 证据 |
|---|---|---|---|
| X-01 | 真实模型对需求歧义判例的一致性、延迟、超时行为 | 产品/测试环境中的真实模型服务 | 判例集结果和请求时延记录；不能用一次通过代替稳定性结论 |
| X-02 | 安全审核 Agent 对跨多个用户授权目录不再误判工作目录外，且仍拒绝集合之外目标 | 真实审批模型 + 本地隔离目录 | 输入 roots、decision trace、executor 未调用/调用证据 |
| X-03 | 宽屏双栏、窄窗口回退、中文长路径与键盘辅助技术 | macOS/Windows 桌面包 | 截图、操作记录、键盘可达性清单 |
| X-04 | 数据库升级/旧版本回退 | 打包应用副本 + v102 数据副本及升级前备份 | 新版迁移成功；旧版打开升级库被高版本保护拒绝；恢复升级前备份后旧版启动成功；再次升级结果可读；列明升级后数据不包含在旧备份中的损失边界 |
| X-05 | 跳过无特殊通知、运行历史可见；本期不触发 IM 特殊通知 | 配置真实飞书/微信账号的验收环境 | skipped event / delivery journal 对照 |
| X-06 | 新增输出目录/归档策略的窄窗、中文长路径、键盘焦点和屏幕阅读器标签 | macOS/Windows 桌面应用 | 宽/窄窗口截图、选择与校验操作记录、键盘可达性清单 |

## 5. 开发进度记录

本节只记录实际进度，不改变技术方案中的验收或契约。开始实现后，每个任务状态变化时更新相应登记项，并在任务下注明验证证据；没有证据不得勾选完成。

### 2026-10-18 评审阻断修复（B-01～B-04）

| 评审项 | 修复与边界 | TDD 证据 | 状态 |
|---|---|---|---|
| B-01 任务/binding revision 及运行写回 | 新建带 binding 的 v1 task 同事务写入 `task_revision=1`；运行元数据（`lastRunAt`、`nextRunAt`）不推进配置 revision；配置变更仍递增并重做预检。 | RED：评审探针观察新建 revision=0 且首次重验 `TASK_REVISION_MISMATCH`；GREEN：`taskPreflightReviewRegression.test.ts` 用真实 resolver binding、新建 store 和两次元数据写回重验，revision 保持 1。 | - [x] |
| B-02 整段 prompt 被当作 basename | exact binding 新增结构化 `targetReference`（basename/path + 原始目标片段）；重验只按该片段检查 basename 唯一性，不从 prompt 字符形状推断。resolver version 升至 2；旧版 exact binding fail closed 并要求重新预检，语义未变的 v1 collection/output binding 继续兼容。 | RED：评审复现完整自然语言误判/含其他路径绕过；GREEN：`taskPreflightReviewRegression.test.ts` 验证不变目标通过、后续新增同名文件失败；`taskTargetResolver.test.ts` 验证旧 exact resolver version 拒绝且旧 collection binding 兼容。 | - [x] |
| B-03 path facts 缺根目录 | provider 把已验证 canonical roots 作为 directory facts，供根目录 collection、exact directory 和首个输出祖先查找。 | RED：评审探针真实临时空目录复现 `TARGET_NOT_FOUND` / `OUTPUT_ANCESTOR_INVALID`；GREEN：`taskPreflightReviewRegression.test.ts` 经真实 provider 分别验证根目录 collection 和根下新输出通过。 | - [x] |
| B-04 深度截断误报 complete | 深度边界目录仍有未扫描内容时标记 `truncated=true`、`complete=false`；resolver 与运行重验因此拒绝不完整 facts。 | RED：评审探针发现深层同名项未收集但 coverage complete；GREEN：`taskPreflightReviewRegression.test.ts` 验证深层同名布局产生不完整覆盖，并被 resolver 与 persisted-binding revalidation 拒绝。 | - [x] |

**合并验证：** `npm exec vitest run -- electron/butler/taskPreflightReviewRegression.test.ts electron/butler/taskPreflight.test.ts electron/butler/taskTargetResolver.test.ts electron/butler/taskPathFacts.test.ts electron/butler/taskStore.test.ts electron/butler/taskScheduler.test.ts electron/butler/butlerIpc.test.ts`：7 files / 82 tests passed。`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental`、`git diff --check` 通过。

### 源码关闭后的缺陷修正：目标不清晰时允许保存草稿

- **问题：** 真实界面遇到 `TARGET_UNCLEAR` 时返回“预检未通过，任务尚未保存”，造成先保存再补充目标的流程无法开始。
- **处理：** create/update 对仅含 `TARGET_UNCLEAR` 的报告仍提交配置，写为停用草稿并返回报告；编辑草稿时清除旧 binding 并恢复 `preflightVersion=0`，防止沿用过期授权选择。界面提示草稿已保存、展示预检报告并保留表单；补充目标且预检通过后按原提交门禁保存绑定。其他 blocker、模型不可用、路径/字段校验仍按原门禁处理。
- **TDD 证据：** RED：`butlerIpc.test.ts` 的 `saves TARGET_UNCLEAR as a disabled draft without valid bindings` 在旧代码中因 `ok:false` 失败。GREEN：`npm exec vitest run -- electron/butler/butlerIpc.test.ts electron/butler/taskStore.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx` 通过 3 files / 69 tests，覆盖已保存停用草稿、旧 binding 清除、保存后报告展示与表单保留。`npm run i18n:generate-types`、`npm run i18n:check`、`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 均通过；首轮类型检查发现 draft 判别类型收窄错误，修正后构建通过。

### 2026-10-18 预检解释与歧义定位修正

| 问题 | 修复与边界 | TDD 证据 | 状态 |
|---|---|---|---|
| 问题只显示代码，目标不清楚时无解释 | 新增共享稳定 code→messageKey 映射，并在 zh-CN/en-US `butler.preflight` 统一维护全部预检问题说明；表单显示人话说明、原因、任务原文片段和下一步，不显示内部代码。预检不可用错误也经同一映射本地化。 | RED：组件断言找不到 `TARGET_UNCLEAR` 的用户说明；GREEN：`ButlerTaskSettings.test.tsx` 覆盖问题说明、原文片段与预检不可用的可读提示。 | - [x] |
| `TARGET_UNCLEAR` 不指出含糊位置；同名歧义没有候选 | 模型澄清协议增加原文精确片段、固定原因码及候选字段；主进程校验片段属于用户原文，并把候选路径限制为已采集 facts。解析器遇到同名目标时返回所有匹配路径（最多显示 20 项并保留总数）；表单提示用户明确路径/范围后重存。 | RED：`taskPreflight.test.ts` 缺少原文片段、原因和候选路径；模型提示词测试缺少 `clarifications` 协议。GREEN：5 个定向测试文件 / 55 项通过，覆盖模型协议、无目标解释、同名候选、预检不可用和表单展示。 | - [x] |

**合并验证：** `npm exec -- vitest run electron/butler/taskPreflight.test.ts electron/butler/taskPreflightModelAnalyzer.test.ts electron/butler/taskTargetResolver.test.ts electron/butler/butlerIpc.test.ts src/renderer/components/Config/ButlerTaskSettings.test.tsx`：5 files / 55 tests passed。`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`、`npm run check:system-invariant-registry`、`npm run build:electron:incremental`、`git diff --check` 通过。`npm run dev` 的 renderer 返回 HTTP 200，开发窗口可进入定时任务设置；实际错误详情由组件回归覆盖。

