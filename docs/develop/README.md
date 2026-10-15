# docs/develop 总索引

> 组织方式：**按主题**（不再按时间堆积）。每个主题 = 一份 `README.md`（索引与状态）+ 现状文档（只写与最新代码一致的事实）+ `history.md`（迭代流水账）+ `in-flight/`（未收口的在途项）。
> 核对基线：`main` `17236274`（2026-10-14）｜整理分支：`codex/docs-consolidation`
> 整理规则与全量判定：见 [`_consolidation/`](./_consolidation/)；本篇只做导航。

## 主题目录

| 主题 | 定位 | 代码域 |
| --- | --- | --- |
| [agent-sdk/](./agent-sdk/) | Agent SDK：内核、契约与模型接入（回合主循环、工具循环、调用契约、准入调度、上下文注入、继续恢复、模型/用量/密钥） | `packages/agent-sdk/src/*`、`electron/toolChatLoop.ts`、`driver/`、`butler/` |
| [architect/](./architect/) | 架构与规划：产品架构理想态、演进 Roadmap、决策记录、外部实现对照研究 | 跨模块 |
| [storage-session/](./storage-session/) | 会话与数据：存储重构、持久化维护、读热路径、消息事实链路、事件流、会话标题与列表 | `electron/sessionStorage/`、`storage/`、`database/` |
| [tools-mcp/](./tools-mcp/) | 工具能力与外部接入：shell、文件工具、grep/rg、browser、subagent、MCP | `electron/shell/`、`tools/`、`browser/`、`mcp/` |
| [safety-approval/](./safety-approval/) | 安全、确认与审批：策略与档位、确认/审批链路、脚本与路径安全、fail-open | `electron/capabilities/`、`confirmation/`、`writeSafety/` |
| [im-remote/](./im-remote/) | 远程与 IM：飞书、微信、远程会话与意图 Track、远程安全、产物决策 | `electron/feishu/`、`wechat/`、`remote/`、`outbound/` |
| [desktop-ui/](./desktop-ui/) | 桌面交互与工作区：聊天界面与渲染性能、composer、上下文占用、多会话、文件面板/查看器、工作目录、设置与托盘 | `src/renderer/`、`electron/workDir*.ts` |
| [knowledge-skills/](./knowledge-skills/) | 技能与知识：Skills 安装与管理、LLM Wiki、项目记忆 | `electron/skills/`、`wiki/` |
| [platform-eng/](./platform-eng/) | 工程支撑：i18n、发版、依赖升级、测试基建、代码治理 | 全仓 |

## 归档

- 已完成迭代的计划、证据、阶段件、复测门禁与台账 → [`archive/<主题>/`](./archive/)（`git mv` 搬迁，**文件名与内容零改动**；仅对 `D` 类补一行废弃标注）。
- 旧路径 → 新路径映射：见 [`archive/INDEX.md`](./archive/INDEX.md) 与全量清单 [`_consolidation/docs-inventory.tsv`](./_consolidation/docs-inventory.tsv)。
- 归档件正文里的相对链接按**搬迁前布局**书写，搬迁后可能失效；这是「内容零改动」的直接后果，属预期（不回头改归档件）。

## 边界（本次不动的目录）

`docs/review/`、`docs/plan/`、`docs/analyze/`、`docs/knowledge/`、`docs/architecture/`、`docs/diagrams/`、`docs/废弃/`、`docs/manual/`、`docs/validation/`、`docs/i18n/`、`docs/skill/`、`docs/superpowers/` —— 只做交叉引用，不搬迁。

> **`docs/superpowers/` 为何不整合**（15 篇：9 份实现计划 + 6 份设计稿，2026-05~06）：它是**另一套工作流的产出**（文档头含 `superpowers:subagent-driven-development` 标记），不是本仓库主题文档。不搬迁的两条硬理由：① `docs/knowledge/SCHEMA.md` 以 `docs/superpowers/{specs,plans}` 作为 `design` / `plan` 两类 docType 的**来源目录**（`SCHEMA.md:145-146`），搬迁会让知识库分类规则指向空目录；② 其内容价值已被各主题的 `需求基线.md` 与 `history.md` 覆盖。
> **发现路径**：改由主题 README 的「关联过程产物」节提供 —— [`desktop-ui/README.md`](./desktop-ui/README.md)（12 篇）、[`platform-eng/README.md`](./platform-eng/README.md)（2 篇）。

## 维护方法

1. 现状文档：写「核对基线提交」，不写行号；每条结论给可复现命令（`rg -n` / `git log -S`）。
2. history：每次涉及本主题的迭代收尾时追加一条（日期 + 短 hash + 变更 + 出处 + 影响）。
3. 归档：迭代收口即 `git mv` 进 `archive/<主题>/`，内容不改，`archive/INDEX.md` 补一行。
4. 核验：每个主题按 [`_consolidation/docs-consolidation-rules.md`](./_consolidation/docs-consolidation-rules.md) §3.0 重跑 `baseline-check-<日期>.md`。
