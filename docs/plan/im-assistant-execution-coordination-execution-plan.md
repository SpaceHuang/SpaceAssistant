# IM 助理与执行 Agent 协同执行计划

> 日期：2026-11-03｜状态：待执行；本轮仅制定计划，没有实施任务完成证据。
> 规格唯一来源：[技术方案](../develop/im-remote/in-flight/im-assistant-execution-coordination-technical-design.md)，以 HEAD `506d09b8` / 文档 blob `fb2217bdefaee4a4506a494583eb6b4c3b8945f1` 为编排基线。
> 评审来源：[三项 P1 阻断报告](../review/im-assistant-execution-coordination-technical-design-review-2026-11-03.md)。方案已补规格，原评审尚未声明通过；本计划安排本地验证，不把已有文档修订当作实现完成。
> 写作依据：[执行计划指南](../rules/execution-plan-writing-guide.md)。验收 A-*、不变量 INV-*、T-01/T-02 与恢复协议以方案为准；本文只登记任务、依赖、执行证据与偏差。

## 0. 交付边界【人必读】

**一句话：** 先证明角色隔离、退出屏障与原调用链可用，再完成 Markdown/控制记录、稳定业务派发和恢复，最后接通双渠道并完成本机闭环与回退演练。

**只有三分钟：** 看本节、阶段边界及 §5 门禁。46 项本机任务均可在前置完成后启动；真实平台、真实模型与人工阅读结果不作为开发过程的门禁。

**已有决定：** T-01 采用每 scope 一份正式 Markdown、助理单写业务正文，数据库只保留执行控制；T-02 A 在送达不确定且无法核实时不自动重发。协调语义交给 Skill；不新增 SDK 协调状态、不把 Runtime 做成工作流引擎。三项评审阻断必须取得实现证据，不能靠提示词自觉避免竞态。

**交付形态：** 按本次请求交付详细执行计划。未来实施分为“本机源码交付”和“外部运行验收”两条清单；无需用户先提供账号、其他系统或外部资源才能推进本机工作。本文不安排自动发布、真实用户发送或生产数据演练。

**不需要重新决定：** T-01/T-02 已确认；任务粒度、依赖顺序、夹具和本机测试由实现者负责。若 U-01/02 本地原型证伪了现有宿主能力，先修订对应 IM 接缝方案并记录证据；不得偷偷改 SDK 或把不可实现任务标记完成。

### 0.1 本机与外部边界

| 本机可执行并可作为开发门禁 | 外部/资源依赖，不能作为本机任务前置 |
|---|---|
| 临时真实 SQLite/真实 sessions 外键、文件原子写入、本机重启模拟、CAS/租约/故障注入 | 微信/飞书真实机器人账号、生产权限及网络服务能力 |
| 假时钟、deferred Promise、fake provider/transport 驱动真实宿主/路由/存储链 | 在线模型生成质量、实际 token/耗时/费用及服务凭据 |
| A-15 退出屏障、A-16 双槽跨 turn 幂等、A-17 主键/代次隔离 | 其他操作系统上的替换/锁/安装包行为，真实 Electron GUI 交互 |
| SDK/会话存储边界、共享类型、测试/编译/构建、临时目录中的回退与备份 | 未参与实现的读者对真实生成消息做隔离阅读，用户真实 IM 体验 |

fake provider 替代外部推理，不替代待验证的宿主状态机；fake transport 替代网络，不跳过原认证/出站校验。固定样本可证明协议和评测流程可执行，不能证明真实模型理解或表达质量。源码交付不等于真实渠道已验收。

## 1. 阶段、准备与证据【人机共读】

### 1.1 阶段边界

| 阶段 | 任务范围 | 输入与允许改动 | 可交付输出与回退实体 |
|---|---|---|---|
| 准备 | P0-01—02 | 当前工作区与方案；只读盘点及测试夹具 | 基线和测试环境；删除本轮夹具/记录即可回退，不修改业务数据 |
| P1 接缝验证 | P1-01—10 | 角色装配、执行适配器、scope 定位、最小 handoff 持久化及原型协调器 | U-01/02 接缝证据与独立执行原型；不接真实渠道。回退新增接缝/最小控制，保留原入口默认路径 |
| P2 可靠协作 | P2-01—22 | P1 可用接缝；完整文件/控制、任务槽位、报告/回答、批次与恢复 | 可通过 fake provider 驱动的可靠宿主链；回退时停派发并保留文档/控制；不删旧授权历史或 permit |
| P3 双渠道源码闭环 | P3-01—12 | P2 宿主链；Skill、共享入口、两渠道路由与服务装配 | 双渠道本地集成、回退演练、全量构建和源码评审；回退接线/Skill 版本并冻结新控制，不自动重做任务 |

**防止阶段依赖倒置：** 方案 P1 出口引用 A-15，P1 在此只交付“真实调用接缝＋最小 workflow 持久化”的 A-15 组件证据；回答材料由测试已存在的引用提供，不等待 P2 文档提交器。完整 Markdown→回答→重启→续跑的 A-15 由 P2-15/16 实现，并在双渠道接线后复验。P1 不宣称 A-01—17 的端到端功能已完成。类似地，P2 的存储备份原语不以 P3 运行期回退演练为前置。

服务装配落点经本轮代码核对为 `electron/feishu/feishuIpc.ts` 与 `electron/wechat/weChatIpc.ts`：二者已负责构造 router/wake dispatcher、启动恢复及 dispose。P3-08 只在这些已有调用点接入方案 §2.2/2.8 的协调器生命周期，不新增 IPC 通道或新的业务模块。方案 §1.3 的路由单元没有列尽这些装配文件，P0-02 的调用面记录需显式登记，不能在实际提交时漏算受影响文件。

保留原默认入口只用于未完成接线的阶段，不建立新旧双写或 SDK fallback。P3 接线后移除旧的执行者直发/最终摘要重复出口，保留方案明确要求的确定性身份拒绝与原生审批消息。不新增用户灰度开关来解决实施顺序；中间提交不部署到真实用户环境。

### 1.2 本机准备与失败分流

P0-01 检查 Node/npm 是否满足 package.json、锁文件依赖是否就绪、Vitest 能否启动、临时目录是否可写。需要安装时遵循锁文件流程，不因编写计划执行安装。SQLite 直接用仓库现有 Vitest 测试环境；`probe:sqlite`/真实 Electron 启动不是本机单测的前置。

环境故障先修环境；既有测试失败记录基线 SHA、命令、用例和影响，不能删测或当新增功能 RED。新增功能先取得范围匹配的失败证据，再在同任务内实现并取得 GREEN；测试文件须先创建，找不到文件/模块不是有效行为失败。已经具备的行为记基线 GREEN，不人为制造失败。

本计划不单独拆“先写失败测试”为一项阻塞任务；每项行为实现与其有意义的边界测试成对交付。所有实现任务默认负责人为执行本计划的编码 Agent；外部验收负责人另见 §7。不开新线程/子 Agent 是执行方式选择，不构成前置条件。

### 1.3 命令和证据约定

所有命令从仓库根目录运行。任务中的 `V` 是下列 shell 函数的缩写，`-t` 对应本任务新增的 describe 名；文件名无目录时按该行声明的生产文件同目录。测试文件尚不存在的，均在其首次使用任务内创建，不提前运行。

```sh
V() { npm exec -- vitest run "$@"; }
```

| 代号 | 命令与时点 |
|---|---|
| BASE | `V electron/remote/remoteAgentRegistry.test.ts electron/remote/turnExecutionAdapter.test.ts electron/remote/imWorkflowSkillHarness.test.ts`；P0-01 只做此定向基线 |
| SDK | `npm run check:agent-sdk`、`npm run typecheck:agent-sdk` |
| STORE | `npm run check:session-storage-boundary`、`npm run check:session-storage-cleanup-boundary`、`npm run check:message-fact-ownership` |
| SHARED | `npm run typecheck:shared` |
| SECURITY | `npm run check:system-invariant-registry` 加相应任务的授权边界测试；没有新 invariant 登记不代表可省略 |
| G1 / G2 | 按 §5 运行此前已创建的本阶段定向文件集合，SDK/STORE/SHARED/SECURITY、`npm test`、`npm run build:electron:incremental`、`git diff --check`；增量构建每阶段至多一次，期间不要每任务全量构建 |
| G3 | §5 最终用例集合与 SDK/STORE/SHARED/SECURITY、`npm test`、`npm run build`、`git diff --check`；最终 build 替代 P3 增量构建，同状态已通过的全量不重复跑 |
| REVIEW | 按 `code-review-and-quality` 技能检查最终实际 diff、记录结论和处理阻断；若因此改代码，按影响定向复验，并使最终构建证据对应交付 SHA |

每项任务证据落 `docs/plan/evidence/im-assistant-execution-coordination/<任务ID>.md`（实施时创建）：产物路径、改动 SHA、用例/命令/退出码、RED 原因或基线 GREEN、结果摘要、覆盖方案 ID 的具体部分、仍未验证项。阶段证据记录最终提交号。只保存合成/脱敏输出，不落生产消息、密钥或完整工具载荷。

任务状态只维护一次，见 §3 的复选框：未开始 `[ ]`、进行中 `[～]`、有证据完成 `[x]`；未评审/阻塞保持未完成并注明原因。本文所有实现任务当前均未开始，未来不要用写好方案或测试命令代替执行证据。

## 2. 唯一任务依赖表【机｜人工可跳过】

本表是 DAG 的唯一真源；§3 不再另写任务依赖。每行仅列直接前置，传递前置自然继承。前置全部完成后，本任务的代码、夹具与验证即可本机启动；外部 E-* 不在表内。检查点只消费此前任务证据，不引用未来任务、最终交付或发布结果。

| 任务 | 直接前置 |
|---|---|
| P0-01 | 无 |
| P0-02 | P0-01 |
| P1-01 | P0-02 |
| P1-02 | P0-02 |
| P1-03 | P1-01、P1-02 |
| P1-04 | P1-01、P1-03 |
| P1-05 | P1-02、P1-03、P1-04 |
| P1-06 | P1-04、P1-05 |
| P1-07 | P1-03、P1-06 |
| P1-08 | P1-03、P1-05、P1-06 |
| P1-09 | P1-02、P1-06、P1-07、P1-08 |
| P1-10 | P1-09 |
| P2-01 | P1-10 |
| P2-02 | P2-01 |
| P2-03 | P2-02 |
| P2-04 | P2-01、P2-03 |
| P2-05 | P2-04 |
| P2-06 | P2-05 |
| P2-07 | P2-01、P2-04 |
| P2-08 | P2-02、P2-04、P2-07 |
| P2-09 | P2-08 |
| P2-10 | P2-09、P1-08 |
| P2-11 | P2-04、P2-07、P1-04 |
| P2-12 | P2-10、P2-11 |
| P2-13 | P2-12、P1-07 |
| P2-14 | P2-04、P2-11、P2-10 |
| P2-15 | P2-11、P2-14、P1-06 |
| P2-16 | P2-09、P2-15、P2-05 |
| P2-17 | P2-04、P2-13、P2-14 |
| P2-18 | P2-05、P2-10、P2-16、P2-17 |
| P2-19 | P2-13、P2-14、P2-15、P2-17、P2-18 |
| P2-20 | P2-19 |
| P2-21 | P2-16、P2-18、P2-20、P2-06 |
| P2-22 | P2-21 |
| P3-01 | P2-22 |
| P3-02 | P2-22 |
| P3-03 | P3-01、P3-02 |
| P3-04 | P2-20、P3-01、P3-02 |
| P3-05 | P3-04 |
| P3-06 | P3-04 |
| P3-07 | P3-05、P3-06、P1-08 |
| P3-08 | P3-07、P2-18 |
| P3-09 | P3-08、P2-06 |
| P3-10 | P3-03、P3-08、P3-09 |
| P3-11 | P3-10 |
| P3-12 | P3-11 |

## 3. 任务登记与完成判据【机｜人工可跳过】

各任务环境均为**本机**。允许改动范围由“落点”界定，附带的就近 test.ts/测试夹具属于本任务范围；表中已有文件的测试如未列全，实施时在任务证据中补实际路径。拟新增测试不意味着必须把生产逻辑拆成同名新模块。通用测试协议只定义一次，任务不得依赖未来测试文件才算 GREEN。

### 准备

- [ ] **P0-01 记录基线并准备可重复的本机测试环境**

  - 落点：package.json、vitest.config.mts、既有测试（只读）。
  - 产物：基线 SHA、工作区差异、Node/npm/依赖及临时目录可用性记录。
  - 完成判据：先确认锁文件依赖可用；仅运行既有定向基线；区分环境错误、既有失败与本需求行为缺失，不刷新锁文件或覆盖他人改动。
  - 验证：`BASE`；对应 A-10/12；方案事实卡。证据：`evidence/im-assistant-execution-coordination/P0-01.md`。

- [ ] **P0-02 锁定契约与建立本地测试夹具**

  - 落点：electron/remote/testSupport/imCoordinationFixtures.ts（拟新增）、本计划证据目录。
  - 产物：假时钟、deferred Promise、合成认证 scope、临时数据库/目录、假 provider/渠道及分阶段验收映射。
  - 完成判据：夹具能独立创建并销毁两个真实 sessions 和 workflow 连接；列出 R-01—03 调用接缝和已有服务装配落点；测试替身只替模型/网络/时钟，后续行为不写入夹具；来源方案复核不等待外部人工签字。
  - 验证：`V electron/remote/imCoordinationFixtures.test.ts`；对应 A-06/10/13；R-01—03。证据：`evidence/im-assistant-execution-coordination/P0-02.md`。

### P1 角色与执行接缝

- [ ] **P1-01 实现 scope 定位和真实主键隔离**

  - 落点：electron/remote/imCoordinationStore.ts、imCoordinationStore.scope.test.ts（同目录，拟新增）。
  - 产物：scope→opaqueScopeId→workflowId/path 的纯函数与最小 get/put。
  - 完成判据：真实 sessions 外键下验证 epoch/channel/owner 差异得到不同工作流行；摘要与元组失配拒绝；此步只存最小控制头，不依赖 Markdown 提交。
  - 验证：`V electron/remote/imCoordinationStore.scope.test.ts`；对应 A-17；R-03；INV-02/05。证据：`evidence/im-assistant-execution-coordination/P1-01.md`。

- [ ] **P1-02 装配互斥的助理与执行角色能力**

  - 落点：electron/remote/imCoordinationTools.ts、electron/remote/imOrchestrationTools.ts、electron/runtime/invocationAssembler.ts。
  - 产物：角色工具目录、显式 Skill 材料接缝和默认回归。
  - 完成判据：执行者从定义和实际 registry 两处都不能发 IM/改目的地/递归分派；默认 IM 与 desktop 未显式传 Skill 的装配不变；不接真实渠道。
  - 验证：`V electron/remote/imCoordinationTools.roles.test.ts electron/runtime/invocationAssembler.test.ts`；对应 A-01/12/13；U-02。证据：`evidence/im-assistant-execution-coordination/P1-02.md`。

- [ ] **P1-03 接通独立执行会话和原授权主体**

  - 落点：electron/remote/imExecutionAgent.ts、electron/remote/imRemoteAgent.ts（仅宿主接缝）。
  - 产物：经过真实接纳/历史端口的执行适配器骨架。
  - 完成判据：使用已有公开端口创建执行会话、冻结配置并接纳 turn；运行原 Agent 链，provider 替身只控制返回；原 owner/epoch 不被执行会话身份替代。
  - 验证：`V electron/remote/imExecutionAgent.lifecycle.test.ts -t P1-03`；对应 A-06/12/13；U-01。证据：`evidence/im-assistant-execution-coordination/P1-03.md`。

- [ ] **P1-04 持久化最小等待报告与退出事实**

  - 落点：electron/remote/imCoordinationStore.ts、electron/remote/imExecutionAgent.ts。
  - 产物：最小 handoff 存取、报告身份和 yielding 状态。
  - 完成判据：现有 workflow 存储提交 requested/answerRef/exitRef；最小测试以已存在的合成材料引用表示回答，不调用尚未实现的 Markdown 协议；关闭并重开数据库可读原 waitId。
  - 验证：`V electron/remote/imExecutionAgent.handoff.test.ts -t P1-04`；对应 A-15 组件；R-01；INV-05/06。证据：`evidence/im-assistant-execution-coordination/P1-04.md`。

- [ ] **P1-05 阻止 yielding 后的新工具派发并跟踪排空**

  - 落点：electron/remote/imExecutionAgent.ts、electron/remote/imCoordinationTools.ts。
  - 产物：报告/工具准入串行区和 in-flight 计数。
  - 完成判据：报告提交与新工具实际准入交错时，旧执行不得再获新准入；报告前已接纳工具可安全 settle；取消信号或租约过期不能伪装为已退出。
  - 验证：`V electron/remote/imExecutionAgent.handoff.test.ts -t P1-05`；对应 A-15 组件；R-01；U-02。证据：`evidence/im-assistant-execution-coordination/P1-05.md`。

- [ ] **P1-06 实现答案与退出的单次续跑汇合**

  - 落点：electron/remote/imExecutionAgent.ts、electron/remote/imCoordinationStore.ts。
  - 产物：tryQueueResume、稳定续跑键及退出证明提交。
  - 完成判据：覆盖答案先于 report 返回、先于退出、与退出同时、租约释放后数据库提交前退出；仅在排空/退出证明和答案均具备时认领一次；loop completed 不误结算任务。
  - 验证：`V electron/remote/imExecutionAgent.handoff.test.ts -t P1-06`；对应 A-15 组件；R-01；U-01。证据：`evidence/im-assistant-execution-coordination/P1-06.md`。

- [ ] **P1-07 验证并行执行不占助理处理槽位**

  - 落点：electron/remote/imExecutionAgent.ts、electron/remote/imAssistantCoordinator.ts（最小接收/调度原型）。
  - 产物：双执行者并行与助理预留容量测试。
  - 完成判据：两个执行会话实际重叠，A 的报告在 A turn 退出前被助理原型读取，B 不停；资源不足保留排队，不另建执行会话绕过租约。
  - 验证：`V electron/remote/imExecutionAgent.parallel.test.ts`；对应 A-06/07/09 组件；INV-06。证据：`evidence/im-assistant-execution-coordination/P1-07.md`。

- [ ] **P1-08 验证授权、托管挂起和接续收回边界**

  - 落点：electron/remote/imExecutionAgent.ts、既有审批/任务控制/托管链（复用不改）。
  - 产物：IM 来源、取消/修订/epoch 失效与未收回 continuation 的原型证据。
  - 完成判据：使用原安全链/托管交接，越权前 executor 未调用；旧 continuation 仍可恢复时不能写 exitRef；无法证明退出则 uncertain，不能降低屏障。
  - 验证：`V electron/remote/imExecutionAgent.safety.test.ts electron/remote/turnExecutionAdapter.test.ts`；对应 A-13/15 组件；U-01/02。证据：`evidence/im-assistant-execution-coordination/P1-08.md`。

- [ ] **P1-09 核对接缝证据和原调用兼容性**

  - 落点：P1 改动测试、electron/remote/imRemoteAgent.test.ts、electron/remote/imWorkflowSkillHarness.test.ts。
  - 产物：U-01/02 本地接缝核对与 R-01 原型结论。
  - 完成判据：明确哪些为真实宿主/存储证据，哪些为 fake provider；无法实现屏障则记录可复现失败并修订 IM 接缝，不把继续开发建立在尚无能力的 SDK 扩展上。
  - 验证：`V electron/remote/imExecutionAgent.lifecycle.test.ts electron/remote/imExecutionAgent.handoff.test.ts electron/remote/imExecutionAgent.parallel.test.ts electron/remote/imExecutionAgent.safety.test.ts electron/remote/imCoordinationTools.roles.test.ts electron/remote/imRemoteAgent.test.ts electron/remote/imWorkflowSkillHarness.test.ts`；对应 A-01/05/06/07/12/13/15 局部；U-01/02。证据：`evidence/im-assistant-execution-coordination/P1-09.md`。

- [ ] **P1-10 完成 P1 本机检查并提交接缝阶段**

  - 落点：P1 改动文件及阶段证据。
  - 产物：G1 结果与阶段提交。
  - 完成判据：仅核对当前已实现的接缝与最小持久化行为；不要求 P2 文件恢复/生产队列或 P3 实际渠道；运行阶段检查后提交且不混入他人修改。
  - 验证：`G1`；对应 INV-01—08 相关边界；U-01/02。证据：`evidence/im-assistant-execution-coordination/P1-10.md`。

### P2 协作存储和调度

- [ ] **P2-01 补全控制记录白名单和严格版本读取**

  - 落点：electron/remote/imCoordinationStore.ts。
  - 产物：控制格式校验、私有前缀枚举与 CAS 命令。
  - 完成判据：补齐方案 10 个顶层键；未知版本保留原文；拒绝跨 scope 写入和通用 workflow put 旁路；空集合/null 缺省按方案；不保存第二份业务正文。
  - 验证：`V electron/remote/imCoordinationStore.control.test.ts`；对应 A-10/13/17；INV-05。证据：`evidence/im-assistant-execution-coordination/P2-01.md`。

- [ ] **P2-02 建立 Markdown 正文与受控草稿读取**

  - 落点：electron/remote/imCoordinationStore.ts、electron/remote/imCoordinationTools.ts。
  - 产物：头部校验、路径绑定、角色可读范围和草稿引用。
  - 完成判据：每 scope 一份正式文件；模型不能改 scope/头部归属；执行者只见本任务冻结材料；正常正文无需机械解析成工作流。
  - 验证：`V electron/remote/imCoordinationStore.document.test.ts -t P2-02`；对应 A-02/10/13；T-01。证据：`evidence/im-assistant-execution-coordination/P2-02.md`。

- [ ] **P2-03 实现同目录原子替换和上一版保留**

  - 落点：electron/remote/imCoordinationStore.ts。
  - 产物：可注入故障的文件提交器。
  - 完成判据：覆盖临时写失败、flush/关闭失败和替换失败；正式文件保留上一完整状态；草稿过期不覆盖；使用真实本机临时目录，无需其他操作系统。
  - 验证：`V electron/remote/imCoordinationStore.document.test.ts -t P2-03`；对应 A-10；INV-05。证据：`evidence/im-assistant-execution-coordination/P2-03.md`。

- [ ] **P2-04 实现 prepared 文件与数据库交接**

  - 落点：electron/remote/imCoordinationStore.ts。
  - 产物：fileCommits prepared→文件替换→控制确认链。
  - 完成判据：只在最终确认后应用后续控制命令/去重结果；禁止事务里 await 文件/模型/网络；失败保留可恢复材料，旧 prepared 未核销不接新提交。
  - 验证：`V electron/remote/imCoordinationStore.checkpoint.test.ts -t P2-04`；对应 A-10；INV-05。证据：`evidence/im-assistant-execution-coordination/P2-04.md`。

- [ ] **P2-05 恢复各文件交接崩溃窗口**

  - 落点：electron/remote/imCoordinationStore.ts。
  - 产物：checkpoint 恢复扫描与不匹配停止消费。
  - 完成判据：重开真实数据库与目录：父版本续交、目标版本补确认、摘要不匹配保留现场；不能凭文件正文重派；孤立草稿不当成正式业务记录。
  - 验证：`V electron/remote/imCoordinationStore.checkpoint.test.ts -t P2-05`；对应 A-10/17；INV-05。证据：`evidence/im-assistant-execution-coordination/P2-05.md`。

- [ ] **P2-06 支持人工维护冲突和联合备份原语**

  - 落点：electron/remote/imCoordinationStore.ts。
  - 产物：停写后正文接纳、联合备份/还原函数及测试。
  - 完成判据：运行中人工改写不静默覆盖；停写/排空 prepared 后备份文档和库；缺文件、上一版恢复、未知版本不抹掉已执行事实；这里只测存储原语，不提前要求运行期完整回退。
  - 验证：`V electron/remote/imCoordinationStore.backup.test.ts`；对应 A-10/14；T-01；方案 §2.8。证据：`evidence/im-assistant-execution-coordination/P2-06.md`。

- [ ] **P2-07 冻结 inputUnit 来源集与跨 turn 认领身份**

  - 落点：electron/remote/imCoordinationStore.ts、electron/remote/imAssistantCoordinator.ts。
  - 产物：来源消息/事件集合到持久化 inputUnit 的认领。
  - 完成判据：部分失败/租约释放/重启仍读同一来源集；新事项另建输入；工具只接受当前宿主已绑定 inputUnit，不接受模型任意自报。
  - 验证：`V electron/remote/imCoordinationStore.inputUnit.test.ts`；对应 A-02/10/16；R-02。证据：`evidence/im-assistant-execution-coordination/P2-07.md`。

- [ ] **P2-08 登记完整计划与稳定任务槽位**

  - 落点：electron/remote/imCoordinationStore.ts、electron/remote/imCoordinationTools.ts。
  - 产物：dispatch registerPlan 模式、planDigest 与冻结输入。
  - 完成判据：同一 inputUnit 一次分配完整槽位；依赖图合法；重复 digest 返回原结果，改文案/换槽号不追加另一套；登记前后故障均无未登记执行。
  - 验证：`V electron/remote/imCoordinationTools.dispatch.test.ts -t P2-08`；对应 A-05/10/16；R-02。证据：`evidence/im-assistant-execution-coordination/P2-08.md`。

- [ ] **P2-09 按稳定业务键提交和认领派发**

  - 落点：electron/remote/imCoordinationStore.ts、electron/remote/imCoordinationTools.ts。
  - 产物：dispatch 模式与跨调用重放。
  - 完成判据：两个槽位中第一槽提交后失败，新 invocation/toolCallId 重试不重复建任务/执行，第二槽仍可派；数据库重开后同样成立；重复调用与新用户请求分清。
  - 验证：`V electron/remote/imCoordinationTools.dispatch.test.ts -t P2-09`；对应 A-06/10/16；R-02。证据：`evidence/im-assistant-execution-coordination/P2-09.md`。

- [ ] **P2-10 绑定任务依赖与取消修订资格**

  - 落点：electron/remote/imAssistantCoordinator.ts、electron/remote/imExecutionAgent.ts、既有任务控制链。
  - 产物：依赖接纳校验、计划代次与取消/修订接线。
  - 完成判据：依赖未完成不执行、无环；新修订关联可信来源；取消先撤销旧资格；旧任务答案/结果不得使新代次执行；不修改既有授权规则。
  - 验证：`V electron/remote/imAssistantCoordinator.taskControl.test.ts`；对应 A-06/13/14/16；INV-04/06。证据：`evidence/im-assistant-execution-coordination/P2-10.md`。

- [ ] **P2-11 提交报告并核销已吸收业务材料**

  - 落点：electron/remote/imCoordinationTools.ts、electron/remote/imCoordinationStore.ts。
  - 产物：report 工具与 pendingEvents 消费确认。
  - 完成判据：报告成功即 durable；同报告不重计；正文 checkpoint 成功后才清理短期 payload；保留控制引用但不永久双写问题/回答；报告失败不虚报保存成功。
  - 验证：`V electron/remote/imCoordinationTools.report.test.ts`；对应 A-02/07/10；INV-05。证据：`evidence/im-assistant-execution-coordination/P2-11.md`。

- [ ] **P2-12 实现普通批次计时计数和全体受阻封批**

  - 落点：electron/remote/imAssistantCoordinator.ts。
  - 产物：普通 collecting/sealed 状态推进。
  - 完成判据：假时钟覆盖 299999/300000ms、第 5/6 项、超时到达新项、独立任务可运行/全体受阻、容量等待不算用户阻塞；不等真实五分钟。
  - 验证：`V electron/remote/imAssistantCoordinator.batch.test.ts`；对应 A-08；INV-03。证据：`evidence/im-assistant-execution-coordination/P2-12.md`。

- [ ] **P2-13 实现紧急优先与安全交接后的 drain**

  - 落点：electron/remote/imAssistantCoordinator.ts。
  - 产物：优先队列、多个批次单次认领、忙碌后重新 drain。
  - 完成判据：urgent 不等普通窗口；不抢占正在执行调用；已认领快照后新项保留，普通进度合并；并行回调不重复启动助理 turn。
  - 验证：`V electron/remote/imAssistantCoordinator.drain.test.ts`；对应 A-02/07/09；INV-03/06。证据：`evidence/im-assistant-execution-coordination/P2-13.md`。

- [ ] **P2-14 提交部分业务回答并隔离安全授权**

  - 落点：electron/remote/imCoordinationTools.ts、electron/remote/imCoordinationStore.ts。
  - 产物：decision_apply 与 Markdown 用户决定写入。
  - 完成判据：匹配来源消息/原文证据、scope 和 taskRevision；部分成功可提交，歧义/未答不批准；不调用安全审批批准接口；此任务用确定性匹配输出，不声称模型语义已验证。
  - 验证：`V electron/remote/imCoordinationTools.decision.test.ts`；对应 A-04/13；INV-04。证据：`evidence/im-assistant-execution-coordination/P2-14.md`。

- [ ] **P2-15 将原型退出屏障接入正式报告和回答**

  - 落点：electron/remote/imExecutionAgent.ts、electron/remote/imCoordinationTools.ts、electron/remote/imCoordinationStore.ts。
  - 产物：生产 handoff 与文档 answerRef 接线。
  - 完成判据：重放 A-15 全部时序，包含文档提交失败和用户回答早到；续跑前真实退出/排空/租约释放，已取消/修订不续跑；再跑原型回归。
  - 验证：`V electron/remote/imExecutionAgent.handoff.test.ts electron/remote/imExecutionAgent.handoff.integration.test.ts`；对应 A-15；R-01；INV-06/08。证据：`evidence/im-assistant-execution-coordination/P2-15.md`。

- [ ] **P2-16 恢复已接纳执行与未知结果**

  - 落点：electron/remote/imExecutionAgent.ts、electron/remote/imCoordinationStore.ts。
  - 产物：稳定请求键查询、执行挂接与 uncertain 保留。
  - 完成判据：接纳后派发记账前失败只挂接原 turn；已执行但结果未提交不重跑副作用；退出证明不足不因租约表为空续跑；恢复认领仍是原 dispatchKey。
  - 验证：`V electron/remote/imExecutionAgent.recovery.test.ts`；对应 A-10/15/16；INV-05/06。证据：`evidence/im-assistant-execution-coordination/P2-16.md`。

- [ ] **P2-17 实现发送意图及 T-02 A 恢复**

  - 落点：electron/remote/imAssistantCoordinator.ts、electron/remote/imCoordinationTools.ts、既有出站适配（复用）。
  - 产物：publish、冻结正文/分片 ID、prepared/sending/sent/uncertain。
  - 完成判据：假渠道覆盖发送前退出、已接收未记账、sent 重启、重复 publish；未知不可盲重发/换 ID 绕过去重；发送前重新校验原目的地与身份。
  - 验证：`V electron/remote/imAssistantCoordinator.delivery.test.ts`；对应 A-01/03/10/13；T-02 A。证据：`evidence/im-assistant-execution-coordination/P2-17.md`。

- [ ] **P2-18 恢复多 scope 并处理授权代次交替**

  - 落点：electron/remote/imCoordinationStore.ts、electron/remote/imAssistantCoordinator.ts。
  - 产物：前缀枚举、旧新 scope 恢复与 epoch 变更。
  - 完成判据：同 session epoch1 留 running/uncertain，epoch2 独立接纳；旧回执只回旧行，新 scope 不继承旧许可；跨 channel/owner 隔离；重启找回两份文件。
  - 验证：`V electron/remote/imAssistantCoordinator.scopeRecovery.test.ts`；对应 A-10/13/17；R-03。证据：`evidence/im-assistant-execution-coordination/P2-18.md`。

- [ ] **P2-19 组合单次助理协调循环和状态查询**

  - 落点：electron/remote/imAssistantCoordinator.ts、electron/remote/imCoordinationTools.ts。
  - 产物：读取→多事项处理→分派/回答→发布→再次 drain。
  - 完成判据：假 provider 驱动一次处理多事项及查询 completed/blocked/partial/uncertain；协调器失败后保留 inputUnit/批次/意图；不依赖两渠道生产接线。
  - 验证：`V electron/remote/imAssistantCoordinator.integration.test.ts`；对应 A-02/04/05/07/11/14。证据：`evidence/im-assistant-execution-coordination/P2-19.md`。

- [ ] **P2-20 接通正式角色工具注册与工作流样例**

  - 落点：electron/remote/imCoordinationTools.ts、electron/remote/imOrchestrationTools.ts、electron/remote/imWorkflowSkillHarness.ts。
  - 产物：五工具正式注册、保留控制写入隔离、样例契约对齐。
  - 完成判据：执行角色无通用控制记录写旁路；样例不再把常规拆分变成统一计划确认；工具接口向主调用材料提供但尚不改变渠道出站。
  - 验证：`V electron/remote/imCoordinationTools.integration.test.ts electron/remote/imWorkflowSkillHarness.test.ts`；对应 A-01/05/12/13；INV-01/02。证据：`evidence/im-assistant-execution-coordination/P2-20.md`。

- [ ] **P2-21 验证随机操作序列与恢复不变量**

  - 落点：electron/remote/imAssistantCoordinator.ts、electron/remote/imCoordinationStore.ts、对应测试。
  - 产物：固定种子随机操作和故障注入集。
  - 完成判据：按方案逐步断言跨 scope、批次、执行代次、提前回答、重复槽位、epoch/回执隔离；打印复现种子；对关键故障注入能验证断言可转红，不镜像实现。
  - 验证：`V electron/remote/imAssistantCoordinator.invariants.test.ts`；对应 A-08/09/10/13/15/16/17；INV-02—08。证据：`evidence/im-assistant-execution-coordination/P2-21.md`。

- [ ] **P2-22 完成 P2 本机检查并提交可靠性阶段**

  - 落点：P2 实现/测试及阶段证据。
  - 产物：G2 结果与阶段提交。
  - 完成判据：重跑本阶段已创建测试和边界检查；完成文件/数据库/执行恢复本地证明；不等待真实 IM、真人阅读或 Windows 文件操作结果。
  - 验证：`G2`；对应 A-02/04/08/09/10/11/13/14/15/16/17 的宿主行为。证据：`evidence/im-assistant-execution-coordination/P2-22.md`。

### P3 Skill 与双渠道源码验收

- [ ] **P3-01 细化并落地助理 Skill 的协调与自说明规则**

  - 落点：electron/skills/bundled/imTaskOrchestrationSkill.ts、对应 test.ts。
  - 产物：包含方案 L-01—10 的助理 Skill 与正反样本。
  - 完成判据：目标明确直接分派；使用 read/registerPlan/dispatch；当前消息自说明；等待/部分完成不混同成功；校验内容装配而非只快照字符串，不声称真实模型已遵循。
  - 验证：`V electron/skills/bundled/imTaskOrchestrationSkill.test.ts`；对应 A-03/04/05/11/14；INV-01/09。证据：`evidence/im-assistant-execution-coordination/P3-01.md`。

- [ ] **P3-02 落地执行 Skill 与报告/退出使用约定**

  - 落点：electron/skills/bundled/imExecutionSkill.ts、对应 test.ts。
  - 产物：执行 Skill 及按任务冻结的上下文装配。
  - 完成判据：报告附必要事实，未知不编造；不发 IM、不自行改业务文档；报告等待后主动交回但正确性仍由宿主保证；不把普通业务回答当安全授权。
  - 验证：`V electron/skills/bundled/imExecutionSkill.test.ts`；对应 A-01/07/13/15；INV-01/02/04。证据：`evidence/im-assistant-execution-coordination/P3-02.md`。

- [ ] **P3-03 建立自说明和部分回复的可离线回放样本**

  - 落点：electron/remote/testSupport/imCoordinationLanguageFixtures.ts（拟新增）、electron/remote/imCoordinationLanguage.test.ts。
  - 产物：六类正反例、长消息/同名任务/跨日/分片样本及离线检查。
  - 完成判据：合成事实与预录输出可驱动宿主：允许的匹配才 apply，歧义留待处理，分片不丢问题影响；冻结样本只证明协议与评测可执行，不证明在线模型生成质量。
  - 验证：`V electron/remote/imCoordinationLanguage.test.ts`；对应 A-03/04/11/14 局部；L-01—10。证据：`evidence/im-assistant-execution-coordination/P3-03.md`。

- [ ] **P3-04 将正式协调材料接入共享 IM 入口**

  - 落点：electron/remote/imRemoteAgent.ts、对应 test.ts、electron/feishu/feishuRemoteAgent.ts、electron/wechat/weChatRemoteAgent.ts（必要参数透传）。
  - 产物：助理输出接收者、执行角色 registry、Skill 以及 accepted-turn 材料接线。
  - 完成判据：沿原接纳与安全链运行；不新增 SDK/Runtime 分支；desktop 默认行为回归；接线仍用本地注入的渠道实例测试。
  - 验证：`V electron/remote/imRemoteAgent.test.ts electron/runtime/invocationAssembler.test.ts`；对应 A-01/05/12/13；INV-07。证据：`evidence/im-assistant-execution-coordination/P3-04.md`。

- [ ] **P3-05 接通飞书正常/忙碌/wake/replay 入口**

  - 落点：electron/feishu/remoteCommandRouter.ts、对应 test.ts。
  - 产物：飞书鉴权后的统一协调入口与原出站适配。
  - 完成判据：正常输入/忙碌/wake/replay 均登记同一协调器；原最终摘要/进度出口不重复发送；假的平台 transport 不绕过真实路由和身份处理。
  - 验证：`V electron/feishu/remoteCommandRouter.test.ts`；对应 A-01/02/06/07/10/13 的飞书本地集成。证据：`evidence/im-assistant-execution-coordination/P3-05.md`。

- [ ] **P3-06 接通微信正常/忙碌/wake/replay 入口**

  - 落点：electron/wechat/weChatCommandRouter.ts、对应 test.ts。
  - 产物：微信统一协调入口及格式/长度适配。
  - 完成判据：与飞书同一宿主协议；保留微信格式适配；消息分片和未知送达不被适配器自动重发；不需要真实微信账号。
  - 验证：`V electron/wechat/weChatCommandRouter.test.ts`；对应 A-01/02/03/06/07/10/13 的微信本地集成。证据：`evidence/im-assistant-execution-coordination/P3-06.md`。

- [ ] **P3-07 核销审批、失败、进度和会话切换旁路**

  - 落点：两渠道 router、electron/remote/imRemoteAgent.ts、对应测试；确认适配复用。
  - 产物：方案 §2.9 旁路清单的逐项本地证据。
  - 完成判据：审批 continuation、超时失败、进度、最终摘要不让执行者直发；身份拒绝/传输错误/原生审批保留确定性协议；用户回答不产生授权；切换不改变原发送归属。
  - 验证：`V electron/remote/imCoordinationBypass.integration.test.ts`；对应 A-01/10/12/13/14；INV-02/04/07。证据：`evidence/im-assistant-execution-coordination/P3-07.md`。

- [ ] **P3-08 装配启动扫描与服务停止清理**

  - 落点：electron/feishu/feishuIpc.ts、electron/wechat/weChatIpc.ts（既有服务装配调用点）、electron/remote/imAssistantCoordinator.ts。
  - 产物：每渠道协调器实例、启动恢复与 dispose 接线。
  - 完成判据：本地构造服务 bundle：先核销 fileCommit 再恢复控制/执行，跨渠道不能消费对方 scope；停止后无 timer/new dispatch；重复启动不重复 drain；新增调用点不新增 IPC 通道。
  - 验证：`V electron/remote/imCoordinationLifecycle.integration.test.ts electron/remote/startupWakeRecovery.test.ts`；对应 A-09/10/13/17；方案 §2.8。证据：`evidence/im-assistant-execution-coordination/P3-08.md`。

- [ ] **P3-09 演练完整关闭、联合备份和源码回退**

  - 落点：本机集成测试、electron/remote/imAssistantCoordinator.ts、electron/remote/imCoordinationStore.ts、回退运维说明。
  - 产物：运行链停接纳/排空/备份/还原/重新启动记录。
  - 完成判据：临时数据库与文档真实运行，旧已派发执行不重做；pending/uncertain 不丢；旧版本入口不消费新格式；不在用户真实数据上演练，不先启用生产链再补回退证据。
  - 验证：`V electron/remote/imCoordinationRollback.integration.test.ts`；对应 A-10/12/14；方案 §2.8。证据：`evidence/im-assistant-execution-coordination/P3-09.md`。

- [ ] **P3-10 完成双渠道本机闭环与全部故障回归**

  - 落点：两渠道 router 集成测试、electron/remote/imCoordinationWorkflow.integration.test.ts。
  - 产物：A-01—17 本地证据矩阵和外部缺口清单。
  - 完成判据：真实文件/SQLite/接纳和租约，fake provider/transport 驱动全链；A-15/16/17 在生产接线下复验；不以协议样本替代 A-03 人类可理解性或 U-03 平台能力。
  - 验证：`V electron/remote/imCoordinationWorkflow.integration.test.ts electron/remote/imCoordinationBypass.integration.test.ts electron/remote/imCoordinationLifecycle.integration.test.ts electron/remote/imCoordinationRollback.integration.test.ts`；对应 A-01—17 本地部分；R-01—03。证据：`evidence/im-assistant-execution-coordination/P3-10.md`。

- [ ] **P3-11 完成源码最终测试构建与边界检查**

  - 落点：最终源代码/测试与本计划证据。
  - 产物：G3 源码验收结果。
  - 完成判据：全量测试/完整构建和全部边界门禁通过；只修本需求引入失败，既有失败独立记账；不要求账号、在线模型、安装包真机或其他 OS 结果。
  - 验证：`G3`；对应 INV-01—09；A-01—17 本地部分。证据：`evidence/im-assistant-execution-coordination/P3-11.md`。

- [ ] **P3-12 评审本次变更并提交源码交付记录**

  - 落点：本计划、docs/develop/im-remote/README.md、必要的现状/运维文档（文档单独提交）。
  - 产物：代码质量评审、源码提交、外部验收交接及证据索引。
  - 完成判据：按 code-review-and-quality 技能评审实际 diff，修复本次阻断并按影响定向复验；再次变更需更新 G3 证据；文档写入复读；本机完成与外部未验分开，不直接启用/发布。
  - 验证：`REVIEW`；对应 R-01—03 实施证据；全部 A 的覆盖与限制。证据：`evidence/im-assistant-execution-coordination/P3-12.md`。

## 4. 依赖倒置与验证范围核对【机｜人工可跳过】

| 易倒置点 | 本计划的安排 | 不允许的替代 |
|---|---|---|
| P1 退出屏障依赖 P2 回答/文档提交 | P1-04—06 使用真实最小控制和已存在的回答材料引用；P2-15 接真实 Markdown checkpoint | 为让 P1 绿而 import 未来 P2 的工具，或把函数调用计数当真实退出证明 |
| scope 定位依赖完整持久化 | P1-01 先实现并验证真实 workflow 主键；P2 才加完整控制/文件 | 先用固定 workflowId 写数据，后续再想迁移 |
| 派发去重依赖注册计划 | P2-07/08 先冻结输入和完整槽位，P2-09 才允许认领派发 | 先执行后补 taskId/dispatchKey，或按 instruction 相似度去重 |
| 回答和报告互相依赖 | P1 屏障接口先以最小存取证明；P2-11/14 各自独立提交，P2-15 组合 | report 工具必须等用户回答才能返回 |
| 计时/优先级依赖实际模型耗时 | P2-12/13 注入假时钟和受控 Promise，本机瞬时覆盖边界 | 等真实五分钟、等模型超时或外部 deadline 才验收 |
| 生产接线依赖完整双渠道 | P3-04 共享入口先可注入验证，P3-05/06 分别接线，P3-07 汇合 | 飞书任务的 GREEN 要求微信下一任务才提供的实现 |
| 启用早于关闭回退 | P3-09 先本地演练，再 P3-10/11 源码关闭；发布不在本计划自动动作内 | 先真实用户启用，再把回退作为收尾补作业 |
| 最终验收与阶段验收互为前置 | P1/P2 关卡只引用当前及此前实现；P3 收集它们，早期不引用 G3 | 以“所有阶段关闭”为早期阶段的完成条件 |

## 5. 本机检查点与源码关闭【机｜人工可跳过】

以下证据清单只解释检查点消费什么，实际依赖仍以 §2 为准。任务中通过后记录具体文件列表，合并运行，不能因本表未展开某文件名就漏测。

| 检查点 / 所属任务 | 只消费这些已产生证据 | 命令范围 | 不要求 |
|---|---|---|---|
| G1 / P1-10 | P1-01 scope 主键，P1-02 角色，P1-03 接纳，P1-04—06 屏障/最小重开，P1-07 并行，P1-08 授权/托管，P1-09 原型兼容 | P1 新增测试全集、P1-09 定向回归、G1 公共命令 | P2 文件提交器、生产队列、两渠道真机、真人语义评分 |
| G2 / P2-22 | P2-01—06 文件/控制/备份原语，P2-07—10 稳定计划派发，P2-11—15 批次/问答/正式屏障，P2-16—20 恢复/发送/工具，P2-21 随机不变量 | P2 已创建测试全集与受影响的 P1 回归、G2 公共命令 | P3 生产渠道接线、服务 bundle 或完整运行期回退演练 |
| G3 / P3-11 | P3-01—03 Skill/离线样本，P3-04—08 共享入口/双渠道/服务，P3-09 完整回退，P3-10 本地闭环 | P3-10 组合命令、受影响前阶段回归、G3 公共命令 | E-01—04 任何外部证据、实际发布、他人未来 PR/线程完成 |
| 源码交付 / P3-12 | G3 的源码 SHA、当前 diff 的质量评审及阻断处理、本机/外部覆盖分列 | REVIEW、文档链接/格式与提交核验 | 产品负责人再次决定 T-01/T-02；强行把外部未验项标绿 |

全量测试仅在 P1/P2 阶段收尾和 P3 最终验收运行；开发循环用任务定向命令。如脚本因既有构建环境/生成产物缺失失败，先按 P0-01 的准备判据处理，不删检查。没有 UI 新文案不新增 i18n 工作；若实施实际引入 UI 或新共享契约，先回方案修订范围，不在任务中顺手扩张。

## 6. 方案验收与实施证据映射【机｜人工可跳过】

此表是覆盖索引，不定义另一套验收，也不是依赖表。“本机”只表示所列行为可以验证，不自动覆盖外部真实体验。

| 方案场景 | 本机证据产出任务 | 外部补充 |
|---|---|---|
| A-01 统一沟通 | P1-02、P2-17/20、P3-04—07/10 | E-01/02 实际收发 |
| A-02 多事项 | P2-07/11/13/19、P3-05/06/10 | E-01/02 多问题真实呈现 |
| A-03 自说明 | P3-01/03/10 的样本、引用和分片协议 | E-03 真实生成＋隔离阅读；E-01/02 平台呈现 |
| A-04 自然语言部分回复 | P2-14/19、P3-03/10 的匹配输出协议 | E-03 在线理解，E-01/02 实际回复 |
| A-05 明确目标直接分派 | P2-08/19/20、P3-01/04/10 | E-03 模型实际选择 |
| A-06 并行 | P1-03/07、P2-09/10、P3-10 | E-01/02 长任务体验 |
| A-07 运行中报告 | P1-04/07、P2-11/19、P3-10 | E-01/02 实际 IM 时间线 |
| A-08 封批 | P2-12/21、P3-10 | E-01/02 可观察表现 |
| A-09 紧急排队 | P2-13/21、P3-08/10 | E-01/02 渠道呈现；不承诺截止前送达 |
| A-10 恢复去重 | P2-04—09/15—18/21、P3-08—10 | E-01/02 平台回执窗口，E-04 其他 OS |
| A-11 对话查询 | P2-19、P3-01/03/10 | E-03 真实表达，E-01/02 实际查询 |
| A-12 桌面不变 | P1-02/09、P3-04/07/09/10 | E-04 Electron GUI 冒烟 |
| A-13 授权不绕过 | P1-08、P2-10/14/18、P3-07/10 | E-01/02 原生审批可用性 |
| A-14 状态真实 | P1-06、P2-10/16/19、P3-03/09/10 | E-03 真实状态说明 |
| A-15 退出屏障 | P1-04—06/08（原型），P2-15/16（正式），P3-10（全链） | 本机确定性时序已充分可测；不等待外部才修竞态 |
| A-16 跨 turn 业务幂等 | P2-07—10/16/21、P3-10 | 同上 |
| A-17 主键隔离 | P1-01（主键），P2-18/21、P3-08/10（恢复） | 同上 |

R-01 的关闭证据来自 A-15 的实际运行记录，R-02 来自 A-16，R-03 来自 A-17。原报告是否已复审通过与实现测试是否通过分别记录，不能因任一项存在就推断另一项完成。

## 7. 外部验收清单与后续启用边界【人机共读】

E-* 不参与 §2 DAG，没有本机任务以 E-* 为前置；源码完成后可交付，即使这些仍未完成。它们也不能用 fake transport 或模板文本勾选完成。

| 项 | 所需资源 / 负责人 | 要验证的方案范围 | 无资源时如何交付 |
|---|---|---|---|
| E-01 飞书实测 | 测试机器人、用户授权与网络；渠道集成人员＋用户 | U-03/04：统一表达、部分回复、运行中问题、原审批、收发/重连及已接收未记账窗口；无回执查询时 T-02 A 保持 uncertain | 保留待外部验收，提供本机测试证据/复现步骤，不阻塞 P1—P3 |
| E-02 微信实测 | 真实微信测试环境；渠道集成人员＋用户 | 与飞书同协议，补微信长度/分片、实际回复与送达核对能力 | 同上，不要求先拿飞书结果才能做源码 |
| E-03 在线模型与隔离阅读 | 真实服务凭据/预算、冻结模型/Skill 版本、无内部上下文的读者；实现者组织、读者评判 | 方案 §2.6.4 与 INV-09，六类消息和部分回复，真实性/可理解性/授权边界分别判断 | 交付样本和评测流程；标注生成质量未验，不把“提示词存在”当行为通过 |
| E-04 平台/真机 | 真实 Electron 运行环境，其他 OS 的设备或 CI runner；平台维护者 | 实际启动/退出、桌面原行为、文件替换/锁/持久化和安装包恢复 | 本机 macOS 文件测试照常完成；跨 OS 与 GUI 结果单列，不作为源码门禁 |

后续启用/发布是独立工作，不包含在 46 项实现任务中。届时引用已经完成的源码、P3-09 回退记录和所需渠道/平台验收结果，再决定部署；缺失外部资源意味着相应渠道尚未验收，不意味着本机实现“无法继续”。不新增未获批的灰度设置项，也不为展示消息而临时增加任务面板。

## 8. 计划静态自检与后续维护【机｜人工可跳过】

本轮只检查：46 项任务逐项有落点/产物/完成判据/命令/环境/状态；DAG 无环、前置均较早出现、三个检查点只消费此前证据；每个方案 A-* 有覆盖索引；所有外部验收均不进入依赖表。检查计划不是执行功能测试，当前没有 G1/G2/G3 通过记录。

未来实施按 §2 拓扑推进，每项完成后只更新自身标记和证据；若实现发现新文件落点或既有接口变化，先在证据记录再修订本计划允许范围，稳定行为或契约变更回到技术方案评审。每阶段提交；文档与代码分开提交，仅暂存本次文件，不处理他人未提交修改。
