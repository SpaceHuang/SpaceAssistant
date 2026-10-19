# 定时任务多工作目录与预检开发方案

> 状态：既有功能与结果目录拆分已实施；2026-10-18 任务级访问授权与 Git 预检修订已完成；2026-10-19 Mock 演练隔离与预算要求已纳入，执行见 E-15
> 需求基线：[定时任务多工作目录与预检需求细化（评审稿）](../../../review/2026-10-17-scheduled-task-multi-workdir-and-preflight-requirement-review.md)  
> 复审依据：[第四轮复审](../../../review/2026-10-17-scheduled-task-multi-workdir-and-preflight-development-plan-review-round-4.md)  
> 核对基线：工作区 `HEAD 7c0edc4176643627fdee85bff017a8d652059f26`；现状以本方案列出的当前文件和复现命令为准。工作区另有未跟踪目录 `llm-wiki.migrated-20261015-135757/`，与本方案无关。

## 第 0 层：决策层【人必读】

### 历轮阻断核销（2026-10-17）

| 评审项 | 修订位置 | 关闭机制与复审证据 |
|---|---|---|
| B-01 目标路径事实、绑定和运行期重验缺失 | §2.3「目标解析与路径事实」、§2.7、§2.8、E-04/E-07 | 受限事实生产器记录覆盖度；预检解析结果随任务版本持久化；运行前重算并比对，变化或无法完整验证时在 executor 前失败。用唯一/同名布局、保存后新增副本、顺序交换、截断及权限失败判例验收。 |
| B-02 回退承诺违反高版本保护 | §2.6、§2.9、E-02/E-10/X-04 | 明确旧应用不能直接打开升级后的数据库；回退协议是先停止写入并恢复升级前数据库备份，升级后新数据不包含在该备份中。不得以旧列投影声称可降级读取。用版本保护 fixture 验证升级拒绝旧应用打开、恢复备份后可打开、再次升级保留已恢复数据。 |
| B-03 skipped 分步写入可永久留错态 | §2.3「运行历史状态」、§2.7、§2.8、E-09/E-10 | 单事务写入完整 skipped 终态、原因和摘要；范围汇总使用稳定恢复游标并原子推进。对事务前后及重启边界注入退出，断言覆盖恰好一次、状态完整；补跑最近槽位按当前 R2/R3 规则处理。 |
| B-04 必填类型切换早于调用方迁移 | §2.3「持久化与共享类型」、§2.9、执行计划 E-01～E-05 | 先用可选兼容字段与集中 adapter 保持现有生产者可编译；逐层迁移 store/IPC/UI/run caller；只有全仓调用点迁完后才在独立阶段收紧为必填。每个阶段执行对应主进程、渲染进程和 shared 类型门禁。 |
| R2-01 单一现存对象绑定不支持动态输入和新建输出 | §2.3「目标模型」、INV-11、§2.7、E-04/E-07 | 区分 exact、collection、output 三类逻辑目标；只对解析唯一性和授权祖先关系做绑定，不冻结普通文件 inode。集合按明确目录/筛选规则在每次运行动态枚举；输出绑定已授权祖先及相对后缀。 |
| R2-02 旧任务没有绑定却被新协议强制要求 | §2.3、§2.4、§2.6、INV-13、E-02/E-07/E-10 | 持久化 `preflight_version`；旧行迁移为 legacy=0，新创建/成功编辑/启用为 v1。legacy 任务未编辑、未主动启用时按需求稿既有提示词语义，只重验字段和目录；缺目录仍失败。 |
| R2-03 skipped 游标可能越过补跑槽位 | §2.3「运行历史状态」、§2.4、§2.7、INV-12、E-09 | 使用独立 `recovery_cursor_at`；跳过事务只越过已经持久化为 skipped 的槽位，停在最近补跑槽位。补跑 run claim 与游标越过该槽位在同一事务提交；queued claim 可恢复，run-start 标记后退出按 interrupted 处理，不重放 Agent。 |
| R2-04 执行计划依赖环/缺项 | 执行计划 DAG、E-02a/E-04/E-05/E-05a/E-07 | 将调用方兼容迁移、预检门禁接入、最终类型收紧拆成独立任务；明确 E-04 provider/binding store 先于 E-07，且 E-05a 在 E-05 后。逐任务核对完成证据只来自自身或前置任务。 |
| R3-01 恢复游标生命周期缺失 | §2.3、§2.4、§2.6、INV-12、E-02/E-03/E-09 | cursor 定义为当前 schedule generation 下首个未核销槽位；普通 tick 与恢复 claim、改期/启停、pending 冲突、删除均使用 taskStore 事务契约，schedule generation 绑定 run。 |
| R3-02 预创建 claim 无续接入口 | §2.3、INV-12、E-03/E-07/E-09/E-10 | 内部 `executeClaimedRun(runId)` 只消费已存在 queued claim；E-03 提供 CAS primitive，E-07 接真实 invoker，E-09 只验 scheduler port，E-10 验真实跨层续接。 |
| R4-01 pending 期间禁止编辑与运行快照要求冲突 | §2.3、§2.4、INV-01/12、E-03/E-05/E-07/E-09 | task revision 与 schedule generation 分离；预检通过的配置编辑在 queued/running 期间可保存，claim 使用冻结 revision；调度操作按 queued/running 阶段分别处理，终态只能清理身份匹配的 pending。 |

上轮 B-02 数据库回退规格已关闭；本表是各轮修订记录，不代替复审对实现可行性的确认。

**一句话：** 本方案把任务目录改成多个明确授权的绝对路径，并在保存前检查任务目标、目录与字段；只有检查通过且用户确认权限清单后才保存，错过时段的跳过写入运行历史但不发送特殊通知。

**只有 3 分钟的话：** 看 D-1（失败运行通知）、D-2（预检是否调用外部模型）、D-3（会话事件存放位置）、本轮阻断核销、第 1 层的安全与数据边界，以及 INV-01、INV-03、INV-05。目录列表与编辑窗口布局已由需求稿的界面归属卡批准。

### D-1：运行准入失败是否需要额外通知？

有些已保存任务到期时可能因模型服务失效或目录不可用而无法启动。此类情形不是“跳过时段”，而是运行失败。错过时段的跳过已经决定只记运行历史、不发特殊通知；本项只涉及运行准入失败及运行中的执行失败。

- **A：只写运行历史，不发送额外通知。** 用户需主动查看历史；实现不增加新的通知打扰和渠道依赖。
- **B：发送失败通知。** 用户能及时修复失效配置；需要决定通知渠道、频率、无接收方行为，并处理通知重试与重复。
- **可逆性：** 可在后续版本新增通知，不影响历史运行记录；已经错过的即时提醒无法补发。
- **依据：** 当前 `butlerDelivery.ts` 只投递 `completed` 运行；failed/skipped/interrupted 均不投递。没有证据表明用户希望失败通知。
- **建议：** 本期只保证历史记录，不新增失败通知链路。
- **未决定时：** 保持现状，不发送失败通知；D-1 不阻塞多目录、预检和历史记录实现。

下钻：需求稿 §2.2、§2.5、§4；`electron/butler/butlerDelivery.ts`。

### D-2：是否允许提交时把任务内容发送给所选模型做目标预检？

判断目标和条件是否清楚，需要语义分析。若由模型完成，点击保存会在真正创建/更新任务前多发一次请求；任务目标、调度和已选目录会发送到该任务选定的模型服务，并可能产生额外费用。需求已经要求目标清晰度检查，但尚未明确这次额外模型请求的服务边界。

- **A：使用任务当前选定的模型和服务（建议作为本期方案）。** 用户不需配置第二个模型，预检能力与未来执行模型一致；每次创建、编辑目标或重新启用时可能增加一次模型请求和费用，任务文字会额外发送给该服务。
- **B：不调用模型，只做本地字段和路径检查。** 不增加外部请求和费用，但系统无法可靠判断语义歧义；需修改需求，删除“目标及条件是否清楚”的自动检查承诺。
- **可逆性：** 可在后续换成本地/单独预检服务；已经发送的任务文本和发生的调用费用不可撤销。
- **依据：** 需求 AC-04 要求对会产生明显不同结果的歧义阻断；纯字段/路径规则无法判定语义。尚无性能、费用或隐私影响的实测数据。
- **未决定时：** 不实现模型目标分析，也不声称 AC-04 已交付；E-04 停在契约评审，不以隐式默认调用外部模型。

下钻：需求稿 §2.2、§2.3 A、AC-04；本方案 §2.3。

### D-3：多目录任务的会话事件文件放在哪里？

当前 automation 会话事件写在一个工作目录下面。新任务有多个同等授权根，若继续挑一个根写会话事件，就会出现哪个目录承载内部记录的问题；该目录不能因此成为 Agent 的默认执行目录。

- **A：放在应用私有数据区。** 每个任务写入 `{userData}/automation-sessions/<taskId>/`；新运行历史集中且不受任务目录增删影响，任务目录里不新增应用事件文件。已有事件不迁移，新事件改位置。
- **B：放在任务目录中。** 由用户指定一个单独的“会话记录位置”或选择目录列表中的一个位置；记录更靠近项目文件，但增加设置/数据字段，且该位置不能隐含授予 Agent 访问权。
- **可逆性：** 新运行可以改写入位置；已写事件文件不会自动迁移。
- **依据：** 当前事件路径使用 `path.join(workDir, 'sessions')`；尚无针对多目录任务的记录位置需求。
- **建议：** 选 A，避免新增用户配置，也不依赖授权列表顺序。
- **未决定时：** 不实现 automation session root 的新布局；E-07 暂停涉及会话/event 的改造，不以任何任务目录排序选一个根。

下钻：`electron/butler/butlerSessionEvents.ts`、`electron/sessionEvents.ts`、`electron/database/operations.ts`。

### D-4：任务目录是否拆分为结果输出目录与资料授权目录？（已裁决）

- **决定：** 用户必须选择一个结果输出目录；另有可空的授权读写目录列表。输出目录只承载任务生成结果，不因此授权读取、列目录或修改已有资料。界面使用现有目录选择器和定时任务编辑弹窗，提供归档模式：直接输出、按 `yyyymmdd` 子目录、按 `yyyymmdd-HH` 子目录。
- **数据兼容：** 新增 `outputDir` 与 `outputOrganization`，规范字段名为 `authorizedDirs`。旧任务原 `workDir/workDirs` 只映射为 `authorizedDirs`，不得推断为输出目录；旧任务未编辑时保持既有 legacy 执行语义，首次编辑必须明确选择输出目录。
- **决定依据：** 同一个工作目录概念无法表达生成结果的归档位置与用户允许读取/修改的资料范围；把输出目录加入授权根会过度开放读取。

### D-5：归档目录命名和默认值（已裁决）

- **决定：** 每日计划默认“按日期”，间隔定时默认“按日期小时”，一次性计划默认“直接输出”。用户仍可自行更改。定时运行按计划槽 `scheduledFor` 的本机时间生成文件夹；手动运行在 claim 转为 running 时冻结当前本机时间到 run snapshot 的 `scheduledFor`。同一日期或小时的运行写入同一归档目录。
- **决定依据：** 默认值应随任务触发粒度匹配，计划时刻可稳定确定归档位置，不受 Agent 实际启动延迟影响。

### D-6：无人值守结果写入边界（已裁决）

- **决定：** 文件工具只允许写入本次运行预检绑定的结果目标，且目标必须在该次归档目录内。输出目录不进入读取授权根；授权读写目录与本地工具权限由 D-7 定义。
- **安全实现：** facts 阶段只报告主进程对规范化路径与预检 binding 的验证结果：文件型 binding 只匹配该文件，目录型 binding 只匹配其归档目录下的普通文件；Policy Engine 通过稳定 rule ID `automation-bound-output-write-allow` 允许该信号，并保留 `automation-write-deny` 对未匹配文件工具写入的 locked 拒绝。final-check 以系统不变量 `SYS-AUTOOUTPUT-001` 确保文件工具写许可始终携带本 run 输出 binding，即使策略配置改变也不能派发未绑定写入；执行端再核验目标路径、binding 和归档目录，失败时 executor 不调用。
- **决定依据：** 结果目录需要实际承接任务生成物；只授权被用户保存前确认的目标并将范围限制在归档目录，可实现写入而不开放任意本地文件写入。

### D-7：任务是否可一次确认本地工具权限？（用户已确认）

- **决定：** 保存任务前，预检必须生成用户看得懂的权限清单，逐项说明资料目录读写、结果目录写入与归档方式、预检判定需要时的本地 Shell 范围，以及配置的结果投递渠道。Shell 授权绑定完整命令文本（含参数）和工作目录；执行超时是 Agent 可按运行情况调整的执行参数，不属于安全授权。用户检查清单并明确确认后，任务才保存。移除独立的 Shell 勾选项，是否需要 Shell 由预检给出并列入同一份待确认清单；旧任务迁移时不产生授权记录。
- **记录所有权：** 确认后由主进程依据本进程持有的一次性预检确认票据创建并保存授权记录，记录确认者、时间、任务版本、预检事实摘要和用户确认的完整权限项。renderer 与业务 Agent 不能提交、补写或替用户声明该记录。任务配置版本变化后必须重新展示清单并确认；旧版本记录不得作为当前授权事实。
- **运行边界：** 主进程将授权记录冻结进 run snapshot，并作为宿主事实提供给安全审核 Agent；业务 Agent 的文字声明不能替代记录。该记录证明用户同意任务长期使用列出的权限，不代表具体命令自动通过。后续运行不再额外向用户索取这些任务权限，但 `run_shell` 仍经过现有危险命令预检和主机路径事实检查；危险、无法完整分析、敏感/系统路径、授权目录之外的路径和 unsupported 结构仍在 executor 前拒绝。结果文件仍通过 D-6 的预检绑定目标写入；输出目录不因此变成读取授权目录。不得新增专用 Git 工具。
- **Git 目标预检：** 选定模型可依据已采集的本地 Git facts 提出所需 Shell 权限并定位仓库目标；多个可用仓库必须列出候选并要求用户说明。Git 本机查询能核验本地 refs/提交记录；本地记录没有包含 GitHub 推送事件时，不得声称知道推送时间。
- **依据与可逆性：** 用户已明确要求授权目录扩展为一次确认的权限清单，并由运行时保存可供安全审核核对的客观记录。用户可在编辑任务后重做预检并撤销或调整权限；变更只影响后续 claim，已运行任务仍使用冻结记录。目录迁移仍保留原值，但不会推导出旧任务授权记录或 Shell 权限。

**本次修订优先级：** D-4～D-7 与下列新增 INV-14～INV-17 优先于本方案其他章节中将 `workDirs` 同时称为输出/授权目录、将所有自动化写入无条件拒绝、将输出目标约束在授权读根内、或无条件拒绝无人值守 Shell 的早期文字。早期章节仍保留为历史实现基线，其冲突处按本修订执行。

**不需要你决定：** 多目录规范化、预检提交门禁、调度跳过记录、数据迁移、策略事实与审计 Agent 的根集合一致性、一次性任务请求到达时刻校验，均按需求稿与本方案规格实现。D-2 只裁决任务目标分析是否可以向模型服务发送一次额外请求，不改变已确认的提交门禁和目录授权规则。

## 第 1 层：概要【人机共读】

### 1.1 目标与边界

本次修订后，任务分别保存必选的 `outputDir`/`outputOrganization` 与可空的 `authorizedDirs`。运行开始时冻结两类目录和计划时刻；授权目录供资料读取/修改，输出目录按归档策略提供绑定结果写入。新建和编辑时，主进程先预检并生成权限清单，renderer 展示给用户核对；只有用户确认后主进程才保存任务和授权记录。阻断则返回问题和候选目录，renderer 保留表单。定时运行不调用目标清晰度模型；运行时配置无效记 `failed`，错过调度槽位记 `skipped` 并留在运行历史。

### 1.2 不做

- 不扫描整台设备寻找候选目录；目录候选只能来自任务中明确的绝对路径、已选择目录的可验证子路径和预检能具体说明来源的路径。无法可靠确定时要求用户在任务文字中补充路径。
- 不自动勾选候选目录，不把模型猜测写入授权集合。
- 不新增主目录、默认执行目录或按目录列表顺序决定目标的行为。
- 不开放 automation 的脚本、任意路径文件工具写入、外发或策略确认能力；本地 Shell 仅按 D-7 的任务级授权使用并保留安全预检。文件工具新增写入仍只限 D-6 约束的预检绑定结果。
- 不为跳过运行发送特殊通知；不扩展其他运行失败通知（D-1）。
- 不在本期为所有自动化历史记录增加清理策略、全局筛选或新的通知中心。

### 1.3 主要方案

1. 历史 `work_dirs_json` 经 adapter 作为 `authorizedDirs` 读取；v104 新增可空 `output_dir`/`output_organization`。新任务必须保存经校验的输出目录与归档模式；旧任务的原目录只映射到授权目录，未编辑前保持 legacy 行为，编辑时要求显式选择输出目录。
2. 运行快照分别持久化 `authorizedDirs`、输出目录、归档模式、`scheduledFor`、实际 `runOutputDir` 和目标 bindings。D-3 选 A 时，会话/event 仍写入应用私有 automation session root，不属于上述任一授权集合。授权根用于资料 facts；输出根仅提供受限输出事实。预检将输出目标绑定为相对输出根的路径，运行时依据计划时刻重映射到归档目录。
3. 任务表单提交先由 create/update IPC 校验字段、目录并运行无工具权限的目标分析；通过时主进程把同一份规范化任务快照与待确认权限清单保存在短时一次性票据中，renderer 只收到票据 ID 与可读清单，不写任务表。用户确认后 renderer 仅提交票据 ID，主进程消费票据、生成授权记录并保存；报告阻断时不产生可确认票据。
4. 资料读写目录由 `authorizedDirs` 决定，输出目录不得加入读取 facts、审批 Agent 读取授权或工具读取根。访问权限由预检清单生成，用户确认记录由主进程保存；任务记录只有在版本匹配时才可冻结到 run snapshot，并作为宿主事实传给安全审核 Agent。`run_shell` 的放行事实只来自该冻结记录；具体调用仍通过既有策略和 final-check。D-6 输出写入由 facts 记录精确 binding 匹配、Policy Engine 稳定规则判定，final-check 对 snapshot 和归档目录复核；执行上下文独立携带授权目录和输出范围。
5. 调度器继续使用唯一 `client_id` 抢占运行；启动恢复写 `skipped/missed-window` 的既有实现补上历史展示与稳定文案。跳过不调用 Agent、不投递，不和运行中的工具拒绝混淆；工具策略拒绝属于已启动运行的失败结果。

### 1.4 主要风险与排除方案

| 选择 | 排除方案 | 原因 |
|---|---|---|
| 主进程保存待确认快照和一次性权限清单；用户确认后消费票据并提交同一快照 | renderer 自己保存权限声明，或重新提交权限和任务字段 | 授权事实必须来自用户看过的那一份清单，且业务 Agent/renderer 不能自行声称用户已批准 |
| 授权根作为无序集合贯穿路径 facts、调用策略、审批 Agent 和工具执行 | 仅把数组显示在设置页，运行链仍用一个根 | 会造成 UI 宣称有授权但策略/审批 Agent 按单目录错误拒绝 |
| D-3 选 A 时使用应用管理的 automation session 存储根保存会话事件；它与 task roots 分离 | 从多目录列表挑一个作为“默认目录”兼做会话根 | 目录排序将影响会话位置与相对路径行为，违反无主目录要求 |
| 对未在授权列表中的明确目标建议已有父目录，经用户勾选后再保存 | 自动加入路径或扫描用户设备寻找近似目录 | 前者扩大授权；后者超出需求且不可预测 |

## 第 2 层：规格【机｜人工可跳过】

### 2.1 事实卡

| ID | 当前事实 | 复核命令 |
|---|---|---|
| F-01 | `AutomationTask`、CRUD 与运行快照目前以单个 `workDir` 为主；缺失时运行器会走旧 Profile 兼容路径。该回退必须按需求移除。 | `rg -n "workDir|workDirSource|legacy-profile" src/shared/automationTaskTypes.ts electron/butler/taskStore.ts electron/butler/butlerInvoker.ts` |
| F-02 | `automation_tasks` / `automation_task_runs` 表由历史 migration 创建；当前 schema version 为 102；run 状态已允许 `skipped`，启动恢复将较早 missed slots 写成 `missed-window`。 | `rg -n "DB_SCHEMA_VERSION|MIGRATION_V15_BUTLER|skipped|missed-window" electron/database/schema.ts electron/database/migrations.ts electron/butler/taskScheduler.ts electron/butler/taskStore.ts` |
| F-03 | task create/update IPC 目前只验证一个工作目录；preload 与 `src/shared/api.ts` 声明 butler 接口。 | `rg -n "butler:(create|update|choose-workdir)|butlerCreateTask|butlerUpdateTask" electron/butler/butlerIpc.ts electron/preload.ts src/shared/api.ts` |
| F-04 | 读路径 facts 的 `ProbeInput` 目前只有一个 `workDir`；automation outside-workdir 的 locked policy 由共享 Policy Engine 决策。 | `rg -n "type ProbeInput|classifyReadPathZone|outside-workdir|automation-readonly-allow" electron/confirmation/extractors/readPathFacts.ts electron/confirmation/toolCallGate.ts src/shared/policy/defaultRules.ts` |
| F-05 | automation invocation 将单一 `workDir` 传入工具装配及审批链；审批 Agent workspace 由 invocation materials 解析。 | `rg -n "workspaceRoot|resolveWorkDirForSession|runApprovalAgent|workspaceRoot: args" electron/butler/butlerInvoker.ts electron/runtime/invocationAssembler.ts electron/confirmation/approvalAgent.ts` |
| F-06 | 表单在 `ButlerTaskSettings.tsx` 中使用窄 Modal、单目录输入；同组件已有运行历史弹窗；config 文案分 `zh-CN`/`en-US`。 | `rg -n "<Modal|workDir|historyRuns|butler\.form" src/renderer/components/Config/ButlerTaskSettings.tsx src/renderer/i18n/resources/{zh-CN,en-US}/config.json` |
| F-07 | skipped 和失败运行都可由 `listAutomationTaskRuns` 返回；现有历史视图呈现状态与错误，但应补充 skipped 原因的用户文案，并确认查询排序可见。 | `rg -n "listAutomationTaskRuns|status|runError|historyRuns" electron/butler/taskStore.ts src/renderer/components/Config/ButlerTaskSettings.tsx` |

基线说明：工作区 HEAD 为 `7c0edc4176643627fdee85bff017a8d652059f26`。实现开始前重新运行事实卡命令并刷新基线；若目标文件已变，先更新方案，不以本方案行号作为定位依据。

### 2.2 不变量

| ID | 不变量 | 由谁保证 | 验证方向 |
|---|---|---|---|
| INV-01 | 每个 run 在 queued→running 原子转换时冻结当时的规范化 `workDirs` 和 task revision；其后任务编辑不改变该 run snapshot。成功保存的新配置供尚未启动的 queued claim 及后续 claim 使用。 | taskStore 在唯一 queued→running CAS 事务内读取当前 task revision、冻结执行配置到 run；`runButlerTask` 只从该 snapshot 构造 turn 配置。 | running run 未终结时移除目录仍可通过预检保存；旧 run snapshot/facts/审批 roots 不变，后续 run 使用新目录集合；queued claim 消费与编辑竞争有事务顺序且只选一个 revision。 |
| INV-02 | 每个根必须是主进程验证过的绝对可访问目录；数组去重且顺序不产生授权优先级。 | 共享目录校验器；task IPC 与 runtime admission 共用。 | 相同 canonical roots 去重；排列变更不改变目录分类集合。 |
| INV-03 | 工作目录内判定为目标在任一授权根之内；超出所有根才是 outside-workdir。敏感、系统、链接逃逸和未知仍走已有策略边界。 | Path facts 汇总器 + 共享策略。 | 每根分别读取、父子根、链接逃逸、未知路径和敏感目录边界回归。 |
| INV-04 | 工具 facts、执行链和安全审核 Agent 接收同一个规范化授权根集合；session persistence root 不属于授权根。 | `ResolvedAutomationRunConfig` 为唯一运行输入；assembler 只透传，不从 active Profile 二次解析。 | 对比 run snapshot、facts input、approval invocation 与工具上下文；切换桌面 Profile 不改变它们。 |
| INV-05 | 新建/编辑先由主进程预检并生成权限清单；通过时只暂存规范化候选快照与一次性票据，不写任务。用户确认票据后，主进程仅提交票据绑定的同一快照并记录授权；阻断、模型失败、目录无效、过期/重放票据或表单变更均不得写库。 | 主进程 create/update IPC 是候选快照与确认票据的唯一生产者；`butler:confirm-write` 是授权记录和任务写入的唯一提交者；renderer 只呈现报告/清单并回传票据 ID。 | blocker 与 preflight pass 都不直接写入；明确确认恰好写一次；mock 延迟、重复/过期票据、并发 revision、表单变更不保存旧快照。 |
| INV-06 | 用户明确勾选候选目录前，该路径不进入任务数据或运行授权；候选路径必须在主进程重新规范化和校验。 | renderer checkbox 仅修改未提交表单；task IPC 验证全部 roots。 | 伪造 renderer payload、未勾选、无效目录、重复路径。 |
| INV-07 | missed-window 记录为 `skipped` 且原因稳定；failed 是准入/运行失败；未到期或已停用不产生 run；跳过不启动 Agent、不调用投递。 | scheduler/taskStore 写入；delivery guard 不接受 skipped。 | 重启恢复、普通 tick、未启用、重复 requestId、delivery invocation spy。 |
| INV-08 | 工具调用在运行开始后被策略拒绝时，该 run 仍为执行失败/终态失败，不改写成 scheduler skipped。 | run executor/终态 writer。 | 安全策略 deny 的 tool-call 集成测试检查状态、错误分类与无 skipped status。 |
| INV-09 | 一次性时间只与主进程收到当前提交/启用请求时捕获的参考时刻比较；预检完成/写库不得重判新时刻。 | 主进程 task handler 捕获 `requestReceivedAt` 并向 schedule 校验与预检提交传递。 | 09:59:59 到达、10:00:03 预检通过；到点后新请求拒绝。 |
| INV-10 | 旧单目录任务迁移为单元素 roots；空目录旧任务不继承 active Profile；已有旧 run snapshot 可读。 | v103 增量迁移与 row mapper。 | 从 schema 102 fixture 升级；重启、重复迁移、原字段保留。 |
| INV-11 | v1 目标按 exact/collection/output 逻辑规则绑定；运行期只拒绝违反该类规则或授权边界的变化，不冻结普通文件 inode，不把预期集合成员变化误判为失败。 | binding resolver、`TaskPathFactsProvider`、runtime admission。 | 不存在的输出及中间目录通过覆盖检查；动态输入新增文件被纳入；exact 新歧义失败；普通原子替换通过；越界写仍被策略拒绝。 |
| INV-12 | `recovery_cursor_at` 表示当前 `schedule_generation` 下首个未核销槽位；每个槽位由 run、skipped summary 或 pending claim 唯一核销。普通配置编辑只推进 task revision，不重置调度游标；调度变更按 queued/running 状态在 taskStore 事务中更新 generation/cursor。 | taskStore transaction + scheduler recovery；claim 消费只使用内部既有 runId，终态按 runId/claim generation 条件清理 pending。 | 配置编辑后旧 run 仍用旧快照；queued 时调度变更冲突；running 时改期/启停可建立新代次；旧 run 终态不清除新代次 pending。 |
| INV-13 | 只有迁移来的 `preflightVersion=0` task 走 legacy 兼容语义；新建任务必须 v1，首次成功编辑或主动启用在同一事务切换到 v1。 | migration defaults、主进程 IPC、taskStore。 | 有效旧任务无 binding 仍按旧语义运行；缺 roots 失败；阻断编辑不变更 v0；成功后 v1；renderer 伪造 v0 被拒绝。 |
| INV-14 | 新任务必须有有效 `outputDir` 和 `outputOrganization`；`authorizedDirs` 可为空且只表示资料读写授权。旧目录只迁移为 `authorizedDirs`，绝不自动充当输出目录；旧任务首次编辑须明确补选输出目录。 | v104 migration、task DTO adapter、主进程 IPC。 | v103→v104 不改旧目录语义；新建缺输出拒绝；空授权目录允许新任务；旧任务未编辑仍可 legacy 运行，编辑未选输出被拒绝。 |
| INV-15 | 每个新 run 从冻结的 `scheduledFor` 和归档模式确定唯一 `runOutputDir`；预检 binding 的相对输出路径只能解析到该目录内。输出目录不能授权读取。 | 主进程输出目录解析器、taskStore run snapshot、runtime admission 与路径 final-check。 | daily/hourly 使用本机计划时间；direct 使用根目录；路径逃逸、链接越界、binding/run snapshot 不匹配均在 executor 前失败；read/list/grep 对输出目录仍视作未授权。 |
| INV-16 | 文件工具自动化写入仅在 facts 验证工具目标与本 run 已批准输出 binding 匹配时 allow：文件 binding 要求目标完全相同，目录 binding 只覆盖该目录下的普通文件；目标必须落在 `runOutputDir` 内。 | facts producer、共享 Policy Engine rules、tool final-check；稳定规则 ID `automation-bound-output-write-allow`、`automation-write-deny`；系统不变量 `SYS-AUTOOUTPUT-001`。 | 匹配输出写入进入 executor；未绑定输出、绑定目录之外的目标、其他输出根、资料授权目录文件工具写入均不进入 executor；输出根不能读取；decision trace 标明稳定 rule ID；empty authorizedDirs 不回退至 outputDir；即使管理员停用 locked write deny，final-check 仍拒绝无 binding 的 automation write permit。 |
| INV-17 | 定时任务权限必须先由预检列成用户可理解的清单，经用户明确确认后由主进程创建并保存授权记录；renderer 和业务 Agent 不能提交或伪造该记录。记录版本必须匹配当前任务，并冻结到 claim snapshot 后作为宿主事实提供给安全审核 Agent；旧任务默认无记录。automation `run_shell` 授权精确绑定完整命令文本（含参数）和工作目录；执行超时由 Agent 按实际情况选择，不属于授权字段或安全校验。现有 Shell 预检、完整度、敏感/系统位置、授权目录外路径与 unsupported 结构边界继续生效。 | task IPC 一次性确认票据、store revision 校验与 snapshot、`TaskPathFactsProvider`、preflight model analyzer、approval clue、`toolCallGate.ts`；稳定 rule IDs `automation-shell-deny`、`automation-authorized-shell-allow`、`automation-shell-analysis-incomplete-deny`、`automation-shell-outside-root-deny`；系统不变量 `SYS-AUTOSHELL-001`。 | 清单分别展示资料读写、结果目录写入、需要时的 Shell 命令与工作目录、投递权限；不显示执行超时；未确认不能保存；伪造 renderer 字段、业务 Agent 声明及过期/版本不符记录均不能授权；每次编辑后的权限变更只影响后续运行，已 claim snapshot 不变；安全审核 Agent 可见记录 ID、任务版本与完整范围；不为 Git 新增专用工具，也不把本机提交时间推断为 GitHub 推送时间。 |

### 2.3 契约卡

#### 持久化与共享类型

- 迁移期间 `AutomationTask.workDirs?: string[]`、`AutomationTaskInput.workDirs?: string[]` 与旧 `workDir?: string` 并存，避免尚未迁移的生产者在契约阶段失去编译能力。唯一兼容入口 `getAutomationTaskWorkDirs()` 将显式 `workDirs` 或明确旧单目录转换为 canonical 数组；缺失和空值统一为 `[]`，绝不从活动 Profile 补值。所有生产者与消费者迁移完毕后，单独阶段将公共 task/input 类型收紧为必填 `workDirs: string[]` 并删除旧字段；不得以断言或空数组填充绕过迁移。
- 数据库增加 `automation_tasks.work_dirs_json TEXT`（v103；若实现时版本已提高，使用下一 schema version）。迁移：非空 `work_dir` -> JSON 单元素数组；空值 -> `[]`；保留旧列用于数据恢复/诊断，不声称旧应用可直接打开升级库。新写入 `work_dirs_json` 为权威值；若兼容期保留 `work_dir` 投影，它只用于旧格式数据交换，不能绕过高版本保护或用于新路径判断。
- `AutomationTask` 新增 `preflightVersion: 0 | 1`；新建、成功编辑和主动启用写 v1，迁移旧行写 v0。v0 是数据库迁移产生的兼容状态，不允许 renderer/API 请求指定。新增 `targetBindingsJson`，v1 必须与 task fields、roots、schedule/prompt revision 同事务保存；v0 必须为空。`AutomationTaskRunConfigSnapshot` 固定记录 `preflightVersion` 与运行时解析出的 `TargetSelection[]`；旧快照仍只读兼容。
- `PreflightReport`：`{status: 'passed' | 'blocked' | 'unavailable', blockers: PreflightIssue[], suggestedDirectories: SuggestedDirectory[]}`。`PreflightIssue` 至少含稳定 `code`、面向用户的本地化 key/参数、关联字段；目录项含 `path`、`purpose`、`source`、`validationStatus`。不返回模型隐藏推理或凭证。
- create/update IPC 结果扩展为判别联合：成功 `{ok:true,id,task?}`；预检阻断 `{ok:false,kind:'preflight-blocked',report}`；验证或系统错误 `{ok:false,kind:'validation-error'|'preflight-unavailable',error,field?}`。同一请求不得既保存又返回阻断。
- 候选清单来源限定为任务文本中可解析的绝对路径及预检能给出具体依据的目标；每项需主进程 realpath/stat 校验。预检不能跨全盘扫描。无法提供可验证候选时只返回“请补充确切目录/目标”的阻断，不伪造路径。
- 目标不是统一绑定到保存时的现存文件身份。主进程 `TaskPathFactsProvider` 只在已选 canonical roots 内产出受限路径事实，供预检解析逻辑目标为以下判别类型；自然语言无明确范围时仍须阻断。扫描限深度 3、每根最多 10,000 项、总计 50,000 项，截断/权限错误报告 coverage incomplete，不能据不完整结果断言唯一：
  - `exact`：任务明确指向单个绝对路径或由路径规则唯一解析出的路径。绑定逻辑 canonical path、目标类型与解析规则，不绑定 inode。运行时同一路径仍在授权根内即可使用当时对象；对象被正常原子替换不构成失败。若该引用来自根内 basename 解析，运行前重算匹配项，新增第二个匹配项或解析路径变化则失败，不任选其一。
  - `collection`：任务明确给出授权根内目录及可判定选择器（初期仅支持固定目录下的 `*.csv` / `*.tsv` 和明确的全目录枚举，不支持任意脚本/正则）。绑定目录路径、选择器、排序规则与文件类型约束，不绑定成员清单；每次运行在该目录内重新枚举，新增/删除/替换成员是预期变化。目录失效、超出根、覆盖不完整或 selector 无法解析则失败；同名成员按全路径区分并确定排序，不进行跨根隐式择一。
  - `output`：绑定目标绝对逻辑路径、最近存在且已授权的 canonical ancestor、相对后缀和期望文件类型。后缀中尚不存在的目录/文件不要求 realpath 或文件身份；每次运行核验祖先身份仍是目录、祖先 realpath 仍在授权根内、后缀不含逃逸/符号链接越界。子目录创建权限由工具和策略执行期决定；本需求不解锁 automation 的 locked write-deny，策略拒绝仍按运行失败记录。
  每类绑定同时记录原始文本片段、解析规则版本、roots digest 与 task revision。文件身份只用于检测 roots/目录祖先被替换、链接逃逸等安全边界，不用于冻结普通输入文件成员。上述选择器范围是本期实现边界，不能让模型自由生成 glob。

#### 预检与保存时序

1. 主进程 handler 入口立即捕获 `requestReceivedAt`，规范化 renderer payload 并对全部必填字段、本地 schedule/交付字段、目录和模型 pair 做校验。
2. 仅在上述结构检查通过后，调用目标分析器。E-04 的结构化分析器不暴露工具调用；新增 E-15 Mock 演练后，模型可见当前任务可用的工具定义，但所有调用只能进入隔离的 Mock dispatcher。两阶段都接收 task prompt、schedule、delivery summary、已选 canonical roots 和允许使用的任务局部路径事实；都不能自动授权。
3. 结构问题、目标歧义、需要授权的目录或分析服务错误形成 report；存在任一 blocker 就不写任务表。候选目录未勾选前总是 blocker。
4. report 返回 renderer 后，renderer保留表单；勾选只将 canonical path 暂存入表单 `workDirs`。再次提交会重新执行完整校验与目标分析，不复用旧报告。
5. 没有 blocker 时，主进程将同一 DTO、`preflightVersion=1`、判别类型 `TargetBinding[]`、facts digest 和 revision 一并写入 taskStore；字段、roots、schedule/prompt revision、bindings 在一个 taskStore 事务中更新。编辑失败不覆盖旧配置。renderer 不得提交 preflightVersion，且 create 无 legacy 入口。
6. 异步分析可在主进程 await，但 renderer 的提交按钮须保持 loading 且禁止重复提交；如果未来采用异步 job，必须加 payload fingerprint 并证明结果绑定精确快照。当前方案不引入后台 job。
7. 单独启用：v1 task 重做字段/目录/目标预检；通过时将 bindings 与启用状态同一事务写入。v0 旧 task 的主动启用必须通过新预检并原子升级到 v1；阻断时维持停用、原 task 状态不变，打开编辑表单显示 report。用户修订后保存成功，再依原意启用。单独启用请求参考时刻由主进程捕获。
8. 运行准入按 `preflightVersion` 分支。v1 在任何 Agent 文件 executor 前重算 `exact`/`collection`/`output` 选择并校验绑定规则：basename 新增歧义、selector 越界/不完整、输出祖先越界或失效则 failed；exact 同一逻辑路径上的普通文件替换、collection 成员变化、output 尚不存在均按各自规则允许。v0 旧任务不要求缺失的 bindings，也不自动升级：未编辑、未主动启用期间沿需求稿兼容，只做既有字段、有效 roots、模型和安全策略准入，不让新预检逻辑重写 prompt 目标；缺目录/失效根仍 failed。旧任务 Agent 沿既有路径语义运行并继续受工具策略限制。v0 只来自迁移，不允许新请求选择。预检报告不复用；业务解析在 admission 做，final-check 只核验已批准材料。

目标分析模型使用任务当前显式 model/service pair；若 pair 不可用，作为 preflight unavailable/validation failure 阻断。预检请求不创建会话、不写 run history、不触发 delivery。调用须有超时和可取消的请求生命周期；超时稳定返回 unavailable，不允许沿用上一次通过结果。

#### Mock 演练隔离契约（E-15）

- Mock 演练使用任务提示词和当前运行时工具目录的定义，让所选模型产生真实格式的工具调用请求；调用只记录意图和参数，不派发到生产 executor。文件工具、`grep`、`run_shell`、`run_script`、MCP、网络与外部投递都必须经过 Mock dispatcher；不得启动进程、读取/写入实际文件内容、连接 MCP/网络服务或发送消息。路径事实只复用本次预检已收集的宿主快照。
- Mock 结果只能是明确标注的合成响应；需要真实文件内容、命令输出、MCP 返回或外部服务结果才能继续判断时，标记覆盖不完整并阻止生成可确认的授权清单。不得用模拟数据冒充事实。未知工具、缺少 Mock adapter 或调用参数无法解析时 fail closed，绝不能回退到生产 executor。
- 拟调用轨迹须记录工具身份、完整的安全相关参数和声明目标；路径仅代表计划访问目标，不能声称为实际访问证据。宿主将结构化轨迹与 E-04 目标/facts 结果合并，仍按现有主进程校验和授权范围规则生成权限提案。
- 第一版硬上限：最多 **5 次模型生成**（初始响应计入）、最多 **12 次 Mock 工具调用**、单次模型调用 **20 秒**、整次预检 **60 秒**；每次生成最多 2,048 个输出 token，累计输出最多 10,240 token。所有限制由主进程运行时强制，并覆盖 SDK 自动重试；不是仅靠提示词约束。
- 达到任一上限立即取消当前模型请求、停止分发后续 Mock 调用并终止预检；允许展示已收集轨迹，但必须标为部分结果/覆盖不完整，不允许用户确认授权或保存任务。不得后台续跑或自动重试。新的预检使用全新 Mock 状态。
- 预算常量须集中定义并可由边界测试注入缩小；UI 不提供放大安全上限的配置。

#### 多根路径与安全审核

- 新建 `ResolvedAutomationRunConfig`，唯一含有已校验 `workDirs`、model route、effort、task snapshot revision、preflightVersion 与运行时解析出的 `TargetSelection[]`。v1 按 binding kind 解析；v0 明确走需求认可的 legacy 分支。due slot 被 claim 时，taskStore 将当前 task revision 与完整执行配置 snapshot 原子绑定到 run；`runButlerTask` admission 后只从该 run snapshot 校验和构造配置，不从可能已编辑的 task 行重读执行输入。
- `readPathFacts`、写路径 facts（当前 automation 写入仍 locked deny）、grep/list/read 工具 gate 增加 `workDirs` 输入；范围为 `inside` iff realpath-safe target under any root。多根集合是无序集。目录项失效时整个 run admission 失败，不静默丢掉坏根继续。
- Policy Engine 仍以稳定 rule ID 处理 `outside-workdir`。多授权根仅改变 facts 的包含根计算；无人值守结果写入例外按 D-6 / INV-16 精确绑定处理。D-7 为明确获批的任务新增 Shell 能力，但不改变敏感/系统位置、授权根外路径、不完整分析和 unsupported 结构的拒绝边界；新增/调整 policy rules 必须有 decision trace 与自动化策略边界测试。
- `invocationAssembler` 将 `workDirs` 明确传入审批 Agent；审批上下文说明这些根是用户在该任务表单中明确选定的范围。审批 Agent 输出不得反算授权；工具 final-check 仍核验同一 roots 快照。
- `TaskPathFactsProvider` 与 `TargetBinding` 属于业务 facts/resolution 层；它们不授予工具权限。运行 admission 在 session/executor 创建前按绑定 kind 解析；final-check 只核验已批准身份、对象、授权代次、permit 与执行材料，不重新消歧。
- `exact` basename 解析出现歧义时失败；`collection` 允许按明确 selector 动态增删成员；`output` 允许目标尚不存在但须维持已授权祖先与安全相对后缀。不得把普通文件替换一概判失败，也不得因“动态”而扩大 selector 到授权 roots 之外。本期不允许用户相对路径产生目录优先级。
- D-3 选 A 时，automation session 的 `fixedWorkDir` 与事件账本使用 `{userData}/automation-sessions/<taskId>` 下稳定私有根（启动时创建并 realpath 校验）；它仅用于会话与内部事件存放，绝不加入 `workDirs`，也不视为用户授权。实际文件工具路径和审批 authorization scope 使用 `workDirs`。若现有工具链不能在不把此根混入授权 facts 的情况下保持该分离，阶段 1 安全门禁失败，先调整契约再合入。
- 消息构造、工具结果裁剪、history projection 当前也接收单个 `workspaceRoot`；不得把 session root 当用户工作目录喂给模型或用它裁剪多根结果。改为用授权 roots 定位文件路径并保留绝对目标；process cwd 类输出若无法唯一归属一个 root，则不裁剪成某一个根下的相对路径。核对 `electron/chatMessageBuild.ts`、`src/shared/claudeToolHistory.ts`、`src/shared/agentToolResult.ts`、`src/shared/processResultProjection.ts`、`electron/runtime/sessionLedgerResultProjection.ts`。

#### 运行历史状态

| 情况 | status | error / 显示 | Agent / 投递 |
|---|---|---|---|
| 启动恢复中较早的错过槽位 | `skipped` | `missed-window`，历史显示“已跳过：错过执行时段” | Agent 不启动；不投递 |
| 最近的可补跑槽位 | 正常进入执行链 | 按真实准入/执行结果 | 现有有界补跑逻辑 |
| 到期但字段、模型或任一根失效 | `failed` | 稳定准入失败类别和可读原因 | Agent 不启动；失败通知按 D-1 默认不新增 |
| 开始运行后工具调用被 Policy Engine 拒绝 | `failed` | 现有工具拒绝原因在 run 失败摘要中保留 | 已经启动；不是 skipped |
| 未启用、未到 nextRunAt | 无 run 行 | 无 | 无 |
| 同一 scheduler request 重放 | 复用唯一 client_id，不重复 run | 现有幂等行为 | 不重复 Agent |

正常调度字段是 `automation_tasks.next_run_at`，不在 run 表，也不能兼作恢复游标。新增 `automation_task_recovery_state(task_id PRIMARY KEY, schedule_generation, recovery_cursor_at, pending_run_id, pending_run_slot, pending_schedule_generation, updated_at)`；任务表维护独立的单调递增 `task_revision` 与 `schedule_generation`，run 行记录所用 task revision、schedule generation、scheduled slot 与 phase。queued claim 先固定 taskId/slot/generation 及 runId，不冻结易变任务配置；唯一 queued→running CAS 事务读取当时的 task revision 并将完整执行配置 snapshot（roots、bindings、prompt/model 等）写入 run。游标表示该代次下第一个尚未核销的计划槽位；一个槽位只能由终态 run、完整 skipped 记录/范围、或唯一 pending claim 核销。范围 skipped 固定起止 slot ID，恢复扫描不得包含已有 run 对应的槽位。创建时 cursor 与首个 `next_run_at` 同事务初始化；迁移时从任务当前 `next_run_at` 初始化，不回扫此前历史；正常 tick 在同一事务内校验 due slot/generation、创建 queued claim 并推进 `automation_tasks.next_run_at` 和 recovery cursor 到下一计划槽位、登记 pending run。这样 run 后来成功、失败或中断时，已认领槽位都不会再次成为 missed。一次性任务同时置为 disabled，cursor 置 NULL。

通过预检的普通配置编辑（prompt、roots、bindings 等）无论当前 pending run 是 queued 还是 running，都可提交：在 taskStore 单事务内写入完整新配置并递增 `task_revision`，不改已冻结的 running snapshot、pending 身份、`schedule_generation`、cursor 或 `next_run_at`。queued claim 尚未开始时没有执行 snapshot，编辑先后顺序由 SQLite transaction 决定；若编辑先提交，queued claim 的启动 CAS 使用新 revision；若 CAS 先提交，run 已进入 running 并冻结旧 revision，编辑只供后续 run 使用。预检与保存间若 task revision 已变化，按原门禁规则返回 stale/conflict 并要求重新预检，不覆盖并发编辑。

改期、停用、重新启用属于调度变更，按 pending phase 区分。存在 queued-before-start claim 时返回稳定 `schedule-pending` 冲突，避免已认领槽位与新日程争夺恢复游标；claim 消费或取消并完成旧 claim 后可重试。pending 对应 run 已是 running 时允许调度变更：事务增加 `schedule_generation`，按新 schedule 同步重算 `automation_tasks.next_run_at` 与 cursor，停用时二者置 NULL，重新启用从请求接收时刻计算首个未来槽位；旧 run 保留旧 generation 和快照。pending 继续指向旧 run 并记录其 `pending_schedule_generation`；新代次只记录计划游标，不创建第二个 pending，也不并发启动同一 task 的另一个 run。旧 run 终态只能在 `runId + pending_schedule_generation` 仍匹配时清除自己的 pending，不得覆盖新代次 cursor。旧 run 若崩溃恢复为 interrupted，也按同一条件清理；随后 scheduler 从新代次游标继续。

删除在任何非终态 run 存在时返回稳定冲突；无活动 run 时，在一个事务中删除 task 与 recovery state，run history 按既有外键/保留策略处理，不留可扫描状态。所有写入口以 task revision、runId 和 generation 条件更新；冲突时整个事务回滚。长运行跨越多个计划槽位时保持单任务串行：不覆盖现有 pending，恢复 cursor 停在最早未核销 due slot；当前 run 终态后由 scheduler 按有界补跑规则逐步核销/分派。

恢复按当前代次 cursor 扫描，先将最近可补跑槽位之前未核销的遗漏逐槽或连续范围写 skipped；每次事务原子写完整终态/摘要并推进到首个未处理槽位，绝不越过最近 due slot。最近补跑槽位 claim、pending 登记与跨过该槽位推进 cursor 也在同一事务。scheduler 只能把已创建的 `runId` 交给主进程内部 `executeClaimedRun(runId)`；该入口按 taskId、slot、generation 校验同一 queued run，并用 queued→running 条件更新作为唯一消费提交点，同时冻结当时最新 task revision/config snapshot；不再插入 run 或生成新 requestId。竞争者 CAS 失败即退出，不进入 Agent。正常 tick 与启动恢复共用该入口和稳定 runId。run-start 持久化 running 后退出只按 interrupted 处理、不重放；任一终态与清除匹配 `pending_run_id/slot/generation` 同事务提交。迁移时旧 queued/running 行标记 `legacy-unknown`，启动恢复收敛为 interrupted，绝不从 client_id 推断可恢复。启动恢复遇到与当前 generation 不同的 pending 时：若关联 run phase=running/legacy-unknown，按旧代次中断并只清匹配 pending，保留新代次 cursor；若仍 queued 则视为不变量失败，禁止执行并诊断。超过 48 个槽位时较早部分逐槽/范围跳过，最近一个 due slot 保持补跑；interval/daily/once 依既有规则枚举。

### 2.4 模型/所有权卡

| 状态/数据 | 唯一 writer | 写入/提交点 | 恢复者 | 失败语义 |
|---|---|---|---|---|
| task `workDirs` | 主进程 create/update IPC -> 一次性确认票据 -> `butler:confirm-write` -> `taskStore` | 用户确认后消费票据并单次保存；目录必须与预检快照及权限清单相同 | schema migration 仅负责旧列映射；不修改用户之后选择 | 预检通过但未确认仍零写入；任何目录无效、票据失效或 revision 冲突均不写 |
| preflight report | 本次主进程提交调用 | 不持久化；返回 renderer | 用户编辑后重新提交 | 超时/unavailable 阻断；无 stale pass |
| run `workDirs` snapshot | taskStore queued→running CAS | 唯一消费事务冻结当时 task revision 与 roots/config 到 run；`runButlerTask` 只读取该 snapshot | 不从当前 task 或桌面 Profile 重算；未启动 queued claim 读取 CAS 时最新已保存 revision | 预检失败不写 task；snapshot 无效则当前 run failed，不调用 Agent |
| task authorization receipt | 主进程 `butler:confirm-write` -> taskStore | 消费未过期的一次性预检票据时，以其中权限项和 task revision 创建记录；用户输入与 Agent 内容不写记录 | 任务配置版本变化时重做预检及确认；claim 仅冻结版本相同的记录 | 票据缺失、过期、已消费、task revision 冲突或记录版本不符时不保存/不向审核 Agent 暴露授权 |
| v1 target bindings | 主进程 create/update/enable IPC -> taskStore | task fields、roots、prompt/schedule revision、`target_bindings_json`、`preflight_version=1` 同事务提交 | run admission 按 kind 重新求值 | 编辑阻断则整笔不变；动态集合只保存选择器，不保存静态成员清单 |
| `preflight_version` | migration 或主进程 taskStore | 旧行 migration 写 0；新建及成功编辑/启用写 1 | runtime admission 分派 v0/v1 | renderer 不可指定；无绑定的 v1 数据完整性错误 fail closed |
| scheduler recovery state | scheduler/taskStore | recovery state 保存 schedule generation、首个未核销 cursor 与带代次的 pending runId/slot；普通配置编辑不改调度状态，改期/启停按 queued/running phase 更新 | 启动恢复器只分派匹配 pending 身份的 queued claim；running 由 interrupted 恢复 | 每个槽位恰好由 run/skipped/pending 一种记录核销；queued 时调度变更冲突，running 时终态按身份清理；transaction rollback 不前进 |
| history label | renderer 从 run status/error 映射 | 读取 API 返回 | 再打开历史重新读取 | 未知状态显示安全通用失败，不误显示通过 |

### 2.5 安全阶段映射

| 阶段 | 落点 | 规则 |
|---|---|---|
| Facts | `electron/confirmation/extractors/readPathFacts.ts`、写路径 facts、`toolCallGate.ts` | 仅报告 canonical target 与 roots 的关系、解析来源、覆盖完整度；不作 allow/deny。未知、失效、逃逸与敏感事实保留分类。 |
| Policy | `src/shared/policy/defaultRules.ts` / Policy Engine | 保留当前 locked deny/allow/confirm 意义；outside 指示仅当目标不在任何任务授权根。任何规则变更使用稳定 rule ID 并可查询 trace。 |
| Final-check | invocation/tool final-check 消费运行授权集合处 | 核对获批 task/run、roots snapshot、permit 与执行材料绑定相同 roots；不重新判定业务歧义。失败用稳定 failure class/case ID，executor 不调用。 |
| Invariant | `systemInvariantRegistry.ts` | 不把 Policy locked decision 登记为 invariant。E-11c 的执行端约束只校验 automation write permit 是否携带匹配本 run 的结果 binding，登记为 `SYS-AUTOOUTPUT-001`；写入策略 verdict 仍由共享 Policy Engine trace 表达。 |

### 2.6 迁移、兼容与回滚

1. 新增 schema v103（若实现时版本已提高则使用下一版本）：除 nullable `work_dirs_json` 外，增加 `preflight_version INTEGER NOT NULL DEFAULT 0`、`target_bindings_json TEXT NULL`、任务 `task_revision` 与 `schedule_generation`，并建立 `automation_task_recovery_state(task_id PRIMARY KEY, schedule_generation, recovery_cursor_at, pending_run_id, pending_run_slot, pending_schedule_generation, updated_at)`；run 行增加 `run_phase`、task revision、schedule generation、slot 与可空冻结配置 snapshot（queued 未消费时为空，running 时必须存在），phase 为 `queued-before-start | running | terminal | legacy-unknown`。迁移旧 queued/running 行为 legacy-unknown，保留其 status/error 供恢复器收敛为 interrupted；旧任务迁移为 v0/null binding；cursor 从 `automation_tasks.next_run_at` 初始化。列与映射成功后才推进版本。
2. `rowToTask` 经 adapter 读取新列及 preflight version；尚未迁移的调用方可继续提供 `workDir`。运行授权只消费 adapter 输出的 canonical roots，不读活动 Profile。旧 run config snapshot 保持只读展示；新 snapshot 写 `workDirs`、preflight version 和当前解析的 selection。
3. 旧单目录任务不自动重做目标清晰度检查，且以 `preflight_version=0` 进入 legacy 分支：未编辑、未主动启用期间只重验原有必要字段、模型和目录，不要求 binding，按需求稿既有提示词语义运行。缺目录或失效根旧任务保持启用状态但运行记稳定 failed/skip 原因，不回退活动 Profile。首次成功编辑或主动启用必须走新门禁，并在 task 更新事务中一并写 v1 与 bindings；阻断不改变旧 task。
4. 当前 migrations 在数据库 schema version 高于应用支持版本时会拒绝打开数据库。因此新版本升级后的数据库**不承诺可被旧应用直接打开**；保留 `work_dir` 列不能绕过该保护。本期回退协议：升级前制作并验证数据库备份；回退时停止新旧应用写入，恢复升级前备份后再启动旧应用。升级后新增/修改的任务和运行历史不会出现在升级前备份中，需由用户决定是否另行导出；不得静默合并或覆盖。
5. 恢复升级前备份再安装新版本时，正常迁移到当前 schema；升级前的单目录任务按原授权恢复。若不能取得有效备份，旧应用不得尝试打开升级库，应保留原库副本并用匹配的新版本处理/导出数据。
6. 不删除目录、不批量修改旧任务 prompt、不撤销用户工作目录权限。发布回退验收分开验证：迁移 fixture 验证新版本升级；版本保护 fixture 验证旧应用拒绝高版本 DB；备份恢复 fixture 验证旧应用可打开备份并再次升级。不得把“旧应用能读旧列投影”作为关闭条件。

### 2.7 故障、并发与恢复场景

| 故障/竞态 | 唯一行为 |
|---|---|
| preflight 超时/拒绝/结构化响应解析失败 | 返回 unavailable 或 blocker；任务表不写，用户可以改任务或重试 |
| renderer 重复点预检或确认 | UI 置 busy；确认票据只可消费一次且有时限；重复确认不重复保存；新预检生成新票据，清理已过期票据 |
| renderer 在检查等待中修改表单 | 当前 UI 禁止编辑字段直到响应，或取消旧提交；不得保存与被检查快照不同的内容 |
| 两个 renderer 调用并发更新同 task | 以请求捕获的 `updatedAt`/版本条件更新；第二个旧快照返回 conflict，不覆盖先完成的新配置 |
| task roots 中有一个目录被删除/权限撤回 | 整个 run admission failed；不静默用剩下目录执行 |
| 保存后目标布局变化 | v1 exact basename 出现新歧义、collection 越出授权目录/扫描不完整、output 授权祖先失效时 executor 前 failed；collection 内成员新增/删除、exact 逻辑路径普通原子替换、output 仍不存在按绑定类型允许 |
| 任务运行时用户移除目录 | 已开始 run 继续使用它的 immutable snapshot；后续 run 采用更新后集合 |
| 目录符号链接目标变化 | 每个执行目标 realpath/final-check 重核；目标超出所有 roots 则保持 outside/拒绝 |
| 应用重启后重复扫描 miss slots | 独立 recovery cursor 只跨过已提交 skipped；最近 due slot 的 run claim 和 cursor advance 同事务；queued-before-start 由恢复器启动，running 不重放 |
| 48 个以上 interval 槽位缺失 | 较早槽位逐槽或范围记 skipped，cursor 停在最近补跑槽位；claim 与跨过最近槽位同事务；固定 slot/range client_id 防重复 |
| 到期运行准入失败 | run 创建并置 failed，保留计划时刻及稳定错误；不把失败改为 skipped |
| 安全策略拒绝运行中的 tool call | task run 按实际执行结果 failed；不发 skipped 通知、不生成 missed-window |
| history 查询失败 | UI 显示加载错误；不得用空状态暗示没有历史 |

### 2.8 验收映射

需求 AC 保持唯一真源于需求稿；本方案给实现证据映射，不重写 AC 内容。

| 需求 AC | 方案保证 | 主验证位置/类型 |
|---|---|---|
| AC-01、01a、02 | workDirs 类型、CRUD、联合路径分类 | `taskStore.test.ts`、`taskConfigValidation.test.ts`、path fact tests |
| AC-01b、03a、10 | 执行/审核 Agent 使用相同根集合，locked policy 意义不变 | `butlerInvoker.test.ts`、invocation/approval integration tests、policy trace tests |
| AC-03、14 | exact/collection/output 目标模型支持歧义检查、动态输入和未创建输出；授权边界变化在 executor 前失败 | path facts provider、binding resolver、preflight and runtime admission tests |
| AC-04、05、12 | 阻断提交不写、表单保留、迟到报告不放行、重试成功 | Butler IPC contract tests + renderer component tests |
| AC-06、06a、06b | 主进程接收时刻校验、一次性执行与重启补偿 | once constraint tests、`taskOnce.test.ts`、scheduler tests |
| AC-07 | v1 目标准入失败记录 failed 且不调用 executor；迁移来的 v0 旧任务按需求稿兼容分支运行；缺失 roots 仍失败 | v0/v1 invoker tests 与 runtime admission integration tests |
| AC-08、09 | run roots 不变式、链接/替换/并发变更与目标绑定变化边界 | path security / invoker / target binding tests |
| AC-11 | 旧任务迁移标记 v0；首次成功编辑/启用原子切换 v1；缺目录不回退活动 Profile | migration fixture、taskStore and v0/v1 invoker tests |
| AC-13 | 宽 Modal 双栏、窄窗单栏、可访问的候选清单 | Butler component tests + macOS 浏览器/真机视觉验收 |
| AC-15（目录重叠样例） | roots 去重与父子重叠按集合解释 | validation/path fact tests |
| AC-16 | skipped history 可查、missed-window 本地化，无特殊通知；安全拒绝是 failed | scheduler/history tests、delivery guard tests、history component tests |
| AC-17（2026-10-18 用户确认的 D-7） | 保存前展示可读的完整权限清单；Shell 清单只列命令与工作目录，执行超时由运行 Agent 灵活选择且不进入授权校验；用户确认后仅由主进程持久化版本匹配的授权记录；后续运行冻结该记录并作为宿主事实交付安全审核 Agent；旧任务无隐式授权；Git 预检识别本地仓库；Shell 仍经过现有安全边界且无需再次向用户索取已确认权限 | task store/IPC/snapshot、preflight facts/analyzer、approval clue、automation lane gate、Butler component tests |

### 2.9 阶段边界与回退实体

| 阶段 | 输出 | 允许改动 | 出口证据 | 可回退实体 |
|---|---|---|---|---|
| P0 兼容契约与验收夹具 | 可选 workDirs、v0/v1、exact/collection/output、recovery state contracts | shared types、fixtures | 现有生产者不改仍可编译；契约反例固定 | adapter/types commit |
| P1 存储 schema 与 primitives | v103、binding fields、recovery table、taskStore transactions | database、taskStore | v0/v1 migration、binding 原子写、cursor/claim 事务 fixture 通过 | migration/store commit；不删除旧列 |
| P2 生产者兼容迁移 | renderer/IPC/store/run callers 改用 workDirs adapter | Butler callers、shared adapter | 每层独立编译；旧单根数据语义保持；不承诺预检门禁 | 每层独立 commit；旧类型保持 |
| P3 预检 resolver 与提交门禁 | 受限 facts、三类目标、create/update/enable 原子门禁 | provider/resolver、Butler IPC | 目标判例和 blocker 0 writes / pass 1 write | preflight/IPC commit |
| P4 类型收紧 | 门禁接通且调用方迁移完成后将 workDirs 收紧为必填 | shared types/callers | 全仓旧入口检索与三端编译通过 | 独立类型收紧 commit |
| P5 多根运行与历史恢复 | v0/v1 run 分支、approval roots、recovery cursor/claim | invoker、policy facts、scheduler/history | 运行时路径矩阵、退出注入及策略 trace | 安全/恢复分别提交 |
| P6 UI、i18n、集成关闭 | 宽表单、授权清单、历史标签和最终验收 | renderer/i18n/related integration | renderer tests、i18n、typecheck/build、review matrix | 可按功能提交回退；DB 回退恢复备份 |
| P7 任务级访问授权与 Git 预检 | 用户可读权限清单、主进程授权记录、本地仓库 facts、运行快照与安全审核事实、获批 Shell 策略 | shared/store/IPC、preflight/provider、policy/gate/approval clue/renderer | 旧任务无工具授权；确认记录与任务版本匹配并冻结；安全审核 Agent 收到完整宿主记录；本地 Git 目标绑定；Shell 现有拒绝边界及 schema v105 migration 回归通过 | 独立权限/预检/policy/UI commits；迁移回退恢复 v104 备份 |

该阶段表与执行计划 DAG 一致：P2 可独立于预检门禁完成，P3 接通门禁后 P4 才收紧类型；运行安全链依赖 P3 的持久化绑定；UI 集成在门禁与类型契约稳定后进行；P7 扩展已关闭的结果目录拆分，Shell 权限必须沿用户表单到 claim snapshot 冻结后才可放行。

### 2.10 外部验收与当前环境门禁

当前机器可验收：Vitest 单测/集成测试、renderer jsdom tests、typecheck、i18n check、Electron incremental build，以及使用临时 SQLite/目录、mock LLM 的迁移与路径回归。

外部验收（不阻塞源码阶段）：真实 LLM 服务下目标分析稳定性与延迟；真实安全审核 Agent 面对跨多个授权根的解释是否一致；macOS/Windows 窗口宽度、键盘辅助技术和长路径视觉；真实飞书/微信渠道（本期不改通知，确认未触发）；打包升级/降级数据库快照。源码关闭前以 mock 和可复现本地安全测试验收，发布前另做平台验收。

## 附录 A：术语对照

| 业务词 | 内部词 |
|---|---|
| 工作目录列表/授权根集合 | `workDirs` |
| 预检 | `PreflightReport` / 主进程 preflight analyzer |
| 运行历史 | `automation_task_runs` / `AutomationTaskRun` |
| 跳过 | `status='skipped'`，本期稳定原因 `missed-window` |
| 失败 | `status='failed'`，包括运行准入失败与运行中策略拒绝 |
| 会话内部存放根 | `automationSessionRoot`，不属于授权根 |

