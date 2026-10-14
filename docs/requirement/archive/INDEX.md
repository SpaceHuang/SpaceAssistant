# docs/requirement 归档总索引

> 归档件一律 `git mv` 搬迁：**文件名不改、内容不改**；口径汇总见各主题 `需求基线.md`。
> 搬迁日期：2026-10-14｜基线：`main` `17236274`

## 旧路径 → 新路径 规则

`docs/requirement/<文件名>` → `docs/requirement/archive/<主题>/<文件名>`

逐件映射（原路径 + 主题 + 去向 + 判定依据）见 [`../../develop/_consolidation/docs-inventory.tsv`](../../develop/_consolidation/docs-inventory.tsv)。

## 归档分布

| 主题 | 件数 | 说明 |
| --- | --- | --- |
| `desktop-ui/` | 37 | 聊天 UI、文件面板/查看器、composer、上下文占用、设置与托盘；含 Plan 模式 4 篇（已废弃）+ 核验更正补入 2 件 |
| `tools-mcp/` | 16 | shell 输出与编码、grep/文件读取、browser、subagent、MCP 系列 |
| `im-remote/` | 14 | 飞书/微信集成、远程工作目录、进度同步、异步审批、产物决策 + 核验更正补入 1 件 |
| `agent-sdk/` | 13 | 模型服务与配置、思考强度、token 用量、API Key 授权、工具配对 + 核验更正补入 3 件 |
| `knowledge-skills/` | 9 | Skills 系列、LLM Wiki、Wiki 导入、项目记忆 |
| `storage-session/` | 6 | 会话标题、列表徽标、消息事实链路、workdir 边界分层 + 核验更正补入 1 件 |
| `safety-approval/` | 3 | 确认卡片信任、shell 安全增强 + 核验更正补入 1 件 |
| `platform-eng/` | 1 | 后台任务机制移除 |
| **合计** | **99** | 另有 1 个 0 字节空文件直接删除｜2026-10-14 两轮核验更正共补入 8 件 |

## 已废弃（D 类）清单

| 文档 | 取代者 |
| --- | --- |
| `archive/desktop-ui/plan-auto-execution-requirement.md` | [`../desktop-ui/remove-plan-mode-requirement.md`](../desktop-ui/remove-plan-mode-requirement.md) |
| `archive/desktop-ui/plan-detail-panel-requirement.md` | 同上 |
| `archive/desktop-ui/plan-resume-button-state-requirement.md` | 同上 |
| `archive/desktop-ui/通用Agent-Plan模式MVP产品需求文档.md` | 同上 |
| `archive/desktop-ui/file-write-directory-layout-requirement.md` | 工作产物管理（`explicit-output-directory-candidate-*`） |
