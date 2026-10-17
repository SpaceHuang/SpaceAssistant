# 定时任务文档产出能力改进方案

> 状态：草稿（未实施）
> 基线：`bd3ac7bbe58f3e583b6e5fdebc8225bb6e6698b0`（工作区另有未提交改动；本方案只依据已读取的当前文件和本机运行日志）
> 范围：automation 定时任务按提示词生成文件，以及任务运行状态对产物是否完成的表达。

## 第 0 层：决策层【人必读】

**一句话：** 定时任务目前按只读权限运行，因此不能把报告写入工作目录；本方案拟增加范围受限的文档写入和明确的产物验收。

**只有 3 分钟的话：** 请先裁决 D-1 和 D-2。若不裁决，系统维持现有只读行为，定时任务继续不能保证写出文件。

### D-1：是否允许定时任务在绑定工作目录中创建文档？

定时任务无人值守运行。当前策略禁止 automation 写文件；开放后，任务可把模型生成的内容写入本次运行绑定的工作目录。请决定是否接受这一行为变化。

- **A：允许受限创建（推荐）**。只允许 `write_file` 在任务运行时已固定的工作目录内创建新文件；拒绝编辑已存在文件、工作目录外路径、Shell、脚本和外发操作。好处是可生成报告；代价是模型可在任务目录留下内容，仍需通过路径校验和写入审计降低误写风险。可通过关闭任务或撤销规则回退，已创建文件不会自动删除。
- **B：继续只读**。不开放任何文件写入。安全行为不变，但要求输出文档的任务仍无法完成。

**不决定时：** 维持 B，不改变当前策略。

### D-2：如何明确一项任务必须交付文件？

目前任务只有自由文本提示词。系统不能可靠地区分“请总结并生成文档”和“仅在回复中总结”，也就不能判断缺少文件是否应算失败。请决定是否在任务配置中增加明确的文件交付要求。

- **A：增加显式交付要求（推荐）**。任务设置中声明是否要求文件，并记录期望的相对路径；运行完成前核对每个要求路径在本次运行中成功创建。缺点是需新增配置字段、数据库迁移和设置界面，旧任务保持“未声明文件要求”。
- **B：只依赖提示词和模型工具调用**。不增加配置，但运行状态只表达模型回合是否完成，不能保证提示词中的文件要求已经兑现。

**不决定时：** 不新增任务配置；文件缺失不改变现有完成语义。

涉及设置界面的 D-2 需先获批界面归属卡，再排入实现阶段；未获批前不实现界面和持久化字段。

**不需要你决定：** 实现者应自行完成路径规范化、链接逃逸检查、原子创建、审计字段、恢复语义和边界测试；这些是实现规格，不转交为产品选择。

## 第 1 层：概要【人机共读】

### 问题与目标

automation 会话把任务工作目录固定在 `AutomationTaskRunConfigSnapshot.workDir`；系统提示说明无人值守时写文件会被拒绝，策略规则 `automation-write-deny` 也拒绝 `write_file` / `edit_file`。这构成了“明确要求生成文档时不能落盘”的产品能力限制，但不能用来解释下面这次没有文件交付要求、也没有发出写文件调用的运行。

本机数据库已映射到一条具体运行：任务 `1c2c8897-fd90-45f2-a8d5-39dec9a263a4` 的 run `3c063454-afab-41ab-845c-6713404ea030`，session `22280cb9-52dd-41ca-a948-f40aca9f9b64`。原提示词要求“总结……按提交分组”，**没有明确要求写文件**；本次 21 个工具调用中没有 `write_file` / `edit_file`。因此这次运行不能作为“写文件规则拦截了文档生成”的证据。它实际因工作目录只绑定到 `daily`、仓库在目录之外而无法读取提交历史；自动化的外部读取与 Shell/脚本调用又受到不同规则限制。run 仍被标记为 `completed`，因为代码把模型回合结束当作任务完成。

本方案目标：

1. 区分任务无法读取输入数据，与任务未声明或未能创建输出文件这两类失败。
2. 若决定支持文档产出，在 D-1 获批后只开放可验证、受任务工作目录限制的文件创建。
3. 在 D-2 选择显式交付要求时，只有所有要求的文件均成功创建并通过存在性校验，运行才可标记为 `completed`。
4. 对任务所需数据不可达、任务范围裁决拒绝、写入被策略拒绝等情况留下可追溯原因；失败不伪装成业务完成。

### 不做

- 不开放 automation 的通用 Shell、脚本或外发能力。
- 不允许覆盖或编辑已存在的文件。
- 不尝试自动判断任意自然语言中是否隐含“必须生成文件”。
- 不把模型回复中声称“已生成”作为文件存在的证据。
- 不处理已有失败运行的自动补跑或自动重试。

### 主要风险与排除方案

选择在现有文件工具闸门中增加受限创建事实和 final-check，复用已固定的任务工作目录。排除“放开 automation 的全部写入工具”：它无法限制任务目标，且会改变文件覆盖、执行命令等行为。排除仅修改系统提示：提示不能覆盖 policy deny，也无法作为安全边界。

## 第 2 层：规格【机｜人工可跳过】

### 事实卡

| ID | 事实 | 复现方式 |
|---|---|---|
| F-1 | automation 系统提示将写文件、执行命令、发送消息列为无人值守自动拒绝操作。 | `rg -n "BUTLER_SYSTEM_APPENDIX|写文件|自动拒绝" electron/butler/butlerInvoker.ts` |
| F-2 | `automation-write-deny` 对 `write_file`、`edit_file` 作 locked deny；`automation-readonly-allow` 显式放行读取工具。 | `rg -n "automation-write-deny|automation-readonly-allow" src/shared/policy/defaultRules.ts` |
| F-3 | 任务运行快照固定工作目录，automation 会话也通过 `fixedWorkDir` 绑定该目录。 | `rg -n "configSnapshot|fixedWorkDir|workDir: workDirResult" electron/butler/butlerInvoker.ts` |
| F-4 | run 当前在模型回合成功后直接记录 `completed`；没有声明必需产物或验证其存在的契约。 | `rg -n "status: 'completed'|extractTextFromContent|resultSummary" electron/butler/butlerInvoker.ts` |
| F-5 | 文件工具的路径参数统一由 `path` 解析；写入策略事实与最终路径执行分别位于确认闸门和文件执行器链路。 | `rg -n "write_file|write-target|path" electron/confirmation/toolCallGate.ts electron/tools/registeredAgentTurnTools.ts electron/toolPathField.ts` |
| F-6 | 用户提供的 `87ab0b2d-e60f-4391-a07a-757e9ab73e02` 是本次任务的 `model_service_id` / run 快照 `serviceId`，不是 session ID。对应 task=`1c2c8897-fd90-45f2-a8d5-39dec9a263a4`、run=`3c063454-afab-41ab-845c-6713404ea030`、session=`22280cb9-52dd-41ca-a948-f40aca9f9b64`；prompt 要求提交总结但没有要求写文档，工具日志没有 `write_file` / `edit_file`。 | 只读查询 `automation_tasks`、`automation_task_runs`；检查 `/Users/space/Documents/工作目录/daily/sessions/22280cb9-52dd-41ca-a948-f40aca9f9b64-20261017/events.jsonl` 中的任务事件和工具调用。 |
| F-7 | 该任务配置的工作目录为 `/Users/space/Documents/工作目录/daily`；运行结果记载该目录只有 `sessions/`，不含目标 Git 仓库。日志显示 `run_shell` / `run_script` 调用以 `POLICY_DENY` 未派发，目录外读取也被拒绝；模型最终明确报告没有取得任何提交数据。 | 查询 task 的 `work_dir`、run 的 `config_snapshot_json` / `result_summary`；读取上述 `events.jsonl` 中 `tool_call` / `tool_result`。 |
| F-8 | 同一 run 的安全审批 Agent 对部分动作确实作过判断：批准了相关的 `toolkit.find`、`env.workspace`；拒绝了无关的 `env.system` 和 `action.session.list`。另有任务/能力边界拒绝，如 `env.workspace` 的工具结果说明该能力只在 desktop lane 可用。 | 查 run 时间窗内 `ownership='internal'` 的审批会话及其 `agent_history_events`；与主 session 工具结果按 approval request ID / 时间核对。 |
| F-9 | `automation-default-confirm` 是策略兜底：它产生 `require-confirm(answerer=agent)`，会调用审批 Agent；它不是 automation 所有工具调用的统一决定者。明确 locked deny（如 automation 写文件和 Shell）在 Policy Engine 内早于审批 Agent 路径。 | `sed -n '450,590p' src/shared/policy/policyEngine.ts`；`rg -n "automation-write-deny|automation-shell-deny|automation-default-confirm" src/shared/policy/defaultRules.ts`；`sed -n '105,145p' electron/confirmation/automationLane.test.ts` |

本次运行的直接问题是**输入仓库不可达，且提示词没有声明文件交付**，不是 `write_file` 被拒的实测案例。若用户确实期望把总结保存成文件，需要同时明确数据源/工作目录关系与输出文件要求；工作目录外读取、Shell、文件写入是不同能力边界，不能用一个“开放 automation”开关概括。

### 不变量

- **INV-1：** automation 写入只能作用于本次 run 快照绑定的规范化工作目录内；模型、任务提示和 renderer 不能扩大该范围。
- **INV-2：** 本方案授权只覆盖创建新文件；覆盖、编辑、删除、Shell、脚本和外发仍由现有拒绝策略处理。
- **INV-3：** 执行器未成功创建目标文件时，不能产生“产物创建成功”的记录。
- **INV-4：** 当任务配置声明必需产物时，任一必需产物未被本次 run 成功创建并复核存在，run 不得进入 `completed`。
- **INV-5：** 授权、路径事实和执行材料必须绑定相同 task、run、session、调用 ID、规范化目标及 run 工作目录快照；绑定不匹配时 executor 不得调用。

### 状态与所有权

| 状态 / 事实 | 唯一 writer | 提交点 | 恢复 / 失败语义 |
|---|---|---|---|
| 运行工作目录快照 | `runButlerTask` | run 配置快照持久化后、session 创建前 | 快照失败则 run failed；禁止回退到随后变化的活动目录 |
| 写入授权决定 | policy engine / tool gate | invocation 授权完成 | 拒绝时 executor 未进入；保留 rule ID 与失败类别 |
| 文件目标创建结果 | 文件 executor | 临时文件原子创建并落盘成功后 | 不确定是否已提交时标记 interrupted / uncertain，不重试覆盖 |
| 必需产物验收 | `runButlerTask` | turn 完成后、run completed 前 | 任一缺失则 run failed，列明缺失的目标，不调用结果投递 |
| run 终态 | `runButlerTask` | 单次终态更新 | completed 需满足任务级产物契约；其他状态不得被恢复流程覆盖成 completed |

### 建议的调用路径与安全阶段

1. **Admission / facts：** 从可信 run 快照读取规范化 `workDir`；对工具目标解析相对路径并构造“目标位于 run 工作目录内、目标是新文件、父目录可达”的观测事实。facts 只报告证据，不作 allow/deny。
2. **Policy：** 仅在 D-1 获批后，用稳定 rule ID 表达 automation 的“目录内新文件创建”放行条件；将现有宽泛 `automation-write-deny` 改为拒绝目录外、现存目标、事实未知或路径不支持的情况。策略 trace 必须能查询命中的规则及理由。
3. **Final-check：** 在 executor 入口再次核验已批准目标、run 工作目录快照、规范化目标和文件不存在状态一致；不重新计算业务风险。失败使用稳定 failure class / case ID，保持 executor 未调用。
4. **Executor：** 通过已有安全文件执行器创建新文件，避免直接新增一条绕开 `pathSecurity` 的写路径。创建期间父目录软链接或目标状态变化时失败关闭；不得静默改写到另一目标。
5. **完成验收：** 对 D-2 显式声明的每个相对路径，核对该 run 关联的成功写入记录并在完成前复核目标存在。只凭最终回复文本、历史文件存在或其他 run 的写入记录不能满足验收。

新增不可配置的目录边界前，先在 `src/shared/security/systemInvariantRegistry.ts` 登记 owner、依据、范围、审计、测试和 overrideability，并运行 `npm run check:system-invariant-registry`。策略规则仍由 Policy Engine 管理，不登记为 invariant 来绕过策略审查。

### 建议契约

若 D-2 选择 A，类型和数据库字段由实现阶段单点定义：

```ts
type RequiredArtifact = { path: string }
type AutomationTaskOutputContract = {
  requiredArtifacts: RequiredArtifact[]
}
```

- 路径必须是相对 `workDir` 的规范化路径，不接受绝对路径、空路径、父目录穿越或规范化后逃出目录的路径。
- `runButlerTask` 在组装本次 run 的用户输入时，须把已声明的必需相对路径明确交给模型，并说明只创建新文件；该说明不构成授权，policy / final-check 仍独立执行。
- 旧任务字段缺省表示未声明交付要求，不推断为必需文件。
- 执行记录仅保存相对路径、结果类别、时间和关联调用标识；不在诊断日志复制文件正文。
- 失败类别至少区分：`outside-run-workdir`、`target-exists`、`path-unverifiable`、`authorization-denied`、`create-failed`、`artifact-missing`、`artifact-commit-uncertain`。
- 错误消息可供模型理解，但稳定类别与 rule ID 才用于机器判断和诊断。

若 D-2 选择 B，不增加 schema；run 的 `completed` 继续只表示模型回合成功，界面和文案不得暗示文件要求已验证。

### 反例场景矩阵

| 场景 | 预期行为 | 验证点 |
|---|---|---|
| 新文件目标在 run 工作目录内 | D-1=A 时允许创建；D-1=B 时拒绝 | 命中相应 policy trace；executor 调用次数符合决策 |
| 目标为工作目录外绝对路径 | 拒绝 | final-check failure；executor 未调用 |
| `../`、软链接、路径规范化后越界 | 拒绝 | 原始与规范目标均留安全诊断；无越权文件 |
| 文件已存在 | 拒绝，不覆盖 | 目标字节不变；稳定 `target-exists` |
| 父目录在检查后被替换为软链接 | 拒绝或提交不确定并进入失败态 | 并发边界测试；不能写入链接目标 |
| 写入成功但进程在 run 更新前退出 | 恢复时按关联调用与目标复核；无法确定则 interrupted | 不重复覆盖；不把不确定状态改为 completed |
| D-2=A 且要求文件缺失 | run failed，delivery 不执行 | 缺失路径明确；完成状态不提交 |
| D-2=A 且文件由旧 run 预先留下 | 本次 run 未成功创建则不满足要求 | 证明验收按 run 关联，不能只检查 exists |
| D-2=B，模型只在回复里称已生成 | 按原回合语义完成，不宣称产物已核验 | 输出状态没有虚假文件验收信息 |
| 任务取消、重复触发、准入失败 | 依现有状态机处理，不产生新的产物授权 | run 幂等与终态约束回归 |

## 阶段、迁移与回滚【机｜人工可跳过】

本方案先完成决策，不授权直接实现 D-1 或 D-2。决策获批后再形成执行计划。

| 阶段 | 内容 | 出口证据 | 回退实体 |
|---|---|---|---|
| P0 决策与契约 | 记录 D-1/D-2；若 D-2=A，完成界面归属卡并固定路径契约 | 决策记录、契约与场景矩阵通过评审 | 文档决策可修订；尚无代码或数据变更 |
| P1 事实与最终核验 | 增加 automation 写入 facts、policy trace、final-check；注册新系统 invariant | policy / final-check 边界测试；executor 未调用断言；registry 检查 | 回退新规则与 final-check 适配；恢复 automation 全面拒绝 |
| P2 文件执行 | 新文件安全创建、原子提交与不确定结果诊断 | 路径逃逸、软链接、已存在目标、并发替换及崩溃窗口测试 | 关闭 automation 创建规则；已创建文件保留，不自动删除 |
| P3 产物契约（仅 D-2=A） | 增量迁移任务字段、IPC 和获批设置界面；run 完成前核验必需文件 | 旧任务迁移兼容、缺失 / 成功 / 重复路径 / 重启测试 | 代码回退；数据库字段保留但忽略，避免破坏已有任务数据 |
| P4 可观测性与验收 | run 终态、事件日志和任务结果说明一致 | 定向测试与手工定时任务验收 | 可回退文案 / 展示层；安全策略关闭写入 |

### 迁移与失败语义

- D-2=A 的新增字段必须 nullable / 有兼容缺省，不回填旧任务，不改变旧任务计划或工作目录。
- 数据迁移只能通过项目既有增量 migration；事务使用 `runInTransaction`，不自行写 `BEGIN` / `COMMIT`。
- migration 失败不标记版本完成；重启后可安全重跑。完成标记必须在全部结构迁移成功后写入。
- 回滚不删除配置字段或已生成文件。旧版本读取不识别新字段时，安全策略默认仍拒绝 automation 写入。
- 文件提交成功与 run 状态提交之间存在崩溃窗口；写入记录须有稳定调用标识，恢复不得盲目重写。无法证明提交状态时使用 interrupted / uncertain，并允许人工检查。

## 验收映射【机｜人工可跳过】

| AC | 关联不变量 | 可执行验证 |
|---|---|---|
| AC-1：拒绝所有未在获批范围内的 automation 写操作 | INV-1、INV-2、INV-5 | `toolCallGate` / Policy Engine 测试覆盖目标内、越界、目标已存在、事实未知；检查 rule ID 和 executor 未调用 |
| AC-2：目标路径无法在最终检查中与批准目标匹配时不执行 | INV-5 | final-check 集成测试改变规范路径、工作目录快照或目标类型，断言稳定 failure class 且 executor 未调用 |
| AC-3：已存在文件字节永不被 automation 本次任务覆盖 | INV-2 | 文件 executor 边界测试：调用前后逐字节相同，并验证不存在备份/临时文件泄漏 |
| AC-4：声明的必需文件缺失时 run 不为 completed，且不投递成功结果 | INV-4 | butlerInvoker 测试：缺失一个、多项、写失败、run 更新失败；断言终态和 delivery 调用 |
| AC-5：旧任务在缺省配置下保持原有行为 | INV-1、INV-2 | migration + taskStore + invocation 集成测试：旧行读取、运行无交付契约、写入仍按 D-1 决策限制 |
| AC-6：重复触发和重启不造成覆盖或虚假完成 | INV-3、INV-4、INV-5 | 故障注入：文件提交后、run 更新前退出；恢复后不重复写，不将不确定状态置为 completed |

验证命令（实现阶段按改动文件一次性选择相关用例；这里不执行）：

```bash
npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/butler/butlerInvoker.test.ts electron/butler/taskStore.test.ts
npm run check:system-invariant-registry
```

若改动文件集合不同，应按实际边界测试调整命令；不把上列示例当作当前仓库中已存在的全部覆盖。

## 未验证项与待定项【机｜人工可跳过】

- 主 session 事件把拒绝结果多记录为泛化的 `POLICY_DENY`；未为每个失败调用保留可查询的 `policy.decision.ruleId`。因此 `run_shell` 的规则归因由其工具名与当前 Policy Engine 规则推得，不能冒称从该次事件记录里直接读到了 rule ID。改进诊断时应让调用结果关联并暴露真实 rule ID / 稳定 case ID。
- 当前任务提示没有声明“保存为文件”；数据库也没有文件交付契约。若产品希望每次都验收某份文档，需由负责人决定任务配置是否增加显式产物要求。
- 尚未复核写入执行器的软链接 / 原子创建细节以及 Policy Engine 对 locked rule 的准确优先级；进入 P1 前按当前基线代码重新读取对应实现并更新事实卡。
- D-1、D-2 由项目负责人裁决；D-2=A 还需界面归属卡审批。未决项不得进入代码实施阶段。

## 术语对照

| 业务词 | 内部词 |
|---|---|
| 定时任务 / 后台任务 | automation task / automation lane |
| 任务工作目录 | run-bound workDir |
| 必需文档 | required artifact |
| 写入授权 | policy decision + final-check |
| 运行完成 | automation task run status `completed` |
