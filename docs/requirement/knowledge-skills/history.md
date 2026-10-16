# knowledge-skills 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/knowledge-skills/history.md`](../../develop/knowledge-skills/history.md)。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-05-24 | `llm-wiki-requirement`（v1.7）、`wiki-import-ingest-requirement`（v1.1） | LLM Wiki 与导入 ingest | — |
| 2026-05-27 | `skill-llm-routing-requirement`（v1.1） | Skill LLM 路由 | — |
| 2026-05-30 | `skill-management-ui-requirement`（v1.0） | Skill 管理 UI | — |
| 2026-05-31 | `browser-setup-skill-requirement`（v1.1） | Browser Setup Skill | 已实施（skill 随会话提供） |
| 2026-09-11 | `skill-install-size-limit-and-cloud-install-requirement`（v1.0） | 安装体积限制与云端安装（决策闭环） | — |
| 2026-09-12 | `skill-github-nested-directory-discovery-requirement`（v1.4） | GitHub 嵌套目录发现 | — |
| 2026-10-10 | `wiki-shared-centralized-storage-requirement`（v1.12） | Wiki 集中共享存储 | `5c7e7a8a`（实现先于需求回写） |
| 2026-10-16 | `skills-requirement` | Skills 用户级存储需求范围收敛为 Windows/macOS 支持平台 | 撤销 Linux 桌面端支持承诺 |
| — | `skills-requirement` | Skills 机制总纲（A 类） | — |
| — | `project-memory-requirement` | 项目记忆 | — |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/skills electron/wiki
```
