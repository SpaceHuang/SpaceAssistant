# AGENTS.md 加载功能的附加交互精简方案

- 日期：2026-10-17
- 文档性质：技术方案；定义稳定目标、边界、不变量、迁移和验收，不维护执行进度。
- 状态：待实施
- 代码事实基线：`1f22be0f`（工作区 HEAD；2026-10-17 核查）
- 关联现状：[`agents-md-workdir-instructions-behavior.md`](./agents-md-workdir-instructions-behavior.md)
- 关联已完成实现计划：[`../archive/agent-sdk/agents-md-workdir-instructions-development-plan.md`](../archive/agent-sdk/agents-md-workdir-instructions-development-plan.md)

## 第 0 层：决策与授权边界【人必读】

**一句话：**目前自动读取项目规则的功能旁边多了控制和查看界面；本次保留自动读取并交给 AI 使用，移除这些额外入口和记录。

**只有 3 分钟的话：**读完本层后，先看概要；再看规格里“自动加载保持、旧会话开关失效、快照不再保存、目录安全校验保持”四条；最后看验收里的成功注入、失败诊断、目录变更和界面移除场景。

**需要你决定的事项：**无新增事项。保留自动加载与上下文注入、移除额外界面和逻辑的范围已由你明确指定。

**不需要你决定（Agent 负责；写出来是为了不占用你的时间）：**核查现有代码中哪些状态还被安全降级、通用历史恢复或其他功能使用；只删除面板专属部分；确定分阶段改动和定向验证；保证旧会话数据可兼容读取。若核查发现必须改变你指定的产品边界才能安全完成，再带着具体影响回来讨论。

## 第 1 层：概要【人机共读】

当前实现除了在模型请求前加载工作目录根部 `AGENTS.md` 并注入上下文，还提供了聊天输入区常驻按钮及面板、会话级启停字段、快照历史查询 IPC，并把请求快照正文写入通用 History 以供 UI 查看。精简后保留文件加载器、请求边界刷新、上下文注入和安全失败诊断；删除专为控制或查看这项功能而新增的界面、会话状态、查询接口和历史快照投影。

这是**现有实现行为的收敛**，不改变 `AGENTS.md` 的规则作用域、刷新时点、内容预算或工具安全策略。没有会话开关后，所有会话均按当前默认行为尝试加载；旧 metadata 中遗留的 `agentsMdEnabled` 不再改变加载结果。

## 事实与基线【机｜人工可跳过】

| ID | 事实 | 复现方式 |
| --- | --- | --- |
| F-01 | `ProjectInstructionsControl` 挂在聊天 Composer 偏好区，显示开关、刷新、当前状态、逐请求列表和快照正文。 | `git show 1f22be0f:src/renderer/components/Chat/ChatView.tsx`；`rg -n "ProjectInstructionsControl|chatGetAgentsMdRequestSnapshots|projectInstructions" src/renderer/components/Chat src/renderer/i18n/resources` |
| F-02 | `agentsMdEnabled` 从 Session metadata / IPC 进入 turn config 和 invocation，并由 observer 作为 `loadAgentsMd` 的 `enabled` 条件；缺省值为 true。 | `rg -n "agentsMdEnabled" src/shared electron`；`sed -n '118,150p' electron/runtime/agentSdkDesktopObserver.ts` |
| F-03 | observer 在逻辑模型请求边界读取文件并注入 system message，同时将状态、摘要、字节数、时间、预算、目录和成功正文写入 `requestMetadata.agentsMdSnapshot`。 | `sed -n '118,150p' electron/runtime/agentSdkDesktopObserver.ts`；`sed -n '245,263p' electron/runtime/agentSdkDesktopObserver.ts` |
| F-04 | 两个快照查询 IPC 从通用 Agent History 读取快照索引与正文；执行器也从 `agentsMdSnapshot.workDir` 读取来源目录，用于派发前检测工作目录绑定是否改变。 | `sed -n '700,805p' electron/ipc/agentProtocolIpc.ts`；`sed -n '975,1000p' electron/runtime/invocationAssembler.ts`；`sed -n '1448,1472p' electron/runtime/invocationAssembler.ts` |
| F-05 | `assembleInvocation` 为所有 lane 提供 `getWorkDirSnapshot`；observer 将来源 binding 与每个模型请求的 History metadata 一起投影；recheck 用 binding key/profile/revision 比较当前目录身份。 | `sed -n '1620,1640p' electron/runtime/invocationAssembler.ts`；`sed -n '118,130p' electron/runtime/agentSdkDesktopObserver.ts`；`sed -n '975,1000p' electron/runtime/invocationAssembler.ts` |
| F-06 | 桌面入口 `claudeStreamHandlers`、Feishu/WeChat 入口 `imRemoteAgent`、automation 入口 `butlerInvoker` 和审批回答 Agent 都经 invocation 装配进入共同 observer。 | `rg -n "assembleInvocation|createAgentSdkDesktopObserver|loadAgentsMd" electron/claudeStreamHandlers.ts electron/remote/imRemoteAgent.ts electron/butler/butlerInvoker.ts electron/confirmation/approvalAgent.ts electron/runtime` |
| F-07 | 加载失败会在模型请求中加入“未加载”诊断；Feishu / WeChat 还通过进度 hook 向用户显示未加载提示。 | `sed -n '76,84p' electron/remote/remoteProgressHooks.ts`；`sed -n '128,140p' electron/runtime/agentSdkDesktopObserver.ts`；`sed -n '81,90p' electron/llmSystemPrompt.ts` |

事实基线统一为 `1f22be0f`；表中每条事实均给出可复现命令。绕过通道核查结果：当前桌面、Feishu、WeChat、butler automation 与 approval agent 都接入 `assembleInvocation` / `createAgentSdkDesktopObserver`；本方案须保留这条共同加载链，禁止只保留桌面或另建 IM 专属加载器。实施前若 HEAD 已变化，仅复跑表中命令并按当前调用关系更新规格，不把文件路径当作稳定 API。

## 第 2 层：规格【机｜人工可跳过】

### 不变量

| ID | 不变量 | 约束与验证 |
| --- | --- | --- |
| INV-01 | 工作目录根部 `AGENTS.md` 的发现、安全读取、预算与每逻辑模型请求刷新行为保持不变。 | 复用现有读取器和请求准备边界；以 loader、observer、provider 请求捕获测试验证。 |
| INV-02 | 加载成功的正文仍只注入到其有效工作目录对应的模型请求。 | 桌面、飞书、微信、automation 继续走共同宿主装配；双目录并发与各入口测试验证不串用。 |
| INV-03 | 删除 UI / 会话开关 / 历史查看后，任何已保存的 `agentsMdEnabled: false` 都不能关闭加载。 | 不再读取该字段作为行为输入；含遗留字段的旧 Session 测试验证加载仍启用。无需数据库迁移或批量改写 metadata。 |
| INV-04 | AGENTS 正文、摘要、加载状态、大小、时间和预算不再为面板展示写入通用 History。 | 从专用 `agentsMdSnapshot` 持久字段移除；通用 History 事件和其他 metadata 不变。 |
| INV-05 | 删除 AGENTS 快照后，执行前目录漂移检查仍比较模型请求来源目录与当前目录。 | 所有 lane 已由 `assembleInvocation` 提供请求 binding；两处 recheck 固定改读同一请求 `workspaceBinding.workDir`，并继续核对 binding key/profile/revision。不得用 AGENTS 内容快照承载目录授权事实。 |
| INV-06 | 读取失败、超限等状态仍通过模型内部诊断说明本轮没有采用指令；本次不再向 IM 用户额外发送 AGENTS 未加载进度提示。 | 保留 `renderAgentsMdStatusSection` 对模型的诊断；移除 `onAgentsMdNotLoaded` 的远程 UI / progress hook 连接。权限与审批语义不变。 |
| INV-07 | 无 AGENTS 专属常驻 UI、会话开关、快照查询 IPC 或快照查看能力。 | renderer、preload、shared API、IPC handler 不再暴露这些产品交互；检查调用面与界面回归。 |

### 状态所有权与契约

| 数据 / 状态 | 精简后的所有者 | 生命周期 |
| --- | --- | --- |
| 加载结果（正文、预算、读取状态） | 宿主请求准备流程 | 仅覆盖当前逻辑模型请求的装配与诊断；provider 同请求重试复用已冻结请求材料，下一逻辑请求重新读取。 |
| 会话加载开关 | 无 | 删除 `agentsMdEnabled` 的创建、更新、读取和传播；旧 JSON 值作为未解释的遗留 metadata，不再参与执行。 |
| AGENTS 历史快照 | 无专属所有者 | 不再将正文、摘要、状态等写入专用 History metadata，不新增替代表或 sidecar。 |
| 请求来源工作目录 | Agent 通用 workspace binding | 按当前 request 的冻结目录身份供派发前安全复核；与 AGENTS 内容是否加载无关。 |
| 面板查询 API | 无 | 删除专属快照索引和正文查询 handler、preload 方法及共享返回类型。 |

已加载正文只随冻结的模型请求材料用于该次 provider 调用，不再复制到 request metadata / Agent History。请求 metadata 保留 `workspaceBinding`，因为它是执行前目录漂移检查的来源事实；删除 `agentsMdSnapshot.workDir` 时，两处执行前校验统一读取 `workspaceBinding.workDir`，binding 的身份字段继续参与比较。该 binding 由共同 invocation assembler 提供，模型请求和工具执行共用；不得把 AGENTS 文件正文、摘要或加载状态留在 History 来间接维持该安全检查。

### 加载失败诊断

模型提示中的“本次未加载及原因”是运行语义，不是面板状态，因此继续保留。远程 IM 用户可见的未加载进度提示属于额外产品呈现，按本次范围删除；缺文件与空文件仍不注入正文，模型侧诊断逻辑继续按现有状态分类执行。此处的模型诊断不显示在 UI，也不进入专用 AGENTS 历史记录。

### 改动面

| 子系统 | 精简目标 | 关键核查点 |
| --- | --- | --- |
| Renderer | 删除 `ProjectInstructionsControl`、Composer 挂载、其测试及专属 i18n key。 | 保留模型 / thinking 选择器及其他 Composer preference。 |
| Session / turn 配置 | 删除 `agentsMdEnabled` 的领域字段、持久化更新入口和入口传播。 | 遗留 metadata 不影响自动加载；不得触碰 `projectMemoryEnabled`。 |
| IPC / preload / API | 删除快照索引与正文查询通道及类型。 | `loadAgentsMd` 必须仍由宿主运行时直接调用，不通过面板 IPC。 |
| Runtime / History | 保留加载和注入；删除 AGENTS 专属快照持久投影。 | 目录漂移检查改读通用 `workspaceBinding.workDir`；其他 request metadata 和审批 / 派发约束不变。 |
| IM 进度 / 日志标签 | 删除远程未加载进度 hook、专属 label 和 i18n key。 | 模型内部失败诊断保留；不记录正文、密钥或原始敏感路径；不改变远程审批提示。 |

### 迁移与回滚

- **存储迁移：**不改 SQLite schema，不回填或清理 Session metadata，不重写历史记录。旧的 `agentsMdEnabled` 字段可留存但不再解释；旧 History 中已存在的快照按通用历史数据保留，不再提供本功能的读取入口。
- **回滚实体：**本次源码改动按分阶段提交回退；恢复旧版代码会重新暴露面板和开关。无需数据回滚，因为本方案不删除已有字段或历史 payload。
- **阶段出口：**阶段边界、输入、产物、验证与回退实体见下表；每一阶段合并前均可编译和回退，不依赖后续阶段的代码。

| 阶段 | 输入与改动范围 | 产物与出口证据 | 回退实体 |
| --- | --- | --- | --- |
| S1 移除产品交互 | 当前 renderer、session 开关、快照查询 IPC 与远程进度提示；改 renderer / i18n / session config / API / preload / IPC / remote progress。 | 无常驻入口、无面板、无会话开关、无查询 API 和 IM 未加载提示；定向 UI、session、IPC 测试与类型 / i18n 检查通过；loader 仍由运行时调用。 | S1 代码提交；无数据库迁移。 |
| S2 解耦安全绑定并移除专属快照历史 | S1 后 observer、invocation assembler、workspace binding 与 History 投影；先将两个派发前校验统一改用 `workspaceBinding.workDir`，再删除 `agentsMdSnapshot` 持久字段和测试夹具。 | 双阶段派发前目录变化仍拒绝执行；有效绑定场景仍按原目录执行；请求快照正文不再进入 History；provider 捕获测试仍证明指令注入；observer / assembler / History 定向测试通过。 | S2 代码提交；回退 S2 可恢复旧 `agentsMdSnapshot` 字段，历史旧值仍兼容。 |
| S3 全入口与最终回归 | S1、S2 合并结果；桌面、飞书、微信、automation 入口和旧 session / history fixture。 | 完成本方案 AC-01–AC-08；定向测试、共享与渲染类型、i18n 检查、最终全量测试通过。外部验收另记，不阻塞源码关闭。 | S1–S2 各自提交；按需逐提交回退。 |

### 排除方案

- 不以隐藏按钮或保留不可达面板代码作为精简：那会继续维护 UI、IPC 和 i18n 的死链路。
- 不保留会话开关但把入口移到设置页：这仍然保留用户明确要求移除的附加界面和逻辑，并继续造成会话间加载行为分叉。
- 不保留专用快照历史而只删查看按钮：这会继续为已移除的产品能力增加正文持久化和存储负担。
- 不删除 loader、模型失败诊断或权限边界：它们属于加载与安全语义，不属于附加面板。

## 验收【人机共读】

| ID | 验收场景 | 通过条件 |
| --- | --- | --- |
| AC-01 | 当前工作目录根有合法 `AGENTS.md`，各 Agent 入口发起逻辑请求。 | provider 捕获的请求包含对应完整指令；目录隔离无串用。 |
| AC-02 | 同一 invocation 的工具返回后，文件被修改 / 删除 / 新建。 | 后续逻辑请求重新读取当前版本；同一 provider 请求重试沿用原请求材料。 |
| AC-03 | 文件缺失、空白、超限、编码错误或读取失败。 | 不注入错误正文、不复用旧内容；必要模型诊断仍在；无 AGENTS UI 状态面板。 |
| AC-04 | 历史 Session 含 `agentsMdEnabled: false`。 | 新代码仍尝试加载有效工作目录的文件；旧 project memory 开关行为不变。 |
| AC-05 | provider 响应后目录绑定改变，或工具准备后目录绑定改变。 | 工具在 executor 前被拒绝；拒绝比较依据来自 `workspaceBinding`，不依赖 AGENTS 快照。 |
| AC-06 | 打开聊天 Composer 并检查 preload / IPC API、远程进度投影。 | 无 AGENTS 常驻按钮、开关、快照列表 / 查看 / 刷新面板、快照查询 IPC 或 IM 未加载进度提示。 |
| AC-07 | 新请求完成并写入 History。 | 不含专为 AGENTS 展示新增的正文、状态、摘要、目录或时间；通用 History 与 workspace binding 读写正常。 |
| AC-08 | 旧数据库与旧历史数据在新版本读取。 | 无 schema migration；旧 metadata / event payload 不阻塞新调用；遗留开关不影响自动加载，旧快照不重新投影为当前状态。 |

### 失败、并发与恢复场景

| 场景 | 处理与验收 |
| --- | --- |
| 两个会话目录并发请求 | 各请求使用各自已冻结的 binding 加载，不共享正文或缓存；由 AC-01 与 observer 双目录测试覆盖。 |
| 同逻辑请求发生 provider 重试 | 复用已准备的冻结请求，不因重试读取另一版本；由 AC-02 的 request capture 测试覆盖。 |
| 读取缺失、失败、超预算 | 当前请求不包含正文，仍包含模型内部未加载诊断；远程用户不收到额外 AGENTS 进度提示；由 AC-03 覆盖。 |
| 响应后或等待派发期间目录变更 | 两个 recheck 点都以 `workspaceBinding` 拒绝派发，executor 不进入；由 AC-05 和 `invocationAssembler.workspace.test.ts` 覆盖。 |
| 请求超时或取消 | AGENTS 精简不改 turn 取消 / 超时结算；被取消的请求不触发重试或额外派发，由现有 turn cancellation / observer 定向测试覆盖。 |
| 重复或乱序的请求事件 | 本方案不新增请求状态写入者或排序机制；查询 IPC 移除后，不再构造 AGENTS 历史列表，通用 History 原有幂等与顺序验证保持。 |
| 进程重启后读取旧 History | 未完成 invocation 仍按既有规则恢复为 interrupted；旧 AGENTS 快照不再用于加载、授权或重新执行，旧事件可被通用 History 忽略未知 metadata 地读取；由 AC-08 和 History recovery 测试覆盖。 |
| 精简阶段部分失败或回退 | S1/S2 分别提交；回退对应源码提交即可恢复旧代码路径。无 schema、字段清理或事件重写，不需要数据补偿。 |

### 验收映射与验证命令

| 验收 | 不变量 | 主要用例 / 证据 |
| --- | --- | --- |
| AC-01–AC-03 | INV-01、INV-02、INV-06 | `electron/projectInstructions/projectInstructions.test.ts`、`electron/runtime/agentSdkDesktopObserver.test.ts`、各入口集成测试 |
| AC-04 | INV-03 | `electron/sessionStorage/sessionStorage.test.ts`、`electron/turnExecutionConfig.test.ts`、`electron/runtime/invocationAssembler.test.ts` |
| AC-05 | INV-05 | `electron/runtime/invocationAssembler.workspace.test.ts`、`electron/runtime/invocationAssembler.test.ts` |
| AC-06 | INV-07 | 删除 `src/renderer/components/Chat/ProjectInstructionsControl.test.tsx` 与 `electron/ipc/agentInstructionsIpc.test.ts`；S1 删除前运行这两份基线测试，删除后运行仍保留的相关 renderer / IPC 测试并搜索 preload/API 残留 |
| AC-07–AC-08 | INV-04、INV-05 | `electron/runtime/sqliteAgentHistory.test.ts`、History recovery 定向测试及旧事件 fixture |

定向测试合并命令（删除专属测试文件前运行；移除它们后从命令中去掉）：`npm exec vitest run electron/projectInstructions/projectInstructions.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/runtime/invocationAssembler.test.ts electron/runtime/invocationAssembler.workspace.test.ts electron/sessionStorage/sessionStorage.test.ts electron/turnExecutionConfig.test.ts electron/runtime/sqliteAgentHistory.test.ts electron/ipc/agentInstructionsIpc.test.ts electron/remote/imRemoteAgent.test.ts electron/butler/butlerInvoker.test.ts src/renderer/components/Chat/ProjectInstructionsControl.test.tsx`。阶段收尾另跑 `npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`。最终源码验收按仓库规定运行 `npm test`。测试路径若实施前重命名，先用 `rg --files` 找到当前对应测试再运行。

## 事实核销与待验证项【机｜人工可跳过】

| 项目 | 当前状态 | 关闭证据 |
| --- | --- | --- |
| UI、会话开关、快照 IPC 与加载注入的实际耦合 | 已基于代码基线 `1f22be0f` 核查 | F-01–F-07 的复现命令；实施前按仓库流程复查 HEAD。 |
| 快照字段与目录漂移安全校验的耦合 | 已确认：两处 recheck 从 snapshot.workDir 读取来源；独立 `workspaceBinding` 同时在 payload 内 | 本方案 INV-05、S2；定向测试需证明移除快照字段仍能在 executor 前拒绝目录漂移。 |
| 远程未加载提示 | 本方案明确删除用户可见 progress hook，保留模型内部诊断 | AC-06 验证 hook / 文案移除；AC-03 验证模型请求仍含未加载诊断。 |
| 真实模型遵循效果、真实 IM 往返和多平台文件系统行为 | 未验证；不属于源码精简的本机门禁 | 发布如需确认，由项目负责人另以真实模型、渠道账号及目标平台记录外部验收。 |

## 业务词对照【机｜人工可跳过】

| 业务词 | 代码 / 数据词 |
| --- | --- |
| 工作目录项目指令 | `AGENTS.md` |
| 逻辑模型请求 | logical provider request / model turn request |
| 加载失败诊断 | `renderAgentsMdStatusSection`（模型内部提示；远程 UI 提示移除） |
| 历史快照投影 | `requestMetadata.agentsMdSnapshot`（精简目标：整体移除；来源目录由通用 `workspaceBinding` 提供） |
