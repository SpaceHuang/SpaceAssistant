# 安全策略三阶段架构源码基线

- 基线日期：2026-10-15（Asia/Shanghai）
- 源码 commit：`8c0d2a89f78816d4a7d1b1a1890ad59f608cee4f`（`Fix synchronous write permit reapproval`）
- 实施分支：`codex/security-policy-three-stage-20261015`
- worktree：`.worktrees/security-policy-three-stage`
- 应用版本：`0.2.7`（`package.json`）
- 产品名 / app id：`SpaceAssistant` / `com.spaceassistant.app`
- SQLite schema version：`99`（`electron/database/schema.ts`）
- 构建入口：`npm run build`，包含托盘图标、渲染进程和 Electron 主进程；主进程完整构建会清理 `dist-electron/` 并执行边界门禁。
- 测试入口：`npm test`，当前执行 Electron 与 renderer 两个 Vitest project。

## 配置与 schema 基线

源码基线由上述 commit 固定。持久化配置由 SQLite `configs` 表及数据库迁移管理；迁移版本以 `DB_SCHEMA_VERSION=99` 为准。运行时用户配置、真实数据库内容不纳入源码基线，修改前应通过对应存储契约和迁移测试核对。策略规则/档位配置和 lock/floor 的具体现状将在 Phase 0 inventory 中逐调用链记录，不在此预设未验证结论。

## 外部证据可用性与缺口

| 证据项 | 当前可用性 | 保管人 / 来源 | 对源码交付的影响 |
|---|---|---|---|
| 源码与自动化测试 | 可用；本 worktree 固定在上述 commit 并承载本次变更 | Git 仓库 | 可完成静态追踪、单测、架构门禁、类型检查和构建验收 |
| 正式安装包及其构建清单 | 当前未提供 | 待发布/制品保管方提供 | 不能声称已在正式包复现原生产问题；不阻塞源码交付 |
| 原生产会话日志、对应数据库与运行配置 | 当前未提供 | 待生产数据保管方提供 | 不能声称已验证原生产现场；仅限制生产复现声明 |
| 跨平台文件系统行为（含 symlink/hardlink、原子写差异） | 当前环境为 macOS；其他平台真机环境未确认 | 各平台验收环境待提供 | 可做可控单测/mock；真实跨平台验收记待外部验证 |
| 真实 IM（微信/飞书）及 MCP 服务、测试账号 | 当前未连接/未提供 | 对应服务和账号保管方待提供 | mock 集成可验证调用顺序和零副作用；真实 dispatch 结果待外部验收 |

源码阶段的结论仅基于当前仓库 commit、测试和构建证据。没有对应正式包和生产数据时，不把自动化 mock 结果表述为原生产问题复现；没有真实服务时，不把 mock dispatch 表述为端到端渠道验收。
