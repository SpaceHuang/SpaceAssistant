# docs/requirement 总索引

> 组织方式：**按主题**，与 [`../develop/`](../develop/) 同名对齐。每个主题 = `README.md`（索引）+ `需求基线.md`（当前生效的需求口径）+ `history.md`（口径变更流水账）+ `in-flight/`（未实施/未收口的需求）。
> 核对基线：`main` `17236274`（2026-10-14）｜首轮整理分支 `codex/docs-consolidation` 已合入 `main`｜**2026-10-29**：补齐 8 个主题的 `README.md` 入口（`knowledge-skills` 原已有），只做结构补全，未重跑断言核验
> 原始需求文档（109 篇）已按主题归档，正文不改；口径汇总进各主题 `需求基线.md`。

## 主题目录

每主题标准形态（`docs/rules/docs-guide.md` §2.3）：`README.md`（索引）+ `需求基线.md`（当前生效口径）+ `history.md`（口径变更流水账）+ `in-flight/`（未实施/未收口需求，按需创建）。

| 主题 | 入口与当前生效口径 |
| --- | --- |
| [agent-sdk/](./agent-sdk/) | [入口](./agent-sdk/README.md)｜[需求基线](./agent-sdk/需求基线.md)｜SDK 契约、runtime 准入、模型/用量/思考强度/密钥 |
| [storage-session/](./storage-session/) | [入口](./storage-session/README.md)｜[需求基线](./storage-session/需求基线.md)｜会话存储、消息事实、标题与列表 |
| [tools-mcp/](./tools-mcp/) | [入口](./tools-mcp/README.md)｜[需求基线](./tools-mcp/需求基线.md)｜shell / 文件 / grep / browser / subagent / MCP |
| [safety-approval/](./safety-approval/) | [入口](./safety-approval/README.md)｜[需求基线](./safety-approval/需求基线.md)｜确认与授权机制、策略单一入口、脚本与 shell 安全 |
| [im-remote/](./im-remote/) | [入口](./im-remote/README.md)｜[需求基线](./im-remote/需求基线.md)｜飞书 / 微信集成、远程安全、意图 Track、产物决策 |
| [desktop-ui/](./desktop-ui/) | [入口](./desktop-ui/README.md)｜[需求基线](./desktop-ui/需求基线.md)｜聊天 UI、composer、上下文占用、文件查看器、工作目录、设置与托盘 |
| [knowledge-skills/](./knowledge-skills/) | [入口](./knowledge-skills/README.md)｜[需求基线](./knowledge-skills/需求基线.md)｜Skills、LLM Wiki、项目记忆 |
| [platform-eng/](./platform-eng/) | [入口](./platform-eng/README.md)｜[需求基线](./platform-eng/需求基线.md)｜i18n、发版与工程治理 |
| [architect/](./architect/) | [入口](./architect/README.md)｜[需求基线](./architect/需求基线.md)｜该主题在需求侧无独立文档（架构口径见 develop 侧） |

## 归档

- 已完成且无未决项的需求原件 → [`archive/<主题>/`](./archive/)。
- 旧路径 → 新路径映射：见 [`archive/INDEX.md`](./archive/INDEX.md) 与 [`../develop/_consolidation/docs-inventory.tsv`](../develop/_consolidation/docs-inventory.tsv)。

## 说明

- 「需求基线」记录**当前生效的口径**，不含已废弃项；被取代/已废弃的（如 Plan 模式 4 篇、`file-write-directory-layout-requirement`）只在对应主题 README 的「已废弃」小节留索引。
- 需求文档里的「状态」字段不可作为判定依据（实测 4 篇里 3 篇滞后），一切以代码核验为准。
