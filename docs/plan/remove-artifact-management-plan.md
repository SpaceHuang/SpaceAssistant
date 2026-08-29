# 移除产物管理机制开发计划

> 目标：整体移除产物管理（artifact management）机制。不再通过 harness 机制为「工作目录整洁」约束 Agent 生成文件的路径；**保留**安全机制中对文件路径的限制（workDir 沙箱、symlink/junction 检查、跨会话写冲突互斥、写入审批）。
>
> 依据：`docs/diagrams/artifact-management.architecture.json` 与三路代码调查（主进程 / 渲染进程 / 远程 IM 通道）；已按 `docs/review/remove-artifact-management-plan-review.md`（B1-B3、N1-N4）、`docs/review/remove-artifact-management-plan-review-v2.md`（B4）、`docs/review/remove-artifact-management-plan-review-v3.md`（B10-B12）与 `docs/review/remove-artifact-management-plan-review-v4.md`（B15-B16）修订，并独立复核出 B5-B9、B13-B14 同类排序问题一并调整（见文末修订记录）。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| SQLite 三张产物表（session_artifacts / artifact_references / artifact_operations） | schema 升 v3 执行 DROP（时点：Phase 6，与 artifacts 目录删除同阶段） |
| 磁盘残留（.spaceassistant/runs/、已生成产物文件） | 保留不动，只停用机制 |
| 配置残留（config.artifactManagementEnabled、scratchGitPolicy 偏好、会话 metadata 冻结键） | 保留不动，代码停止读写 |
| docs/ 下产物相关需求/设计文档与架构图 | 保留原地 |
| 实施节奏 | 同一分支分阶段，每阶段可编译可测试（`npm test` + `npm run build` 全绿） |

## 排序原则（v2 修订的核心）

删除顺序必须遵循依赖方向，保证任意阶段结束时测试与构建全绿：

1. **先摘调用方，后删被调方**：渲染端 UI 先删（Phase 3），preload 通道与 api.ts 方法后删（Phase 5）。若反过来，中间状态渲染端调用已不存在的 `window.api.artifactList` 会运行时崩溃，且 `build:renderer`（纯 `vite build`，无类型检查）不会发现。
2. **electron/artifacts/ 与其依赖的 shared 类型文件同阶段删除**（Phase 6）：13 个 artifacts 源文件 import `src/shared/artifactTypes.ts`，先删类型会让 `build:electron`（tsc 类型检查）持续红灯。
3. **数据库 schema v3 DROP 放在 artifacts 目录删除的同一阶段**（Phase 6）：`createMemoryAppDb` 走 `:memory:` 全量真实 schema，artifacts 下大量测试（repository / cleanSession / ipc / relocate / databaseMigrations 等）直接依赖三表存在；提前 DROP 会让这些测试红到 Phase 6。
4. **源文件/行为与对应测试同阶段删除**（`legacyMigration` + 其测试、`builtinToolDefinitions.artifact` 属性 + 其契约测试、errorCodes 码 + 其断言用例、`createSession` 冻结行为 + 依赖该行为的测试）。
5. **类型契约文件（.typecheck.ts）与其断言的目标成员同阶段删除**：typecheck 文件参与 `build:electron` 的 tsc 编译（tsconfig.electron.json 含 `src/shared/**`），目标成员先删会让编译红到 Phase 6（如 `artifactApi.typecheck.ts` 断言 api.ts 方法、`remoteDecisionOutbound.typecheck.ts` 断言 tools/types.ts 字段）。

## 移除后的写入行为（目标形态）

产物管理 flag 关闭时的直写链路成为唯一路径：

```
write_file / edit_file
  -> 桌面自动审批 / 用户确认（保留）
  -> 跨会话写冲突租约 toolWriteConflict（保留，模块迁出 artifacts/）
  -> pathSecurity.resolveSafeWriteTarget 沙箱校验（保留，不动）
  -> 原子写入（保留）
```

不再有：三容器（project/package/scratch）、六类用户决策、`.spaceassistant/runs/` 草稿区、产物登记、迁移（relocate）、系统提示产物上下文注入、`artifact` 工具入参 schema。

## 明确保留的边界（勿删）

- `electron/pathSecurity.ts` 全部（独立安全模块，无 artifacts 依赖）
- `electron/toolWriteConflict.ts` 及其依赖（见 Phase 1 迁移清单）
- `electron/tools/builtinExecutors.ts` 写入执行器（已不感知 artifact；`resolveSafeWriteTarget` 沙箱校验位于 532-534、632-634，与产物 flag 无关、始终生效）
- `electron/tools/writeFileAutoApproval.ts`、`safeAtomicWrite`、`fileStateCache` 写入安全链路
- `WriteSuccessCard` 主体（只删产物徽章逻辑）
- 飞书/微信命令路由器主体与 IM 基础设施（guard、限流、claim、confirm、`ImAuditLogger`、`sendXxxRemoteOutbound`）
- `ReferencedFilesPanel`（数据源是消息 toolCalls 内存派生，与产物无关）
- `electron/database/legacyWorkspaceLayoutCleanup.ts`（独立历史清理，不依赖 artifacts）

---

## Phase 1：迁出共享模块（先保证写入安全不受损）

`toolWriteConflict.ts`（跨会话写互斥，与产物 flag 无关、永远生效）依赖以下放在 `electron/artifacts/` 下的模块，需迁出到新目录 `electron/writeSafety/`（名称可在实施时再定，建议与 `toolWriteConflict.ts` 同址）：

- `toolPathLease.ts`（+ `getSharedArtifactPathLeaseRegistry`）
- `pathLeaseRegistry.ts`
- `normalizeToolRelPath.ts`
- `artifactPathKeys.ts`
- `toolArtifactPath.ts` 中的 `resolveWorkspaceRootReal`

操作：
1. 移动上述文件（连同其测试），重命名去掉 artifact 语义（如 `toolPathLease` 保持原名即可，`artifactPathKeys` -> 可改 `writePathKeys` 或保留原名，实施时以最小 diff 为准）。
2. `toolWriteConflict.ts`、`toolChatLoop.ts` 改 import 路径指向 `electron/writeSafety/`（`main.ts` 无需改动，见 Phase 2 对 268-278 的处置）。
3. 若迁移的文件 import 了纯产物模块（`toolArtifactPath.ts:3` import 了 `src/shared/artifactTypes.ts` 的 `ArtifactWriteIntent`），内联或改到非产物类型文件，切断该依赖。
4. 写冲突租约的共享 registry 由 `toolWriteConflict` -> `toolPathLease` 的静态 import 链获得，与 `main.ts` 的动态 import 无关。
5. **在原位置留 re-export 桥接文件至 Phase 6**：被迁模块在 `electron/artifacts/` 内部有 21 处相对 import（`artifactCleanSession`、`artifactDeletion`、`artifactIpc`、`relocateRecovery`、`relocateService`、`toolLoopArtifactFlow`、`writeRegistration`、`reviewRemediation` 及各自测试），这些文件要到 Phase 6 才删。做法：`artifacts/toolPathLease.ts`、`artifacts/pathLeaseRegistry.ts`、`artifacts/artifactPathKeys.ts` 改为 `export * from '../writeSafety/xxx'`；`artifacts/toolArtifactPath.ts` 本体保留（其余导出不动）并回引 `export { resolveWorkspaceRootReal } from '../writeSafety/...'`。桥接文件随目录在 Phase 6 一并删除。（备选：改写全部 21 处内部 import 指向 writeSafety，diff 更大不推荐）

**验收**：`npm test` + `npm run build` 通过；`toolPathLease`/`toolWriteConflict` 相关测试全部保留且通过。

## Phase 2：主进程摘除产物门禁

### toolChatLoop.ts
- 删 imports（约 150-175 行的 artifacts/remote 相关，Phase 1 迁出者除外；**含 175 行的 `serializeArtifactDecisionForRemote`**，其唯一使用点 1121 在门禁分支内）
- 删 `createToolLoopArtifactState` 调用（约 549）
- 删每轮系统提示注入：`buildArtifactContextSummaries` / `formatArtifactContextBlock`（约 573-587）
- 删完成摘要 `buildArtifactCompletionSummary` 与 `artifact:completion-summary` 事件（约 803-808）
- 删产物门禁分支 `resolvedArtifactWrite`（约 1031-1111，含 `onDecisionRequired`、`sendRemoteArtifactDecisionPrompt`、`artifact:decision-request` 推送、`tool:path-resolved` 唯一发射点 1105）
- 删写后登记 `registerArtifactWriteOutcome`（约 1821-1841）；保留 `checkWritePathConflict`/`claimWritePath`/`releaseWritePath`（约 1695-1717、1815-1817）

### 其他主进程
- `electron/llmSystemPrompt.ts`：删 `artifactContextHint` 参数及拼接（50、53-55）；工具约定提示（35/40 行）保留
- `electron/llmSystemPrompt.test.ts`：删 artifact 上下文用例（102-111）；123 行附近是保留功能的注释，不动
- `electron/chatCancelRegistry.ts`：摘 `cancelArtifactDecisionsForRequest`（7、32、49）
- `electron/main.ts`：**整段删除 268-278**（`getSharedArtifactPathLeaseRegistry` 的动态 import 唯一目的是把 registry 传给 `recoverPendingRelocateOperations`，删后者后前者无消费者；租约本身经静态 import 链使用，不受影响）
- `src/shared/builtinToolDefinitions.ts`：删 `ARTIFACT_WRITE_INTENT_SCHEMA`（1-35）及 `write_file`/`edit_file` 的 `artifact` 属性（78、92）
- **同阶段删除** `src/shared/builtinToolDefinitions.artifact.test.ts`（断言 artifact 属性契约，属性删除即失败）
- `electron/toolChatLoop.ts`：删 `sendRemoteArtifactDecisionPrompt` 调用点（函数本体及**其测试用例**留到 Phase 4 整文件删除，避免 `remoteDecisionOutbound.test.ts:99-121` 两个动态 import 用例中途失败）

**验收**：编译通过；发消息让 Agent 写文件，走直写链路（审批 + 租约 + 沙箱）；发工具调用含 `artifact` 字段时被忽略不报错。

## Phase 3：渲染进程清理（先于 preload，防运行时悬空调用）

> 此时 preload 仍实现 artifact API、主进程仍注册 handler，但渲染端删除后不再有任何调用者，一切编译运行正常。

### 删除文件
- `components/Chat/ArtifactDecisionCard.tsx`（+ .test.tsx、ArtifactDecisionFlow.test.tsx）
- `components/DetailPanel/`：`SessionArtifactsPanel.tsx`、`SessionArtifactsCleanAction.tsx`、`ArtifactRelocateDialog.tsx`、`useSessionArtifacts.ts`（+ 各自测试）
- `components/Config/ArtifactSettingsTab.tsx`（+ 测试）
- `services/pendingArtifactDecisionStore.ts`（+ 测试）、`hooks/usePendingArtifactDecisionSnapshot.ts`

### 修改文件
- `components/Chat/ChatView.tsx`：删 59-61、1385、1572-1583（决策卡片渲染）
- `components/DetailPanel/index.tsx`：删 3、7-9、31-35、82-128 中产物部分；`ReferencedFilesPanel` 保留并自动占满 bottom 区
- `detailPanel.css`：删 `.session-artifacts-*` 规则（1207-1260）
- `components/Chat/WriteSuccessCard.tsx`：删产物 import（3）、`readArtifactMeta`（14-38）、徽章逻辑（54-64、83/88），路径回退到 `confirmDiff.oldPath` / `input.path`（已有回退链）
- `services/chatToolSessionService.ts`：删 `onPathResolved`（120-137）与 `toolOnPathResolved` 订阅（259）；**删 `onRedirect`（140-156）与 `toolOnRedirect` 订阅（258）**（`tool:redirect` 主进程零发射点，全链路死代码，与 Phase 5 的 preload 端同步删除）
- `services/chatToolSessionService.test.ts`：删 `tool:path-resolved` 用例（122-153，含 151-153 对 `artifactMeta` patch 的断言）、`tool:redirect` 用例（157、183）、`artifactTypes` mock（22）
- `services/chatRunnerService.ts`：删 7、296、305、311
- `components/Config/`：`ToolsSettingsTab.tsx`（11、33-34、107-108、268-269）、`ConfigModal.tsx`（92、197-200、343-346、449/487、656-658、951-953）、`toolsSettingsNav.ts`（6、16、25 删 'artifacts' 条目）、`configModalSnapshot.ts`（15、31、101、138-141）
- `store/configSlice.ts`：`ToolsSettingsSubTab` 删 `'artifacts'`（5）
- `src/test/setup.ts`：删 10 个 artifact API mock（56-65）
- 部分修改的测试：`DetailPanel.test.tsx`、`configModalSnapshot.test.ts`、`WriteSuccessCard.test.tsx`（删徽章用例）

### 本阶段**不删**（仍被 electron 侧或 preload 引用，留待 Phase 5/6）
- `src/shared/api.ts` 的 9 个 `artifact*` 方法与类型、`toolOnRedirect`/`toolOnPathResolved` 声明（Phase 5 随 preload 删）
- `src/shared/artifactTypes.ts`、`artifactDecisionTypes.ts` 等类型文件（Phase 6 随 artifacts 目录删）
- `domainTypes.ts` 的 `ToolCallRecord.artifactMeta`、`AppConfig.artifactManagementEnabled` / `scratchGitPolicy`（Phase 6 删；`artifactConfig.ts` 等仍在引用）

### i18n
- 删 key：`chat.json` 的 `artifactDecision.*`（25 个）+ `writeSuccess` 徽章 5 个；`config.json` 的 `tools.nav.artifacts.*` + `artifactSettings.*`（10 个）；`detailPanel.json` 的 `sessionArtifacts.*`（28 个）；zh-CN 与 en-US 同步
- 运行 `npm run i18n:generate-types` 重新生成类型，`npm run i18n:check` 校验

**验收**：`npm test` 全绿；设置页无「产物」子标签；写文件成功卡片正常显示路径（无徽章）；DetailPanel「引用的文件」正常。

## Phase 4：远程决策通道摘除

- 整删：`electron/remote/artifactDecisionImBridge.ts`、`electron/remote/remoteDecisionOutbound.ts`（含 `sendRemoteArtifactDecisionPrompt` 函数本体）及其测试：`artifactDecisionImBridge.test.ts`、`remoteDecisionOutbound.test.ts`、`desktopImDecisionRace.test.ts`
- **`artifactDecisionRemote.ts` 及其测试本阶段不删**（移至 Phase 6）：`toolLoopArtifactFlow.ts:20` 仍 import `buildArtifactDecisionOptions`（源码，Phase 6 才删），提前删会让 `build:electron` 从 Phase 4 红到 Phase 6。Phase 2 已摘除 toolChatLoop 侧调用（175 行 import + 1121 行使用），中间态它是仅被 artifacts 内部引用的活模块，全绿
- **同阶段删除** `src/shared/remoteDecisionOutbound.typecheck.ts`（断言 `electron/tools/types.ts` 的 `sendDecisionText` / `appendArtifactDecisionAudit` / `RemoteArtifactDecisionAuditEvent`，与本阶段的 tools/types.ts 摘除同步，否则 `build:electron` 红到 Phase 6）
- `electron/feishu/remoteCommandRouter.ts`：删 import（15-19）、入站决策块（351-376）、remoteContext 的 `sendDecisionText`/`appendArtifactDecisionAudit`（732-741）
- `electron/wechat/weChatCommandRouter.ts`：删 import（16-20）、入站块（190-217）、remoteContext 两字段（440-451）；删 `weChatCommandRouter.artifactDecision.test.ts`
- `electron/feishu/remoteCommandRouter.artifactDecision.test.ts` 删除
- `electron/tools/types.ts`：删 `RemoteArtifactDecisionAuditEvent` 枚举（32-42）及 `RemoteContext` 的 `sendDecisionText`、`appendArtifactDecisionAudit`（69-78）
- IM 审计：`feishu.artifact_decision.*` / `wechat.artifact_decision.*` 事件随出站层删除自然消失；`ImAuditLogger` 基础设施保留

**验收**：`npm test` + `npm run build` 通过；飞书/微信远程指令（聊天、工具 Y/N 确认、会话/工作目录管理）全部正常。

## Phase 5：IPC、api.ts 与配置摘除（渲染端调用者已清空）

### preload.ts（17-36 及相关）
- 删 invoke 通道：`artifact:list` / `artifact:decision-response` / `artifact:delete` / `artifact:clean-session` / `artifact:relocate` / `artifact:set-default-dir`
- 删事件订阅：`artifact:changed` / `artifact:decision-request` / `artifact:decision-settled`
- 删 `toolOnPathResolved`（188-200）
- 删 `toolOnRedirect`（180-187，与 Phase 3 的渲染端删除呼应）。注意 180-200 行区间同时含两个导出，逐个删除，勿整段剪切
- 删除 `electron/preload.artifact.test.ts`（整文件为 artifact 通道契约测试）
- **同阶段删除** `src/shared/artifactApi.typecheck.ts`（断言 api.ts 的 9 个 `artifact*` 方法签名，与本阶段的 api.ts 方法删除同步，否则 `build:electron` 红到 Phase 6）

### api.ts（此时渲染端已无调用者，删除安全）
- 删 `ArtifactApiItem`、`ArtifactDecisionResponsePayload`（93-114）、9 个 `artifact*` 方法（186-205）、configSet 产物字段（336-337）、`toolOnPathResolved`（394-401）、`toolOnRedirect`（411-413）
- `artifactTypes.ts` / `artifactDecisionTypes.ts` 类型文件本体保留至 Phase 6（electron 侧仍在 import）

### appIpc.ts
- 删 imports 109-112、`createArtifactIpcHandlers` + `setArtifactDecisionSettledNotify`（269-277）
- 删 handler 注册 465-489
- 删 `session:create` 的 flag 冻结（500）
- 删 `config:get`/`config:set` 中 `artifactManagementEnabled`（833、1024-1030）与 `scratchGitPolicy` 读写（808、834、875、1031-1041）
- CONFIG_KEYS（146）删对应 key

### 数据库（代码层摘除；**schema 结构本阶段不动**）
- `electron/database/operations.ts`：删 imports 20-21；`createSession` 摘 `freezeArtifactManagementFlag`（147-150）与 `sanitizeArtifactSessionMetadataOnSave`（163）；`updateSession` 摘 flag 保留逻辑（220-230）；`deleteSession` 摘 artifact_operations 检查（274-287），恢复为直接删除（三表仍在，仅代码不再查询）
- `electron/database/migrateFromJson.ts`：摘 14、100-115、291
- **同阶段删除** `electron/artifacts/legacyMigration.ts` **及** `electron/artifacts/legacyMigration.test.ts`（源与测试同删，防 import 断裂）
- `electron/database/legacyWorkspaceLayoutCleanup.test.ts`：去除对 `../artifacts/legacyMigration` 的 import（8-11）及依赖 `resolveArtifactDefaultDir` / `sanitizeArtifactSessionMetadataOnSave` 的用例（内联桩替代或直接删用例）
- **同阶段删除依赖冻结行为的测试**（`createSession` 摘除 `freezeArtifactManagementFlag` 后即失败，文件本体留到 Phase 6）：`electron/artifacts/artifactConfig.test.ts` 删两个冻结用例（15-32，保留 8-13 的 config 读取用例）；`electron/artifacts/featureFlag.test.ts` 整文件删除（唯一用例即冻结行为断言）；`electron/artifacts/artifactAcceptance.integration.test.ts` 删 AC-01/AC-35 用例（28-41，同样依赖冻结行为）
- 注意：会话 metadata 中已冻结的 `artifactManagementEnabled` 键成为死数据，按决策保留不清除（metadata 为 `Record<string, unknown>`，类型可容忍）

**验收**：`npm test` + `npm run build` 通过（artifacts 模块自身测试仍绿，因三表仍在）；配置读写不再出现产物字段；新建/删除会话正常。

## Phase 6：删除 artifacts 目录本体、共享类型与数据库结构（一并收尾）

### 删除文件
- `electron/artifacts/` 剩余全部（Phase 1 迁出者已在别处；含 `index.ts` 空接口、`databaseMigrations.test.ts`、桥接文件等）
- `electron/remote/`：`artifactDecisionRemote.ts`、`artifactDecisionRemote.test.ts`、`artifactDecisionRemoteIntegration.test.ts`（**不在 artifacts 目录下，不会被目录删除扫到，须显式点名**；此时其消费方 toolLoopArtifactFlow 与两个 artifacts 测试已随目录删除）
- `src/shared/`：`artifactTypes.ts`、`artifactDecisionTypes.ts`、`artifactContainer.typecheck.ts`、`artifactEntrypoint.typecheck.ts`、`artifactPathProvenance.typecheck.ts`、`artifactDecisionOwner.typecheck.ts`、`typeTests/artifactPathProvenance.typecheck.ts`（13 个 artifacts 源文件的 import 已随目录删除，`build:electron` 不再断裂。`artifactApi.typecheck.ts` 已在 Phase 5 删、`remoteDecisionOutbound.typecheck.ts` 已在 Phase 4 删）

### 修改文件
- `src/shared/domainTypes.ts`：删 `ToolCallRecord.artifactMeta`（573-574）、`AppConfig.artifactManagementEnabled` / `scratchGitPolicy`（754-756）
- `src/shared/errorCodes.ts`：删 6 个 `ARTIFACT_*` 错误码（28-33）；**同阶段删除** `src/shared/errorCodes.test.ts` 的对应断言用例（15-21）

### 数据库结构
- `electron/database/schema.ts`：删 `ARTIFACT_V2_SQL` 中三表定义（69-136）
- `electron/database/migrations.ts`：bump schema v3；v1->v2 步骤随之成为空操作（`ARTIFACT_V2_SQL` 已删，全新库直接走 v3）；v2->v3 执行 `DROP TABLE IF EXISTS session_artifacts / artifact_references / artifact_operations`（事务内，幂等）
- **新建迁移测试**（`electron/database/` 下，如 `migrations.v3.test.ts`）：覆盖 v1 直升 v3、v2 升 v3（三表消失、其余表数据完好）、重复执行 DROP 幂等、三表不存在的库升级不报错。这是本次唯一改动存量用户数据的步骤，不依赖手动冒烟。原 `electron/artifacts/databaseMigrations.test.ts` 的迁移覆盖职责由新测试承接

### 收尾验证
1. 全仓库 grep `artifact`（大小写不敏感）确认残留引用为零（`docs/` 除外，按决策文档保留原地；CLAUDE.md 未提及产物管理，无需更新）
2. 全量验证：`npm test`、`npm run build`（renderer + electron）、`npm run i18n:check`
3. 手动冒烟（重点）：
   - 新会话让 Agent 写/改文件：审批弹窗 -> 成功卡片 -> 文件树刷新 ->「引用的文件」面板出现记录
   - 并行两会话写同一文件：写冲突租约生效
   - 路径越界（`../`、绝对路径、symlink）：被 pathSecurity 拒绝
   - 飞书/微信远程指令与工具 Y/N 确认正常
   - 存量库升级（v2->v3）数据完好
4. 提交（分阶段多个 commit，最终合并为同一分支交付）

## 风险与回滚

- **最大风险点**：Phase 1 模块迁移若遗漏隐式依赖（`toolArtifactPath.ts` 可能被其他产物模块反向引用），以「每阶段编译 + 测试通过」兜底
- **行为变化**：产物管理开启过的存量会话，移除后写文件不再触发决策（直接按 flag-off 链路走），符合预期
- **已接受的显示回退**：产物管理开启过的存量会话中，文件可能被重定向到 `.spaceassistant/runs/` 等草稿区，`finalPath` 与 `input.path` 不一致；删除 `readArtifactMeta` 后，历史消息的写成功卡片与「引用的文件」将显示原始请求路径而非实际落盘路径。功能不受影响，属已接受的取舍
- 回滚：整个特性在独立分支，任一阶段不过可直接回退该 commit

## 评审修订记录

### 第一轮（2026-08-29，采纳 `docs/review/remove-artifact-management-plan-review.md`）

- **B1（阻断）**：`tool:redirect` 处置自相矛盾已修正。独立核实确认主进程全仓库零发射点，`onRedirect` 为全链路死代码，选择「两端一起删」：preload `toolOnRedirect`（180-187）、api.ts 类型、`chatToolSessionService` 处理器与订阅、测试用例。原「185-200」行号区间横跨两个导出，已改为逐个点名删除，防误删
- **B2（阻断）**：增补 `legacyWorkspaceLayoutCleanup.test.ts` 对 `legacyMigration` 依赖的改造
- **B3（阻断）**：增补 `llmSystemPrompt.test.ts` artifact 用例删除、`preload.artifact.test.ts` 整文件删除
- **N1**：`main.ts:268-278` 统一为「整段删除」（租约 registry 走静态 import 链）
- **N2**：增补 v3 迁移专项测试
- **N3**：「已接受的显示回退」记入风险一节
- **N4**：点名 `chatToolSessionService.test.ts:122-153`（含 `artifactMeta` 断言）与 mock（22）

### 第二轮（2026-08-29，采纳 `docs/review/remove-artifact-management-plan-review-v2.md` 并扩展）

- **B4（阻断，采纳推荐方案 A 并扩展）**：schema v3 DROP 从 Phase 3 后移至 Phase 6，与 artifacts 目录删除同阶段。核实依据：`createMemoryAppDb`（`electron/database/testHelpers.ts:8-12`）走 `:memory:` 全量真实 schema，artifacts 下 repository / cleanSession / ipc / relocate / databaseMigrations 等测试直接依赖三表存在
- **B5（独立复核新增，阻断）**：13 个 `electron/artifacts/` 源文件 import `src/shared/artifactTypes.ts`（已 grep 逐一确认），原计划 Phase 5 删类型文件、Phase 6 才删目录，期间 `npm run build:electron`（tsc 类型检查）持续失败。修正：类型文件移至 Phase 6 与目录同删
- **B6（独立复核新增，阻断）**：原顺序（Phase 3 删 preload/api.ts，Phase 5 删渲染端调用者）会产生运行时悬空：中间状态打开 DetailPanel 即调 `window.api.artifactList` 抛 TypeError，且 `build:renderer` 纯 `vite build` 无类型检查、vitest 不做类型检查，此错不会被工具发现。修正：**渲染端清理（新 Phase 3）提前到 preload/api.ts 摘除（新 Phase 5）之前**，并将「排序原则」写入计划
- **B7（独立复核新增）**：`legacyMigration.ts` 源与 `legacyMigration.test.ts` 必须同阶段删除（原计划源在 Phase 3、测试到 Phase 6，import 断裂）
- **B8（独立复核新增）**：`errorCodes.test.ts:15-21` 断言 6 个 `ARTIFACT_*` 码，随 Phase 6 删除错误码同阶段删用例
- **B9（独立复核新增）**：`src/shared/builtinToolDefinitions.artifact.test.ts` 从 Phase 5 移至 Phase 2（artifact 属性删除即失败）
- v2 评审小瑕疵确认：Phase 2 的「hint 拼接相关断言（123 附近）」表述已删除（123 行实为保留功能的注释）

### 第三轮（2026-08-29，采纳 `docs/review/remove-artifact-management-plan-review-v3.md` 并扩展）

- **B10（阻断，采纳）**：Phase 1 迁出的 5 个模块在 `electron/artifacts/` 内部有 21 处相对 import（`artifactCleanSession`、`artifactDeletion`、`artifactIpc`、`relocateRecovery`、`relocateService`、`toolLoopArtifactFlow`、`writeRegistration`、`reviewRemediation` 及各自测试，已 grep 逐一核实），直接移走会让 `build:electron` 从 Phase 1 起全红。修正（Phase 1 操作 5）：原位置留 re-export 桥接文件至 Phase 6；`toolArtifactPath.ts` 本体保留其余导出并回引 `resolveWorkspaceRootReal`
- **B11（阻断，采纳后移方案）**：`remoteDecisionOutbound.test.ts:99-121` 两个用例动态 import 并调用 `sendRemoteArtifactDecisionPrompt`。修正：Phase 2 只删 toolChatLoop 调用点，函数本体连同测试留到 Phase 4 整文件删除（避免中途红灯，也避免单独改测试用例）
- **B12（阻断，采纳推荐方案）**：`artifactConfig.test.ts:15-29` 两个用例与 `featureFlag.test.ts` 唯一用例直接依赖 `createSession` 冻结行为（已读测试源码核实）。修正：Phase 5 摘除冻结时同阶段删这些用例（`featureFlag.test.ts` 整文件删，`artifactConfig.test.ts` 保留 9-14 的 config 读取用例）。`legacyMigration.test.ts` 已在 Phase 5 同阶段删除（见 B7），无残留
- **B13（独立复核新增，阻断）**：`src/shared/remoteDecisionOutbound.typecheck.ts` import `electron/tools/types` 并断言 `sendDecisionText` / `appendArtifactDecisionAudit` / `RemoteArtifactDecisionAuditEvent`（已读文件核实），Phase 4 删这些字段会让 `build:electron` 红到 Phase 6。修正：该 typecheck 文件移至 Phase 4 同阶段删除
- **B14（独立复核新增，阻断）**：`src/shared/artifactApi.typecheck.ts` 断言 api.ts 的 9 个 `artifact*` 方法签名（已读文件核实），Phase 5 删方法后同型红灯。修正：该 typecheck 文件移至 Phase 5 同阶段删除
- v3 非阻断意见采纳：Phase 4 测试清单点名 `artifactDecisionRemoteIntegration.test.ts`，防漏删（后随 B15 调整移至 Phase 6）
- 排序原则增补第 5 条：类型契约文件与其断言的目标成员同阶段删除

### 第四轮（2026-08-29，采纳 `docs/review/remove-artifact-management-plan-review-v4.md` 并扩展）

- **B15（阻断，采纳方案 A 并补两点）**：`toolLoopArtifactFlow.ts:20`（非测试源码）import `buildArtifactDecisionOptions`，Phase 4 删 `artifactDecisionRemote.ts` 会让 `build:electron` 红到 Phase 6。修正：该文件及测试移至 Phase 6。独立复核补充：(1) `toolChatLoop.ts:175` 也 import `serializeArtifactDecisionForRemote`（1121 行使用），Phase 2 摘门禁分支时须连 import 一起删，否则修复不完整；(2) `artifactDecisionRemote*` 三个文件在 `electron/remote/` 下、不被 artifacts 目录删除扫到，已显式加入 Phase 6 删除清单；(3) 已核实 `artifactDecisionRemoteIntegration.test.ts` 只 import artifactDecisionBridge 与 artifactDecisionRemote 本体（不依赖 Phase 4 删除的 imBridge/outbound），后移到 Phase 6 安全
- **B16（阻断，B12 漏网，采纳）**：`artifactAcceptance.integration.test.ts:28-41` 的 AC-01/AC-35 用例同样依赖 `createSession` 冻结行为（已读测试源码核实）。修正：增补进 Phase 5 的同阶段删除清单
- 独立终扫（「Phase X 改变的符号 × 全仓库引用方 × 删除时点」交叉法）：artifacts 目录外的全部 import 方（appIpc 110-113、chatCancelRegistry 7、migrateFromJson 14、operations 20-21、toolChatLoop 163-175、toolWriteConflict 1-8、imBridge 8）均已由对应阶段覆盖；`artifactConfig.ts` 只 import database、不依赖 `AppConfig` 类型，Phase 6 删 `AppConfig` 产物字段安全；`desktopImDecisionRace.test.ts` 只依赖 Phase 4 同阶段删除的 imBridge。未再发现新的断链
