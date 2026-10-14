# docs/develop 归档总索引

> 归档件一律 `git mv` 搬迁：**文件名不改、内容不改**（`git log --follow` 可追史）；仅 `D` 类（已废弃）在头部补一行指向取代者。
> 搬迁日期：2026-10-14｜基线：`main` `17236274`｜整理分支：`codex/docs-consolidation`

## 旧路径 → 新路径 规则

| 情形 | 旧路径 | 新路径 |
| --- | --- | --- |
| 已完成迭代原件（B 类） | `docs/develop/<文件名>` | `docs/develop/archive/<主题>/<文件名>` |
| 已废弃（D 类） | 同上 | 同上 |
| 阶段件 / 证据 | 同上 | 同上 |

逐件映射（原路径 + 主题 + 去向 + 判定依据）见 [`../_consolidation/docs-inventory.tsv`](../_consolidation/docs-inventory.tsv)：按「原路径」列查行，取「主题」「去向」两列即可推出新路径。

## 归档分布

| 主题 | 件数 | 说明 |
| --- | --- | --- |
| `agent-sdk/` | 12 | 生命周期改进/契约矩阵/上下文与 token 成本/驱动权限/失败 turn 续跑等已收口件 |
| `storage-session/` | 64 | 存储重构全套阶段件（`a*`/`c*`/`i*`/`r*`/`m3`）、profile 采样、迁移与清理计划、消息事实证据 |
| `tools-mcp/` | 19 | run_shell 生命周期/方言/Windows 宿主、grep/rg、browser、subagent、MCP 集成与延迟加载 |
| `safety-approval/` | 6 | 桌面自动审批、ask 档位统一、fail-open、脚本安全 parser 升级与金标准评审 |
| `im-remote/` | 3 | 远程私聊安全测试计划与发布说明、意图 Track 开发方案 |
| `desktop-ui/` | 18 | 聊天列表渲染性能三件套与复测门禁、流式抖动、composer、多会话、工作区清理 |
| `platform-eng/` | 10 | 云 main 恢复 7 件（含 3 个 `.tsv`）、分叉接入 2 件、测试套件清理审计 |
| **合计** | **132** | 另有 2 个 0 字节空文件直接删除（不进归档） |

## 注意

归档件正文中的相对链接按**搬迁前布局**（`docs/develop/`，深度 2）书写；搬迁到 `archive/<主题>/`（深度 3）后，指向代码目录（如 `../../electron/`）与 `docs/review/`（未入库）的链接会失效。按「归档件内容零改动」原则**不做回改**；需要点击时请以本索引 + `docs-inventory.tsv` 反查，或用 `git log --follow` 定位原件。
