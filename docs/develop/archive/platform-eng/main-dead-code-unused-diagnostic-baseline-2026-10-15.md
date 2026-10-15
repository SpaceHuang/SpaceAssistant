# 未使用诊断基线（2026-10-15）

由当前 codex/main-dead-code-cleanup worktree 在 ebdff6fa593fada24983d77e75700465368c7f55 上运行 TypeScript 项目的 Electron 与 Renderer 配置得到。命令参数：--noUnusedLocals --noUnusedParameters --noEmit --incremental false --pretty false。按文件、行、列去重；本表是诊断清理工作清单，不代表可以机械删除。初始化器、副作用、公开参数与共享类型须按方案核实。

- 去重后：277 项，分布于 97 个文件。
- 诊断码：TS6133 234、TS6192 15、TS6196 28。
- 跨 Electron/Renderer 项目的重复诊断已按文件、行、列合并；详细行标出出现项目。

## 文件计数

| 诊断数 | 文件 |
|---:|---|
| 88 | electron/toolChatLoop.ts |
| 18 | src/renderer/components/Chat/ChatView.tsx |
| 11 | electron/claudeStreamHandlers.ts |
| 9 | src/shared/api.ts |
| 7 | electron/outbound/outboundAcceptor.ts |
| 6 | electron/ipc/agentProtocolIpc.ts |
| 6 | electron/ipc/ipcShared.ts |
| 5 | electron/tools/builtinExecutors.ts |
| 4 | src/renderer/services/messageMutationGateway.ts |
| 3 | electron/feishu/remoteCommandRouter.ts |
| 3 | electron/ipc/fileIpc.ts |
| 3 | electron/mcp/mcpService.ts |
| 3 | electron/runtime/sessionProjectionRevalidation.ts |
| 3 | electron/shell/scriptContentSecurity.ts |
| 3 | electron/shell/scriptIr/pythonAdapter.ts |
| 3 | electron/tools/runShellExecutor.ts |
| 3 | electron/wechat/weChatCommandRouter.ts |
| 3 | src/shared/domainTypes.ts |
| 2 | electron/confirmation/imChannel.ts |
| 2 | electron/database/migrations.ts |
| 2 | electron/ipc/configIpc.ts |
| 2 | electron/ipc/desktopIpc.ts |
| 2 | electron/ipc/securityIpc.ts |
| 2 | electron/llmServiceResolver.ts |
| 2 | electron/remote/deferredApprovalCloseCoordinator.ts |
| 2 | electron/runtime/hostedTurnHandoff.ts |
| 2 | electron/runtime/invocationAssembler.ts |
| 2 | electron/runtime/sqliteAgentHistory.ts |
| 2 | electron/shell/shellToolLoopHelpers.ts |
| 2 | electron/storageProfile/storageProfileWorkerClient.ts |
| 2 | electron/usageStats/usageStatsQueries.ts |
| 2 | electron/workDirSnapshot.ts |
| 2 | src/renderer/components/Chat/ToolCallCard.tsx |
| 2 | src/renderer/components/Config/ConfigModal.tsx |
| 2 | src/renderer/components/DetailPanel/FileContentView.tsx |
| 1 | electron/browser/actDangerAssessor.ts |
| 1 | electron/browser/browserDependencyDetect.ts |
| 1 | electron/browser/browserUserErrors.ts |
| 1 | electron/browser/stagehandService.ts |
| 1 | electron/butler/butlerIpc.ts |
| 1 | electron/capabilities/handlers/env.ts |
| 1 | electron/confirmation/extractors/outboundExtractors.ts |
| 1 | electron/confirmation/readConfirmationRegistry.ts |
| 1 | electron/confirmation/settingsSecurityModel.ts |
| 1 | electron/database/index.ts |
| 1 | electron/database/migrateFromJson.ts |
| 1 | electron/database/sessionStorageCleanupEstimate.ts |
| 1 | electron/driver/deliveryHub.ts |
| 1 | electron/effectiveTools.ts |
| 1 | electron/ipc/sessionIpc.ts |
| 1 | electron/main.ts |
| 1 | electron/mcp/mcpOauthService.ts |
| 1 | electron/remote/deferredApprovalRuntime.ts |
| 1 | electron/remote/imWorkflowSkillHarness.ts |
| 1 | electron/remote/weChatProgressAdapter.ts |
| 1 | electron/runtime/agentSdkOutputRecovery.ts |
| 1 | electron/runtime/callAdmission.ts |
| 1 | electron/runtime/callAdmissionGate.ts |
| 1 | electron/runtime/sessionProjectionConsistencyAudit.ts |
| 1 | electron/runtime/sessionStorageShadow.ts |
| 1 | electron/sessionEvents.ts |
| 1 | electron/sessionStorage/contextPortRegistry.ts |
| 1 | electron/sessionStorage/coordinator.ts |
| 1 | electron/shell/shellPathAnalysis.ts |
| 1 | electron/skills/skillParser.ts |
| 1 | electron/skills/skillRouter.ts |
| 1 | electron/storage/agentLogRetention.ts |
| 1 | electron/storage/sessionStorageMaintenance.ts |
| 1 | electron/storage/spillReferenceBackfill.ts |
| 1 | electron/tools/readPermitTestUtils.ts |
| 1 | electron/tools/remoteSessionExecutors.ts |
| 1 | electron/tools/runLarkCliExecutor.ts |
| 1 | electron/tools/snapshotReadRegisteredTool.ts |
| 1 | electron/tools/toolInvocationCoordinator.ts |
| 1 | electron/tools/wechatExecutors.ts |
| 1 | electron/tools/workDirExecutors.ts |
| 1 | electron/wiki/wikiPaths.ts |
| 1 | electron/wiki/wikiProjects.ts |
| 1 | electron/workDirManager.ts |
| 1 | packages/agent-sdk/src/context.ts |
| 1 | packages/agent-sdk/src/scheduler.ts |
| 1 | src/renderer/components/Chat/ChatBubble.tsx |
| 1 | src/renderer/components/Chat/ChatRunningStatus.tsx |
| 1 | src/renderer/components/Config/ModelsSettingsTab.tsx |
| 1 | src/renderer/components/Config/ShellSettingsTab.tsx |
| 1 | src/renderer/components/Config/ToolsSecuritySettingsTab.tsx |
| 1 | src/renderer/components/Config/WikiTab.tsx |
| 1 | src/renderer/components/DetailPanel/FileToolbar.tsx |
| 1 | src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx |
| 1 | src/renderer/components/FloatingNotification/FloatingNotificationApp.tsx |
| 1 | src/renderer/components/UsageStats/UsageStatsDrawer.tsx |
| 1 | src/renderer/services/chatRunnerService.ts |
| 1 | src/renderer/services/fileContentSyncBus.ts |
| 1 | src/shared/configSetTypeGate.ts |
| 1 | src/shared/policy/policyEngine.ts |
| 1 | src/shared/surfaceReplay.ts |
| 1 | src/shared/turnCoordinator.ts |

## 逐项诊断

| 文件 | 行:列 | 诊断 | 项目 |
|---|---:|---|---|
| electron/browser/actDangerAssessor.ts | 5:3 | TS6196 'ActFillPreview' is declared but never used. | electron |
| electron/browser/browserDependencyDetect.ts | 11:3 | TS6133 'NPM_INSTALL_CMD' is declared but its value is never read. | electron |
| electron/browser/browserUserErrors.ts | 4:32 | TS6133 'NPM_INSTALL_CMD' is declared but its value is never read. | electron |
| electron/browser/stagehandService.ts | 21:7 | TS6133 'nodeRequire' is declared but its value is never read. | electron |
| electron/butler/butlerIpc.ts | 1:1 | TS6133 'ipcMain' is declared but its value is never read. | electron |
| electron/capabilities/handlers/env.ts | 113:49 | TS6133 'handlerDeps' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 3:28 | TS6133 'assertValidOptionalAnthropicBaseUrl' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 9:10 | TS6133 'getDbConnection' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 11:1 | TS6133 'MODEL_BASELINE' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 35:273 | TS6133 'surfaceItemIdentity' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 47:1 | TS6133 'rebuildClaudeMessagesFromHistory' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 87:46 | TS6133 'db' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 289:46 | TS6133 'ipcMain' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 293:60 | TS6133 'sender' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 565:19 | TS6133 'boundaryEventWriter' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 588:57 | TS6133 'message' is declared but its value is never read. | electron |
| electron/claudeStreamHandlers.ts | 595:82 | TS6133 'message' is declared but its value is never read. | electron |
| electron/confirmation/extractors/outboundExtractors.ts | 2:15 | TS6196 'EnvFacts' is declared but never used. | electron |
| electron/confirmation/imChannel.ts | 11:3 | TS6196 'OriginInfo' is declared but never used. | electron |
| electron/confirmation/imChannel.ts | 146:47 | TS6133 'memoryTiers' is declared but its value is never read. | electron |
| electron/confirmation/readConfirmationRegistry.ts | 79:48 | TS6133 'state' is declared but its value is never read. | electron |
| electron/confirmation/settingsSecurityModel.ts | 13:8 | TS6133 'PolicyPackageMap' is declared but its value is never read. | electron |
| electron/database/index.ts | 4:30 | TS6133 'openSqliteDatabaseReadOnly' is declared but its value is never read. | electron |
| electron/database/migrateFromJson.ts | 2:1 | TS6133 'path' is declared but its value is never read. | electron |
| electron/database/migrations.ts | 7:77 | TS6133 'MIGRATION_V18_CONFIRMATION_COMMIT_IDENTITY_SQL' is declared but its value is never read. | electron |
| electron/database/migrations.ts | 23:55 | TS6133 'MIGRATION_V49_SESSION_PROJECTION_SCOPE_SQL' is declared but its value is never read. | electron |
| electron/database/sessionStorageCleanupEstimate.ts | 6:10 | TS6133 'RETENTION_POLICY_CONFIG_KEYS' is declared but its value is never read. | electron |
| electron/driver/deliveryHub.ts | 434:13 | TS6133 'last' is declared but its value is never read. | electron |
| electron/effectiveTools.ts | 5:56 | TS6196 'WikiConfig' is declared but never used. | electron |
| electron/feishu/remoteCommandRouter.ts | 3:1 | TS6133 'CURRENT_SCHEMA_VERSION' is declared but its value is never read. | electron |
| electron/feishu/remoteCommandRouter.ts | 24:85 | TS6133 'isRequestLeaseOwner' is declared but its value is never read. | electron |
| electron/feishu/remoteCommandRouter.ts | 1263:15 | TS6133 'assistantMessageId' is declared but its value is never read. | electron |
| electron/ipc/agentProtocolIpc.ts | 20:48 | TS6133 'getTurnByRequestId' is declared but its value is never read. | electron |
| electron/ipc/agentProtocolIpc.ts | 20:68 | TS6133 'listPersistedTurns' is declared but its value is never read. | electron |
| electron/ipc/agentProtocolIpc.ts | 48:43 | TS6133 'clearSystemManagedCacheEntry' is declared but its value is never read. | electron |
| electron/ipc/agentProtocolIpc.ts | 55:139 | TS6133 'isPendingMemoryTier' is declared but its value is never read. | electron |
| electron/ipc/agentProtocolIpc.ts | 276:7 | TS6133 'event' is declared but its value is never read. | electron |
| electron/ipc/agentProtocolIpc.ts | 426:13 | TS6133 'trustAllowed' is declared but its value is never read. | electron |
| electron/ipc/configIpc.ts | 366:15 | TS6133 'feishuAuthorizationChanged' is declared but its value is never read. | electron |
| electron/ipc/configIpc.ts | 385:15 | TS6133 'wechatAuthorizationChanged' is declared but its value is never read. | electron |
| electron/ipc/desktopIpc.ts | 3:1 | TS6133 'path' is declared but its value is never read. | electron |
| electron/ipc/desktopIpc.ts | 7:10 | TS6133 'app' is declared but its value is never read. | electron |
| electron/ipc/fileIpc.ts | 3:1 | TS6133 'existsSync' is declared but its value is never read. | electron |
| electron/ipc/fileIpc.ts | 24:34 | TS6133 'DEFAULT_WIKI_ROOT_DIRNAME' is declared but its value is never read. | electron |
| electron/ipc/fileIpc.ts | 418:37 | TS6133 'ctx' is declared but its value is never read. | electron |
| electron/ipc/ipcShared.ts | 8:1 | TS6133 'BrowserDetectContext' is declared but its value is never read. | electron |
| electron/ipc/ipcShared.ts | 9:1 | TS6133 'ClaudeTurnExecution' is declared but its value is never read. | electron |
| electron/ipc/ipcShared.ts | 10:1 | TS6133 'DebouncedSessionBackupManager' is declared but its value is never read. | electron |
| electron/ipc/ipcShared.ts | 12:1 | TS6133 'TurnRuntime' is declared but its value is never read. | electron |
| electron/ipc/ipcShared.ts | 14:1 | TS6133 'WorkDirManager' is declared but its value is never read. | electron |
| electron/ipc/ipcShared.ts | 15:15 | TS6133 'shell' is declared but its value is never read. | electron |
| electron/ipc/securityIpc.ts | 11:1 | TS6133 'recordSettingsChange' is declared but its value is never read. | electron |
| electron/ipc/securityIpc.ts | 77:7 | TS6133 'event' is declared but its value is never read. | electron |
| electron/ipc/sessionIpc.ts | 35:1 | TS6133 'createAnthropicClient' is declared but its value is never read. | electron |
| electron/llmServiceResolver.ts | 383:60 | TS6133 'existingKeys' is declared but its value is never read. | electron |
| electron/llmServiceResolver.ts | 396:9 | TS6133 'activeSet' is declared but its value is never read. | electron |
| electron/main.ts | 1185:89 | TS6133 'turn' is declared but its value is never read. | electron |
| electron/mcp/mcpOauthService.ts | 5:3 | TS6133 'auth' is declared but its value is never read. | electron |
| electron/mcp/mcpService.ts | 8:8 | TS6133 'McpServerProfile' is declared but its value is never read. | electron |
| electron/mcp/mcpService.ts | 16:10 | TS6133 'McpConnectionManager' is declared but its value is never read. | electron |
| electron/mcp/mcpService.ts | 19:40 | TS6133 'isOAuthFlowActive' is declared but its value is never read. | electron |
| electron/outbound/outboundAcceptor.ts | 19:10 | TS6133 'appendMessage' is declared but its value is never read. | electron |
| electron/outbound/outboundAcceptor.ts | 22:1 | TS6133 'summarizeFailedInvocation' is declared but its value is never read. | electron |
| electron/outbound/outboundAcceptor.ts | 24:1 | TS6133 'HistorySnapshot' is declared but its value is never read. | electron |
| electron/outbound/outboundAcceptor.ts | 26:15 | TS6196 'ContinuationSourceQueries' is declared but never used. | electron |
| electron/outbound/outboundAcceptor.ts | 27:10 | TS6133 'runInTransaction' is declared but its value is never read. | electron |
| electron/outbound/outboundAcceptor.ts | 28:1 | TS6133 'createContinuationStartedSystemMessage' is declared but its value is never read. | electron |
| electron/outbound/outboundAcceptor.ts | 330:15 | TS6133 'now' is declared but its value is never read. | electron |
| electron/remote/deferredApprovalCloseCoordinator.ts | 3:1 | TS6133 'runInTransaction' is declared but its value is never read. | electron |
| electron/remote/deferredApprovalCloseCoordinator.ts | 54:11 | TS6133 'now' is declared but its value is never read. | electron |
| electron/remote/deferredApprovalRuntime.ts | 6:46 | TS6133 'parseDeferredApprovalReply' is declared but its value is never read. | electron |
| electron/remote/imWorkflowSkillHarness.ts | 148:15 | TS6133 'index' is declared but its value is never read. | electron |
| electron/remote/weChatProgressAdapter.ts | 25:9 | TS6133 'progressConfig' is declared but its value is never read. | electron |
| electron/runtime/agentSdkOutputRecovery.ts | 14:11 | TS6133 'requestId' is declared but its value is never read. | electron |
| electron/runtime/callAdmission.ts | 58:37 | TS6133 'now' is declared but its value is never read. | electron |
| electron/runtime/callAdmissionGate.ts | 36:22 | TS6133 'request' is declared but its value is never read. | electron |
| electron/runtime/hostedTurnHandoff.ts | 6:1 | TS6133 'InvocationHistoryWriter' is declared but its value is never read. | electron |
| electron/runtime/hostedTurnHandoff.ts | 8:1 | TS6133 'AgentInvocationMaterials' is declared but its value is never read. | electron |
| electron/runtime/invocationAssembler.ts | 15:27 | TS6133 'getSession' is declared but its value is never read. | electron |
| electron/runtime/invocationAssembler.ts | 15:39 | TS6133 'updateSession' is declared but its value is never read. | electron |
| electron/runtime/sessionProjectionConsistencyAudit.ts | 125:9 | TS6133 'messages' is declared but its value is never read. | electron |
| electron/runtime/sessionProjectionRevalidation.ts | 3:23 | TS6133 'getMessageSkeletons' is declared but its value is never read. | electron |
| electron/runtime/sessionProjectionRevalidation.ts | 12:10 | TS6133 'hasSessionProjectionEligibility' is declared but its value is never read. | electron |
| electron/runtime/sessionProjectionRevalidation.ts | 97:7 | TS6133 'deferred' is declared but its value is never read. | electron |
| electron/runtime/sessionStorageShadow.ts | 5:23 | TS6133 'getTurnContext' is declared but its value is never read. | electron |
| electron/runtime/sqliteAgentHistory.ts | 250:64 | TS6133 'invocationRepairCount' is declared but its value is never read. | electron |
| electron/runtime/sqliteAgentHistory.ts | 2022:19 | TS6133 'repairId' is declared but its value is never read. | electron |
| electron/sessionEvents.ts | 529:46 | TS6133 'error' is declared but its value is never read. | electron |
| electron/sessionStorage/contextPortRegistry.ts | 3:1 | TS6133 'createStorageSessionContextAdapter' is declared but its value is never read. | electron |
| electron/sessionStorage/coordinator.ts | 1:1 | TS6133 'Message' is declared but its value is never read. | electron |
| electron/shell/scriptContentSecurity.ts | 9:10 | TS6133 'IrCoverageError' is declared but its value is never read. | electron |
| electron/shell/scriptContentSecurity.ts | 892:11 | TS6133 'wouldB11' is declared but its value is never read. | electron |
| electron/shell/scriptContentSecurity.ts | 894:5 | TS6133 'scope' is declared but its value is never read. | electron |
| electron/shell/scriptIr/pythonAdapter.ts | 219:17 | TS6133 'alias' is declared but its value is never read. | electron |
| electron/shell/scriptIr/pythonAdapter.ts | 447:10 | TS6133 'patternTargetName' is declared but its value is never read. | electron |
| electron/shell/scriptIr/pythonAdapter.ts | 781:9 | TS6133 'keyNode' is declared but its value is never read. | electron |
| electron/shell/shellPathAnalysis.ts | 1:1 | TS6133 'fs' is declared but its value is never read. | electron |
| electron/shell/shellToolLoopHelpers.ts | 6:3 | TS6133 'touchTrustedCommand' is declared but its value is never read. | electron |
| electron/shell/shellToolLoopHelpers.ts | 9:1 | TS6133 'AppDatabase' is declared but its value is never read. | electron |
| electron/skills/skillParser.ts | 29:10 | TS6133 'parseSimpleYaml' is declared but its value is never read. | electron |
| electron/skills/skillRouter.ts | 145:39 | TS6133 'timeoutMs' is declared but its value is never read. | electron |
| electron/storage/agentLogRetention.ts | 4:33 | TS6133 'formatAgentLogFileName' is declared but its value is never read. | electron |
| electron/storage/sessionStorageMaintenance.ts | 8:1 | TS6133 'runInTransaction' is declared but its value is never read. | electron |
| electron/storage/spillReferenceBackfill.ts | 10:7 | TS6133 'MAX_CHUNK_ROWS' is declared but its value is never read. | electron |
| electron/storageProfile/storageProfileWorkerClient.ts | 5:1 | TS6133 'pathToFileURL' is declared but its value is never read. | electron |
| electron/storageProfile/storageProfileWorkerClient.ts | 54:7 | TS6133 'tsxCjsApiPath' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 5:1 | TS6133 'PermitBoundToolExecutionPort' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 16:1 | TS6133 'NormalizedStopReason' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 21:1 | TS6133 'getCallAdmissionGate' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 22:1 | TS6133 'coordinatorConfirmHook' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 27:1 | TS6133 'PreparedShellExecution' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 29:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 30:1 | TS6133 'createMcpToolExecutor' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 31:1 | TS6133 'createRegisteredMcpTool' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 33:3 | TS6133 'buildSnapshotFromDb' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 36:1 | TS6133 'getSecret' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 37:1 | TS6133 'createMcpOAuthClientProvider' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 38:1 | TS6133 'maskSensitiveArgs' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 40:3 | TS6196 'AutoApproveFallback' is declared but never used. | electron |
| electron/toolChatLoop.ts | 41:3 | TS6196 'AutoApprovedWriteMeta' is declared but never used. | electron |
| electron/toolChatLoop.ts | 44:3 | TS6196 'ShellSecurityHints' is declared but never used. | electron |
| electron/toolChatLoop.ts | 49:1 | TS6133 'computeDiffLineStats' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 50:1 | TS6133 'sessionDisplayNameRaw' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 51:1 | TS6133 'evaluateFileToolAutoApproval' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 55:1 | TS6133 'getSkillByName' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 57:10 | TS6133 'recordStepUsage' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 57:27 | TS6133 'recordTurnSummary' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 60:1 | TS6133 'ActDangerAssessment' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 61:1 | TS6133 'assessActDanger' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 65:3 | TS6133 'isBrowserSessionActTrustedHost' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 66:3 | TS6133 'rememberBrowserSessionActTrust' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 67:3 | TS6133 'rememberBrowserSessionTrustedUrl' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 69:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 84:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 86:1 | TS6133 'BROWSER_REMOTE_DISABLED_CODE' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 87:1 | TS6133 'SHELL_REMOTE_DISABLED_ERROR' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 89:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 90:1 | TS6133 'getBuiltinSensitivePrefixes' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 91:1 | TS6133 'canShowShellTrustOption' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 93:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 98:1 | TS6133 'validateReadExecutionBoundary' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 99:1 | TS6133 'buildWriteExecutionPermit' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 100:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 101:1 | TS6133 'recordPolicyExecutionVeto' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 102:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 103:1 | TS6133 'getSecurityAuditLog' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 104:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 105:1 | TS6133 'shouldFallbackToUser' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 106:1 | TS6133 'approvalFallbackReasonFor' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 107:1 | TS6133 'ConfirmationChannel' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 108:1 | TS6133 'AgentChannel' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 109:1 | TS6133 'loadEffectivePolicyRules' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 110:1 | TS6133 'getBuiltinToolMetadata' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 111:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 112:15 | TS6196 'ConfirmAnswererKind' is declared but never used. | electron |
| electron/toolChatLoop.ts | 112:36 | TS6196 'ConfirmOutcome' is declared but never used. | electron |
| electron/toolChatLoop.ts | 112:73 | TS6196 'ConfirmRequest' is declared but never used. | electron |
| electron/toolChatLoop.ts | 114:3 | TS6133 'formatScriptDenyUserMessage' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 118:3 | TS6133 'checkRemoteTaskBudget' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 120:3 | TS6133 'recordOutboundWrite' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 121:3 | TS6133 'recordToolCall' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 125:1 | TS6133 'recheckRemoteWriteAuthorization' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 126:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 133:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 142:1 | TS6133 'shouldRequestImConfirm' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 152:34 | TS6133 'resolveRequestLocale' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 155:1 | TS6192 All imports in import declaration are unused. | electron |
| electron/toolChatLoop.ts | 160:1 | TS6133 'toolConfirmRegistry' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 161:1 | TS6133 'fs' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 162:1 | TS6133 'path' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 163:1 | TS6133 'assertSafeToolInput' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 172:3 | TS6133 'checkWritePathConflict' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 173:3 | TS6133 'claimWritePath' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 174:3 | TS6133 'releaseWritePath' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 177:54 | TS6133 'authorizeToolCall' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 178:38 | TS6133 'isToolRevoked' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 721:5 | TS6133 'toolExecutionConcurrency' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 731:5 | TS6133 'wikiConfig' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 734:5 | TS6133 'larkCliRunner' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 737:5 | TS6133 'workDirManager' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 741:5 | TS6133 'hostDiagnostics' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 742:5 | TS6133 'hostUsage' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 747:5 | TS6133 'hostAnswerer' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 753:5 | TS6133 'resourceLocks' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 754:5 | TS6133 'invocationRuntime' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 755:5 | TS6133 'invocationLeaseState' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 756:5 | TS6133 'getBrowserDetectContext' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 757:5 | TS6133 'getMcpConnectionManager' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 758:13 | TS6133 'invocationEvents' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 760:5 | TS6133 'turnUsageStats' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 777:9 | TS6133 'remoteBudgetState' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 795:9 | TS6133 'shellOutputMode' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 909:7 | TS6133 'effortRetryUsed' is declared but its value is never read. | electron |
| electron/toolChatLoop.ts | 1043:9 | TS6133 'appendReplayUserMessage' is declared but its value is never read. | electron |
| electron/tools/builtinExecutors.ts | 12:10 | TS6133 'resolveSafePath' is declared but its value is never read. | electron |
| electron/tools/builtinExecutors.ts | 12:27 | TS6133 'resolveSafePathReal' is declared but its value is never read. | electron |
| electron/tools/builtinExecutors.ts | 12:48 | TS6133 'resolveSafeWorkDirPath' is declared but its value is never read. | electron |
| electron/tools/builtinExecutors.ts | 60:1 | TS6133 'runShellExecutor' is declared but its value is never read. | electron |
| electron/tools/builtinExecutors.ts | 636:10 | TS6133 'escapeRegex' is declared but its value is never read. | electron |
| electron/tools/readPermitTestUtils.ts | 2:1 | TS6133 'path' is declared but its value is never read. | electron |
| electron/tools/remoteSessionExecutors.ts | 15:15 | TS6196 'ToolExecutionContext' is declared but never used. | electron |
| electron/tools/runLarkCliExecutor.ts | 1:29 | TS6196 'ToolExecutionContext' is declared but never used. | electron |
| electron/tools/runShellExecutor.ts | 40:7 | TS6133 'DEFAULT_IO_MAX' is declared but its value is never read. | electron |
| electron/tools/runShellExecutor.ts | 212:9 | TS6133 'command' is declared but its value is never read. | electron |
| electron/tools/runShellExecutor.ts | 430:13 | TS6133 'spawnErrorMessage' is declared but its value is never read. | electron |
| electron/tools/snapshotReadRegisteredTool.ts | 2:55 | TS6133 'ToolExecutionContext' is declared but its value is never read. | electron |
| electron/tools/toolInvocationCoordinator.ts | 12:105 | TS6133 'signal' is declared but its value is never read. | electron |
| electron/tools/wechatExecutors.ts | 1:29 | TS6196 'ToolExecutionContext' is declared but never used. | electron |
| electron/tools/workDirExecutors.ts | 9:15 | TS6196 'ToolExecutionContext' is declared but never used. | electron |
| electron/usageStats/usageStatsQueries.ts | 343:23 | TS6133 'whereTurn' is declared but its value is never read. | electron |
| electron/usageStats/usageStatsQueries.ts | 343:47 | TS6133 'paramsTurn' is declared but its value is never read. | electron |
| electron/wechat/weChatCommandRouter.ts | 4:1 | TS6133 'CURRENT_SCHEMA_VERSION' is declared but its value is never read. | electron |
| electron/wechat/weChatCommandRouter.ts | 818:19 | TS6133 'parked' is declared but its value is never read. | electron |
| electron/wechat/weChatCommandRouter.ts | 1069:15 | TS6133 'assistantMessageId' is declared but its value is never read. | electron |
| electron/wiki/wikiPaths.ts | 3:34 | TS6133 'DEFAULT_WIKI_ROOT_DIRNAME' is declared but its value is never read. | electron |
| electron/wiki/wikiProjects.ts | 3:1 | TS6133 'path' is declared but its value is never read. | electron |
| electron/workDirManager.ts | 7:26 | TS6133 'getSession' is declared but its value is never read. | electron |
| electron/workDirSnapshot.ts | 5:1 | TS6133 'AppDatabase' is declared but its value is never read. | electron |
| electron/workDirSnapshot.ts | 44:3 | TS6133 'fallbackWorkDir' is declared but its value is never read. | electron |
| packages/agent-sdk/src/context.ts | 4:36 | TS6196 'HistoryEvent' is declared but never used. | electron |
| packages/agent-sdk/src/scheduler.ts | 144:13 | TS6133 'activeCount' is declared but its value is never read. | electron |
| src/renderer/components/Chat/ChatBubble.tsx | 477:28 | TS6133 'itemIndex' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatRunningStatus.tsx | 43:6 | TS6196 'StatusProps' is declared but never used. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 22:1 | TS6133 'LastUsage' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 24:3 | TS6133 'clearLiveSession' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 25:3 | TS6133 'getLiveMessages' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 33:3 | TS6133 'commitMessagePatch' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 53:1 | TS6133 'resolveChatLocale' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 54:1 | TS6133 'buildToolChatPayload' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 66:1 | TS6133 'activateBrowserRecoverySkillIfNeeded' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 67:40 | TS6133 'BROWSER_SETUP_RECOVERY_SKILL' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 69:1 | TS6133 'filterBuiltinToolsForRenderer' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 71:10 | TS6133 'appendSkillHintRecord' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 71:73 | TS6133 'createSkillHintRecord' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 73:10 | TS6133 'DEFAULT_WIKI_CONFIG' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 81:1 | TS6133 'CHAT_CANCELLED_MESSAGE' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 105:10 | TS6133 'buildClaudePayload' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 116:9 | TS6133 'tErrors' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 117:9 | TS6133 'tContextUsage' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 168:9 | TS6133 'chatBaseUrl' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ChatView.tsx | 174:10 | TS6133 'exposureTools' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ToolCallCard.tsx | 46:1 | TS6133 'ConfirmCardDecision' is declared but its value is never read. | renderer |
| src/renderer/components/Chat/ToolCallCard.tsx | 250:9 | TS6133 'shellCommand' is declared but its value is never read. | renderer |
| src/renderer/components/Config/ConfigModal.tsx | 3:36 | TS6133 'Input' is declared but its value is never read. | renderer |
| src/renderer/components/Config/ConfigModal.tsx | 3:56 | TS6133 'Radio' is declared but its value is never read. | renderer |
| src/renderer/components/Config/ModelsSettingsTab.tsx | 13:3 | TS6133 'ConfigModelVisionBadge' is declared but its value is never read. | renderer |
| src/renderer/components/Config/ShellSettingsTab.tsx | 1:17 | TS6133 'App' is declared but its value is never read. | renderer |
| src/renderer/components/Config/ToolsSecuritySettingsTab.tsx | 2:66 | TS6133 'Radio' is declared but its value is never read. | renderer |
| src/renderer/components/Config/WikiTab.tsx | 1:57 | TS6133 'Switch' is declared but its value is never read. | renderer |
| src/renderer/components/DetailPanel/FileContentView.tsx | 4:1 | TS6133 'useTypedSelector' is declared but its value is never read. | renderer |
| src/renderer/components/DetailPanel/FileContentView.tsx | 5:1 | TS6133 'DEFAULT_WIKI_CONFIG' is declared but its value is never read. | renderer |
| src/renderer/components/DetailPanel/FileToolbar.tsx | 19:1 | TS6133 'MarkdownRenderView' is declared but its value is never read. | renderer |
| src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx | 4:1 | TS6133 'DEFAULT_WIKI_CONFIG' is declared but its value is never read. | renderer |
| src/renderer/components/FloatingNotification/FloatingNotificationApp.tsx | 8:3 | TS6133 'formatFloatingActionSummary' is declared but its value is never read. | renderer |
| src/renderer/components/UsageStats/UsageStatsDrawer.tsx | 2:8 | TS6133 'dayjs' is declared but its value is never read. | renderer |
| src/renderer/services/chatRunnerService.ts | 35:10 | TS6133 'persistKey' is declared but its value is never read. | renderer |
| src/renderer/services/fileContentSyncBus.ts | 147:10 | TS6133 'onContentChanged' is declared but its value is never read. | renderer |
| src/renderer/services/messageMutationGateway.ts | 1:15 | TS6196 'ChatImageAttachment' is declared but never used. | renderer |
| src/renderer/services/messageMutationGateway.ts | 2:1 | TS6133 'CURRENT_SCHEMA_VERSION' is declared but its value is never read. | renderer |
| src/renderer/services/messageMutationGateway.ts | 3:1 | TS6192 All imports in import declaration are unused. | renderer |
| src/renderer/services/messageMutationGateway.ts | 17:3 | TS6133 'ackDisplayMessagePersisted' is declared but its value is never read. | renderer |
| src/shared/api.ts | 9:15 | TS6196 'CacheKey' is declared but never used. | electron, renderer |
| src/shared/api.ts | 13:3 | TS6196 'AutoApproveFallback' is declared but never used. | electron, renderer |
| src/shared/api.ts | 14:3 | TS6196 'BrowserActDangerInfo' is declared but never used. | electron, renderer |
| src/shared/api.ts | 24:3 | TS6196 'GithubSkillCandidate' is declared but never used. | electron, renderer |
| src/shared/api.ts | 29:3 | TS6196 'ToolCallResultPersisted' is declared but never used. | electron, renderer |
| src/shared/api.ts | 30:3 | TS6196 'ToolRiskLevel' is declared but never used. | electron, renderer |
| src/shared/api.ts | 33:3 | TS6196 'ShellSecurityHints' is declared but never used. | electron, renderer |
| src/shared/api.ts | 96:3 | TS6196 'BrowserDependencyFailureCode' is declared but never used. | electron, renderer |
| src/shared/api.ts | 97:3 | TS6196 'BrowserDependencyToolError' is declared but never used. | electron, renderer |
| src/shared/configSetTypeGate.ts | 17:6 | TS6196 '_WechatRequired' is declared but never used. | electron, renderer |
| src/shared/domainTypes.ts | 6:34 | TS6133 'DEFAULT_WIKI_ROOT_DIRNAME' is declared but its value is never read. | electron, renderer |
| src/shared/domainTypes.ts | 886:1 | TS6192 All imports in import declaration are unused. | electron, renderer |
| src/shared/domainTypes.ts | 891:1 | TS6192 All imports in import declaration are unused. | electron, renderer |
| src/shared/policy/policyEngine.ts | 286:36 | TS6133 'facts' is declared but its value is never read. | electron, renderer |
| src/shared/surfaceReplay.ts | 406:10 | TS6133 'replayCanonicalPayload' is declared but its value is never read. | electron, renderer |
| src/shared/turnCoordinator.ts | 466:13 | TS6133 'cancelled' is declared but its value is never read. | electron, renderer |
