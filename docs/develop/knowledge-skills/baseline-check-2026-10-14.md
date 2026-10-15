# knowledge-skills baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- electron/skills electron/wiki` = **0 条**
> 被核验对象：[`技能与知识-现状.md`](./技能与知识-现状.md)（2026-10-14 新写；本主题 develop 侧原先无文档）

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| A1 Skills 安装（本地/GitHub）三件 | 现状 §1 | `ls electron/skills/skillInstall.ts electron/skills/skillGithubInstall.ts electron/skills/skillGithubArchive.ts` | 命中 | 一致 |
| A2 扫描/解析/路径 | 现状 §1 | `ls electron/skills/skillScanner.ts electron/skills/skillParser.ts electron/skills/skillPaths.ts` | 命中 | 一致 |
| A3 匹配与路由 | 现状 §1 | `ls electron/skills/skillMatcher.ts electron/skills/skillRouter.ts electron/skills/skillRoutingPrompt.ts` | 命中（`skillRouter` 2 文件引用） | 一致 |
| A4 内置技能目录 | 现状 §1 | `ls electron/skills/bundled` | 命中 | 一致 |
| A5 Wiki 项目存储/路径 | 现状 §2 | `ls electron/wiki/wikiProjectStore.ts electron/wiki/wikiProjects.ts electron/wiki/wikiPaths.ts` | 命中（`wikiProjectStore` 6 文件引用） | 一致 |
| A6 Wiki 挂载/迁移/初始化 | 现状 §2 | `ls electron/wiki/wikiMount.ts electron/wiki/wikiMigration.ts electron/wiki/wikiInit.ts` | 命中 | 一致 |
| A7 Wiki 写并发 | 现状 §2 | `ls electron/wiki/wikiWriteMutex.ts` | 命中（7 文件引用） | 一致 |
| A8 项目记忆与记忆资格 | 现状 §3 | `ls electron/projectMemory*.ts`；`rg -n 'deriveMemoryEligibility' src/shared/policy/memoryEligibility.ts` | 命中（`projectMemory` 被 30 文件引用；资格函数命中） | 一致 |

## 矛盾与时间线检查

- **双入口检查**：develop 侧现状（本次新写）与 requirement 侧需求基线职责不同，**不构成双入口**。
- **状态滞后项**：`archive/knowledge-skills/wiki-shared-centralized-storage-requirement.md`（v1.12）自述未标注已实施，但实现已在代码内（`wikiProjectStore` / `wikiMount` / `wikiMigration` / `wikiWriteMutex`）—— 判定为**状态滞后**，已按代码更正（见 §4 与 [`history.md`](./history.md)「存疑」）。
- **history 抽样**（3 条，均可命中）：`5c7e7a8a`（Wiki P0+P1 集中共享存储）、`072d1103`（Wiki 实现评审 9 阻断项）、`4f5e1c59`（迁移前创建共享 `wiki/`）。

## 无法核验项

- Skill 安装的**真实网络探测与 GitHub 归档下载**需联网真机，标 `待真机核验`（本地 fixture 单测覆盖形状，不覆盖真实网络）。
- Wiki 迁移在**真实用户数据**上的行为需真机，标 `待真机核验`。

## 抽样复核建议（用户抽 3 条）

A3、A5、A7。
