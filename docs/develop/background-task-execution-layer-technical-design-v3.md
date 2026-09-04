# 后台 Mission 执行层详细技术方案 v3

> 依据：`docs/requirement/background-task-execution-layer-design-v3.md`
> 状态：待复审（已响应六轮评审提出的十八项 P0）
> 设计目标：在不侵入 Agent 内部循环、不建设通用工作流引擎的前提下，为自治后台任务提供可信确认、隔离执行、可取消、可恢复、可审计和不可变交付能力。

## 1. 结论与实施边界

本方案采用“主进程内 Mission 控制面 + 可替换 AgentBackend + Run 私有 snapshot workspace + SQLite 事实账本 + 内容寻址 revision store”的实现。Agent 负责目标内的规划和执行，SpaceAssistant 只管理执行生命周期及正式状态。

首版不建设独立 Worker 服务、通用队列、DAG、子 Agent 拓扑、容器编排平台或通用验证 DSL。后台运行由 Electron 主进程托管；Renderer 关闭或窗口隐藏不影响运行，应用退出则受控停机并在下次启动恢复。

### 1.1 Agent 产品决策

当前版本只实现本地 Codex 后端，但 SpaceAssistant：

- 不打包、下载、安装或升级 Codex；
- 不替用户登录 Codex；
- 不读取、保存或代用户提供 OpenAI API Key；
- 只使用用户环境中已经安装且配置完成的 Codex；
- Codex 不存在、未登录、配置错误、版本不兼容或未通过安全准入时，本次创建/启动明确失败，不静默降级；
- 后续提供独立的 SubAgent 客户端后端作为 Codex 不可用时的候选替代，并长期支持其他 Agent。

Mission、AgentRun、事件、恢复、Candidate 和 Review 核心机制不得依赖 Codex 专有类型。后端差异通过最小 `AgentBackend` adapter 隔离；MVP 不建设动态插件市场，也不实现运行中的自动后端切换。

### 1.2 当前差距

当前仓库存在二十个不能绕过的前置差距：

1. 仓库尚无 AgentBackend 接入和版本化能力探测。当前 Codex adapter 必须通过安装/配置可用性检查，以及当前平台的沙箱、进程树终止、原生事件和退出检测准入测试，才允许创建 `supervised` / `dedicated` Mission。
2. 现有 `session_artifacts` 表登记的是可变工作区路径，不是不可变 revision store。它可继续服务普通会话 Artifact，但不能承载 Candidate、Review target 或 Mission 正式交付物。
3. 独立浅 Git snapshot 在目标平台上的创建、配置隔离、LFS/filter/submodule 检测和性能尚未形成验证夹具；Phase 0 必须先固化支持范围，不能退回共享 worktree 作为静默降级。
4. 当前子进程工具没有可跨主进程崩溃重识别的 containment identity 和 gated launch 协议，不能直接作为后台 Run 的释放证明。
5. 独立 workspace 尚无离线 dependency layer 与工具链 identity；required command validator 在依赖未物化前不能启用。
6. 当前文件写入能力没有正式工作树专用的持久化 apply journal，不能以进程内 catch/backup 代替崩溃事务。
7. 当前会话消息投递没有 Mission 状态事务 outbox，不能以事件日志或 payload 幂等键代替数据库唯一约束。
8. Host Validator 尚不是可持久化、可取消和可恢复的执行单元，不能作为 CandidateImporter 内的普通子进程启动。
9. 正式工作树 apply 尚无 handle-relative、拒绝 reparse/symlink 祖先的文件系统适配层；只做路径字符串预检仍存在 TOCTOU。
10. dependency layer 目前没有显式数据库 FK 引用图；descriptor hash 或业务 JSON 不能充当 GC root。
11. revision store 尚无可线性化 GC claim；MVP 必须关闭已发布 blob 物理 GC，不能用非原子“删除前重检”冒充并发安全。
12. apply 尚无叶子目录项 quarantine 状态与 file mode 合同，不能在 identity 检查后直接 replace/unlink。
13. ValidationAttempt 尚未进入 Mission 累计资源账本；单次 timeout 和全局并发不能替代用户确认的总预算。
14. dependency layer manifest 尚不能表达 npm `.bin` 等层内相对 symlink；若跟随成普通文件或由物化器猜测恢复，都无法证明三类 execution owner 获得相同依赖树。
15. revision store 尚无所有 publisher 共用的持久化容量 reservation；在 finalized blob 不回收的 MVP 中，Prepare/Candidate 并发或崩溃可永久耗尽应用数据盘。
16. 当前实施阶段把生产 dependency layer 放在代码 Run 之后；软件 Mission 必须在生产环境 binding、物化器和双重 capability gate 就绪前保持禁用。
17. dependency tree 首次扫描与 blob 捕获之间尚无 source identity fence；publication 若重新按字符串路径读取，可能固化扫描后被替换的未授权内容。
18. revision hash 路径尚无经平台验证的 NO_REPLACE 单赢家发布；普通 rename 会覆盖竞争者并破坏永久容量计费。
19. 物理 blob 去重身份与逻辑 revision media type 尚未拆开；相同字节以不同语义发布时不能由首个 publisher 决定全局类型。
20. Mission usage ledger 尚未区分累计消耗、当前并发 gauge 和历史高水位；若统一求和，已释放进程/workspace 会永久阻断后续 Validator/Reviewer/Recovery owner。

为降低首版风险，软件开发 Mission 进一步采用以下保守限制：

- 只支持 Git 仓库且确认时正式工作树必须干净；固定 `HEAD` commit 作为 `baseIdentity`。
- Agent 只写宿主创建的独立单基线 Git snapshot，不直接写用户工作树；snapshot 不与源仓库共享 `.git`、对象库或 refs。
- Agent 可在 snapshot 内执行本地 Git 写操作；Git 网络操作、源仓库写入和远端副作用由宿主边界禁止。
- 网络、浏览器、远程插件写入、消息发送、`git push`、创建 PR 等外部副作用全部禁用。
- Shell 仅允许由已验证 Agent 沙箱约束的本地命令；不是在 SpaceAssistant 中维护一套命令前缀白名单。
- Mission 完成只发布不可变 CodeChangeSet，不自动改写用户工作树。“应用到工作区”是用户显式触发的后续受控操作。
- 原生会话恢复仅作为可选上下文优化；等待、崩溃和修订在宿主中始终创建新 AgentRun。

这些限制是 MVP 的能力边界，不是最终产品上限。

## 2. 目标与非目标

### 2.1 本方案交付目标

- 从普通会话生成、预览并可信确认 Mission。
- 主进程原子创建 Mission 与首个 AgentRun。
- 在私有 snapshot workspace 中启动、监控和停止 Agent 执行环境。
- 持久化事件、权威 RunSnapshot、非权威 ProgressNote 和累计资源使用。
- 使用 generation fencing 拒绝旧 Run 的晚到结果。
- 支持取消 drain、决策停放、应用重启扫描和工作成果级崩溃恢复。
- 从固定基线与最终 workspace 文件树导入不可变 Candidate，执行固定验证合同和独立 Review。
- 所有 required criterion 闭合后原子发布 MissionDeliverable，并向原会话投递结果。
- 提供任务列表、详情、决策处理、取消和历史 Run 查看能力。

### 2.2 明确不做

- 不把 Mission 拆成宿主持久化 Task、Stage 或 DAG。
- 不持久化后端内部计划、子 Agent 或委派关系。
- 不实现分布式调度、跨设备恢复和运行中的自动后端切换。
- 不依赖某个 Agent 的自定义工具、周期性回调或结构化 handoff 才能保证正确性。
- 不做运行期精确磁盘配额；只做可观察占用的软阈值停止。
- 不在首版支持脏 Git 工作树、非 Git 软件开发仓库或自动三方合并。
- 不在首版实现旁路 LLM 进展摘要器；只消费 adapter 可识别的 Agent 原生输出，缺失时仅展示运行事实。

## 3. 现状复用与差距

### 3.1 可直接复用

| 现有能力 | 位置 | 复用方式 |
|---|---|---|
| SQLite WAL、事务与迁移 | `electron/database/` | 新增 v3 migration 和 Mission repositories；关键状态写入使用 `runInTransaction` |
| 会话与 workDir profile 绑定 | `electron/workDirManager.ts` | Prepare 时解析来源会话的 profile，随后固化 realpath identity，不在 Run 中动态跟随 active profile |
| 路径规范化基础 | `electron/pathSecurity.ts`、`electron/artifacts/pathIdentity.ts` | 提取/扩展为 Mission workspace、导入和 apply 共用的路径校验 |
| 子进程启动基础 | `electron/spawnUtil.ts` | 复用参数化 spawn；另增能证明后代释放的 `ProcessTreeController`，不能直接把当前 `killProcessTree` 当作准入完成 |
| Artifact 路径租约和恢复经验 | `electron/artifacts/` | 复用事务、幂等、staging、恢复测试方法；不复用其可变路径实体作为 revision |
| 主进程 IPC 注册模式 | `electron/appIpc.ts`、`electron/preload.ts`、`src/shared/api.ts` | 新增窄 Mission API，所有 actor/session/surface 从 sender 和主进程状态派生 |
| 会话消息与置顶 | `electron/database/operations.ts` | 结果投递创建 system/assistant 消息并更新 Session `updated_at` |
| Activity Bar 与 Redux | `src/renderer/App.tsx`、`src/renderer/store/` | 新增独立 Mission pane 和轻量列表投影，不把事件全文塞入 Redux |
| 内置 Skill 机制 | `electron/skills/bundled/`、`electron/skills/skillScanner.ts` | 将 `background-mission-intake` 作为 bundled skill 注册 |

### 3.2 必须新增或修正

- AgentBackend registry、当前 Codex adapter、沙箱 profile 和原生事件适配。
- POSIX 进程组 / Windows 进程树的统一取消与释放证明。
- Run 私有 snapshot workspace 生命周期、稳定点扫描和恢复 bundle。
- Mission 专用 SQLite 状态与条件更新。
- 带全 publisher 容量 reservation 的内容寻址 blob/revision、CodeChangeSet、Candidate 和 Review 数据。
- 可表达 npm 内部相对 symlink 的 dependency manifest、链接图校验和安全物化器。
- 后台事件写入器、快照投影器和 Renderer 重放 API。
- 任务列表、详情、确认、决策、人工验收 UI。

## 4. 总体架构

```text
Renderer
  ├─ MissionConfirmDialog     可信预览与确认
  ├─ MissionListPane          轻量任务列表
  └─ MissionDetailPane        快照、时间线、决策、交付物
             │ typed IPC
             ▼
Electron Main Process
  ┌──────────────── MissionApplicationService ────────────────┐
  │ prepare / confirm / cancel / resume / manual accept       │
  └───────────────┬──────────────────────────┬────────────────┘
                  ▼                          ▼
        MissionRepository            MissionSupervisor
         SQLite transactions          scheduler + recovery scan
                  │                          │
                  │                    AgentRunWrapper
                  │             ┌────────────┼──────────────┐
                  │             ▼            ▼              ▼
                  │      RunWorkspaceManager AgentBackend BackendEventAdapter
                  │                          │
                  │                   CodexMcpBackend (MVP 候选)
                  │                          │
                  ▼                          ▼
          Revision/Candidate Store    RunEventWriter + SnapshotProjector
                  │
                  ├─ ValidationCoordinator ── HostValidatorExecutor
                  ├─ ReviewCoordinator ── Reviewer AgentRun
                  └─ CandidateAcceptanceService
```

控制面全部位于主进程。Renderer 只发出用户操作和读取投影，不能持有权威运行状态。`MissionSupervisor` 是唯一运行协调器，但不解释任务语义；它只按数据库事实推进生命周期。

### 4.1 依赖方向

```text
shared contracts
      ▲
repositories ← application services ← supervisor/coordinators ← adapters
      ▲                                      ▲
   SQLite                         filesystem / git / Agent runtime
```

- Repository 不依赖 Electron、Renderer 或任何具体 Agent。
- AgentBackend adapter 不直接改 Mission 表，只向 Wrapper 输出规范化事件和执行结果。
- Renderer 不能调用内部的 create/start/accept 方法。
- Candidate 接受、generation 提升和终态发布只能经 application service 的事务方法完成。

## 5. 目录与模块设计

建议新增以下目录；按阶段创建文件，不预先生成空抽象：

```text
src/shared/backgroundMission/
  types.ts                    领域 DTO、状态、ExecutionToken
  api.ts                      Renderer 可见请求/响应与事件类型
  schemas.ts                  MissionDraft、handoff、review result 的 Zod schema
  stateMachine.ts             纯函数状态转换与允许操作
  completion.ts               criterion/evidence 闭合判定纯函数

electron/backgroundMission/
  missionIpc.ts               IPC sender 校验和 API 注册
  missionApplicationService.ts
  repositories.ts             SQL 访问；首版集中一处，规模增长后再拆
  missionSupervisor.ts        队列、并发槽、启动扫描
  agent/
    agentBackend.ts            最小后端接口、能力和规范化事件
    agentBackendRegistry.ts    后端注册、选择和可用性查询
    agentRunWrapper.ts         与后端无关的一次 Run try/finally 生命周期
    containmentManager.ts      gated launch、持久化身份和崩溃重识别
    processTreeController.ts   已验证 containment 的停止与资源释放证明
  backends/codex/
    codexMcpBackend.ts         stdio MCP 启动、tools/call 和结果归一化
    codexAppServerBackend.ts   仅在深度事件控制确有必要时实现
    codexCapabilityProbe.ts    安装、版本、配置和沙箱准入探测
    codexProtocolProfile.ts    具体版本 schema 与事件归一化
  workspace/
    runWorkspaceManager.ts    创建、封存、删除私有 snapshot workspace
    workspaceObserver.ts      稳定点、文件树 diff、hash、占用统计
    dependencyLayer.ts        Node 依赖 SourceCapturePlan、链接图验证与物化
  events/
    runEventWriter.ts         有界队列、批量落库、flush
    snapshotProjector.ts      权威 RunSnapshot 投影
  recovery/
    drainService.ts
    recoveryService.ts
  delivery/
    revisionStore.ts          容量 reservation、NO_REPLACE blob 发布与 typed revision
    candidateImporter.ts
    validationCoordinator.ts   持久化 attempt 的领取、取消与恢复
    hostValidatorExecutor.ts   通过通用 containment 执行固定命令
    reviewCoordinator.ts
    candidateAcceptanceService.ts
    codeChangeSetApplyService.ts
    missionNotificationService.ts

electron/skills/bundled/
  backgroundMissionIntakeSkill.ts

src/renderer/components/BackgroundMission/
  MissionConfirmDialog.tsx
  MissionListPane.tsx
  MissionDetailPane.tsx
  MissionDecisionCard.tsx
  MissionDeliverables.tsx

src/renderer/store/
  missionSlice.ts             列表、选中项和通知；不保存完整事件流
```

`repositories.ts` 首版集中管理 SQL 是有意选择：Mission 表虽多，但访问模式高度事务化。只有文件显著膨胀或不同模块产生真实独立生命周期时再拆 repository，避免为每张表建立一层样板。`AgentBackend` 也只是编译期接口和主进程 registry，不是可从第三方目录动态加载代码的插件系统。

## 6. 共享领域模型与状态约束

需求文档中的 `MissionDraft`、`Mission`、`AgentRun`、`RunSnapshot`、`ProgressNote`、`CandidateSubmission`、`ReviewAssignment` 等定义作为领域基线，实际代码统一放入 `src/shared/backgroundMission/types.ts`。本节只补充实现所需约束。

### 6.1 AgentRun 后端身份

需求文档中 `AgentRun.backend: 'codex'` 调整为不可变后端快照：

```ts
interface AgentRunBackendSnapshot {
  backendId: string                 // MVP: 'codex-local'
  integrationMode: 'mcp' | 'app_server'
  adapterVersion: string
  runtimeVersion: string
  capabilityProfileVersion: string
  capabilities: AgentBackendCapabilities
  nativeSessionId?: string          // 仅用于可选上下文恢复
}
```

Prepare 将 `backendId + integrationMode + adapterVersion + allowedRuntimeVersionRange + capabilityProfileVersion` 作为后端约束纳入 `draftHash`，并在预览中展示当时探测到的 runtime 版本；每个 Run 再固化实际 binary/schema/runtime identity。运行前若新版本仍落在已确认范围且产生完全相同的 verified capability profile，可以继续；否则进入 `paused(agent_backend_changed)` 并要求重新预览。确认后若已选后端或 integration mode 不可用，不得暗中切换；未来 fallback 必须重新生成预览，明确展示执行者、协议能力、权限差异和预算后再确认。

### 6.2 标识和时间

- 所有业务 id 使用 `crypto.randomUUID()`，不从 Agent 输出中读取。
- 数据库时间统一保存 Unix epoch 毫秒，由主进程生成。
- `eventId` 由适配器生成单 Run 单调序号，例如 `${runId}:${sequence}`；原生事件 id 仅作为 payload 字段保留。
- JSON 字段都带顶层 `schemaVersion`；读取时用 Zod 校验并只支持明确版本。

### 6.3 状态写入规则

不建设通用状态机框架，只为具有独立生命周期的实体提供小型纯函数：

```ts
assertMissionTransition(from, to, reason): void
assertRunTransition(from, to, reason): void
assertValidationAttemptTransition(from, to, reason): void
assertContainmentTransition(from, to, reason): void
assertApplyOperationTransition(from, to, reason): void
```

Repository 的所有状态更新必须同时满足：

```sql
WHERE id = :id
  AND generation = :generation
  AND status IN (...expectedStatuses)
```

影响行数不是 1 即返回 `stale_execution` 或 `invalid_transition`，调用方不得重试成无条件更新。

### 6.4 ExecutionToken

```ts
type ExecutionToken =
  | Readonly<{
      ownerKind: 'agent_run'
      ownerId: string
      missionId: string
      runId: string
      generation: number
    }>
  | Readonly<{
      ownerKind: 'validation_attempt'
      ownerId: string
      missionId: string
      attemptId: string
      candidateId: string
      generation: number
    }>
  | Readonly<{
      ownerKind: 'apply_operation'
      ownerId: string
      operationId: string
      missionId: string
      candidateId: string
      codeChangeSetRevisionId: string
      repoIdentity: string
      generation: number
      journalVersion: number
    }>
```

Token 只在 owner executor 内存和宿主调用链中传递，不写入 Agent/Validator 输入。apply token 从已持久化 operation 行派生，不接受 Renderer 提供 repo/journal identity。以下入口必须验证 token：

- 启动进程、绑定 execution environment；
- 把事件投影为当前 snapshot；
- 创建/封存 RecoveryBundle；
- Candidate、validation 和 Review 导入；
- Candidate 接受与 Mission 终态；
- CodeChangeSet apply；
- live decision 回复。

旧 Run 的事件仍可写入 `run_events`，但标记 `superseded=1`，且不进入当前 snapshot。

## 7. 持久化设计

### 7.1 迁移方式

- 将 `DB_SCHEMA_VERSION` 从 2 提升为 3。
- 新增 `BACKGROUND_MISSION_V3_SQL`，由 `runMigrations` 在单个事务执行。
- 迁移只新增表和索引，不修改现有 Session、Message 和 Artifact 行，便于关闭功能后回滚应用逻辑。
- 所有外键开启；Mission 审计数据默认不级联删除。删除来源 Session 时保留 Mission，通过 `origin_session_id` 的逻辑引用处理，不加 `ON DELETE CASCADE`。

### 7.2 MVP 表集合

为避免把每个 JSON 子结构都拆表，首版使用 28 张表。不可变或需要唯一约束的身份字段独立成列，展示型快照保存在版本化 JSON 中。containment、validation attempt、mission usage ledger、physical blob/logical revision、revision store quota/operation、environment binding/reference graph、apply journal 和 notification outbox 都承担独立的崩溃恢复、引用完整性、类型安全或幂等职责，不是为查询便利做的提前拆分。

| 表 | 关键列 | 说明 |
|---|---|---|
| `prepared_missions` | id, hashes, actor/session/surface, normalized_draft_json, status, expires_at | 一次性预览快照 |
| `mission_confirmations` | prepared_id, idempotency_key, hashes, mission_id | 唯一约束 `(actor_id, idempotency_key)` |
| `missions` | id, origin_session_id, status, status_reason, generation, active_run_id, brief/scope/budget/result_json | Mission 权威记录；`paused` 等细分原因单独存列 |
| `agent_runs` | id, mission_id, generation, attempt_no, role_json, backend snapshot, native_session_id, status, mission_environment_id, environment_descriptor_hash, workspace id, usage_json | 唯一约束 `(mission_id, generation, attempt_no, role_kind)` |
| `run_events` | run_id, event_id, sequence, kind, payload_json, superseded, created_at | 唯一 `(run_id,event_id)`，索引 `(run_id,sequence)` |
| `run_snapshots` | run_id PK, mission_id, generation, snapshot_json, updated_at | 每 Run 一行覆盖投影 |
| `run_progress_notes` | id, run_id, generation, sequence, source, note_json | 唯一 `(run_id,sequence)` |
| `resource_drain_operations` | id, mission_id, owner_kind, owner_id, generation, type, status, timeout_at, error_code | AgentRun 或 ValidationAttempt 的资源释放屏障 |
| `execution_containments` | id, owner_kind, owner_id, platform, launch_nonce, root_pid, process_birth_identity, binary_identity, containment_identity_json, status, persisted_at, released_at | 唯一 `(owner_kind,owner_id)`；可跨主进程崩溃重识别，不以裸 PID 作为身份 |
| `mission_decisions` | id, origin_run_id/generation, kind, status, context_json, deadlines | 决策和 resolution 同行保存；不额外拆表 |
| `run_workspace_snapshots` | id, run_id, sequence, workspace_identity, manifest_json, observed_bytes | 稳定点事实 |
| `mission_execution_environments` | id, prepared_mission_id, mission_id, environment_identity, descriptor_revision_id, lockfile_revision_id, dependency_manifest_revision_id, descriptor_hash, status, retained_until | CHECK prepared/mission 恰有一个；确认事务把 preview binding 转移给 Mission，索引 environment identity 供 revision 复用 |
| `dependency_layer_entries` | manifest_revision_id, relative_path, entry_kind, blob_id, link_target, mode, byte_size | `regular_file | symlink | directory` 的完整树；普通依赖文件直接引用物理 blob，唯一 `(manifest_revision_id,relative_path)` |
| `recovery_bundles` | id, run_id, generation, status, entries_json, refs_json | 文件条目保持一个不可变 JSON 清单 |
| `content_blobs` | id, sha256, byte_size, storage_key, file_identity_json, accounted_operation_id, created_at | 只表达物理内容；`sha256` 唯一，quota 只对 blob 计费 |
| `content_revisions` | id, blob_id, revision_hash, media_type, schema_version, created_at | 逻辑类型 envelope；唯一 `(blob_id,media_type,schema_version)` 和 `revision_hash`，多个类型可引用同一 blob |
| `revision_store_quota` | singleton id, config_version, max/accounted/reserved counters, unattributed_accounted counters, updated_at | revision store 全 publisher 共用的 file_count/logical/physical 权威容量计数与系统硬上限快照；unattributed 是 accounted 子集 |
| `revision_store_operations` | id, publisher_kind, publisher_owner_id, idempotency_key, status, ticket_identity, reserved/observed/charged counters, progress_json, timestamps | Prepare、Candidate、environment、recovery 等发布操作共用的持久化 reservation；唯一 `(publisher_kind,publisher_owner_id,idempotency_key)` |
| `candidate_submissions` | id, producer token, workspace_identity, status, deliverables/evidence/assessment_json | 幂等唯一 `(mission_id,producer_run_id,producer_generation,workspace_identity)` |
| `validation_attempts` | id, mission/candidate, validator identity, generation, status, workspace_identity, mission_environment_id, usage_ledger_id, timeout_at, started_at, resources_released_at, finished_at, error_code | 每次 command validation 的持久化执行生命周期；唯一 attempt 自己拥有 containment/drain 和预算账本项 |
| `mission_usage_ledger` | id, mission_id, owner_kind, owner_id, generation, status, usage_schema_version, reservation_json, observed_json, settlement_json, process_released_at, workspace_released_at, release_proof_json, usage_sequence, settled_at | AgentRun、Reviewer Run、ValidationAttempt 共用的强类型预算事实；唯一约束 `(mission_id, owner_kind, owner_id)` |
| `validation_records` | id, validation_attempt_id, candidate_id, validator identity, evidence_key, workspace_identity, mission_environment_id, result_json | 只保存 completed attempt 的不可变结果；`validation_attempt_id` 唯一 |
| `review_assignments` | id, candidate_id, target_revision/hash, assignment_json, status | 冻结 Review 输入 |
| `reviews` | id, assignment_id, reviewer_run_id, target identity, verdict, result_json | `assignment_id` 唯一；失败尝试在 AgentRun/事件中审计 |
| `mission_deliverables` | id, mission_id, candidate_id, key, kind, revision_id, producer identity | 唯一 `(mission_id,key)`，只在接受事务发布 |
| `manual_acceptance_records` | id, candidate/criterion/evidence/target identity, actor, decision | 唯一 `(candidate_id,criterion_id,evidence_key,actor_id)` |
| `code_change_set_apply_operations` | id, mission/candidate/revision, repo/base/pre_apply identity, generation, status, journal_version, journal_revision_id, quarantine_identity_json, cursor_index, progress_json, error_code, timestamps | 正式工作树 apply 的持久化 journal；同一 repo 同时只允许一个非终态 operation |
| `mission_notifications` | id, mission_id, notification_kind, state_version, origin_session_id, payload_json, status, message_id, attempts, timestamps | 事务 outbox；唯一 `(mission_id,notification_kind,state_version)` |

上述 environment 表和业务表的所有 `*_revision_id` 都是指向 `content_revisions(id)` 的真实外键并使用删除限制；每个 revision 的 `blob_id` 再以删除限制指向 `content_blobs(id)`。`dependency_layer_entries.blob_id` 对 regular file 直接指向 `content_blobs`，避免为成千上万依赖文件制造没有额外语义的逻辑 revision；manifest/descriptor/CodeChangeSet/普通交付文件仍使用 typed revision。`agent_runs`、`validation_attempts`、`validation_records` 的 `mission_environment_id` 同样是删除限制外键。entry CHECK 保证：普通文件必须且只能引用 blob；symlink 必须且只能保存规范相对 target；directory 不引用 blob/target。非根目录全部显式保存，空目录和目录 mode 因而可重建。这些约束用于防止业务记录悬空；MVP 不以“未被外键引用”为依据物理删除任何已发布 revision/blob。

`mission_usage_ledger` 另有 CHECK/Repository 双重约束：`status='settled'` 必须同时存在 settlement、process/workspace release timestamp 和对应 proof；任一 release timestamp 必须与同 kind proof 同时写入；非 settled 行不得带 settlement。JSON 的 v1 严格校验仍在 Repository 执行，SQLite CHECK 不尝试解析完整业务 schema。

不再增加 candidate deliverable、evidence、CodeChangeSet header/entry 和 decision resolution 表：

- `missions.budget_usage_json` 是带 schema version、按固定 sum/max/active-only 代数从 `mission_usage_ledger` 同事务更新的汇总缓存；预算预留、实际消耗、资源释放和结算事实不能只存在于 run event 或某类 owner 的 usage JSON 中。
- CodeChangeSet 是 expected type 为 `application/vnd.spaceassistant.code-change-set+json`、expected schema version 固定的 typed revision；消费方不能只按数据库中的 MIME 自我判定类型，其文件内容引用普通 file-bytes revision。
- Candidate 的 deliverable/evidence 列表是不可变 JSON；可查询字段（candidate id、revision id、target hash）仍独立成列。
- Decision resolution 与 Decision 一对一，保存在同行列中即可。

如果后续出现跨 Mission 全文查询、单条 evidence 独立生命周期或海量条目性能问题，再做规范化迁移；MVP 不提前为这些假设付出复杂度。

### 7.3 条件事务

必须提供以下具名事务，禁止在协调器中散落多表写入：

```ts
confirmPreparedMission(input): Mission
invalidateMissionExecutions(input): ResourceDrainOperation[]
markDrainCompleted(input): void
parkRunAfterDrain(input): void
createRecoveryRun(input): AgentRun
createCandidateSubmission(input): CandidateSubmission
createValidationAttempts(input): ValidationAttempt[]
claimValidationAttempt(input): ValidationAttempt
interruptValidationAttempt(input): ResourceDrainOperation
reserveExecutionBudget(input): MissionUsageLedgerEntry
recordExecutionUsage(input): void
releaseExecutionGauge(input): void
settleExecutionBudget(input): void
reserveRevisionStoreCapacity(input): RevisionStoreOperation
registerFinalizedBlob(input): ContentBlob
getOrCreateTypedRevision(input): ContentRevision
publishRevisionStoreOperation(input): void
settleRevisionStoreOperation(input): void
recordValidation(input): ValidationRecord
recordReview(input): Review
acceptCandidateSubmission(input): Mission
createApplyOperation(input): CodeChangeSetApplyOperation
advanceApplyOperation(input): void
finalizeApplyOperation(input): void
enqueueMissionNotification(input): MissionNotification
deliverMissionNotification(input): void
```

其中 `confirmPreparedMission` 在同一事务校验预览、消费幂等键、创建 Mission/Run，并把 execution environment binding 从 PreparedMission 转移到 Mission；`invalidateMissionExecutions` 同时失效活跃 AgentRun 和 ValidationAttempt，并为每个持有资源的 owner 创建 drain。四个 budget 事务统一服务 Executor、Reviewer 和 ValidationAttempt，账本与 Mission 汇总缓存同事务更新。revision store 事务统一服务所有 publisher；reservation 与 quota singleton 使用 `BEGIN IMMEDIATE` 条件更新，业务协调器不能自行读取“剩余空间”后直接写 blob。`registerFinalizedBlob` 只有文件系统 NO_REPLACE winner 或其精确崩溃恢复可以调用，并以 `content_blobs.sha256` 唯一行作为“该 blob 已计费”的线性化点；`getOrCreateTypedRevision` 只创建逻辑 envelope，不增加 blob quota。`recordValidation` 只接受 generation 当前、attempt 处于 `submitting`、预算已结算且 containment/workspace 已释放的结果，并在同一事务写 ValidationRecord 和 `attempt → completed`。`acceptCandidateSubmission` 在同一事务重验 generation、Candidate identity、所有 required criterion、Review/manual evidence，随后发布 deliverable、完成 Mission，并插入对应 outbox。apply 事务只推进已持久化 journal 的单一步骤或终态，不能用一笔长 SQLite 事务包住文件系统写入。

### 7.4 revision store

存储根位于应用 `userData/background-missions/revisions/`，不在任何 Agent 可写目录中：

```text
revisions/
  blobs/sha256/ab/abcdef...
  staging/<operation-id>/...
```

revision store 的容量上限是应用签名配置，不接受 MissionDraft、Agent 或 Renderer 放大。至少包含：store-wide file count、logical bytes、accounted physical bytes、单次 Prepare file/logical/new-physical bytes、其他单次 publication 上限、最大并发 publication，以及必须保留给宿主的 `minFreeDiskBytes`。发布版本在 Phase 0 代表性仓库测量后固化具体值和 `configVersion`；运行时只能进一步收窄。`physical bytes` 按 revision store 文件系统的 allocation block 向上取整，并为 store 内目录、ticket 和 journal 元数据使用固定保守开销，不能只求和文件 length；SQLite 自身增长由宿主磁盘安全余量覆盖。

store-wide logical/file counters 只对唯一 finalized blob 计一次，另加无法归属 orphan 的保守 charge；`accounted = attributed content_blobs + unattributed conservative charge`，后者不能伪造成某个 typed revision。单 operation logical/file 上限始终按本次完整输入计算，不能因去重放大单次 Prepare。physical counter 记录 store 根实际新增 allocation 的保守上界。三类 counter 任一不足都拒绝整个 publication。

所有 Prepare dependency layer、Candidate import、RecoveryBundle 和其他 revision publisher 都只能调用 `RevisionStoreCoordinator`，状态固定为：

```text
reserved → writing → publishing → settled
     └──────────────→ abandoned_charged
无法判定新增占用 ──→ abandoned_charged
```

发布协议：

1. publisher 先做不写 revision store 的稳定扫描，形成不可变 `SourceCapturePlan`：可信 source root handle/identity，以及每个 entry 的规范路径、kind、source identity、mode、size/hash 或 link target。该扫描计算 file/logical/worst-case physical bytes；最坏值按所有输入均形成新 blob、最大同时 staging 和固定元数据开销计算，去重不能用于降低预留。内存生成的 manifest 等输入直接固定 bytes/hash，不伪装成文件路径。超过单 operation 硬上限立即失败。
2. `reserveRevisionStoreCapacity` 预先生成随机 ticket identity，并在应用内 store mutex 和 SQLite `BEGIN IMMEDIATE` 下检查 `revision_store_quota`：`accounted + reserved + requested` 不得超过三类 store-wide 上限；同时读取宿主文件系统可用空间，要求扣除本次及已有 reservation 后仍不少于 `minFreeDiskBytes`。事务将 ticket identity 写入幂等 operation、增加 reserved counters 后才允许创建 ticket。外部进程仍可能抢占磁盘，因此每次扩展 staging 前再次检查安全余量，失败就停止写入，但绝不超出应用自身 reservation。
3. 在 `staging/<operation-id>/ticket.json` 以 `O_EXCL` 写入与 operation 完全相同的 ticket identity、publisher identity、reservation counters 和 `reserved` 状态，`fsync` 文件及目录后才进入 `writing`。首次创建 staging、`blobs/sha256` 或 hash 分片目录时，由根向叶逐级创建，每创建一级立即 `fsync` 其父目录。
4. 每次捕获普通源文件都从仍保持打开且 identity 未漂移的 source root handle 开始，逐级 no-follow 打开祖先并核对 plan 中的 directory identity；leaf 打开后先以 `fstat` 核对普通文件类型/source identity/mode/size，再流式写 staging 并重算 hash/size，结束前后再次 `fstat`。两次读取结果必须与首次 plan 完全一致，不能用新结果重写 tree hash。directory/symlink 在开始捕获相关子树前和最终 publication 前分别以 handle-relative `fstatat/readlinkat` 复核 kind/identity/mode/target。任一漂移放弃整个 operation；已写 staging 只按本协议清理/计费。只长期持有一个 root handle，不以持有每个文件句柄闭合窗口。
5. staging 文件 `fsync` 后，先把 `publish_intent(hash, staging identity, expected target path)` 写入 operation/ticket 并持久化，再调用平台 verified 的 **NO_REPLACE** primitive。POSIX 首选同文件系统 `linkat(staging, blobPath)`：成功者 flush blob parent 后删除 staging link 并 flush staging parent；也可使用已验证的 `renameat2(RENAME_NOREPLACE)`/`renamex_np(RENAME_EXCL)`。Windows 使用语义等价的 native no-replace move/link。禁止 check-then-rename 和普通覆盖 rename；平台缺少原语时整个 revision publication capability 不准入。
6. NO_REPLACE winner 重新打开 target，校验 hash/size/file identity 后立即调用 `registerFinalizedBlob`。该 `BEGIN IMMEDIATE` 事务以 `content_blobs.sha256` 唯一插入为线性化点，同时把这一 blob 的 file/logical/allocated bytes 从本 operation reserved 原子转入 store accounted，并记录 `accounted_operation_id`；同 operation 重放只返回同一行，不重复计费。当前 intent 注册完成并持久化后才能处理下一 blob，因此崩溃时至多有一个“文件已发布、DB 未登记”的精确 intent。若数据库已存在同 hash 行但 identity/size/storage key 不匹配，视为 `revision_store_corrupted`，绝不覆盖“修复”。
7. NO_REPLACE loser 只能重新打开 target 并校验 hash/size。随后有界等待 winner 的 `content_blobs` 行达到 accounted；在 winner 文件已落盘但数据库尚未登记的窗口保持 `waiting_for_blob_registration` 和自己的 staging/reservation，不发布业务引用。超时后由 coordinator 定位匹配的 active publish intent；winner 崩溃时，启动恢复只依据已持久化 intent、staging/target identity 精确完成 `registerFinalizedBlob`。无法证明 winner 时停止 publication、保守计费并报告 store corruption，不无限等待。loser 看到已 accounted 的同 hash blob 后才删除自己的 staging、flush 并释放对应 reservation，记录 `deduplicated`。
8. 所有 blob 均存在已 accounted 的 `content_blobs` 行后进入 `publishing`。业务发布事务按调用方固定的 media type/schema allowlist 调用 `getOrCreateTypedRevision`，用 domain-separated canonical envelope `revisionHash = H(blob.sha256, mediaType, schemaVersion)` 幂等创建逻辑 revision，再发布业务 FK 并完成 operation。新增同 blob 的 revision 只产生受限 SQLite 元数据，不增加 blob file/logical/physical quota。事务成功后把 ticket 标记 `published` 并持久化；DB 提交后、ticket 更新前崩溃时以数据库状态为准。
9. DB 业务发布回滚、进程崩溃或 ticket/progress 不完整时，不猜测退款。已经有 `content_blobs` 行的 winner bytes 已逐 blob 计费；能证明 staging 已删除时释放剩余 reservation，否则 `settleRevisionStoreOperation` 将无法解释的 reservation 全额转为 unattributed accounted 并标记 `abandoned_charged`。`progress_json` 只保存当前 intent、计数和滚动摘要，保持有界。
10. MVP 不删除 `revisions/blobs/` 下任何已发布或孤儿 blob，也不删除任何 `content_blobs/content_revisions` 行。启动扫描只清理 operation/ticket 明确拥有且确认未发布的 staging；清理成功并 flush 后才可释放对应 reservation。数据库、operation 或 ticket 状态不可验证时不删除、不退款。

`revision_store_quota` 是权威计数，磁盘遍历只用于启动审计，不能在正常路径中用“扫描后写入”代替 reservation。审计发现实际 allocated bytes 大于 accounted 时立即把差额保守计入并暂停新 publication；小于 accounted 时不自动下调。容量不足返回 `revision_store_quota_exceeded`，同时提供 sanitized 的 store 上限、已计费、已预留、本次请求和安全余量，不暴露内容路径。

首次初始化 quota 或迁移已有 store 时，必须在禁止 publication 的维护模式扫描整个 store 并把无法归属的内容全额计入；扫描失败则 revision store 保持不可写。启动恢复遇到 `reserved` 但 ticket/staging 均不存在时，只有验证 operation identity 从未进入 `writing` 后才释放 reservation；ticket 存在、identity 不符或任一目录不可读时一律保守计费。系统配置收窄到低于既有 accounted usage 时保留历史内容并拒绝所有新 publication，不通过修改计数伪造空间。

故障恢复把“blob 已持久化但数据库未引用”视为已计费保留孤儿或根据精确 publish intent 补登记；“`content_blobs` 已引用但文件无法重新打开/校验”视为 P0 存储损坏并停止所有 revision publication，不用空内容或重新生成内容静默修复。已发布 blob GC 只有未来引入带 claim/version、quarantine、容量减记和持久化 journal 的独立设计后才能开启。

Agent 输入、handoff 和 Renderer API 永远不暴露 `storage_key` 真实路径。

### 7.5 typed revision 合同

物理去重与逻辑类型严格分层：`content_blobs.sha256` 只回答“字节是否相同”，`content_revisions` 回答“这些字节以什么宿主语义和 schema 消费”。MVP media type/schema 是代码内 allowlist，至少区分 CodeChangeSet、dependency manifest、ExecutionEnvironmentDescriptor、普通 file bytes、结构化 evidence 和普通 artifact；Agent/Renderer 不能提交任意 media type，也不能修改已有 revision 类型。

每个业务入口在读取前必须由调用合同提供 `expectedMediaType + expectedSchemaVersion`，随后：

1. 条件查询 revision，要求 media type/schema 精确匹配，不根据行中已有值反向选择解析器。
2. 解析关联 `content_blobs`，重新打开 storage key 并校验 blob id、sha256、byte size 和文件 identity。
3. 结构化类型使用对应严格 schema 解析，拒绝未知关键字段，并校验 manifest 内部声明的 content hash、目标 revision expected type/schema 及业务 identity。
4. 普通 file-bytes revision 不执行 JSON/MIME 嗅探；即使字节恰好等于 CodeChangeSet，也只能作为普通文件消费。

同一 blob 可以按不同发布顺序并发创建多个 typed revision；唯一 `(blob_id,media_type,schema_version)` 使同类型重放幂等，不同类型互不阻断。逻辑 revision 不增加 blob quota，但受固定 allowlist、业务幂等键和数据库大小安全余量限制，不能借此创建无界自定义类型。

## 8. Mission Intake、Prepare 与确认

### 8.1 Intake Skill

新增 bundled `background-mission-intake` Skill，并在 `getBundledSkills()` 注册。Skill 只描述以下流程：

- 判断是否适合后台执行；
- 使用当前会话已有工具做只读上下文获取；
- 只询问会改变目标、范围、授权、成本或交付的问题；
- 从一份 MissionDraft 同时渲染 brief；
- 只调用 `prepare_mission`。

`prepare_mission` 是普通会话 Agent 唯一可见的新 builtin tool。`confirm/create/start/accept/apply` 不进入 builtin tool definitions。

### 8.2 Prepare 服务

```ts
prepareMission(
  untrustedDraft: unknown,
  trustedContext: { actorId; sessionId; surfaceId; webContentsId }
): PreparedMissionPreview
```

处理顺序：

1. Zod 严格解析并拒绝未知关键字段、blocking unresolved issue 和空 required deliverable。
2. 在任何 revision publication 前，以系统可信配置检查 actor 的未确认 PreparedMission 数量和滚动时间窗创建频率；MVP 默认同时最多 3 个未过期 preview、每小时最多 10 次新 environment publication。只有 trusted context、规范化草案和环境输入 fingerprint 全部相同的幂等重放才返回现有 preview；相同 environment 但不同 Mission 仍创建独立 preview binding，只是不重复发布依赖内容。超限返回 `prepare_rate_limited`。
3. 从 Session 解析 workDir profile；获取 realpath、设备/文件标识、Git root、`HEAD` 和 clean 状态。
4. 软件开发类 Mission 若非 Git 或工作树不干净，返回可操作错误，不自动 stash/commit。
5. 由 `AgentBackendRegistry` 按已配置选择策略查询可用后端；MVP 只选择 `codex-local`。探测失败即返回具体错误，不下载、不登录、不索取 API Key。
6. 固化 backend id、adapter、允许的 runtime 版本范围和 verified capability profile，并展示当前实际 runtime 版本；无合格 profile 时拒绝后台启动。
7. 按系统上限收窄 capability/budget，不接受草案中的 actor、路径身份和安全配置。
8. 软件开发 Mission 解析并验证 §11.6 环境，先由只读稳定扫描计算 content-based `environmentIdentity`。若相同 profile/runtime/lockfile/dependency tree/policy 的已发布 environment 存在，则只创建新的 preview binding；否则必须先通过 §7.4 的 per-Prepare/store-wide reservation 再发布 descriptor/dependency revisions。依赖层、额度、工具链或离线运行条件任一不满足都在 Prepare fail closed。
9. 校验每个 required criterion 只有一个确定性 binding；command validator 只允许已登记的固定 executable/argv/env policy。
10. 规范化 ReviewPolicy、interactionMode 和 output contract。
11. 使用 canonical JSON（稳定 key 顺序、UTF-8、无 `undefined`）计算 `draftHash` 与 `executionScopeHash`。
12. 写入 PreparedMission 并返回从 `normalizedDraft` 生成的预览。

预览中的“请求值”和“最终生效值”不同则明确显示收窄原因，并展示 dependency environment 是复用还是新发布、输入 file/logical bytes、实际 reservation 和 store 剩余硬额度。软件开发 Mission 还固定展示：“MVP 自动 apply 只支持基线中父目录已存在的文件；新目录变更仍可作为 CodeChangeSet 交付，但需导出 patch 或手工应用。”PreparedMission 默认 30 分钟过期；这是配置，不写入状态机常量。

### 8.3 可信确认 IPC

Renderer 仅提交：

```ts
missionConfirm({ preparedMissionId, expectedHash, idempotencyKey })
```

`missionIpc.ts` 根据 `event.sender.id` 查找当前窗口/会话绑定，派生 actor 和 surface；不接受 Renderer 传 actor/session/surface。确认前重算 workDir identity、Git `HEAD`、clean 状态、安全 profile 版本和 scope hash。任一变化返回 `preview_stale`，要求重新 Prepare。

桌面首版的可信来源定义为：主进程首次启动生成并持久化的 `localInstallationActorId`，加当前 `webContents.id` 形成 desktop surface。Prepare 记录来源 Session；确认时主进程校验该 PreparedMission 正由同一 surface 打开的专用确认窗口展示，Renderer 不能通过 payload 改写来源 Session。未来接入 IM actor 时新增 surface adapter，不复用 Agent 文本中的用户标识。

成功后 `MissionSupervisor.wake()`，但 Mission/Run 已在事务中创建；即使唤醒失败，启动扫描仍会处理 queued Run。确认和实际启动之间后端变得不可用时，Run 以 `agent_backend_unavailable` 结束，Mission 进入 `paused(agent_backend_unavailable)` 并展示诊断；用户修复本地安装/配置后可显式重试，但不得切换后端或自动反复启动。

## 9. 调度与 AgentRun 生命周期

### 9.1 MissionSupervisor

Supervisor 是主进程单例，职责仅有：

- 查询可运行的 queued/recovering/reviewer AgentRun 和 queued ValidationAttempt；
- 按配置的全局并发上限领取一个持久化 execution owner；
- 启动一个与具体后端无关的 `AgentRunWrapper`；
- 接收完成、异常和 drain 信号；
- 应用启动时扫描非终态 AgentRun、ValidationAttempt 和 resource drain。

不引入持久化队列产品。SQLite 中 `agent_runs.status='queued'` 与 `validation_attempts.status='queued'` 就是两类队列，领取通过事务条件更新 `queued → starting`，可避免应用内重复启动。MVP 单实例锁已存在，因此无需分布式 lease。

全局默认并发为 1，验证稳定后可配置为 2；Reviewer、Executor 与 Host Validator 共用槽位和 containment 计数，避免绕过资源上限。

### 9.2 Wrapper 固定流程

```ts
async function executeRun(token: ExecutionToken): Promise<void> {
  let budget: MissionUsageLedgerEntry | undefined
  let environment: RunEnvironment | undefined
  let containment: ExecutionContainment | undefined
  let handle: AgentRunHandle | undefined
  try {
    assertTokenCurrent(token)
    budget = await reserveExecutionBudget(token)
    environment = await runWorkspaceManager.createOrRestore(token)
    await renderReadOnlyInputs(token, environment)
    containment = await containmentManager.allocateAndPersist(token)
    const backend = agentBackendRegistry.requireForRun(token)
    handle = await backend.startRun(buildAgentRunRequest(token, environment, containment))
    await markRunning(token, environment.identity, containment.identity)
    await consumeBackendEvents(token, handle.events)
    await handle.waitForCompletion()
    await markSubmitting(token)
    const processProof = await drainService.releaseContainmentAfterNaturalExit(token, handle)
    await releaseExecutionGauge(token, 'process', processProof)
    if (await isExecutorRun(token)) {
      const candidate = await candidateImporter.importCandidate(token, environment)
      await validationCoordinator.createAttempts(token, candidate)
    } else {
      await reviewCoordinator.importResult(token, environment)
    }
    const workspaceProof = await runWorkspaceManager.release(token, environment)
    await releaseExecutionGauge(token, 'workspace', workspaceProof)
    await settleExecutionBudget(token, 'completed')
  } catch (error) {
    await handleRunFailureOrCrash(token, environment, error)
  } finally {
    await eventWriter.flush(token.runId, FLUSH_TIMEOUT)
    await ensureResourcesReleased(token, environment, containment, handle)
    await persistAnyVerifiedGaugeReleaseAndSettle(token, budget)
  }
}
```

Agent 报告 Turn/任务结束不等于 Run 完成。AgentRun 在自身 containment 释放并完成 Candidate 导入后可以结束，但 Mission 仍保持 `validating`；每个 Host Validator 由独立持久化 ValidationAttempt 承担。只有 Agent/Validator containment 全部释放、Candidate 验证和可能的 Review/人工确认结束后 Mission 才能完成。

### 9.3 启动输入

每个 Run 的协议文件由宿主生成：

```text
.space-assistant/
  input/mission.json
  input/mission.md
  input/resume-context.json       # 仅恢复/停放续跑
  input/review-assignment.json    # 仅 reviewer
  output/handoff.json             # executor best effort
  output/review-result.json       # reviewer best effort
```

`input` 由后端沙箱策略设为只读；仅靠 chmod 不作为安全边界。`.space-assistant` 全目录从 Candidate 扫描中排除。启动 prompt 只说明读取输入、在私有 workspace 工作和输出约定，不内嵌完整数据副本，避免 prompt 与文件漂移。

## 10. AgentBackend、Codex 接入与进程控制

### 10.1 最小后端契约

核心执行层只依赖以下接口：

```ts
interface AgentBackend {
  readonly backendId: string
  probe(): Promise<AgentBackendProbeResult>
  startRun(request: AgentRunRequest): Promise<AgentRunHandle>
  resumeContext?(request: AgentResumeRequest): Promise<AgentNativeContextRef>
}

interface AgentRunHandle {
  readonly backendSnapshot: AgentRunBackendSnapshot
  readonly events: AsyncIterable<AgentBackendEvent>
  readonly nativeSessionId?: string
  waitForCompletion(): Promise<AgentBackendCompletion>
  interrupt(reason: 'cancel' | 'timeout' | 'park' | 'shutdown'): Promise<void>
  release(): Promise<AgentResourceReleaseResult>
}
```

`AgentBackendEvent` 只包含宿主可消费的规范事件：`status`、`text_delta`、`tool`、`file_change`、`approval_request`、`user_input_request`、`usage`、`warning` 和 `native_unknown`。后端不支持的粒度可以缺失，Wrapper 仍从进程和 workspace 观察生成最低限度的 `status` 事实。每条事件保留 opaque native payload 引用用于诊断，但 Mission 逻辑不读取 Codex 专有字段。

后端必须声明 `AgentBackendCapabilities`，至少包括工作目录、沙箱、受限只读根、网络控制、原生事件、结构化输出、用户输入请求、会话上下文恢复、usage 计量、interrupt 和进程树释放等级。只有标记 `verified` 的能力能进入正确性路径。

Registry 首版是代码内静态注册：

```ts
new AgentBackendRegistry([
  new CodexMcpBackend(...)
])
```

未来 SubAgent 客户端或其他 Agent 实现相同接口并通过同一准入套件即可注册。不得让 backend adapter 绕过 RunWorkspaceManager、ExecutionToken、CandidateImporter 或 AcceptanceService。

### 10.2 Codex MCP adapter（MVP 优先候选）

Phase 0 优先验证用户机器上的 `codex mcp-server`。SpaceAssistant 主进程作为确定性 MCP Client，为每个 AgentRun 启动独立 stdio MCP 进程并直接发起 `tools/call`；`codex` 工具不注册给前台会话 Agent，因此 Mission 创建、授权、预算和启动时机仍由宿主控制。

MVP 只依赖当前公开的粗粒度工具面：

- `codex`：传入 Mission prompt、私有 `cwd`、`sandbox`、非交互 approval policy 和宿主生成的受控 config，返回 `threadId` 与最终文本；
- `codex-reply`：只在新 AgentRun 需要携带已确认上下文且兼容性测试通过时使用；它不表示恢复旧进程、工具调用或 execution token。

执行原则：

- 仅从用户显式配置的 executable path 或受控 PATH 查找 `codex`，不搜索任意磁盘位置；找不到时返回 `agent_backend_not_installed`，不下载或安装。
- 先执行 `codex --version`、只读 `codex login status`，再启动 `codex mcp-server`，完成 MCP `initialize/initialized` 和 `tools/list`；只接受经版本 profile 验证的工具名和 schema。
- SpaceAssistant 不执行登录流程，不读取、持久化或设置 API Key；认证状态只归一化为 configured/unconfigured，stdout/stderr 和错误在落库前清洗 credential、环境变量值及账号信息。
- 每个 Run 独占一个 MCP Server 进程，避免强制取消一个 Run 时影响其他 Run；不在 MVP 引入共享 MCP 连接池。
- Host 直接调用 `codex`，传入固定 snapshot cwd 和收窄后的 sandbox/config；MCP 参数中的任意 config 不接受 Agent 或 Renderer 透传。
- MCP tool result、最终文本和 `threadId` 只用于摘要、上下文续接及诊断；Mission 完成仍以进程释放、最终文件树和宿主验证为准。
- 取消先发送标准 MCP cancellation（仅在实测 verified 后视为优雅中断），随后始终由 `ProcessTreeController` 确认或强制终止该 Run 的整个进程组。
- MCP 未提供细粒度工具、usage 或文本流事件时，相关 capability 标为 unavailable/unknown，UI 只展示进程与 workspace 观察事实，不伪造事件。

为确保安装归用户管理，MVP 不引入会携带或自动下载 Codex runtime 的 SDK 依赖。Codex MCP profile 按 `binary realpath + binary hash + runtime version + OS/arch + adapter version + MCP protocol version + tools schema hash` 缓存；任一项变化都重新 probe。

### 10.3 App Server 增强路径与协议选择

官方定位上，[Codex MCP Server](https://learn.chatgpt.com/docs/mcp-server) 面向把 Codex 作为专家接入多 Agent 工作流，[Codex App Server](https://developers.openai.com/codex/app-server/) 面向需要认证、会话历史、审批和流式 Agent 事件的深度产品集成。SpaceAssistant 的认知角色属于前者、执行控制面兼有后者需求，因此以硬能力验证而不是“是否多 Agent”的标签决定协议。

App Server 不再是预先确定的 MVP 前提。只有 Phase 0 证明下列必需能力无法由 MCP + 宿主边界可靠实现时，才实现并选择 `CodexAppServerBackend`：

- 无法可靠取消 MCP tool call 并释放全部后代进程；
- 非交互审批不能 fail closed，或 cwd/sandbox/network 配置不能被强制约束；
- 无法稳定区分完成、失败、取消和协议断开；
- 产品确认必须依赖实时 turn/item/approval/usage 事件，而不能接受降级后的宿主观察；
- 必须在同一活动 Run 内精确 interrupt/resume，而不是停放后创建新 Run。

App Server 可使用 `thread/start`、`turn/start`、`turn/interrupt` 和流式通知提供更深控制，但其 Codex 专有协议和版本 schema 成本更高。协议选择在 Prepare 前完成并写入 `AgentRunBackendSnapshot.integrationMode: 'mcp' | 'app_server'`；同一 Mission 已确认后不得因运行失败静默切换协议实现。

### 10.4 可用性与选择策略

```ts
type AgentBackendProbeResult =
  | { available: true; snapshot: AgentRunBackendSnapshot }
  | {
      available: false
      code:
        | 'not_installed'
        | 'not_configured'
        | 'unsupported_version'
        | 'protocol_incompatible'
        | 'sandbox_unverified'
        | 'launch_failed'
      userMessage: string
      diagnosticRef?: string
    }
```

MVP 的产品后端选择只有 `codex-local`；其内部 integration mode 由 Phase 0 结论和 verified capability profile 确定，优先 MCP。Prepare 和启动均不可用时直接报错。未来加入 SubAgent 后，后端选择发生在 Prepare 之前，确认 UI 显示实际 backend；不得在用户确认后因 Codex 失败自动换用权限、模型或计费语义不同的后端。

### 10.5 硬准入测试

测试夹具至少覆盖：

- snapshot workspace 内创建、修改、删除成功；外部读写、`..`、绝对路径失败；
- snapshot 内的 index、objects、local refs 可写，但源仓库 `.git`、对象库、refs 和工作树不可写；
- `git add/commit/reset/branch/switch` 等本地操作不得影响源仓库，Git 网络访问失败；
- symlink/hardlink 逃逸失败；
- 环境变量只暴露允许集合，Secrets 不继承；
- 网络默认不可达；
- 子进程和后端内部子 Agent 继承相同边界；
- 取消后根进程、后代进程和句柄全部释放；
- 超时、进程数超限能由宿主/沙箱停止；
- 原生事件乱序、截断、未知 schema 不影响退出检测和文件扫描；
- MCP tools schema 漂移、阻塞调用、标准取消无效、server 异常退出和错误输出清洗；
- MCP 粒度不足时只降级 UI 可观测性，不影响 snapshot 导入、取消和完成判定；
- 旧 generation 不能导入 Candidate 或发布结果。

准入按 backend/runtime/platform 独立。某组合未通过就拒绝创建并显示具体可操作错误，不能降级为只设置 cwd。

### 10.6 通用执行 containment

- 任何会启动子进程的持久化 owner——`AgentRun` 或 `ValidationAttempt`——启动前先生成不可猜测 `launchNonce`，在宿主管理目录持久化并 `fsync` launch ticket，再启动宿主自有的 gated launcher。launcher 只能记录 root PID、进程 birth identity、binary identity、平台 containment identity 和 nonce 后等待，不得在放行前启动 Agent 或 Validator command。
- 主进程交叉校验 ticket 与实际进程，将身份写入 `execution_containments(status='gated',ownerKind,ownerId)` 并提交后，才向 launcher 发送一次性放行信号；随后更新为 `active`。因此“进程已创建但 DB 身份未持久化”的崩溃窗口最多留下不执行 payload 的 launcher，启动扫描可从 ticket 发现并终止。
- POSIX containment adapter 至少提供独立 process group/平台容器、成员枚举、进程 start time/birth identity、可验证 owner marker 和安全 signal。重启后必须对 containment membership、birth、binary 和 nonce 交叉验证；只拿到 PID/PGID 或无法验证成员时禁止发信号并进入 `containment_identity_unverifiable`，该平台不能通过无人值守准入。
- Windows 必须使用带 kill-on-close 语义且经崩溃测试验证的 Job Object 或等价 OS containment。若 Electron 主进程崩溃后不能证明成员已被内核终止，或不能以持久化 identity 安全确认残留成员，则 Windows 不准入；`taskkill /T` 只能作为已验证目标的停止动作，不能作为身份或归属证明。
- 取消先请求 owner executor 优雅停止，再对已验证 containment 发送终止；宽限期后强制停止并重新枚举。只有确认 containment 无成员、launcher/ticket 已封存、所有句柄和临时资源释放后，才能写 `execution_containments.released_at`，再写对应 AgentRun 或 ValidationAttempt 的资源释放事实。
- adapter completion、stdout/stderr 读取结束和根进程 `close` 只证明协议/根进程状态，不等价于 `resourcesReleasedAt`。
- Browser、路径租约、验证 workspace 和临时缓存由 owner environment 统一登记，释放完成后一次性写资源释放时间。

## 11. 私有 snapshot workspace 与观察

### 11.1 创建

软件开发 Mission 确认时冻结：

```ts
baseIdentity = sha256(repoRealpath + '\0' + headCommit)
```

启动时再次确认正式仓库仍存在且 `HEAD` 未变化。代码类私有 workspace 位于 `userData/background-missions/workspaces/<runId>`，实现为仅含固定 `baseIdentity` 的独立浅 Git 仓库：

- 独立持有 `.git`、index、objects 和 local refs，不使用 `git worktree`、hardlink、alternates、`--shared` 或指向源仓库的 gitfile；
- 仅复制固定基线提交需要的 tree/blob，不复制完整历史；创建完成后核对 commit/tree identity，不一致即删除未启用目录并失败；
- 不配置 remote，不初始化或递归处理 submodule；首版遇到 submodule、Git LFS 或 required clean/smudge filter 时在 Prepare 阶段明确拒绝，待独立兼容设计；
- snapshot 创建 Git 进程使用宿主提供的受控 system/global config 和环境，不继承用户仓库配置中的 hook、credential、签名、pager、editor、外部 diff/merge driver 或网络代理；
- 创建过程只读取源仓库，Agent 进程仅在 snapshot 完成并通过隔离校验后启动。

具体浅复制命令和 Windows/POSIX 配置隔离参数在 Phase 0 使用 fixture 固化，正确性依赖上述后置条件而不是某个 Git 命令的成功退出。当前仓库规模下 snapshot 只复制基线对象；不因性能提前引入共享对象库。大型仓库实测出现瓶颈后，再单独评估只读基线缓存和文件系统 copy-on-write，不进入 MVP。

Run 不复用上一 Run 的可写 snapshot。崩溃恢复时，先封存旧 workspace，再从固定 base 创建新 snapshot 并由宿主恢复已选定的 revision；这样不会让新旧进程并发写同一路径。

### 11.2 Git 写权限边界

Agent 对 snapshot 目录拥有本地写权限，包括工作文件、index、objects 和 local refs。允许其按自身工作流执行 `git add`、`commit`、`reset`、`restore`、创建分支等操作；MVP 不维护容易遗漏的 Git 子命令白名单。

权限边界由执行环境保证，而不是由提示词保证：

- 源仓库工作树和 `.git` 不在 writable roots，且不向 Agent 暴露可写路径别名；
- snapshot 没有 remote，沙箱网络关闭，`fetch/pull/push/clone` 等不能产生外部效果；
- hooks 指向宿主管理的空目录，禁用 credential helper、commit/tag signing、外部 diff/merge、pager、editor 和 fsmonitor 等外部程序入口；
- Agent 可以破坏本 Run 的 index、refs 或对象库；这只会使本 Run 导入失败或进入恢复，不得影响源仓库；
- 宿主后续不执行或信任 Agent 写入的 remote、hook 或仓库配置。

Agent commit 仅作为可选检查点，不是交付协议。CandidateImporter 始终比较固定基线 manifest 与最终文件系统；不能只使用 `base..HEAD`，因为 Agent 可能未 commit、commit 后继续修改、reset 或改写 refs。

### 11.3 非代码任务工作目录

文档处理、离线调研等非代码 Mission 使用 `userData/background-missions/workspaces/<runId>` 私有目录：

- Prepare 把明确输入文件固化为 content revision，并将 revision identity 纳入 hash；不在 Run 中直接读取之后可能变化的原路径。
- 启动时由宿主将输入 revision 投影到只读 `inputs/`，Agent 只写 `workspace/` 和 handoff output。
- Candidate Importer 只扫描 `workspace/` 中与 output contract 可映射的文件。
- 非代码 Mission 不提供 CodeChangeSet，也不执行 apply；正式结果仍通过同一 revision store 发布。
- 首版不支持“读取整个非 Git 目录后任意修改”的 Mission，这类请求应迁移到 Git 或缩小为明确输入/输出文件。

### 11.4 路径规则

- 所有条目必须是相对 repo root 的规范路径，不允许空段、`.`、`..`、绝对路径或 NUL。
- 扫描时对祖先链 `lstat`；symlink 不跟随，hardlink 数量/文件身份异常标记为不安全。
- 拒绝 `.git`、`.space-assistant/input`、revision store 和宿主 staging 根。
- 导入时重新打开文件并核对 scan 前后的 stat/hash；变化则本次快照无效并重试，超过次数进入 waiting。

### 11.5 稳定点和占用

`WorkspaceObserver` 使用单一串行扫描器，不接入每次文件写入：

- 默认每 5 秒采集 workspace 可观察字节数和 Git 状态；
- 原生命令结束、进程自然退出和取消前额外触发扫描；
- 同一文件在连续两个扫描中 size、mtime、hash 一致，且没有已知相关命令仍运行，才标记 `committed`；
- 最近一次扫描后变化、活跃命令相关文件或无法读取的文件标记 `uncertain`；
- 与已固化 revision 不同且来源无法解释标记 `drifted`。

5 秒只是默认配置。UI 必须同时展示采样时间和“非精确配额”。首次观察超过 `softMaxObservedWorkspaceBytes` 后立即触发取消，不声称阻止了采样间隔内的超额。

### 11.6 离线依赖与工具链合同

独立 snapshot 不读取源仓库的未跟踪依赖，也不在 Run 中联网安装。每个代码 Mission 在 Prepare 固化不可变 `ExecutionEnvironmentDescriptor`：

```ts
interface ExecutionEnvironmentDescriptor {
  profileId: 'node-lockfile-offline-v1' // MVP 唯一实现
  os: string
  arch: string
  runtime: Array<{ realpath: string; version: string; sha256: string }>
  packageManager: { name: 'npm'; version: string; realpath: string; sha256: string }
  lockfileRevisionId: string
  dependencyManifestRevisionId: string
  nativeAbi?: string
  materializedPaths: string[]
  environmentPolicyId: string
  environmentIdentity: string
  descriptorHash: string
}

type DependencyLayerEntry =
  | { path: string; kind: 'regular_file'; blobId: string; byteSize: number; mode: number | 'not_applicable' }
  | { path: string; kind: 'symlink'; linkTarget: string }
  | { path: string; kind: 'directory'; mode: number | 'not_applicable' }

interface DependencyLayerManifest {
  schemaVersion: 1
  rootMode: number | 'not_applicable'
  entries: DependencyLayerEntry[]
  treeHash: string
}
```

MVP 只实现 SpaceAssistant 当前所需的 npm lockfile profile；pnpm、Yarn、Python、Rust、容器镜像和任意系统 SDK 在没有对应 verified profile 时拒绝 required command validator，不建立通用环境编排层。

Node profile 的物化协议：

1. Prepare 校验 `package-lock.json` revision、Node/npm 可执行文件 realpath/version/hash、OS/arch/ABI，以及源工作区现有 `node_modules` 的 npm 元数据和完整树 manifest。扫描从已打开的 layer root handle 逐级 no-follow：为每个 directory/regular file/symlink 保存 source identity；普通文件读取前后核对 identity/size/mode/hash；symlink 使用 `readlinkat` 并在读取前后核对叶子 identity。该 root handle 一直保持到 dependency publication 完成或放弃，只持有这一根句柄而不是数万个 leaf handle。
2. manifest header 保存 root mode，entries 显式保存除根以外的全部 directory、regular file 和 symlink。路径和 link target 使用 `/`、UTF-8 NFC 和平台大小写规则规范化；symlink target 必须是相对路径，拒绝绝对路径、盘符/UNC、NUL 和从链接父目录解析后越出 layer root 的 `..`。构建完整链接图后，要求每个链接最终解析到 manifest 内已有 entry，拒绝 dangling link、循环和超过固定深度的链。POSIX npm 的 `node_modules/.bin/*` 相对 symlink 按原语义保留，不能跟随并转换为普通文件。
3. MVP 对普通文件 `st_nlink > 1` 一律返回 `dependency_hardlink_unsupported`，不保留 hardlink identity，也不由 copy/COW 隐式打散。socket、FIFO、device、junction 和其他 reparse/link 类型同样拒绝；平台无法安全创建 POSIX-style symlink 时该 environment profile 不准入。
4. 宿主通过 §7.4 的统一 reservation 和上述 `SourceCapturePlan` 固化依赖树：每个 regular file 的第二次读取仍从同一个 root handle 逐级 no-follow reopen，并必须逐项匹配首次 source identity/mode/size/hash；仅其内容成为 `content_blobs`。所有普通文件捕获后、发布 manifest 前，再从 root handle 对全部 source entries 做一次 kind/identity/mode/link-target 复核；任一祖先、leaf 或 symlink 漂移都放弃整个 environment publication，绝不以第二次结果重算 tree/environment identity。进程崩溃后不恢复旧 source copy，而是结算旧 operation 并重新稳定扫描。
5. root mode 和三类 entry 都进入 canonical manifest hash，entries 写入 `dependency_layer_entries`，最后以固定 dependency-manifest type/schema 发布 logical revision。`environmentIdentity` 只由 profile、runtime hashes、lockfile content hash、tree hash 和 policy version 计算，不包含 PreparedMission/binding/revision row id；相同身份幂等复用已有 descriptor/manifest/blob revisions，但每个 PreparedMission 仍创建自己的 binding 行。MVP 不执行 `npm install`/`npm ci`、postinstall 或网络下载；用户需先在正式工作区完成依赖准备。
6. 每个 Executor、Reviewer、Validator workspace 从同一 dependency manifest revision 物化独立副本。顺序固定为：按深度以临时 owner-writable mode 创建 directory；以 exclusive/no-follow handle-relative create 写 regular file、设置最终 mode 并校验；用 `symlinkat` 或已验证平台等价原语创建 symlink；最后按深度降序设置 directory 和 root 的最终 mode 并 flush。所有目标 leaf 必须不存在，任何类型冲突都放弃整个可丢弃 workspace，不做覆盖修复。
7. 物化完成后，从目标 root handle 重新扫描整棵树，按相同规则重算 entry kind/path/blob hash/mode/link target 和链接图；只有 tree identity 与 manifest 完全一致才可绑定 containment。三类 execution owner 的物化结果必须得到同一 tree identity。包管理器缓存和测试缓存只写 `.space-assistant/runtime/`。
8. `materializedPaths` 与 `.space-assistant/runtime/` 从 Candidate/RecoveryBundle 扫描中按宿主 descriptor 精确排除，不能由 Agent 增加排除路径。Agent 修改自己的依赖副本只影响当前 Run；Validator 总是重新物化未修改的 canonical layer。
9. Prepare 和 Supervisor claim 是独立的两道服务端 capability gate。Run/Reviewer/Validator 启动前按 §7.5 的 expected descriptor/dependency-manifest media type/schema 读取 typed revisions，重新校验 environment binding 存在且 `published`、descriptor/runtime identity、manifest → entry → blob FK 闭合、平台 materializer profile verified，并完成本次 tree identity 校验；任一缺失、类型错误或漂移返回 `execution_environment_unavailable/changed`，不得退回读取源 `node_modules`、跟随链接复制或联网安装。feature flag 和 Renderer 隐藏状态不能绕过这两道检查。

完整 descriptor 也按固定 type/schema 写为不可变 typed revision。Prepare 在同一事务创建 `mission_execution_environments` preview binding，以独立 FK 列引用 descriptor、lockfile 和 dependency manifest revisions；引用完整性检查不解析 `normalized_draft_json` 或任意 manifest JSON。确认事务把同一 binding 从 `prepared_mission_id` 原子转移到新 `mission_id`，并由随后创建的 AgentRun、ValidationAttempt 和 ValidationRecord 通过 `mission_environment_id` 引用；确认失败整体回滚，不留下 Mission 指向错误环境。

显式关系图为：environment binding → descriptor/lockfile/dependency manifest typed revisions → `dependency_layer_entries`；其中只有 `regular_file` entry 直接引用 `content_blobs`，symlink/directory 的语义由受 CHECK 约束的结构列持有。MVP 用它做发布校验和审计，但按 §7.4 不对任何已发布 blob 执行物理 GC。逻辑保留策略为：

- pending PreparedMission 是临时 binding；过期/放弃事务以同一行条件更新将其标为 `expired/released`，与确认并发线性化。MVP 保留该只读行、environment identity 和 revision FKs 作为复用索引，但它不再授权创建 Mission；不靠删除 binding 表示过期。
- 非终态 Mission、可恢复 AgentRun、Candidate 验证、Review 和非终态 ValidationAttempt 始终保留 environment binding。
- MVP 对已完成 Mission 不释放 environment binding。未来即使增加 Mission 历史删除，也只能先事务化处理业务引用；物理 blob 删除仍需另行设计带 claim/version/quarantine 的 GC 协议。

`environmentIdentity`、`descriptorHash` 和 `missionEnvironmentId` 进入 `draftHash`、backend capability snapshot、每个 AgentRun 和 ValidationRecord。Executor、Reviewer 和 Host validator 必须使用同一 environment binding；若某验证命令需要额外工具，必须在 Prepare 作为 runtime identity 明确登记。

## 12. 事件、Snapshot 与进展摘要

### 12.1 事件写入

主进程使用内存有界 FIFO + SQLite 批量事务，不引入外部消息总线：

- 文本 delta 在入队前按 100 ms 或 4 KiB 合并；
- status、process、decision、workspace、usage、deliverable、review 事件不可合并；
- 批量按 100 条或 200 ms 落库；
- 队列达到上限时先压缩文本 delta；仍无法容纳离散事件则停止 Run，错误为 `event_delivery_overflow`；
- 每个 terminal/cancel/crash 路径都执行限时 flush。

原始 thinking 只按产品现有隐私策略保存；若无明确允许，MVP 不持久化 thinking，只保存普通文本与结构化事实。

### 12.2 Snapshot 投影

`SnapshotProjector` 只接收以下事实源：

- AgentRun、AgentRunHandle 和 ProcessTreeController 状态；
- verified 原生事件；
- WorkspaceSnapshot；
- Decision、Candidate、Validation、Review repository；
- 宿主资源监控。

每次投影在事务内以 token 条件更新 `run_snapshots`。`lastTool` 只有 native profile 声明工具事件为 verified 时才出现。

### 12.3 ProgressNote

需求模型中的 ProgressNote source 调整为 `agent_output | event_summarizer`，并附 `backendId`。首版仅从 adapter 明确、可解析的普通 Agent 输出生成 `source='agent_output'` note。解析失败就不生成，不从自由文本猜测文件已完成或测试已通过。旁路 `event_summarizer` 延后，避免为非正确性能力增加第二套 LLM 调用、预算和失败处理。

Renderer 订阅 `mission:changed` 轻量通知后主动拉取最新 snapshot；文本时间线使用游标分页，不通过全局广播发送整个历史。

## 13. 取消、drain 与应用退出

### 13.1 取消事务

用户调用 `missionCancel({ missionId, expectedGeneration })` 后：

1. 事务锁定 Mission、active AgentRun 和所有非终态 ValidationAttempt。
2. `mission.generation += 1`，Mission 进入 `cancelling`，清空 active token。
3. 旧 Run 和活跃 attempt 进入 `cancelling`，关闭 pending live decision。
4. 为每个仍持有 containment/workspace 的 execution owner 创建 `mission_cancel` resource drain。
5. 事务提交后 Supervisor 按 owner 调用 ProcessTreeController。

每个 owner 的根进程结束、后代清空后先用 containment proof 调用 `releaseExecutionGauge(process)`；验证 workspace/缓存删除后再用对应 proof 调用 `releaseExecutionGauge(workspace)`。事件 flush、租约/句柄释放和 budget settlement 全部完成后 drain 才完成；所有 owner 都满足时 Mission 才标记 `cancelled`。任一 gauge 的释放不修改该 owner 已产生的 wall/attempt 累计量。

超时进入 `paused(cancel_timeout)`，保留后台观察和“重试取消”操作；不允许启动新 Run。

### 13.2 正常应用退出

当前 `runShutdownCleanup()` 必须加入 `missionSupervisor.shutdown()`，顺序为：

1. 停止领取 queued Run 和接受新的 revision publication；
2. 对活跃 AgentRun 和 ValidationAttempt 创建/续写 shutdown drain，并停止全部 containment；
3. 对已证明释放的 process/workspace 分别持久化 gauge release，限时 flush revision operation ticket/progress、事件和数据库，不在退出窗口中猜测清理或退款；
4. 未能完全 drain 的 execution owner 和未结算 revision operation 留在非终态，下一次启动优先恢复。

应用退出不是用户取消 Mission。下次启动完成旧资源确认后，按 crash recovery 规则恢复。

## 14. 崩溃恢复

### 14.1 启动扫描

启动恢复屏障必须先于普通 queued 调度或任何新 revision publication 执行：

1. `RevisionStoreCoordinator` 核对 quota config/version、执行启动审计并恢复所有非终态 revision operation：对唯一 current publish intent 核对 staging/target identity，精确补做目录 flush/`registerFinalizedBlob`，解除 loser 的 `waiting_for_blob_registration`，其余无法证明部分保守结算；未完成时 store 保持不可写。
2. 扫描持久化 launch ticket 和 `execution_containments`，处理 AgentRun/ValidationAttempt 尚未放行的 gated launcher；以 birth/binary/nonce/containment membership 验证身份，禁止按裸 PID/PGID 操作。
3. 恢复所有 `draining/timed_out` operation；对 verified containment 停止并枚举成员，对无法验证身份的记录 fail closed、阻止该平台继续调度并产生 P0 诊断。
4. 扫描非终态 ValidationAttempt；停止 containment、删除验证 workspace/缓存并分别写 budget gauge release proof，再以条件事务标记 `interrupted` 和结算累计 actual。generation 仍当前且累计/当前 gauge 均允许时才创建新 attempt id，否则保持 Mission waiting/paused。
5. 扫描 `starting/running/waiting/parking/submitting/reviewing/cancelling` AgentRun。
6. 无法接管的 Run 原子失效，创建 `crash_recovery` drain。
7. containment 和其他资源全部释放后扫描并封存 RecoveryBundle。
8. 满足自动恢复条件才创建新 generation Run；否则暂停等待用户。
9. 完成未终态 apply operation 的恢复/隔离和 notification outbox 重放后，才领取普通 queued AgentRun 或 ValidationAttempt。

MVP 不尝试跨应用重启接管仍在运行的 Agent 协议连接；发现孤儿执行环境只执行停止与 drain。

### 14.2 RecoveryBundle

Bundle 的 `entries_json` 保存 path、operation、before/after hash、状态和 revision id。`committed` 内容写入 revision store；`uncertain` 也可为审计保存 blob，但新 Run 输入必须明确其不可靠状态。`drifted` 不自动覆盖任何内容。

自动恢复仅在以下条件全部满足时发生：

- 非用户取消、无 P0 安全事件和未知目录外副作用；
- 旧资源已释放，bundle 已 sealed；
- repo realpath 与 base commit 可验证；
- recovery attempts、时间和强制预算仍足够。

新 Run 从固定 base 创建新 snapshot workspace。宿主只恢复 committed revision；uncertain 文件以只读 recovery context 和单独副本提供，由新 Agent 检查后决定是否采用，避免直接把不完整内容当当前工作区事实。

## 15. 决策、停放与恢复

宿主首版不恢复仍在执行的原生 Turn，所以 `liveRunResumableUntil` 等于创建时间，所有 P0/P1 决策直接走停放。Codex adapter 可将 `thread/resume` 标记为 `experimental`，但只能在新 AgentRun 中恢复对话上下文：

1. 校验来自 handoff/native event 的问题 schema；无法形成安全问题则 Run 失败或以诊断信息暂停。
2. 创建 `pending_live` Decision 后立即原子提升 generation、将 Decision 改为 `pending_parked`，创建 `decision_park` drain。
3. drain 成功后 Run 为 `parked`，Mission 保持 `waiting`。
4. 用户回答保存 actor 和 context identity。
5. 普通产品/信息回答创建使用已预留 generation 的新 AgentRun。
6. 即时工具确认标记 expired，新 Run 必须重新读取现场。
7. scope/authorization change 生成新的 PreparedMission scope revision，重新走可信确认。

Decision UI 不直接向任何 Agent stdin/协议连接写入内容。只有某后端的“活动 Turn 输入恢复”能力升级为 verified，才增加宽限期内同 Run 恢复分支；普通 thread/context resume 不满足该条件。

## 16. Candidate、验证与正式交付

### 16.1 Candidate 导入

Executor 自然退出后，Importer 必须先确认 token 有效且资源已释放，然后：

1. 记录最终稳定 workspace identity；若 snapshot Git 元数据已损坏，仍继续尝试宿主文件树扫描。
2. 以宿主保存的固定基线 manifest 与最终文件系统构造文件操作清单，显式包含新增、修改、删除和路径变化；`git status --porcelain=v2 -z` 仅作为诊断和一致性校验，不是权威输入。
3. 对每个普通文件做路径、安全、文件数、单文件和总字节检查。
4. 通过 `RevisionStoreCoordinator` 捕获每个文件 blob，并创建 expected type 为 `application/vnd.spaceassistant.file-bytes`、schema 1 的普通文件 revision；随后生成 CodeChangeSet manifest/`overallHash`，以固定 CodeChangeSet media type/schema 创建另一 typed revision。相同字节的普通文件与 manifest 可共享 blob，但 revision identity 必须不同。
5. schema 校验 handoff，只用其映射 deliverable key 和补充 summary，不相信其路径/hash/evidence 声明。
6. handoff 缺失时，代码 Mission 仍可把完整 diff 确定性映射到唯一的 `code_change_set` deliverable；其他多交付物合同无法唯一映射时进入 `waiting(candidate_mapping_required)`。
7. 事务创建 `CandidateSubmission(status='validating')`。

CodeChangeSet 每个普通文件 entry 同时保存 `beforeMode/afterMode`。POSIX 记录 `stat.mode & 0o777`，拒绝 setuid/setgid/sticky 和非普通文件；Importer 把内容不变但 mode 不同的文件记录为 `mode_change`。Windows 使用显式 `not_applicable`，不得用临时文件默认权限推导结果。mode 与内容 hash 一起进入 entry/overall hash。

任一导入限额失败时不发布 Candidate 或部分 revision 引用。仍在 staging 的内容按 operation ticket 清理；已经原子进入最终 blob 路径但未引用的孤儿在 MVP 保留，不执行物理 GC。

### 16.2 Host validator

只支持 Prepare 时登记的固定定义：

```ts
{
  executable: string
  args: string[]
  cwd: 'candidate_workspace'
  environmentPolicyId: string
  timeoutSeconds: number
  passCondition: 'exit_code_zero'
}
```

CandidateImporter 不直接 spawn validator。它在创建 Candidate 的事务中按 required command binding 插入 `ValidationAttempt(status='queued')`，冻结 candidate/validator/generation/environment identity；Mission 进入 `validating`。`MissionSupervisor` 领取 attempt 后执行：

1. 从固定 base + CodeChangeSet 构造一次性独立验证 workspace，不与源仓库共享 Git 元数据，并从 Mission 固化的 dependency layer 重新物化未修改依赖。
2. 通过 §10.6 gated launcher 创建 `ownerKind='validation_attempt'` containment；containment 身份持久化后才执行固定 executable/argv。
3. timeout、全局并发、进程数和磁盘观察与 AgentRun 使用同一资源控制；输出只保留有界、清洗后的验证事实。
4. 命令退出后将 attempt 标记 `submitting`，再停止并证明 containment 无成员、写 process gauge release，封存输出，删除验证 workspace/缓存并写 workspace gauge release，结算累计 usage；最后以 generation 条件事务把 attempt 标记 `completed` 并写唯一 ValidationRecord。

结果记录 executable/argv、validator version、exit code、workspace identity、`missionEnvironmentId`、descriptor hash 和 target revision ids。Agent 自行运行的测试只进入事件时间线，不生成 required evidence。

Mission cancel、shutdown、generation 提升或 timeout 会把活跃 attempt 转为 `cancelling/interrupted` 并创建 `resource_drain_operations`。只有对应 containment、后代、workspace 和缓存全部释放，attempt 才能进入 `interrupted`，Mission 才能完成取消或创建修订 Run。晚到退出和 ValidationRecord 由 generation fencing 拒绝。

验证失败将 Candidate 标记 `revision_requested`，在全部 validation attempt 已终态且资源释放后创建新 Executor Run并附固定失败记录；不自动无限重试，次数受 Mission budget 和 ReviewPolicy 约束。崩溃恢复产生的 `interrupted` attempt 只有在 generation 仍当前且预算允许时才创建新 attempt id 重试，永不复用旧 workspace/containment。

### 16.3 接受事务

`acceptCandidateSubmission` 逐条计算 required criterion：

- artifact：candidate 中存在对应 key 和不可变 revision，且按 output contract 的 expected media type/schema 通过 §7.5 校验；
- command：存在来源/validator/version/target/workspace 全匹配的 passed record；
- review：存在相同 assignment target/hash 的 pass Review；
- manual：存在允许 actor 对相同 target revision 的 pass record。

接受前还必须确认该 Candidate 没有非终态 ValidationAttempt，所有 validation containment/workspace 已释放；仅 generation fencing 能拒绝结果，不足以证明资源已经停止。

全部通过后同事务：Candidate → accepted、插入 MissionDeliverable、Mission → completed、写 result JSON、清空 activeRunId，并以唯一业务键插入 `mission_notifications(status='pending')`。事务提交后只唤醒 outbox dispatcher；通知失败不回滚 Mission，由启动扫描重放 pending outbox。

## 17. 独立 Review

### 17.1 创建 Assignment

需求模型中的 `ReviewPolicy.reviewer: 'independent_codex' | 'user'` 调整为：

```ts
type ReviewerSelection =
  | { kind: 'independent_agent'; backendConstraint: AgentBackendConstraint }
  | { kind: 'user' }
```

MVP 的 independent agent 仍为 `codex-local`，但 ReviewCoordinator 只依赖 `AgentBackend`。未来允许 Executor 与 Reviewer 使用不同后端时，两者约束都必须在 Prepare 时确定并进入 hash；“独立”仍要求新原生 Session、不共享可写 workspace 和固定 ReviewAssignment，而不是只看厂商名称。

确定性验证通过且 ReviewPolicy 要求 Review 时，`ReviewCoordinator` 冻结：

- Candidate id、target revision id/hash；
- Mission goal、included/excluded scope 和 success criteria；
- Prepare 时的 rubric snapshot；
- validation evidence refs；
- 仓库 `AGENTS.md` 等策略文件的内容 revision，而不是可变路径；
- review output schema。

随后创建 `role.kind='reviewer'` 的新 AgentRun。Reviewer 使用从固定 Candidate 构造的独立只读 workspace；只允许写 `.space-assistant/output` 和可丢弃测试目录。

`on_risk` 首版不调用模型判断。Prepare 固化一个版本化 risk policy：Candidate 包含删除、已配置关键路径、数据库 migration、权限/安全配置，或超过固定文件数/总字节阈值时要求 Review。规则版本和阈值进入 `draftHash`；运行后不能临时降低。

### 17.2 结果导入

Reviewer 退出并释放资源后，宿主读取 `review-result.json`：

- assignment id、target revision/hash 必须精确匹配；
- 所有 required rubric criterion 必须出现且 status 合法；
- `pass` 不能包含 blocking finding，important 数量满足 passPolicy；
- 未知 severity、路径逃逸、非法行号或重复 criterion 均拒绝；
- 缺失/无效文件视为 Review attempt 失败，不读取自然语言结论代替。

`revise` 保留原 Candidate/Review，提升 generation 并创建新 Executor Run；上下文只含固定 Candidate、required changes、验证和仓库当前 identity。达到上限按 policy 等待用户或失败。

Reviewer 崩溃可用同一 Assignment 创建新 Reviewer Run，不需要恢复中间文件。其重试次数和消耗仍计入 Mission 累计预算。

## 18. CodeChangeSet 应用到用户工作树

Mission 完成和应用变更是两个动作。首版默认只发布 CodeChangeSet，用户点击“应用到工作区”后才创建持久化 apply operation。状态固定为：

```text
preparing → ready → applying → committing → applied
                    └→ rolling_back → rolled_back
任一非终态 ───────────────────────→ recovery_required
```

`preparing` 不允许修改正式工作树。创建流程：

1. 校验 Mission/Candidate/revision identity、用户 actor 和 generation，并按 §7.5 以 expected CodeChangeSet media type/schema 读取 target revision、以 expected file-bytes type/schema 读取每个内容 revision；任一类型/hash 不匹配都在工作树零写入时失败。随后获取 repo 级 mutex；数据库唯一约束禁止同一 repo 存在两个非终态 operation。
2. 要求正式仓库 realpath、`HEAD` 与 `baseIdentity` 一致且工作树干净；在临时独立 workspace 完整模拟 apply 并运行最小结构校验。
3. 规范化 CodeChangeSet：rename 在 journal 中表示固定 source 删除 + 固定 target revision 写入；只处理普通文件，拒绝路径逃逸、大小写折叠冲突、目录/文件冲突和跨设备临时路径。MVP 不创建或删除目录；add/rename target 的任一父目录若在固定 base 中不存在，返回 `apply_new_parent_unsupported`，不创建 operation。Mission 确认预览固定展示这一能力限制，apply 预览列出具体不支持路径并允许用户改用导出 patch/手工应用。
4. 通过已验证的 repo root/Git metadata directory handles，在仓库实际 Git metadata 目录下创建操作专属隔离区 `spaceassistant/apply/<operationId>/`，权限为仅当前用户可访问。隔离区必须与工作树处于同一文件系统；创建后持久化并复核 root、Git metadata directory 和 quarantine directory identity。无法满足同文件系统、目录 flush 或安全 handle 解析时，不创建 operation，并在该平台关闭 `applyEnabled`。
5. 对所有受影响 source/target 记录 before identity 和 `beforeMode`；存在的 before 内容先写入 revision store，不存在使用显式 absence marker。after revision 同时携带 `afterMode`。POSIX 只接受普通文件及 `mode & 0o777`，拒绝 setuid/setgid/sticky；Windows 将 mode 明确记为 `not_applicable`。纯权限变化规范化为 `mode_change`，mode 进入 entry hash 和 CodeChangeSet hash。
6. 生成不可变 journal，至少包含 `journalVersion`、operation/repo/root/Git metadata/quarantine identity、每个 entry 的 operation/path、before/after revision/hash/mode、顺序、父目录 identity、隔离文件名和持久化子状态。journal revision、完整 backup refs、上述 identity 和 `cursorIndex=0` 在同一事务持久化并转为 `ready`。只有该事务提交后才能发生第一次正式工作树写入。

确定性 entry 顺序为：删除及 rename source 按路径深度降序/字典序执行，再按路径深度升序/字典序写入 add、modify、`mode_change` 和 rename target。每个 entry 使用以下持久化子状态超集；`add` 跳过 `old_quarantined`，`delete`/rename source 跳过 `after_staged` 和 `after_installed`，其余操作按完整路径推进：

```text
add:                 pending → after_staged ───────────────→ after_installed → entry_committed
modify/mode_change:  pending → after_staged → old_quarantined → after_installed → entry_committed
delete/rename source: pending ──────────────→ old_quarantined ──────────────→ entry_committed
已发生工作树变更的任一状态 ───────────────────────────────────────────────→ rollback_pending
rollback_pending → installed_quarantined → old_restored → rollback_committed
任一无法证明的状态 ─────────────────────────────────────────→ recovery_required
```

`progress_json` 在每次文件系统屏障后记录实际 quarantine 名称、文件 identity、mode 和下一步；状态推进使用 operation id、generation、`journalVersion` 和旧子状态做条件更新。逐 entry 协议为：

1. 在数据库把当前 entry 标记为 executing，并保存期望 before/after identity；此处是允许响应取消的边界。
2. 重新打开并保持 repo root、Git metadata 和 quarantine directory handles，核对其持久化 identity；从 root handle 逐级解析祖先并保持 parent handle。POSIX 每级使用 `openat(...,O_DIRECTORY|O_NOFOLLOW)`、`fstat`，叶子使用 `fstatat(...,AT_SYMLINK_NOFOLLOW)`；任何 symlink、identity 漂移或越出 root 都进入 `recovery_required`，不使用重新解析过的绝对路径。
3. 若 entry 有 after 内容，先在 operation quarantine 中以 exclusive name 创建普通文件，写入固定 revision，设置 `afterMode`，`fsync` 文件并校验 hash/mode，再 flush quarantine directory；持久化 identity 后进入 `after_staged`。目标工作树此时仍未变化。
4. `add` 直接把 staged-after 从 quarantine 原子移动到目标 leaf，必须使用平台已验证的 handle-relative **NO_REPLACE** primitive；目标已存在则移动不发生并返回 `apply_conflict`，绝不覆盖该 leaf。
5. `modify/delete/mode_change` 及 rename source 先把当前目标 leaf 原子移动到 operation quarantine 的 exclusive old-name，同样使用 NO_REPLACE destination。移动完成并 flush 两侧目录后，才对已经隔离的对象校验 before identity/hash/mode：匹配则持久化 `old_quarantined`；不匹配则使用 NO_REPLACE 尝试原路恢复。若恢复时目标已被并发创建，保留隔离对象和新目标，进入 `recovery_required`，不删除其中任何一方。
6. `modify/mode_change` 在目标 leaf 已为空后，把 staged-after 以 NO_REPLACE 原子移动到目标并 flush 两侧目录，校验 after identity/hash/mode 后持久化 `after_installed`；`delete` 在 old 文件隔离并验证后直接满足 after absence。任何 NO_REPLACE 冲突均保留已知文件并进入 `recovery_required`，不使用 direct overwrite rename 或“预检后 unlink”。
7. Windows 必须使用 native helper 持有 repo/ancestor/quarantine handles，以拒绝 reparse point 的方式解析组件，并提供语义等价的 handle-relative NO_REPLACE move、exclusive create 和目录 flush；POSIX adapter 必须提供已验证的 `renameat2(RENAME_NOREPLACE)`、`renamex_np(RENAME_EXCL)` 或等价能力。平台缺少任一所需原语时关闭对应 operation 或整个 `applyEnabled`，不能退化为 check-then-rename。
8. 通过仍持有的 handles 确认 after 状态，事务推进 `cursorIndex/progress_json` 到 `entry_committed`。崩溃后先按 journal 子状态和 quarantine/worktree 中的实际 identity 重建唯一状态；不能唯一判定时进入 `recovery_required`，不重做可能覆盖数据的动作。

所有 entry 完成后进入 `committing`，重新校验完整 after manifest、`HEAD` 仍为 base、目录屏障已完成，最后事务写 `applied`、新 workspace identity 和 audit。`applied` 是唯一成功提交点，不自动 commit/push。

用户取消只在 entry 边界生效：`ready/applying/committing` 收到取消后进入 `rolling_back`，不能把部分状态当取消成功。回滚按 journal 逆序执行：若 after 已安装，先用 NO_REPLACE 将目标 leaf 移入新的 operation quarantine 名称，再对隔离后的对象校验 after；若 identity 不符则按相同规则尝试恢复或保留双方并进入 `recovery_required`。随后将原 old 文件从 quarantine 以 NO_REPLACE 恢复到目标；add 的 before absence 则保持目标为空。rename 保留原 mode；从 revision 重建时必须先恢复 `beforeMode` 再发布。每个移动、校验和目录 flush 后都持久化回滚子状态，全部 before manifest 匹配才写 `rolled_back`。

MVP 不自动删除 operation quarantine 中的 old、staged 或 rollback 文件，包括已成功 apply/rollback 后的文件；它们是恢复材料，不属于 Candidate 内容，也不参与 revision blob GC。任务详情展示占用，后续清理必须由单独的、可证明 operation 已终结且用户确认的协议实现。任何路径出现既非预期 before 也非 after、备份缺失或平台原子移动失败，都进入 `recovery_required`，保留全部 quarantine/revision/journal 并锁定该 repo 的后续 apply。

启动扫描在普通调度和新 apply 前处理非终态 operation：

- `preparing` 因尚未允许正式写入，可校验无变更后标记 `rolled_back`；
- `ready/applying` 默认恢复回滚；`rolling_back` 继续回滚；
- `committing` 且完整 after manifest 已匹配时完成提交，否则回滚；
- 无法证明当前文件属于 before/after/quarantine 中 journal 记录的唯一状态时进入 `recovery_required`，只提供 journal、quarantine identity、before/after revisions 和人工恢复指引，不自动猜测。

每次 apply/恢复入口都由主进程从持久化 operation 派生 `ApplyOperationToken`，包含 `operationId`、Mission/Candidate/CodeChangeSet revision、repo identity、generation 和 `journalVersion`。所有进度条件更新和平台 adapter 调用都校验该 token；Renderer 只提交 operation intent，不能提供或覆盖 repo identity、generation、journal version。

首版不处理 base 漂移和三方合并；发现漂移只提示用户重新执行或自行应用 patch。这比实现一个不可靠的自动 merge 更符合 MVP 边界。

## 19. 资源预算

### 19.1 强制项

- `maxDurationMinutes`：既是 Mission 累计 wall-time 上限，也是每个 execution owner deadline 的上界；AgentRun、Reviewer Run 和 ValidationAttempt 都必须先从同一预算账本预留，owner executor 触发 interrupt，并由 ProcessTreeController 强制停止。
- `maxConcurrentProcesses`：Agent、Reviewer 和 Host Validator containment 统一计数；只有平台准入测试证明可约束后启用，否则该平台不准入。
- Candidate 文件数、单文件和总字节：导入前确定性检查；所有 revision 写入（包括 Prepare）另由 §7.4 store-wide/per-operation reservation 强制约束，CandidateImporter 不维护旁路“剩余额度”。
- `maxRecoveryAttempts`：作为 cumulative attempt 维度在创建恢复 Run/预算 reservation 的同一事务检查，不维护第二个可分叉计数器。
- Mission 全局并发：Supervisor 领取任一 execution owner 前检查。

预算事实统一写入 `mission_usage_ledger`，`owner_kind` 仅允许 `executor_run | reviewer_run | validation_attempt`。一个 owner 只有一个账本项；重放同一 owner 不重复预留或计费，重试必须创建新 owner，因此历史消耗不会被覆盖。核心事务为：

```text
reserved → active → settling → settled
    └──────────────→ settling
无法确认资源释放 ─→ active（继续 drain，不得释放 reservation）
```

`reservation_json` 和 `observed_json` 不是自由 JSON；`usage_schema_version=1` 时必须通过以下共享 schema，未知字段、负值、非安全整数或未知计量等级均拒绝：

```ts
interface MissionUsageReservationV1 {
  schemaVersion: 1
  cumulative: {
    wallDurationMs: number
    attempts: Partial<Record<'executor' | 'reviewer' | 'validation' | 'recovery', number>>
    verifiedTokens?: number
    verifiedToolCalls?: number
  }
  activeGauge: {
    processSlots: number
    containmentSlots: number
    workspaceBytes: number
  }
  ownerLimits: {
    workspaceHighWaterBytes: number
  }
}

interface MissionUsageObservedV1 {
  schemaVersion: 1
  cumulative: {
    wallDurationMs: number
    cpuTimeMs?: number
    attempts: Partial<Record<'executor' | 'reviewer' | 'validation' | 'recovery', number>>
    verifiedTokens?: number
    verifiedToolCalls?: number
  }
  current: { processCount: number; containmentCount: number; workspaceBytes: number }
  highWater: { processPeak: number; workspaceBytes: number }
  metering: {
    wallDuration: 'verified'
    processCount: 'verified'
    containmentCount: 'verified'
    workspaceBytes: 'verified' | 'estimated'
    cpuTime?: 'verified' | 'estimated' | 'unknown'
    tokens?: 'verified' | 'estimated' | 'unknown'
    toolCalls?: 'verified' | 'estimated' | 'unknown'
  }
}

interface MissionUsageSettlementV1 {
  schemaVersion: 1
  cumulativeActual: {
    wallDurationMs: number
    attempts: Partial<Record<'executor' | 'reviewer' | 'validation' | 'recovery', number>>
    verifiedTokens?: number
    verifiedToolCalls?: number
  }
  conservativeDimensions: Array<'wallDurationMs' | 'verifiedTokens' | 'verifiedToolCalls'>
  reason: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'never_started'
}

type ProcessReleaseProofV1 =
  | { containmentId: string; releasedAt: number; containmentIdentityHash: string }
  | { neverLaunched: true; verifiedAt: number }

type WorkspaceReleaseProofV1 =
  | { workspaceId: string; deletedAt: number; workspaceIdentityHash: string }
  | { neverCreated: true; verifiedAt: number }

interface ExecutionGaugeReleaseProofSetV1 {
  schemaVersion: 1
  process?: ProcessReleaseProofV1
  workspace?: WorkspaceReleaseProofV1
}
```

所有缺省 attempt/token/tool counter 在 canonicalization 时归一为 0；`Partial` 只用于传输便利，不允许动态 key。`verifiedTokens/verifiedToolCalls` 只有对应 metering 为 `verified` 时才能进入 reservation/settlement 和 hard limit，estimated/unknown 只作诊断。reservation、observed、settlement 和 release proof 必须使用同一 `usage_schema_version`。

维度分类和唯一聚合代数为：

| 分类 | MVP 维度 | 准入/重建运算 | 释放与结算 |
|---|---|---|---|
| 累计消耗 `cumulative_sum` | wall duration、各类 attempt；verified 时的 token/tool call | `Σ settled actual + Σ non-settled reservation`；历史 actual 永不退款 | 未启动 owner 可结算为 0；已启动按 actual，未知 wall time 按 reservation 保守计费 |
| 当前 gauge `active_only_sum` | process slots、containment slots、workspace bytes | 仅对相应 `*_released_at IS NULL` 的 owner 求 `max(reservation, observed.current)` 之和；terminal 但未 drain 仍计入 | 持久化并验证对应 release proof 后从当前准入占用移除，不修改累计消耗 |
| 单 owner/历史高水位 `historical_max` | process peak、workspace high-water | 每 owner 与自身 limit 比较；Mission 审计值为所有 owner observed high-water 的 `max`，绝不相加 | release 后历史 max 保留，但不占 process/workspace 当前额度 |

对任一 Mission 的 ledger rows `R`，纯 fold 定义为：

```text
CommittedCumulative[d] = Σ r∈R (r.status == settled ? r.settlement.cumulativeActual[d] : r.reservation.cumulative[d])
ObservedCumulative[d]  = Σ r∈R r.observed.cumulative[d]
ActiveProcessSlots     = Σ r∈R, r.process_released_at == null max(r.reservation.activeGauge.processSlots, r.observed.current.processCount)
ActiveContainmentSlots = Σ r∈R, r.process_released_at == null max(r.reservation.activeGauge.containmentSlots, r.observed.current.containmentCount)
ActiveWorkspaceBytes   = Σ r∈R, r.workspace_released_at == null max(r.reservation.activeGauge.workspaceBytes, r.observed.current.workspaceBytes)
HistoricalHighWater[d] = max r∈R r.observed.highWater[d]，空集合为 0
```

`settlement.cumulativeActual[d]` 是 settlement 事务从 observed/保守规则固化的不可变累计值，不包括 current/high-water。准入在上述 cache 上加本次 request 后比较对应 limit；不得把三个表达式的结果彼此相加。

revision store 的永久 file/logical/physical bytes 不进入该账本，只由 §7.4 quota 管理。若未来增加累计 bytes-written，必须新增明确的 `cumulative_sum` 字段和 schema version，不能复用 workspace high-water。

核心事务固定为：

- `reserveExecutionBudget(owner)`：`BEGIN IMMEDIATE` 中校验 Mission generation/状态和 schema。累计维度按 `settled actual + non-settled reservation + request` 检查；process/containment/workspace 分别按当前 active-only cache 加 request 检查；owner workspace limit 单独比较。全部通过才插入 owner reservation 并更新 cache，之后才能创建 gated containment。
- `recordExecutionUsage(owner, usageSequence, observed)`：每个 owner 由宿主分配严格递增序号，只接受 `usageSequence > ledger.usage_sequence`。cumulative observed 只能增加，current gauge 可增可减，high-water 只能取大；active-only cache 对每个 owner 始终取 `max(reservation,current)`。process current 超过 reservation 或 workspace 超过 owner limit 时立即触发停止，不能靠采样回落掩盖；相应 release proof 写入后，只接受该 current gauge 为 0 的最终 flush。attempt 在 gated launch 真正放行时从 0 单调记为对应种类的 1，恢复 Run 可同时记 `executor=1,recovery=1`。该事务不释放 reservation。AgentBackend usage、宿主进程采样和 ValidationAttempt 都走同一入口。
- `releaseExecutionGauge(owner, kind, proof)`：`kind='process'` 只接受已验证 containment 无成员且 launcher 已释放的 proof，写 `process_released_at` 并把 observed process/containment current 归零；`kind='workspace'` 只接受 owner workspace/cache 已删除或从未创建的 proof，写 `workspace_released_at` 并把 workspace current 归零。每种 proof 只生效一次，high-water 不变，并在同一事务按 active-only 代数更新 cache。仅状态 terminal 不构成释放证明。
- `settleExecutionBudget(owner, reason)`：要求 execution 已终止，且 process/workspace gauge 均有 release proof；只结算一次。累计维度以 verified actual 替换 reservation 的相应部分，未用 wall duration 可退款，但已经开始的 attempt 永久计数；崩溃窗口内无法确定的 wall time 按 reservation 结算。high-water 原样保留，gauge 已由 release 事务移除。

owner deadline 只从累计 wall duration 计算：`remaining = maxDuration - settledActual - otherNonSettledReservations`，本 owner deadline 为 `now + min(ownerPolicyDuration, remaining)`。process/workspace 没有“duration remaining”，分别做 active-only admission；不同单位绝不进入同一个 remaining 值。余额不足时 owner 保持未启动并记录 `budget_exceeded`。

多个 required validator 允许串行执行以降低 active gauge，但在 Candidate 进入 validating 前仍需验证其 attempt 数和最坏串行 wall duration 可被累计预算覆盖。generation 提升、cancel、timeout、shutdown 和重启恢复都不删除 reservation。旧 owner 可以在 process/workspace 分别证明释放后让出当前 gauge，但其 wall duration/attempt actual 仍保留；新 generation owner 再走独立预留。

Mission 进入任何完成/取消终态前必须没有未结算 owner，且全部 containment/workspace 已释放。累计值超限时不能成功完成，但允许在记录 `budget_exceeded` 后进入失败或取消终态。

### 19.2 观测或条件强制项

- workspace bytes：周期采样 current/high-water；单 owner 首次观察超过 `ownerLimits.workspaceHighWaterBytes` 后停止。Mission 同时 workspace 准入只合计尚未释放 owner 的 `max(reservation,current)`，不合计历史 high-water。
- Token/tool calls：只有 native profile 标记计量为 verified 才能做硬上限；否则保存 estimated/unknown，不阻止运行也不显示精确剩余额度。

`missions.budget_usage_json` 固定为 `MissionBudgetUsageV1`，分别保存 `committedCumulative(sum)`、`activeGauge(active-only sum)` 和 `historicalHighWater(max)`，另保存实际观测累计值供 UI 展示。所有 ledger mutation 与 cache 在同一 SQLite 事务更新；启动时用同一个纯 fold 函数从 ledger 重建并比较。已知 v1 行可原子修复 cache 并审计，任一 ledger/config schema 未知、计量类型未知却被配置为 hard limit、整数溢出或数据库不可读时暂停领取全部 execution owner。协调器不得各自实现另一套聚合逻辑。

## 20. IPC 与 Renderer

### 20.1 Renderer 可见 API

```ts
agentBackendGetStatus({ backendId?: string })
missionGetPrepared({ id })
missionConfirm({ preparedMissionId, expectedHash, idempotencyKey })
missionList({ cursor?, status? })
missionGetDetail({ missionId })
missionListEvents({ missionId, runId, afterSequence?, limit })
missionCancel({ missionId, expectedGeneration })
missionRetryCancel({ missionId })
missionResolveDecision({ missionId, decisionId, answer })
missionRecordManualAcceptance(...)
missionRetryReview({ missionId, assignmentId })
missionApplyCodeChangeSet({ missionId, candidateId })
missionOnChanged(cb)
```

`prepare_mission` 只注册到主进程 builtin tool executor，并直接调用 `MissionApplicationService.prepareMission`，不经 Renderer API。Renderer 只能读取已经由该工具创建的 PreparedMission 并提交可信确认。

`agentBackendGetStatus` 只返回 backend id、显示名、runtime/adapter 版本、可用状态、稳定错误码和清洗后的修复提示；不返回 executable 之外的敏感配置、认证文件、环境变量或 API Key。当前 Codex 不可用时，确认/Prepare 界面直接显示“请先在系统中安装并完成 Codex 配置”，不提供安装、登录或填写 Key 的入口。

不暴露：`createMission`、`startMission`、任意 status 更新、任意 generation 更新、`acceptCandidate`、revision storage path 或任意 validator command。

所有 mutation payload 使用严格 schema、大小限制和 expected generation/revision。主进程从 sender 派生可信上下文。

### 20.2 UI 状态

`missionSlice` 只保存：

```ts
{
  items: MissionListItem[]
  selectedMissionId: string | null
  unreadMissionIds: string[]
  needsAttentionCount: number
}
```

详情组件按 id 拉取并局部维护分页事件。`mission:changed` 只携带 `{missionId, updatedAt, reason}`，避免高频原生事件触发 Redux 大对象更新。

Activity Bar 新增后台任务入口。详情明确分区：

- “运行事实”：Snapshot、文件变化、资源和采样时间；
- “进展摘要”：带具体 backend 和 `agent_output` 标签；
- “时间线”：游标分页；
- “决策/人工验收”：固定 target hash；
- “交付物与 Review”：不可变 revision 链接；
- “操作”：按状态显示取消、重试取消、回答、重试 Review、应用变更。

不展示总步骤数、完成百分比或内部子 Agent。

### 20.3 原会话投递

完成、失败、取消和需用户处理的权威状态事务必须同时写入 `mission_notifications` outbox，唯一键为 `(mission_id,notification_kind,state_version)`。payload 只包含摘要、证据/交付链接和详情入口，不把 `run_events` 当投递账本。

`MissionNotificationService` 只消费 `status='pending'` 的 outbox：

1. 使用 outbox id 派生稳定 `messageId`。
2. 在同一 SQLite 事务中重新检查 outbox pending；来源 Session 存在时以该稳定 id 插入 Message、更新 Session `updated_at`、写 outbox `delivered/message_id`。任一步失败整笔回滚。
3. Message 主键冲突但业务键匹配时视为已插入并补齐 outbox 状态；冲突内容不匹配则停止并审计。
4. 来源 Session 已删除时，同事务将 outbox 标记 `suppressed(session_missing)`；Mission 仍在任务面板展示，不新建会话。
5. 启动扫描重放 pending outbox；Renderer 的 `mission:changed` 仅是可重复的失效通知，不承担持久投递保证。

## 21. 错误模型、审计与隐私

共享错误码至少包含：

```text
backend_not_verified
agent_backend_not_installed
agent_backend_not_configured
agent_backend_unsupported_version
agent_backend_protocol_incompatible
agent_backend_unavailable
agent_backend_changed
preview_stale
idempotency_conflict
invalid_transition
stale_execution
sandbox_violation
containment_identity_unverifiable
event_delivery_overflow
budget_exceeded
usage_schema_unsupported
usage_cache_inconsistent
execution_environment_unavailable
execution_environment_changed
dependency_link_unsupported
dependency_hardlink_unsupported
validation_interrupted
candidate_import_limit_exceeded
candidate_mapping_required
revision_store_corrupted
revision_store_quota_exceeded
revision_publication_unsupported
revision_type_mismatch
revision_source_drifted
prepare_rate_limited
cancel_timeout
recovery_requires_attention
recovery_exhausted
review_result_invalid
review_failed
workspace_drifted
apply_conflict
apply_new_parent_unsupported
apply_recovery_required
notification_delivery_conflict
```

错误记录分为用户可读 summary 和内部 sanitized detail。环境变量、完整 prompt、Secret、外部绝对路径和可能含敏感信息的 stdout 不进入普通日志。Run events 对大文本设长度上限，超出部分写截断标记，不把日志系统当 Artifact store。

审计至少记录：Prepare/confirm actor，scope/environment hash，revision operation、blob winner/accounting、typed revision media/schema、quota reservation/charge，Run token/containment identity、usage schema/reservation/settlement、process/workspace release proof，取消/重跑原因，Decision actor，Candidate/revision hash，Validator/environment identity，Review target/verdict，manual acceptance/override，apply operation/actor/逐 entry 结果和 notification outbox 结果。

## 22. 测试方案

### 22.1 纯函数与 schema

- MissionDraft 正常化、canonical hash 和未知字段拒绝。
- required criterion/evidence 唯一闭合与错误映射。
- Mission/Run 状态转换矩阵。
- handoff/review result schema、pass/finding 一致性。
- CodeChangeSet manifest hash 和路径规范化。
- DependencyLayerEntry 三类 CHECK、相对 link target 规范化、链接图解析/循环检测和 tree identity。
- revision store file/logical/allocated bytes reservation 算法、block rounding、安全余量和饱和加法。
- content blob hash identity、typed revision hash envelope、media/schema allowlist 和 expected-type consumer 映射。
- MissionUsageReservation/Observed/Settlement/ReleaseProof v1 严格 schema，以及 cumulative sum、active-only sum、historical max 的纯 fold；未知字段/schema、负数和溢出 fail closed。

### 22.2 Repository 与迁移

- v2 → v3 迁移、失败回滚和重复启动幂等。
- Prepare 过期/消费、确认幂等冲突。
- generation 条件更新影响 0 行时拒绝。
- Candidate 接受事务缺任一 evidence 均整体回滚。
- containment gated/active/released 条件转换与 launch nonce 唯一。
- ValidationAttempt 领取、generation 失效、submitting/completed/interrupted 条件转换；只有 containment/workspace 已释放的 submitting attempt 能在同一事务进入 completed 并创建 ValidationRecord。
- PreparedMission environment binding 在确认事务原子转移给 Mission；确认回滚和过期不产生悬空 FK，维护任务不会物理删除任何已发布 blob。
- revision store operation 幂等预留、quota singleton 条件更新、成功 actual 结算和 `abandoned_charged` 保守结算；quota/operation 任一写失败整体回滚。
- `registerFinalizedBlob` 对同 hash/同 operation 重放只计费一次；其他 operation 不能重复 claim winner，`getOrCreateTypedRevision` 对同 blob/type/schema 幂等、不同 type 相互独立。
- apply operation 同 repo 非终态唯一、逐 entry 进度条件更新和终态不可逆。
- mission usage ledger 的 owner 唯一预留、重复 usage sequence 幂等；cumulative 单调增加、current gauge 可升降、high-water 只取 max，settlement 只写一次；ledger 与 Mission cache 任一写失败均整体回滚。
- process/workspace release proof 分别幂等，terminal 但无 proof 不释放 active gauge；settlement 必须同时具备两类 proof，并保留累计 actual/high-water。
- 在 reservation 插入、containment 激活、usage sequence 更新、process/workspace release、`settling` 和 `settled` 前后注入崩溃；重启 fold 只能保守保留未证明 gauge，不能重复累计或错误退款。
- ledger 与 `MissionBudgetUsageV1` cache 对 sum/max/active-only 三类维度逐项一致；已知 v1 cache 可从 ledger 原子重建，未知 ledger/config schema 停止调度。
- Mission 状态与 notification outbox 同事务；同业务键重复写只产生一行。
- notification、event 和 usage 重放不重复。

### 22.3 Snapshot workspace 与 revision

- clean Git repo 创建独立单基线 snapshot；脏 repo Prepare 拒绝。
- snapshot 不包含 hardlink、alternates、shared object store、remote 或源仓库 gitfile；源仓库 `.git` 和工作树在 Agent 运行前后 hash/identity 不变。
- Agent 在 snapshot 内执行 add/commit/reset/branch 后，源仓库不变，最终未提交文件仍可进入 Candidate。
- Agent 改写 refs、删除 index 或损坏 snapshot Git 元数据时，宿主仍按最终文件树导入，无法安全扫描时明确失败。
- hooks、credential helper、签名、外部 diff/merge 和 Git 网络不可用；submodule、LFS、required filter 在 MVP Prepare 阶段拒绝。
- add/modify/delete/rename/untracked 的 manifest 正确。
- symlink/hardlink/路径别名/保留根逃逸拒绝。
- 扫描中变化产生 unstable/uncertain，而不是 revision。
- staging ticket 在创建、写入、NO_REPLACE publish、DB 发布和 ticket 更新各边界崩溃；仅明确未发布的 staging 可清理。
- 在 publish intent、NO_REPLACE、目标目录 `fsync`、最终 reopen、`content_blobs` 注册和业务 DB commit 前后注入崩溃；恢复后只允许“精确补登记/已计费孤儿”或“有效 DB 引用”，不得出现悬空引用或重复计费。
- 新建 hash 分片目录时验证目录链屏障；数据库或 ticket 不可读时 staging 清理数必须为 0。
- 并发发布同 hash、DB 新增引用、PreparedMission 过期/消费以及维护扫描期间，`revisions/blobs/`、`content_blobs` 和 `content_revisions` 物理/行删除数始终为 0；finalized orphan 同样保留。
- 多个 Prepare、Candidate import 和 Recovery publisher 并发申请同一余额时只有满足 store-wide reservation 的操作成功；实际 allocated bytes 加 active reservation 始终不超过应用硬上限，并保留 `minFreeDiskBytes` 检查。
- 在 reservation commit、ticket 创建、每个 staging write/NO_REPLACE publish、DB publication、actual 结算前后崩溃；无法证明的 finalized/orphan 占用全额计费，过期 preview、事务回滚和 feature flag 关闭均不会错误退款。
- 两个及多个 publisher 在 no-replace、目录 flush、winner progress 和 quota 注册各边界并发/崩溃；相同 hash 只有一个 filesystem winner 和一个 `content_blobs` accounting winner，loser 验证后去重，finalized logical/physical usage 永远只增加一次。
- 预先存在但 hash/size/identity 无法验证的目标、DB row 存在但物理文件缺失、平台仅支持覆盖 rename 均 fail closed；不通过覆盖来“修复” store。
- 每个目标 OS/filesystem adapter 分别验证 `linkat`/`RENAME_NOREPLACE`/Windows 等价原语确实在目标存在时失败且不改变双方 identity/content；未通过 profile 时所有 revision publisher 均不可启动。
- 去重命中只释放已验证 loser reservation；不同仓库和持续变化 dependency tree 会消耗新额度，耗尽后在创建 staging 前返回可诊断 `revision_store_quota_exceeded`。
- 同一字节按普通 file、CodeChangeSet、descriptor、dependency manifest 的不同发布顺序及并发创建 typed revisions，blob 只计费一次、各 revision expected type/schema 稳定；恶意普通文件预占 manifest 字节不能阻断或污染后续类型。
- 消费入口以错误 expected type/schema 读取 revision 必须返回 `revision_type_mismatch`，不能因内容看似 JSON 或行中 MIME 改选解析器。
- 相同规范化草案重放不重复 Prepare/environment publication；相同 environment identity 的不同 Mission 复用 immutable descriptor/manifest revisions 和 dependency blobs、各自持有 binding，但未确认 preview 数量和 publication 频率限制仍生效。
- 文件数、单文件、累计大小超限不产生部分 Candidate。

### 22.4 执行环境

- lockfile、Node/npm realpath/version/hash、OS/arch/ABI 或 dependency manifest 任一漂移均使 Prepare fail closed。
- 真实 npm fixture 保留 `node_modules/.bin` 相对 symlink；manifest 明确包含 regular_file/symlink/directory，空目录、可执行 mode、link target 和 tree identity 往返一致。
- 绝对/盘符/UNC/越界 target、dangling link、链接循环/超深链、hardlink、junction/reparse 和特殊文件均 fail closed；安全链接链可确定性物化。
- 扫描 `readlinkat`/regular leaf 前后并发交换 symlink 与普通文件时整次 environment publication 失败；物化使用 exclusive handle-relative create，目标类型冲突不覆盖。
- 首次扫描完成后，在 reservation 前后、每个 source reopen 前后交换祖先 directory、regular leaf 或 symlink；第二次捕获必须匹配首次 source identity/mode/hash，任何漂移整次放弃，repo/layer root 外字节不得进入 staging/blob。
- source 文件在已捕获后、manifest publication 前再次漂移时最终 source pass 拒绝发布；失败过程不得重算 tree/environment identity，残余 staging 按 operation reservation 清理或计费。
- Agent 不能修改 canonical layer；修改 Run 私有副本不影响 Validator。
- Executor、Reviewer、Validator 的 descriptor hash 完全一致并写入结果；缺少额外 system tool 时不启动 command validator。
- 在网络关闭、源 `node_modules` 不可读条件下，使用同一 layer 分别运行 SpaceAssistant 的 `npm test`、`npm run typecheck:renderer` 和 `npm run typecheck:shared` fixture。
- dependency layer publication 中断由 revision operation 保守结算 staging/finalized 占用；workspace 物化中断只留下 owner 可识别的可丢弃 workspace，不执行 npm install/postinstall，不读取或记录 registry credential。
- descriptor、lockfile、manifest 和每个 file blob 任一 FK 缺失均不能发布 environment binding；引用校验不扫描业务 JSON。
- 三类 execution owner 物化后从目标 root 复扫得到相同 tree identity；平台不能安全创建/复核 symlink 时 profile 准入失败，不退化为跟随复制。

### 22.5 AgentBackend 与准入 E2E

- `AgentBackend` contract test 对规范事件、完成、interrupt、release 和错误映射使用 fake backend 验证。
- 当前 `codex-local` 支持的每个 OS/arch 使用用户环境兼容的真实 Codex 版本运行隔离 fixture。
- Codex 未安装、未配置、版本不支持和协议不兼容分别返回稳定错误，不触发安装、登录或 API Key 请求。
- 可用性探测只执行 `codex login status` 和协议握手，不调用 login/logout mutation；状态、stdout/stderr 和日志不包含 email、token 或 credential 内容。
- MCP protocol/tools schema 或 App Server schema hash/版本变化使旧 capability profile 失效并重新 probe。
- gated launcher 创建后、containment DB commit 前强杀主进程，重启能从 ticket 安全识别并停止，且 Agent 从未启动。
- 强杀 Electron 主进程、根进程先退出但孙进程存活、PID/PGID 复用模拟下，不漏杀、不误杀；无法验证身份时不发信号并使平台准入失败。
- Windows Job Object kill-on-close、成员归属与释放证明；没有等价能力的平台组合不准入。
- 根进程、孙进程、内部并行任务取消与超时释放。
- sandbox 外读写、网络和环境变量逃逸失败。
- stdout 截断、未知原生事件、异常退出和 flush timeout。
- 未通过 probe 时 UI/API 均不能启动 Mission。

### 22.6 生命周期集成

- confirm → queued → running → submitting → validating → completed。
- software Mission 缺少/伪造/未发布 environment binding 时，Prepare 与 Supervisor claim 两处分别 fail closed；直接写 queued 数据、Renderer feature flag 或旧版本数据均不能绕过 claim gate，且 gated containment 尚未创建。
- 取消后旧 Run 的 event/Candidate/Review/accept/apply 全部 stale。
- cancel drain 超时保持 paused，不显示 cancelled。
- 决策立即停放，晚到回答创建新 Run 而非恢复旧进程。
- 应用重启优先恢复 drain，再封存 bundle，再创建恢复 Run。
- committed/uncertain/drifted 分类与验证 stale。
- Review pass/revise/无效结果/崩溃重试/耗尽。
- manual evidence 只对固定 Candidate 有效。
- outbox 在“Message 插入后、delivered 更新前”和相反边界注入崩溃；因同一 SQLite 事务，恢复后结果只能是完整投递一次或仍 pending。
- apply 对 add/modify/delete/rename/mode_change 的 `after_staged`、`old_quarantined`、`after_installed`、目录 flush 和进度提交各边界注入崩溃；重启最终只能完整 applied、完整 rolled_back 或保留完整材料的 recovery_required。
- apply 取消只在 entry 边界转入 rollback；未知外部改动不会被自动覆盖，同 repo 新 apply 在旧 operation 非终态时被拒绝。
- ValidationAttempt 运行中 cancel、timeout、shutdown、Electron 强杀和 generation 提升均创建 drain；根进程先退出而孙进程存活时不完成 attempt，恢复后旧 attempt 为 interrupted 且只用新 attempt 重试。
- Validator 退出到 ValidationRecord 提交各边界崩溃时，Mission 不会 completed/cancelled 后遗留 validator 进程或 workspace。
- apply 在祖先解析期间并发交换 symlink/junction，在 leaf move 前并发替换目标；handle-relative adapter 必须保证 repo 外零写入，NO_REPLACE 冲突不得覆盖，已隔离的未知 leaf 必须恢复或与新目标同时保留。
- add 在发布瞬间被并发创建时保持双方内容；modify/delete 在 leaf 隔离后校验出 before 不符时不 unlink；ApplyOperationToken 的 generation、repo identity 或 journalVersion 过期时平台 adapter 零写入。
- executable 文件 modify、纯 `mode_change`、delete/rollback 保留精确 POSIX mode；非法特殊 mode、非普通文件和 Windows mode 误比较被确定性拒绝。
- operation quarantine 与工作树跨设备、缺少平台 NO_REPLACE 原语或目录 flush 时 `applyEnabled=false`；成功和回滚后 quarantine 仍保留且可按 journal identity 审计。
- add/rename target 父目录在 base 不存在时 Prepare 展示能力限制、apply 预览给出具体路径并返回 `apply_new_parent_unsupported`，不隐式 mkdir。
- Executor、Reviewer、多个 required ValidationAttempt 串行/并行预留共享同一 Mission 余额；重试、generation 提升、usage 重放、中断和主进程崩溃均不重置或重复累计，余额不足时 containment 尚未创建。
- 多 validator 失败后 revise、连续 interrupted attempt 及 Reviewer 重试耗尽累计预算后，新的任意 execution owner 都无法从 `queued` 进入 gated launch；乱序/重复 usage sequence 不改变累计值。
- `maxConcurrentProcesses=1` 时 Executor drain 并写 process release proof 后，Validator、Reviewer、Recovery Run 可依次获得同一 slot；历史 process peak 仍可审计但不占当前 gauge。
- 两个同时活跃 owner 的 process/workspace reservations 按 active-only 相加；其中一个只进入 terminal、尚未证明 containment/workspace 释放时仍占额度，分别写 release proof 后才移除对应 gauge。
- 多个串行 owner 的 wall duration 和 executor/reviewer/validation/recovery attempt 按 settled actual 持续累加；process/workspace 释放不改变这些累计值。
- 主进程崩溃且无法证明 containment/workspace 释放时，重启继续保留对应 gauge；恢复 drain 后只释放 gauge，再按 actual/保守 wall time 结算，不修改历史 high-water。
- 多个历史 workspace high-water 使用 max 而非 sum；同时 workspace admission 只合计未释放 reservation，revision store bytes 只改变 §7.4 quota、不进入 Mission workspace fold。

### 22.7 Renderer

- 预览展示最终规范化 scope 和收窄原因。
- 列表状态、needs attention、无窗口后台更新。
- Snapshot 与 ProgressNote 视觉来源分离。
- waiting/parking/parked/cancelling/paused 的按钮和文案正确。
- 事件分页重放不重复，刷新/切换不丢失。
- 完成投递使来源会话置顶。
- 资源视图分别标注累计消耗、当前占用和历史高水位；已释放 process/workspace 显示为 0 当前占用，但保留 wall/attempt 与 peak 审计值。

## 23. 分阶段实施

### Phase 0：后端抽象与 Codex 准入 Spike（必须先完成）

- 实现 `AgentBackend`、Registry、fake contract test 和 `codex-local` MCP adapter Spike。
- 实现 Codex executable/version/configuration 探测和一个平台的 MCP protocol profile。
- 对照验证 MCP 与 App Server 的取消、审批、sandbox、完成判定和事件粒度；MCP 通过全部硬门槛则不实现 App Server，未通过才实现最小 App Server adapter 并记录选择依据。
- 确认不安装、不登录、不提供 API Key 的失败链路和用户提示。
- 完成 AgentRun/ValidationAttempt 共用的 gated launcher、平台 containment、主进程崩溃、PID 复用、进程树、事件和取消 E2E fixture；无法证明重识别与释放的平台不准入。
- 完成独立单基线 Git snapshot Spike：验证无 hardlink/alternates/remote、受控 Git 配置、源仓库零写入、Agent 本地 Git 写入和最终文件树导入，并记录代表性仓库的创建时间与磁盘占用。
- 完成 `node-lockfile-offline-v1` Spike，在网络和源 `node_modules` 读取均关闭时，用同一 dependency layer 运行 SpaceAssistant 的 test 与两个 typecheck fixture。
- Spike 的真实 npm fixture 必须包含 `.bin` 相对 symlink，并覆盖链接链/循环/逃逸、hardlink 和平台 symlink 原语；不能用“全普通文件”的简化 fixture 代替。
- 验证 revision blob hash 路径的同文件系统 NO_REPLACE 原语、目录持久化和多 publisher 单赢家语义；目标平台只能普通覆盖 rename 时，revision publication 能力不准入。
- 输出版本化 capability report。
- 任一硬门槛失败则停止“无人值守 MVP”发布，后续模块仍可在开发 feature flag 下推进。

退出标准：至少一个目标 backend/runtime/platform/integration mode 组合全部通过 §10.5，且重复运行稳定；Codex 协议选择有可复现 fixture 证据。

### Phase 1：生产存储、执行环境与 Mission 创建

- v3 migration（含通用 containment/drain、validation attempt、统一 mission usage ledger、content blob/typed revision、revision store quota/operation、三类 dependency entry/FK 图、apply operation、notification outbox）、shared types/schema、repositories。
- 固化 MissionUsage v1 reservation/observed/settlement/release-proof schema 和唯一 sum/max/active-only fold；Repository 与 UI cache 只能复用该纯函数。
- 实现生产 `RevisionStoreCoordinator`、SourceCapturePlan、store-wide/per-publication reservation、NO_REPLACE 单赢家/registerFinalizedBlob、ticket/启动恢复、typed revision allowlist、持久化屏障和 finalized 零删除策略；所有 publisher API 禁止绕过 coordinator。
- 实现生产 `node-lockfile-offline-v1` scanner、scan-to-capture source fence、canonical manifest、relative symlink graph、materializer、ExecutionEnvironmentDescriptor 和 environment binding 发布/复用。
- bundled Intake Skill 和唯一 `prepare_mission` tool。
- Prepare/Confirm 原子事务、Mission 列表/详情骨架；软件 Mission Prepare 必须真实走上述 production store/environment 路径。
- feature flag 下可创建 queued Run，但 Supervisor 在 Phase 2 前不领取；缺少 published environment binding 的 software Run 即使由测试/旧数据直接插入也必须被 claim predicate 拒绝。

退出标准：授权来源、hash、过期、幂等和 workDir 漂移测试通过；MissionUsage v1 fold 对 sum/max/active-only 有固定向量且未知 schema fail closed；真实 `.bin` symlink 依赖树可由 production 路径发布、复用和一致物化，首次扫描后的 source 替换无法进入 blob；同 hash 多 publisher 永远只有一个文件/计费 winner；相同 blob 的不同 typed revision 互不污染；PreparedMission environment binding 可确认转移/过期释放；并发 publication/崩溃不突破 store quota；缺 binding 的 software Mission 在 Prepare fail closed。

### Phase 2：最小安全执行闭环

- Supervisor、RunWorkspaceManager、ContainmentManager/gated launcher、AgentRunWrapper、ProcessTreeController、EventWriter、SnapshotProjector，以及 Executor/Reviewer 共用的强类型预算预留、观测、process/workspace release proof、结算和唯一 fold/cache。
- 单并发 Executor、时间限制、workspace 软阈值、取消 drain。
- 只领取 Phase 1 production environment gate 通过的软件 Run，使用相同 manifest 的私有依赖副本；先支持“运行后生成可查看 diff”，不宣称正式完成。

退出标准：窗口关闭仍运行；主进程崩溃后可安全重识别并释放 containment；取消能证明全部资源释放；旧 generation 无法进入当前投影；串行 owner 可复用已释放 process/workspace gauge 而 wall/attempt 不退款，未知 usage schema 停止调度；删除/篡改 environment binding 或关闭 materializer capability 后，Supervisor claim 在 gated containment 创建前 fail closed，且绝不读取源 `node_modules`。

### Phase 3：不可变 Candidate 与确定性验证

- 基于 Phase 1 `RevisionStoreCoordinator`/typed revision contract 的 CodeChangeSet importer、普通 file-bytes revisions 和导入硬限额。
- ValidationCoordinator/持久化 attempt、HostValidatorExecutor、ValidationAttempt 接入统一预算账本及同一 environment materializer、completion 判定、MissionDeliverable 接受事务。
- notification outbox 和原会话同事务幂等投递。

退出标准：revision 故障注入无悬空引用，维护扫描对全部 finalized blob 零删除；离线隔离环境可运行 required command；多个 Validator 与 Agent/Reviewer 共享累计预算且重放不重复计费；Validator cancel/timeout/主进程崩溃后 containment 与 workspace 均释放；只有固定 Candidate 的 required evidence 全部通过才能 completed；通知崩溃重放不重不漏。

### Phase 4：Decision、停放与崩溃恢复

- Decision UI、默认立即 parking、新 Run resume context。
- 稳定点、RecoveryBundle、AgentRun/ValidationAttempt containment、apply、staging ticket 和 outbox 启动扫描、自动恢复和人工选择。
- 累计预算与 recovery limit。

退出标准：应用崩溃/重启不丢失已固化成果，不并发复用旧 snapshot workspace。

### Phase 5：独立 Review 与人工验收

- ReviewAssignment、Reviewer AgentRun、Reviewer 接入统一预算账本、结构化结果导入。
- revise 新 generation、重试/耗尽、manual acceptance。

退出标准：required Review 无法被 Executor 文本或无效 JSON 绕过。

### Phase 6：显式 CodeChangeSet apply 与 UI 完整化

- 持久化 apply journal、同文件系统 operation quarantine、handle-relative/reparse-safe NO_REPLACE 平台 adapter、逐 entry 可重放子状态、file mode、新父目录拒绝、漂移拒绝、备份 revision、回滚和审计。
- 任务面板完整时间线、资源、Recovery 和交付视图。
- 提升并发前进行压力测试。

进入 Phase 6 编码前必须复审 §18 的 journal、quarantine、handle-relative NO_REPLACE 平台能力和启动恢复协议。退出标准：祖先 symlink/junction 或 leaf 并发交换无法造成 repo 外写入、覆盖或误删；新父目录确定性拒绝；其余 add/modify/delete/rename/mode_change 每个文件操作边界的崩溃注入最终只能完整 apply、完整回滚或带完整恢复材料进入 recovery-required，且权限位正确，绝不部分成功后宣称完成。

## 24. 灰度与回滚

- 配置 `backgroundMission.enabled` 默认 false 用于产品灰度；开启后即展示功能入口。backend probe 未通过时入口保留并返回稳定错误/修复提示，不把“未安装 Codex”伪装成功能未发布。
- 再分 `executionEnabled`、`reviewEnabled`、`applyEnabled` 三个门，便于逐阶段灰度。
- 关闭功能只阻止 Prepare、新 AgentRun、新 ValidationAttempt 和新 revision publication；已有活跃 execution owner 必须先 drain，已有 revision operation 必须恢复/保守结算，不能通过关开关释放 reservation。
- 当前版本不内置 fallback backend；未来注册 SubAgent 后，是否作为默认/备选由新的产品配置和确认预览决定。
- 数据库迁移只新增表，应用逻辑回滚不删除数据；高版本数据库仍遵循现有 upgrade-required 保护。
- workspace 和明确未发布 staging 的清理由各自 owner/ticket 与宽限期控制，不随 feature flag 关闭立即删除；staging 成功清理并持久化后才能减记 reservation，finalized physical blob 和 typed revision 在 MVP 始终不删除。

## 25. 主要风险与取舍

| 风险 | 方案 |
|---|---|
| 本地 Agent 运行时随版本变化 | backend adapter 固化 binary/schema hash + version profile；变化即重新 probe，未验证就禁用 |
| Codex 未安装或未配置 | 稳定错误和诊断入口；当前版本不安装、不登录、不索取 API Key，也不静默 fallback |
| 后续后端语义不同 | Prepare 前选择并将 backend/capability snapshot 纳入 hash；所有后端复用同一安全与交付内核 |
| Electron 主进程崩溃影响托管 | gated launcher、持久化 containment/ticket、SQLite 事实账本和启动扫描；MVP 不提前引入独立 daemon |
| POSIX/Windows 进程树语义不同 | 平台独立 containment 准入；不能安全重识别成员并证明资源释放的平台不发布 |
| Host Validator 在取消后泄漏 | Validator 是持久化 ValidationAttempt，与 AgentRun 复用 gated containment、drain、预算和启动恢复 |
| 独立 snapshot 缺少依赖 | MVP 只支持已验证的 Node 离线 dependency layer；其他生态 fail closed，不在 Run 中联网安装 |
| npm 内部 symlink 被错误复制 | manifest 显式保存 regular/symlink/directory 和链接图；保留安全相对链接、拒绝 hardlink/逃逸/循环，物化后复扫 tree identity |
| dependency 扫描后源文件被替换 | 首次扫描保存 SourceCapturePlan；同一可信 root handle 下二次 no-follow 捕获并逐项比对，发布前再复核源树，漂移整次放弃 |
| Prepare 或崩溃耗尽 revision store | 所有 publisher 写前使用 store-wide 持久化 reservation；finalized orphan 保守计费，可信硬上限、安全余量和 Prepare 数量/频率共同 fail closed |
| 同 hash 并发覆盖或重复计费 | verified NO_REPLACE 决定唯一 filesystem winner；`content_blobs.sha256` 条件插入决定唯一 accounting winner，loser 仅在验证后去重 |
| 物理去重污染逻辑类型 | `content_blobs` 与 typed `content_revisions` 分层；消费方提供 expected type/schema 并重验 blob，普通文件不能被 MIME 嗅探成 manifest |
| 分阶段实现绕过依赖安全合同 | 生产 revision store/environment scanner/materializer 前移到 Phase 1；Prepare 与 Supervisor claim 双 gate，Phase 2 才允许软件 Run |
| dependency/content blob 被提前删除 | MVP 关闭 finalized physical blob 和 typed revision 的全部 GC，只清理 ticket 可证明未发布的 staging；显式 FK 图仍负责发布完整性 |
| revision DB 引用悬空 | blob 文件与目录双重持久化屏障、最终 reopen 校验后才提交 DB；孤儿保留，数据库或 ticket 不可读时零删除 |
| apply 中途崩溃污染正式工作树 | before revision + operation quarantine + 持久化逐 entry 子状态 + 启动恢复；未知漂移进入 recovery-required 并锁定 repo |
| apply 路径/叶子 TOCTOU 或 mode 丢失 | 保持 root/parent/quarantine handles，以 NO_REPLACE 原子隔离 leaf 后校验，持久化 before/after mode；平台无法证明时关闭 apply |
| 多类执行绕过 Mission 累计预算 | Executor、Reviewer、ValidationAttempt 共用幂等 reservation/settlement ledger；wall/attempt 用 cumulative sum，启动前预留，崩溃未知按保守值结算 |
| 已释放进程/workspace 永久占位 | process/workspace 使用带独立 release proof 的 active-only sum；历史 peak/high-water 仅取 max 审计，不与新 reservation 相加 |
| 本地结果通知重投或漏投 | Mission 状态事务内写 outbox，本地 Message/Session/outbox 在同一 SQLite 事务投递 |
| 事件量造成 DB 压力 | 文本合并、批量事务、游标分页；离散事实不丢弃 |
| 稳定点误判中间文件 | 连续扫描 + 活跃命令事实；不确定一律 uncertain |
| 脏工作树和 merge 复杂 | MVP Prepare 要求 clean；base 漂移拒绝自动 apply |
| 表数量与开发成本 | 展示型/一对一结构保存在版本化 JSON，只拆需身份、约束和独立生命周期的数据 |
| ProgressNote 误导用户 | 明确标记非权威；首版不额外引入 LLM 摘要器 |
| Reviewer 与 Executor 共同盲点 | 固定 target、隔离上下文、确定性验证；多模型/多 Reviewer 延后 |

## 26. 关键设计决策

1. 后台 Mission 是主进程能力，不复用 Renderer `chatRunnerService` 承担生命周期。
2. SQLite 既是队列也是事实账本，MVP 不增加外部队列或 Worker 服务。
3. Agent 是黑盒；正确性只依赖 adapter 声明的 verified 原生能力和宿主边界。
4. 当前版本只实现用户自备的 `codex-local`；SpaceAssistant 不分发、不登录、不提供 API Key，不可用时明确报错。
5. 核心机制依赖最小 `AgentBackend`，未来 SubAgent/其他 Agent 通过同一 contract 和准入套件接入；确认后不自动切换后端。
6. 软件开发 Mission 首版只接受 clean Git base，以删除脏工作树快照和自动 merge 的复杂度。
7. 现有 `session_artifacts` 不升级为 revision；Mission 使用独立内容寻址存储，避免破坏普通会话语义。
8. 默认立即停放并以新 Run 继续；原生 thread resume 只可优化上下文，不恢复旧 AgentRun。
9. 先固化 Candidate，再运行宿主 validator/Reviewer；Agent completion 和自述永远不完成 Mission。
10. required evidence 闭合和正式发布必须在单个接受事务内重验。
11. Mission 完成不自动应用代码；apply 是用户显式、保守且可审计的后续动作。
12. 首版使用最少必要的数据规范化和单体 repositories 文件；出现真实查询/生命周期需求后再拆。
13. Phase 0 准入 Spike 是发布前置，不与 UI/数据开发结果互相掩盖。
14. 代码 Run 使用独立单基线 Git snapshot；Agent 可写 snapshot 内的 Git 状态，但源仓库、remote 和 Git 网络始终不可写，交付以基线 manifest 与最终文件树差异为准。
15. `codex-local` 优先通过宿主直接调用的 MCP Server 接入；它不作为前台 Agent 自由调用的工具。App Server 仅在 MCP 无法满足 verified 生命周期硬门槛时启用。
16. AgentRun 和 ValidationAttempt 进程都只能通过持久化 gated containment 启动；裸 PID/PGID 不是身份，无法跨崩溃证明成员归属的平台不准入。
17. 软件开发 Mission 必须在 Prepare 固化离线 ExecutionEnvironmentDescriptor，并通过 environment binding/entry FK 图表达完整 regular file/symlink/directory 树；MVP 保留安全相对 symlink、拒绝 hardlink，只实现当前仓库所需的 Node/npm profile。
18. revision blob 只能经平台验证的 NO_REPLACE 发布并由 `content_blobs.sha256` 唯一事务计费；完成文件/目录屏障并重新校验后才能发布业务引用，MVP 不物理删除任何 finalized blob/revision。
19. 正式工作树 apply 使用 operation quarantine、持久化逐 entry journal、before revisions/modes 和 handle-relative NO_REPLACE 平台适配；MVP 不创建新父目录、不自动清理 quarantine，成功、回滚和 recovery-required 都由可重放状态决定。
20. Mission 权威状态变化通过事务 outbox 投递来源 Session；run event 和 Renderer 通知不承担幂等投递保证。
21. ValidationRecord 只能由已释放全部 containment/workspace 资源的 completed ValidationAttempt 产生；取消、超时和崩溃重试永远创建新 attempt。
22. Executor、Reviewer 和 ValidationAttempt 统一通过强类型 mission usage ledger 记账；累计量、当前 gauge、历史 high-water 分别使用 sum、active-only sum、max，重试与 generation 变化不重置历史累计消耗。
23. 所有 revision publisher 统一通过持久化 store quota operation 写前预留；去重只在可验证结算时退款，finalized orphan 或崩溃未知占用保守计费。
24. 生产 revision store、dependency manifest/materializer 和 environment binding 是首个软件 Mission Prepare/Run 的前置交付；feature flag 不能代替 Prepare 与 Supervisor claim 的服务端 gate。
25. dependency publication 使用首次 SourceCapturePlan、同一可信 root handle 下的二次捕获和发布前源树复核；任何漂移放弃整次操作，不重写已确认 tree identity。
26. 物理内容身份由 `content_blobs` 唯一去重，逻辑语义由可多对一引用 blob 的 typed revision 表达；所有消费者从 expected media/schema 出发验证，发布顺序不决定类型。
27. process/workspace 只有在持久化验证 release proof 后才让出当前 gauge；释放不退款 wall/attempt actual，terminal 状态本身不作为资源释放事实。
