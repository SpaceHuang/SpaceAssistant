# 显式输出目录 AC-01～AC-44 映射表

> 更新：2026-07-18（评审 v2 修复后）  
> 说明：每条 AC 至少链接到一个自动化测试或明确的人工跨平台用例。  
> **证据层级**：`生产链路` = 经 `prepareArtifactToolWrite` / `resolveToolArtifactPath` / IPC；`helper` = 纯函数单测。

| AC | 描述摘要 | 证据 | 层级 |
| --- | --- | --- | --- |
| AC-01 | 新源码/测试进项目约定位置 | `artifactAcceptance.integration.test.ts` AC-02/05 | 生产链路 |
| AC-02 | migration SQL 保持 migration 路径 | `artifactAcceptance` + `artifactResolver.test.ts` | 生产链路 / helper |
| AC-03 | 临时验证脚本进 scratch | `artifactAcceptance` AC-03/36 | 生产链路 |
| AC-04 | 项目变更摘要含修改与新建 | `artifactAcceptance` AC-04; `completionSummary.test.ts` | helper |
| AC-05 | docs 路径归入项目变更 | `artifactAcceptance` AC-02/05 | 生产链路 |
| AC-06 | 未指定纳入项目时归入工作包 | `artifactAcceptance` AC-10 | 生产链路 |
| AC-07 | 指定文件路径精确写入 | `artifactAcceptance` AC-07（真实 evidence）; `reviewRemediation` 伪造拒绝 | 生产链路 |
| AC-08 | 指定目录写入该目录 | `artifactResolver.test.ts` | helper |
| AC-09 | 合法唯一显式位置不弹目录选择 | `artifactAcceptance` AC-07 | 生产链路 |
| AC-10 | 未指定位置首次询问且可完成选择 | `artifactAcceptance` AC-10（resume→ready）; `reviewRemediation` ownership/location | 生产链路 |
| AC-11 | 两个精确交付文件分别写入 | `artifactAcceptance` AC-07 | 生产链路 |
| AC-12 | 主成果与支撑/SQL 按字面路径 | `artifactAcceptance` AC-07 | 生产链路 |
| AC-13 | 多个目录级位置逐个询问 | `reviewRemediation` ownership resume; `artifactResolver` | 生产链路 |
| AC-14 | 无未指定支撑时不建空 .materials | `artifactResolver.test.ts` | helper |
| AC-15 | SQL/脚本可进 .materials | `artifactAcceptance` AC-15（经 repository package primary） | 生产链路 |
| AC-16 | 指定路径/工作包的 PDF 保留 | `referenceRetention.test.ts` | helper |
| AC-17 | 普通检索不创建本地资料 | `referenceRetention` + `artifactAcceptance` AC-41 | helper |
| AC-18 | 持续编辑 draft.md 复用 artifactId | `artifactAcceptance` AC-18（`prepareArtifactToolWrite`+db）; `reviewRemediation` | 生产链路 |
| AC-19 | draft.md 原地定稿不强制 final.md | `artifactAcceptance` AC-18/19 | 生产链路 |
| AC-20 | 仅保留链接时不复制 PDF | **manual** — reference-retention UI | manual |
| AC-21 | 取消主成果后待决定资料仍可见 | `artifactAcceptance` AC-21/26 | 生产链路 |
| AC-22 | scratch 仅写入 runs 目录 | `artifactAcceptance` AC-22 | 生产链路 |
| AC-23 | 首次 scratch 前 Git 策略询问 | `scratchGitPolicy.test.ts` | helper |
| AC-24 | add-ignore 仅追加精确规则 | `scratchGitPolicy.test.ts` | helper |
| AC-25 | keep-visible / cancel 分支 | `scratchGitPolicy.test.ts` | helper |
| AC-26 | 可清理 scratch、保护 reference | `artifactAcceptance` + `artifactCleanSession` | 生产链路 |
| AC-27 | relocate 后唯一编辑位置 | `reviewRemediation` register→relocate→delete; `relocateService` | 生产链路 |
| AC-28 | 使用中 scratch 不可清理 | `artifactCleanSession`（统一 lease key）; `reviewRemediation` write 阻塞 relocate | 生产链路 |
| AC-29 | 工作区外路径拒绝 | `safeTarget.test.ts`; `pathSecurity` | helper |
| AC-30 | Windows 设备名/UNC/junction | `pathIdentity` 默认 `process.platform`；**Windows 人工**仍建议 spot-check | helper + manual |
| AC-31 | 异平台绝对路径拒绝 | `safeTarget.test.ts` | helper |
| AC-32 | 伪造路径不能经 artifact IPC 越界 | `artifactIpc.test.ts` | 生产链路 |
| AC-33 | scratch 可读项目相对资源 | `artifactAcceptance` AC-33 | 生产链路 |
| AC-34 | 写入失败不回退污染根目录 | `toolLoopArtifactFlow` + `artifactAcceptance` AC-39 | 生产链路 |
| AC-35 | 项目变更不触发归属确认 | `artifactAcceptance` AC-01/35 | 生产链路 |
| AC-36 | 一次性脚本进 scratch 无归属确认 | `artifactAcceptance` AC-03/36 | 生产链路 |
| AC-37 | 同用途文件组 ownership 决策一次 | `reviewRemediation` ownership 全选项 resume | 生产链路 |
| AC-38 | 文件/目录类型冲突拒绝 | `artifactAcceptance` AC-38 | 生产链路 |
| AC-39 | trailing `/` / 二义询问 | `pathTypeDecision` + `artifactAcceptance` | helper / 生产链路 |
| AC-40 | 不因名称形式强猜类型 | `pathTypeDecision` + `artifactAcceptance` | helper / 生产链路 |
| AC-41 | 普通检索不写本地 | `artifactAcceptance` AC-41 | helper |
| AC-42 | 指定路径或工作包资料保存 | `artifactAcceptance` AC-42 | helper |
| AC-43 | 无工作包 save 提供 long-term/pending/cancel | `artifactAcceptance` AC-43 | helper |
| AC-44 | Agent 建议暂存需轻量确认 | `artifactAcceptance` AC-44; `ArtifactDecisionCard` | helper / UI |

## 跨平台路径安全人工验证

| 平台 | 状态 | 范围 |
| --- | --- | --- |
| macOS (darwin) | **已完成** | POSIX realpath、symlink 拒绝、path identity |
| Windows | **待人工** | 盘符/UNC/设备名/junction；生产已默认 `process.platform` |
| Linux | **待人工** | POSIX symlink spot-check |

## 评审修复回归（2026-07-18）

| 项 | 证据 |
| --- | --- |
| Critical #1–#3 / Required #8 | `reviewRemediation.test.ts`；`toolArtifactPath.ts` 生产接线 |
| Critical #4 | `buildArtifactDecisionOptions` 经 tool loop 下发；AC-10 resume→ready |
| Required #5/#11 | `reviewRemediation` cancel wait；bridge 无 waiter 不 consume |
| Required #6/#7/#12 | `writeRegistration` realpath/relative/identity；tombstone 释放；`process.platform` |
| Required #9/#10 | `relocateRecovery` **backup_committed 专用测**；`sessionDeletion` rolled_back |
| 统一 lease | `reviewRemediation` write 阻塞 delete / relocate |

## 评审 v2 修复回归（2026-07-18）

| 项 | 证据 |
| --- | --- |
| Critical #1 relocate 相对路径 + lease | `reviewRemediation` register→relocate→delete；write lease 拒 relocate；`relocateService`/`relocateRecovery` 相对回写 |
| Critical #2 ownership resume | `reviewRemediation` package→output-location→ready；project→ready |
| Required #3 远程 output-location | `artifactDecisionRemote(Integration)` `1 reports/final` → `change-directory:`（**库 API 已修**；飞书/微信 IM 入站接线另跟） |
| Required #4 evidence 最终 consume | `reviewRemediation` overwrite ready 后 unresolved 为空 |
| Required #5 验收去虚标 | AC-10 resume 完成；backup_committed 专用测；本表更新 |
