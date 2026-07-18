# 显式输出目录 AC-01～AC-44 映射表

> 更新：2026-07-18（Section 12 验收）  
> 说明：每条 AC 至少链接到一个自动化测试（`file:line`）或明确的人工跨平台用例。

| AC | 描述摘要 | 证据 |
| --- | --- | --- |
| AC-01 | 新源码/测试进项目约定位置 | `electron/artifacts/artifactAcceptance.integration.test.ts` dev scenario AC-02/05 |
| AC-02 | migration SQL 保持 migration 路径 | `electron/artifacts/artifactResolver.test.ts:5-14` |
| AC-03 | 临时验证脚本进 scratch | `artifactAcceptance.integration.test.ts` AC-03/36 |
| AC-04 | 项目变更摘要含修改与新建 | `artifactAcceptance.integration.test.ts` AC-04; `completionSummary.test.ts:5-14` |
| AC-05 | docs 路径归入项目变更 | `artifactAcceptance.integration.test.ts` AC-02/05 |
| AC-06 | 未指定纳入项目时归入工作包 | `artifactAcceptance.integration.test.ts` AC-10; `artifactResolver.test.ts:38-43` |
| AC-07 | 指定文件路径精确写入 | `artifactAcceptance.integration.test.ts` AC-07; `artifactResolver.test.ts:24-28` |
| AC-08 | 指定目录写入该目录 | `artifactResolver.test.ts:31-36` |
| AC-09 | 合法唯一显式位置不弹目录选择 | `artifactAcceptance.integration.test.ts` AC-07 |
| AC-10 | 未指定位置首次询问 | `artifactAcceptance.integration.test.ts` AC-10 |
| AC-11 | 两个精确交付文件分别写入 | `artifactAcceptance.integration.test.ts` AC-07/12 |
| AC-12 | 主成果与支撑/SQL 按字面路径 | `artifactAcceptance.integration.test.ts` AC-07/12 |
| AC-13 | 多个目录级位置逐个询问 | `artifactResolver.test.ts:53-58` ownership decision |
| AC-14 | 无未指定支撑时不建空 .materials | `artifactResolver.test.ts:45-51` |
| AC-15 | SQL/脚本可进 .materials | `artifactAcceptance.integration.test.ts` AC-15 |
| AC-16 | 指定路径/工作包的 PDF 保留 | `referenceRetention.test.ts:16-20`; `registerReferenceMetadata` 测试 |
| AC-17 | 普通检索不创建本地资料 | `referenceRetention.test.ts:5-8`; `artifactAcceptance.integration.test.ts` AC-41 |
| AC-18 | 持续编辑 draft.md 复用 artifactId | `artifactAcceptance.integration.test.ts` AC-18 |
| AC-19 | draft.md 原地定稿不强制 final.md | `artifactAcceptance.integration.test.ts` AC-18/19 |
| AC-20 | 仅保留链接时不复制 PDF | **manual** — 需 UI 确认 reference-retention 选择；逻辑见 `referenceRetention.ts` |
| AC-21 | 取消主成果后待决定资料仍可见 | `artifactAcceptance.integration.test.ts` AC-21/26 |
| AC-22 | scratch 仅写入 runs 目录 | `artifactAcceptance.integration.test.ts` AC-22 |
| AC-23 | 首次 scratch 前 Git 策略询问 | `scratchGitPolicy.test.ts:18-31` |
| AC-24 | add-ignore 仅追加精确规则 | `scratchGitPolicy.test.ts:34-41` |
| AC-25 | keep-visible / cancel 分支 | `scratchGitPolicy.test.ts:18-31` |
| AC-26 | 可清理 scratch、保护 reference | `artifactAcceptance.integration.test.ts` AC-21/26; `artifactCleanSession.test.ts` |
| AC-27 | relocate 后唯一编辑位置 | `ArtifactRelocateDialog.test.tsx`; `relocateService.test.ts` |
| AC-28 | 使用中 scratch 不可清理 | `artifactCleanSession.test.ts`; `artifactAcceptance.integration.test.ts` AC-28 |
| AC-29 | 工作区外路径拒绝 | `artifactSafeTarget.test.ts`; `pathSecurity` 既有测试 |
| AC-30 | Windows 设备名/UNC/junction | **manual Windows** — `artifactPathIdentity.test.ts` POSIX 自动化；junction 见 Section 3 备注 |
| AC-31 | 异平台绝对路径拒绝 | `artifactSafeTarget.test.ts` |
| AC-32 | 伪造路径不能经 artifact IPC 越界 | `artifactIpc.test.ts`; `artifactMutationGuard.ts` |
| AC-33 | scratch 可读项目相对资源 | `artifactAcceptance.integration.test.ts` AC-33 |
| AC-34 | 写入失败不回退污染根目录 | `toolLoopArtifactFlow.test.ts`; `artifactAcceptance.integration.test.ts` AC-39 |
| AC-35 | 项目变更不触发归属确认 | `artifactAcceptance.integration.test.ts` AC-01/35 |
| AC-36 | 一次性脚本进 scratch 无归属确认 | `artifactAcceptance.integration.test.ts` AC-03/36 |
| AC-37 | 同用途文件组 ownership 决策一次 | `artifactResolver.test.ts:53-58` |
| AC-38 | 文件/目录类型冲突拒绝 | `artifactAcceptance.integration.test.ts` AC-38; `pathTypeDecision` 测试 |
| AC-39 | 不存在 trailing `/` 按目录；无扩展名二义询问 | `pathTypeDecision` 测试; `artifactAcceptance.integration.test.ts` AC-39 |
| AC-40 | 不因名称形式强猜类型 | `pathTypeDecision` 测试; `artifactAcceptance.integration.test.ts` AC-38/40 |
| AC-41 | 普通检索不写本地 | `artifactAcceptance.integration.test.ts` AC-41 |
| AC-42 | 指定路径或工作包资料保存 | `artifactAcceptance.integration.test.ts` AC-42 |
| AC-43 | 无工作包 save 提供 long-term/pending/cancel | `artifactAcceptance.integration.test.ts` AC-43 |
| AC-44 | Agent 建议暂存需轻量确认 | `artifactAcceptance.integration.test.ts` AC-44; `ArtifactDecisionCard.test.tsx` |

## 跨平台路径安全人工验证

| 平台 | 状态 | 范围 |
| --- | --- | --- |
| macOS (darwin) | **已完成**（本机开发/测试环境） | POSIX realpath、symlink 拒绝、路径 identity — 自动化测试 + 本地手工 spot-check |
| Windows | **待人工** | 盘符/UNC/设备名/尾随点空格/junction；需在 Windows 打包或 dev 环境复跑 `artifactPathIdentity.test.ts` 与 Section 3 安全用例 |
| Linux | **待人工** | POSIX symlink、路径 identity；建议在 Linux CI 或本地复跑 `electron/artifacts/*safe*` 与 `pathSecurity` 测试 |

## Section 12 专项

| 任务 | 证据 |
| --- | --- |
| 旧 workspaceLayout 不触发 artifact 会话重定向 | `legacyMigration.test.ts`; `featureFlag.test.ts`; `toolChatLoop.ts` `shouldUseLegacyWorkspaceRedirect` 门控 |
| writeDirChoice 不迁移 artifactDefaultDir | `legacyMigration.test.ts` |
| ArtifactSettingsTab 替换 WorkspaceLayoutTab | `ArtifactSettingsTab.test.tsx` |
| 旧 WriteDir UI 门控 | `legacyWriteDirUi.test.ts`; `ChatView.tsx` |
| 三类端到端场景 | `artifactAcceptance.integration.test.ts` dev / analysis / research 分组 |
