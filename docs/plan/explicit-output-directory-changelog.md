# 显式输出目录与工作产物管理 — 灰度变更日志

> MVP 灰度切片（2026-07-18）

## 功能开关

- **配置键**：`config.artifactManagementEnabled`（设置 → 工具 → 工作产物 →「启用工作产物管理」）
- **默认值**：`false`（opt-in 灰度）
- **会话冻结**：开关仅在**创建会话时**从全局配置读取并写入 `sessions.metadata.artifactManagementEnabled`；后续修改设置不影响已有会话
- **互斥**：artifact 会话不执行旧 `workspaceLayout` 扩展名重定向、不写 `writeDirChoice` 运行语义

## 数据迁移 v2

- SQLite schema v2：新增 `session_artifacts`、`artifact_references`、`artifact_operations` 及索引
- v1 数据库启动时单事务升级到 v2；高版本库拒绝打开
- **不迁移** `sessions.metadata.writeDirChoice` → `artifactDefaultDir`；artifact 会话在下次正常 save 时剥离 `writeDirChoice`

## 旧行为保留与移除条件

| 旧能力 | artifact 会话 | legacy 会话（flag=false，保留一版） |
| --- | --- | --- |
| 扩展名→子目录重定向 | 禁用 | 仍可用 |
| WriteDirConfirmPanel / writeDir chip | 禁用 | 仍可用 |
| WorkspaceLayoutTab 设置 UI | 已替换为 ArtifactSettingsTab | 旧配置只读留 DB，设置页不再编辑映射 |

**移除旧 UI/重定向的前置条件**（记录门槛，尚未执行移除）：

1. AC-01～AC-40 核心集成测试通过（`artifactAcceptance.integration.test.ts` 等）
2. AC-01～AC-44 映射表可追溯（见 `explicit-output-directory-ac-mapping.md`）
3. 三类端到端场景自动化通过
4. Windows/Linux 路径安全人工验证完成

当前状态：**灰度 gate 1～3 已通过**（2026-07-18 CI/本地 `npm test`）；gate 4 Windows/Linux 仍为 manual。

## 恢复与限制

- Relocate 非终态 operation 可在启动时恢复；失败进入 `recovery_required` 需人工介入（见 `relocateRecovery.test.ts`）
- 写入成功但 artifact 登记失败：工具结果失败，审计 `artifact.register.failed`，文件已落盘需用户核对
- 工作区 profile 漂移：`ARTIFACT_WORKSPACE_CHANGED` 阻断 mutation

## 不在 MVP 范围内

- 完全删除 legacy workspaceLayout 代码（仍 behind flag=false）
- 自动迁移历史 writeDirChoice 为 artifact 默认目录
- Windows junction 自动化（标记 manual）
- 全仓库 i18n strict 清零（既有 ~290 处硬编码中文未在本特性范围修复）

## 验证记录（2026-07-18）

- `npm test` — 见 Section 12 实施提交证据
- `npm run typecheck:shared` / `typecheck:renderer` — 通过
- `npm run i18n:check` — 通过（新增 `artifactSettings.*` keys）
- `npm run i18n:check:strict` — **既有 290 处失败，非本特性新增**；本特性新增文案均已 i18n 化
- `npm run build` — 通过

## 评审修复（2026-07-18）

对照 `docs/review/explicit-output-directory-tdd-implementation-review.md` 已修复 Critical #1–#4 与 Required #5–#12：

- 生产 resolve 接线：evidence 校验/消费、`existingArtifact`、`packagePrimaryPath`
- 全 kind decision options + cancel 中断 wait + `consumeAsUserDecision`（无 waiter 不消费）
- 登记 realpath / 相对 canonical / identity；delete tombstone 可释放；lease 统一 key；Windows 默认 `process.platform`
- relocate `backup_committed` 前进恢复；`deleteSession` 终态含 `rolled_back`
- AC 映射表区分生产链路 vs helper；核心 AC-07/10/15/18 改为经 `prepareArtifactToolWrite`

灰度 gate：**Critical/Required 代码修复已落地**；Windows/Linux 路径安全人工验证仍为 manual pending。
