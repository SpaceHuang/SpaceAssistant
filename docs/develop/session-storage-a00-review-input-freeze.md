# A-00 工作区审阅输入冻结清单

- 生成时间：2026-10-05T19:17:58+08:00
- 仓库：`/Users/space/Documents/Develop/SpaceAssistant/.worktrees/session-storage-refactor-tdd`
- HEAD：`2961af96b1b02e297e2478b6297e592d9d9a40fb`
- `origin/main`：`5440f7764b92d2512593c7bf139c21958b7f26a0`
- 冻结输入路径数：122（tracked 67；untracked 55）
- 对账：`git status --porcelain=v1 -uall` 共 122 行；清单逐行映射，漏项 0、重复项 0。
- 分类：8 个唯一归属类别；未分类路径数 0。
- 说明：这是审阅输入快照。该清单文件在快照生成后新增，故不属于被冻结输入；后续变更应另建快照，不回写本清单。

| 状态 | 路径 | 唯一归属 | 差异摘要/文件摘要 |
| --- | --- | --- | --- |
| tracked ` M` | `.gitignore` | 构建/验证配置与资源边界 | 增 3 / 删 0 行 |
| tracked ` M` | `docs/develop/session-storage-refactor-migration-plan.md` | 存储重构计划与证据 | 增 52 / 删 24 行 |
| tracked ` M` | `docs/develop/session-storage-refactor-technical-design.md` | 存储重构计划与证据 | 增 350 / 删 24 行 |
| tracked ` M` | `docs/review/2026-10-03-session-storage-rollback-floor-audit.md` | 存储重构计划与证据 | 增 292 / 删 5 行 |
| tracked ` M` | `electron/agentLogger/agentLogProjection.test.ts` | M4-2 观察记录 | 增 17 / 删 0 行 |
| tracked ` M` | `electron/agentLogger/agentLogProjection.ts` | M4-2 观察记录 | 增 2 / 删 1 行 |
| tracked ` M` | `electron/agentLogger/agentLogger.test.ts` | M4-2 观察记录 | 增 17 / 删 0 行 |
| tracked ` M` | `electron/agentLogger/agentLogger.ts` | M4-2 观察记录 | 增 4 / 删 0 行 |
| tracked ` M` | `electron/agentLogger/types.ts` | M4-2 观察记录 | 增 2 / 删 0 行 |
| tracked ` M` | `electron/appIpc.sessionUpdate.test.ts` | 主线集成与跨层持久化交叉点 | 增 56 / 删 0 行 |
| tracked ` M` | `electron/database/index.ts` | 主线集成与跨层持久化交叉点 | 增 2 / 删 2 行 |
| tracked ` M` | `electron/database/migrations.agentHistory.test.ts` | 主线集成与跨层持久化交叉点 | 增 137 / 删 4 行 |
| tracked ` M` | `electron/database/migrations.sessionContentCutover.test.ts` | 主线集成与跨层持久化交叉点 | 增 8 / 删 8 行 |
| tracked ` M` | `electron/database/migrations.sourceTruthSpillGc.test.ts` | 主线集成与跨层持久化交叉点 | 增 3 / 删 3 行 |
| tracked ` M` | `electron/database/migrations.ts` | 主线集成与跨层持久化交叉点 | 增 148 / 删 1 行 |
| tracked ` M` | `electron/database/migrations.v11.test.ts` | 主线集成与跨层持久化交叉点 | 增 1 / 删 1 行 |
| tracked ` M` | `electron/database/operations.test.ts` | 主线集成与跨层持久化交叉点 | 增 170 / 删 1 行 |
| tracked ` M` | `electron/database/operations.ts` | 主线集成与跨层持久化交叉点 | 增 116 / 删 28 行 |
| tracked ` M` | `electron/database/schema.ts` | 主线集成与跨层持久化交叉点 | 增 187 / 删 1 行 |
| tracked ` M` | `electron/database/sessionStorageProfile.test.ts` | M4-4/5 测量与估算 | 增 45 / 删 1 行 |
| tracked ` M` | `electron/database/sessionStorageProfile.ts` | M4-4/5 测量与估算 | 增 30 / 删 5 行 |
| tracked ` M` | `electron/database/sqliteStore.ts` | 主线集成与跨层持久化交叉点 | 增 16 / 删 0 行 |
| tracked ` M` | `electron/database/thinkingEffort.test.ts` | 主线集成与跨层持久化交叉点 | 增 1 / 删 1 行 |
| tracked ` M` | `electron/database/usageStatsFacts.test.ts` | 主线集成与跨层持久化交叉点 | 增 22 / 删 3 行 |
| tracked ` M` | `electron/ipc/agentProtocolIpc.ts` | 主线集成与跨层持久化交叉点 | 增 32 / 删 0 行 |
| tracked ` M` | `electron/ipc/sessionIpc.ts` | 主线集成与跨层持久化交叉点 | 增 152 / 删 1 行 |
| tracked ` M` | `electron/main.ts` | 主线集成与跨层持久化交叉点 | 增 83 / 删 9 行 |
| tracked ` M` | `electron/messageCodec.ts` | 主线集成与跨层持久化交叉点 | 增 7 / 删 1 行 |
| tracked ` M` | `electron/outbound/outboundAcceptor.test.ts` | 主线集成与跨层持久化交叉点 | 增 445 / 删 1 行 |
| tracked ` M` | `electron/outbound/outboundAcceptor.ts` | 主线集成与跨层持久化交叉点 | 增 330 / 删 15 行 |
| tracked ` M` | `electron/runtime/agentSdkUsageRecorder.test.ts` | 主线集成与跨层持久化交叉点 | 增 6 / 删 3 行 |
| tracked ` M` | `electron/runtime/agentSdkUsageRecorder.ts` | 主线集成与跨层持久化交叉点 | 增 7 / 删 1 行 |
| tracked ` M` | `electron/runtime/canonicalHistory.test.ts` | 主线集成与跨层持久化交叉点 | 增 15 / 删 0 行 |
| tracked ` M` | `electron/runtime/canonicalHistory.ts` | 主线集成与跨层持久化交叉点 | 增 1 / 删 1 行 |
| tracked ` M` | `electron/runtime/hostedTurnHandoff.test.ts` | 主线集成与跨层持久化交叉点 | 增 40 / 删 0 行 |
| tracked ` M` | `electron/runtime/invocationAssembler.test.ts` | 主线集成与跨层持久化交叉点 | 增 24 / 删 1 行 |
| tracked ` M` | `electron/runtime/invocationAssembler.ts` | 主线集成与跨层持久化交叉点 | 增 13 / 删 6 行 |
| tracked ` M` | `electron/runtime/sessionTranscriptProjection.test.ts` | 主线集成与跨层持久化交叉点 | 增 20 / 删 3 行 |
| tracked ` M` | `electron/runtime/sessionTranscriptProjection.ts` | 主线集成与跨层持久化交叉点 | 增 37 / 删 1 行 |
| tracked ` M` | `electron/runtime/sqliteAgentHistory.test.ts` | 主线集成与跨层持久化交叉点 | 增 102 / 删 0 行 |
| tracked ` M` | `electron/runtime/sqliteAgentHistory.ts` | 主线集成与跨层持久化交叉点 | 增 128 / 删 53 行 |
| tracked ` M` | `electron/sessionBackupManager.test.ts` | 主线集成与跨层持久化交叉点 | 增 48 / 删 2 行 |
| tracked ` M` | `electron/sessionTitleSuggest.outlet.test.ts` | 主线集成与跨层持久化交叉点 | 增 89 / 删 1 行 |
| tracked ` M` | `electron/sessionTitleSuggest.ts` | 主线集成与跨层持久化交叉点 | 增 30 / 删 20 行 |
| tracked ` M` | `electron/storage/sessionStorageMaintenance.test.ts` | M4-6…M4-9 清理/维护安全 | 增 248 / 删 0 行 |
| tracked ` M` | `electron/storage/sessionStorageMaintenance.ts` | M4-6…M4-9 清理/维护安全 | 增 118 / 删 23 行 |
| tracked ` M` | `electron/toolChatLoop.invocation.test.ts` | 主线集成与跨层持久化交叉点 | 增 84 / 删 1 行 |
| tracked ` M` | `electron/toolChatLoop.ts` | 主线集成与跨层持久化交叉点 | 增 21 / 删 4 行 |
| tracked ` M` | `electron/turnCoordinatorStorage.test.ts` | 主线集成与跨层持久化交叉点 | 增 27 / 删 0 行 |
| tracked ` M` | `electron/turnCoordinatorStorage.ts` | 主线集成与跨层持久化交叉点 | 增 2 / 删 0 行 |
| tracked ` M` | `electron/usageStats/usageStatsMaintenance.test.ts` | M4-6…M4-9 清理/维护安全 | 增 3 / 删 2 行 |
| tracked ` M` | `electron/usageStats/usageStatsMaintenance.ts` | M4-6…M4-9 清理/维护安全 | 增 3 / 删 0 行 |
| tracked ` M` | `electron/usageStats/usageStatsRecorder.test.ts` | 主线集成与跨层持久化交叉点 | 增 28 / 删 0 行 |
| tracked ` M` | `electron/usageStats/usageStatsRecorder.ts` | 主线集成与跨层持久化交叉点 | 增 12 / 删 0 行 |
| tracked ` M` | `package.json` | 构建/验证配置与资源边界 | 增 11 / 删 2 行 |
| tracked ` M` | `scripts/after-pack.cjs` | 构建/验证配置与资源边界 | 增 122 / 删 0 行 |
| tracked ` M` | `scripts/session-storage-cold-start-profile.ts` | 构建/验证配置与资源边界 | 增 125 / 删 11 行 |
| tracked ` M` | `src/renderer/components/Chat/MessageInput.test.tsx` | 主线集成与跨层持久化交叉点 | 增 28 / 删 0 行 |
| tracked ` M` | `src/shared/api.ts` | 主线集成与跨层持久化交叉点 | 增 19 / 删 1 行 |
| tracked ` M` | `src/shared/assistantFactAggregator.ts` | 主线集成与跨层持久化交叉点 | 增 11 / 删 1 行 |
| tracked ` M` | `src/shared/domainTypes.ts` | 主线集成与跨层持久化交叉点 | 增 5 / 删 0 行 |
| tracked ` M` | `src/shared/outboundProtocol.ts` | 主线集成与跨层持久化交叉点 | 增 4 / 删 0 行 |
| tracked ` M` | `src/shared/skillHintRecords.ts` | 主线集成与跨层持久化交叉点 | 增 14 / 删 0 行 |
| tracked ` M` | `src/shared/turnBoundaryCompaction.test.ts` | 主线集成与跨层持久化交叉点 | 增 16 / 删 1 行 |
| tracked ` M` | `src/shared/turnBoundaryCompaction.ts` | 主线集成与跨层持久化交叉点 | 增 34 / 删 1 行 |
| tracked ` M` | `src/shared/turnCoordinator.test.ts` | 主线集成与跨层持久化交叉点 | 增 32 / 删 0 行 |
| tracked ` M` | `src/shared/turnCoordinator.ts` | 主线集成与跨层持久化交叉点 | 增 28 / 删 14 行 |
| untracked `??` | `docs/develop/session-storage-reader-architecture-audit.md` | 存储重构计划与证据 | SHA-256 defff21c4fdf68fc12a3d285bfbbda5f64d7a668272c4be6e5476e3f6fee647a; 7228 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-cleanup-estimate-2026-10-04.json` | 存储重构计划与证据 | SHA-256 a2b48b517b92c93616d6643f8c7a03e38f193cd7aede838f2bafc9f89c1662fb; 28267 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-cleanup-estimate-2026-10-04.md` | 存储重构计划与证据 | SHA-256 a4b3a6649d0224c53973e55a38eef2e20240521c4aaa6645d41a66f0f19f8d19; 2583 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-m4-3-status.md` | 存储重构计划与证据 | SHA-256 1e1d991f407b590722a5f7966f86b96f4f09f2b5b33a53e7790784acfd83b7fc; 24109 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-maintenance-profile-2026-10-04.json` | 存储重构计划与证据 | SHA-256 51a3379a95d0db3f627f12d9e1bf213a144477159eee5d0fa34a2ef89829a1b1; 56515 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-maintenance-profile-2026-10-04.md` | 存储重构计划与证据 | SHA-256 a6a37e2b22d283a92b2c726c297e3b36971994475f4610e3f9980502f6420856; 3449 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-maintenance-profile-2026-10-05.json` | 存储重构计划与证据 | SHA-256 1e24e2b9cba6526c2cc53848b5326ca3d0d104dd8a335ce13732b431b2110d8c; 60213 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-maintenance-profile-2026-10-05.md` | 存储重构计划与证据 | SHA-256 3fc01ccaf9ea38d7ddc14ee6b2c1ecb81d58c93b299a7329b84521fb1495e63a; 3606 bytes |
| untracked `??` | `docs/develop/session-storage-refactor-profile-baseline-2026-10-04.md` | 存储重构计划与证据 | SHA-256 3fce74711b1d4767b50e0fd48b32d771e4e91ab3890d5712920df62a2901a7fb; 3050 bytes |
| untracked `??` | `electron/database/migrations.mainSchemaCompatibility.test.ts` | 主线集成与跨层持久化交叉点 | SHA-256 a12cb9df12efc17e96f4e6b5b64c55708930379f26c8260c4a28e7b5666d0e97; 13444 bytes |
| untracked `??` | `electron/database/sessionStorageCleanupEstimate.test.ts` | M4-4/5 测量与估算 | SHA-256 c11a3e8be57db8d7481a164dbadd64a7d643c488bc8028a84dde6236d4b06bc9; 6371 bytes |
| untracked `??` | `electron/database/sessionStorageCleanupEstimate.ts` | M4-4/5 测量与估算 | SHA-256 7469674977a922403e428926a0648cb7335e692d6d581edef58ddc32f1457653; 13344 bytes |
| untracked `??` | `electron/runtime/sessionProjectionConsistencyAudit.test.ts` | M3 投影迁移/审计 | SHA-256 4e67dcc2e38b8ad3a0e52775256d48c9a2bdc7181a6803861297eadf170a6e08; 15789 bytes |
| untracked `??` | `electron/runtime/sessionProjectionConsistencyAudit.ts` | M3 投影迁移/审计 | SHA-256 a08f1bd058c302a5f8b1512284cff699db71aeb791442f44bd6435f997437f0c; 26546 bytes |
| untracked `??` | `electron/runtime/sessionProjectionLegacyBaseline.test.ts` | M3 投影迁移/审计 | SHA-256 973ac357992728281d0b9cad44feb3ed9b29c35678120fac89e3e609df3e23d8; 13966 bytes |
| untracked `??` | `electron/runtime/sessionProjectionLegacyBaseline.ts` | M3 投影迁移/审计 | SHA-256 6f5fda6aa35f59f1741687b0c26ed2a4f8441c150828cd0a7952b75af69529fa; 5088 bytes |
| untracked `??` | `electron/runtime/sessionProjectionLegacyQueue.test.ts` | M3 投影迁移/审计 | SHA-256 a643eb3fbb36a081382a191cd093e8509a84e9b3d254f8ac2713c9667e444900; 8568 bytes |
| untracked `??` | `electron/runtime/sessionProjectionMigration.test.ts` | M3 投影迁移/审计 | SHA-256 661ce1acc64249775436a28bcaa1c948e7eb9660e20a953b61fea81c5501ccdb; 27622 bytes |
| untracked `??` | `electron/runtime/sessionProjectionMigration.ts` | M3 投影迁移/审计 | SHA-256 86de141cf5713980305c829784ee472851693a3736191b2a6db850b71ce028c2; 25383 bytes |
| untracked `??` | `electron/runtime/sessionProjectionMigrationInventory.test.ts` | M3 投影迁移/审计 | SHA-256 aab6635d6eec799a6258c10f651db304e789671b547678234e364e4a411c1001; 20650 bytes |
| untracked `??` | `electron/runtime/sessionProjectionMigrationInventory.ts` | M3 投影迁移/审计 | SHA-256 bd9a282954add578c719103cd1406ab417c821cdb38cf0f1f28e60220a40ecdb; 13859 bytes |
| untracked `??` | `electron/runtime/sessionProjectionObservation.test.ts` | M3 投影迁移/审计 | SHA-256 0c8f10836c35be73c18b3fdc4d8e8622e965f5d8c0a22dbd0bbcdc07da5b143b; 4767 bytes |
| untracked `??` | `electron/runtime/sessionProjectionObservation.ts` | M3 投影迁移/审计 | SHA-256 0805758b948f29d9565d8ea204f7270144b5b57a52d91d2a5fd2eeb86c2fbf13; 5479 bytes |
| untracked `??` | `electron/runtime/sessionProjectionObservationReport.test.ts` | M3 投影迁移/审计 | SHA-256 801377fb87b02a60a9289f074124fc3dab44c8246b9a6fe703efcb8c415f948f; 5660 bytes |
| untracked `??` | `electron/runtime/sessionProjectionRetirementCandidates.test.ts` | M3 投影迁移/审计 | SHA-256 303175848080d2dd77cde403eecd4a3e4496e284924a6e95fa6edddc98c293e3; 7058 bytes |
| untracked `??` | `electron/runtime/sessionProjectionRetirementCandidates.ts` | M3 投影迁移/审计 | SHA-256 7f5bf9eebd134656e7d5d1284cabc68ac1e6c1ee7ca238e8187ea14339777210; 4009 bytes |
| untracked `??` | `electron/runtime/sessionStorageBuildIdentity.test.ts` | M3 投影迁移/审计 | SHA-256 98b040b312e512a9be7cf7d560daf3e82b000de712adc6b05303763f85893805; 2330 bytes |
| untracked `??` | `electron/runtime/sessionStorageCleanupProduction.test.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 ce33236edf5b15276abec544231afd8e7e76f44e5ed946ba6a7eb371a2f569c4; 1522 bytes |
| untracked `??` | `electron/runtime/sessionStorageCleanupProduction.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 008b03e16315b74522463c9af65dcc8a9d98ceed0e781b6df59a753caf3ab4f9; 3339 bytes |
| untracked `??` | `electron/runtime/sessionStorageCleanupReleaseConfig.test.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 00e7ef265f19802d2a9717bb7dbd544721397888d6d5be703e619695ef7b2085; 3764 bytes |
| untracked `??` | `electron/runtime/sessionStorageCleanupReleaseConfig.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 2b1496ee0a0408d1c32168d83e5b5e3e6ac081fb9cee9c167675b4962931302f; 3550 bytes |
| untracked `??` | `electron/runtime/sessionStorageCleanupReleaseGate.test.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 83f3fd935cfa330ce839cb34504a38f7ced6095978d2b6fa484d197fafb5a3a9; 6967 bytes |
| untracked `??` | `electron/runtime/sessionStorageCleanupReleaseGate.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 9ddde977f41e331b5f95dcce11b53c67dfe6f4e74a079c526dbbe3a6ce52108d; 5908 bytes |
| untracked `??` | `electron/sessionCompactionLock.test.ts` | 主线集成与跨层持久化交叉点 | SHA-256 b12cb7664da2a314b2f47664307ed55970c186a80b4cea7d5832423cf800e485; 1812 bytes |
| untracked `??` | `electron/sessionCompactionLock.ts` | 主线集成与跨层持久化交叉点 | SHA-256 d8423b569a3120043e3d80e7244bb24b9f2082602d20d09cf16bff604889557b; 2553 bytes |
| untracked `??` | `electron/sessionContextCompaction.test.ts` | 主线集成与跨层持久化交叉点 | SHA-256 778d43997f275caf10d0a03cbf33cf30e61b041b9338d9d15559924a80261fcf; 8809 bytes |
| untracked `??` | `electron/sessionContextCompaction.ts` | 主线集成与跨层持久化交叉点 | SHA-256 1eaef9d3914eb0f9f5407babfbc0ce2beda48569cd84e3e1cc5a558874bd8218; 7127 bytes |
| untracked `??` | `electron/sessionContextSummary.test.ts` | 主线集成与跨层持久化交叉点 | SHA-256 46220505e80b81793c48bf9f6f10cf8876bbbd39e601a23b49b9878e8740f910; 2095 bytes |
| untracked `??` | `electron/sessionContextSummary.ts` | 主线集成与跨层持久化交叉点 | SHA-256 6a1adca13d3837a8514135c1ae0e958c8df303aa429e10cd935ecde981f4300f; 2756 bytes |
| untracked `??` | `electron/sessionDirectoryGrants.test.ts` | 主线目录授权复用/集成冲突 | SHA-256 01b4baccf2f0c40961f28ca4a5cd257b56b81c7c020fdefb0af4682ab2812519; 6099 bytes |
| untracked `??` | `electron/sessionDirectoryGrants.ts` | 主线目录授权复用/集成冲突 | SHA-256 672ed31eb3dbb8c049c70acd0a63168363539a57b252ee30f4946fc26f1d8247; 5273 bytes |
| untracked `??` | `electron/storage/sessionMessageContentCleanupMaintenance.test.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 2bd94f08470edb9cca7ed59e700dc50fa9a87ae47190f1438cb62880c0e433cc; 11083 bytes |
| untracked `??` | `electron/storage/sessionMessageContentCleanupMaintenance.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 6dea34ff2c0c9e5412001cdae1d7fe149bcedec59c28bb7a118f2f75931b54b9; 6833 bytes |
| untracked `??` | `electron/tools/afterPackCleanupReleaseMetadata.test.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 1ed632b3ca1f6783137f50572f50aba2299e516c79649b8efb931e4593a6787e; 7845 bytes |
| untracked `??` | `resources/session-storage-cleanup-compatibility.json` | M4-6…M4-9 清理/维护安全 | SHA-256 38e0b9de817f645c4bec37c0d4a3e58baecccb040f5718dc069a72c7385a0bed; 5 bytes |
| untracked `??` | `resources/session-storage-cleanup-deployment.json` | M4-6…M4-9 清理/维护安全 | SHA-256 267584e31e2360a8c311fcd82b927029b02ad1539f7d64a7d4f919192444428d; 94 bytes |
| untracked `??` | `scripts/check-session-storage-cleanup-boundary.mjs` | M4-6…M4-9 清理/维护安全 | SHA-256 7e87468e437f34f78a7ba916c471eebcab6fd8eb02364fdba97cd9caf93c31a9; 1612 bytes |
| untracked `??` | `scripts/create-session-storage-cleanup-fixture.ts` | M4-6…M4-9 清理/维护安全 | SHA-256 3709421c9b55973d8340a007b9f82e2e704ab4dc5d0801f98e92149b235d81e9; 5289 bytes |
| untracked `??` | `scripts/create-session-storage-profile-fixture.ts` | M4-4/5 测量与估算 | SHA-256 c1ef93a76772163ce0768e10a90308dee78a471b9652d7a430c08bd23bd0aa55; 4339 bytes |
| untracked `??` | `scripts/session-projection-observation-report.ts` | 构建/验证配置与资源边界 | SHA-256 8d484c4fc35b220fb6a56901c9a5a67cb90f17ece6e7a14e9eab6f882f22f286; 6431 bytes |
| untracked `??` | `scripts/session-projection-scope-profile-audit.ts` | 构建/验证配置与资源边界 | SHA-256 74c0acf9e97f074da84f372749d87e3f538eec2cd33ab5e898a9874f21629566; 8089 bytes |
| untracked `??` | `scripts/session-storage-cleanup-estimate.ts` | M4-4/5 测量与估算 | SHA-256 441170accea777eb21b9619518f66a927b385de115974f5e4bfbed4fa94a25ee; 521 bytes |
| untracked `??` | `scripts/session-storage-maintenance-profile.ts` | M4-4/5 测量与估算 | SHA-256 3768488e55fcbafe82ebd639b81592caedfb7601d941dc859794a548a4bbbb6c; 14023 bytes |
| untracked `??` | `src/shared/sessionDirectoryGrant.test.ts` | 主线目录授权复用/集成冲突 | SHA-256 225fcb6b6510466d4f8550b24ec46fb91353ceae9c7ddd15b50ae65f171a6271; 2199 bytes |
| untracked `??` | `src/shared/sessionDirectoryGrant.ts` | 主线目录授权复用/集成冲突 | SHA-256 342db589b5a58542a0486e2cba88ae7cd35040754249b47ec7d9d6aca70bace1; 3519 bytes |
