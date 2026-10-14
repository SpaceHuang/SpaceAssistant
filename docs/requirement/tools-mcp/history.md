# tools-mcp 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/tools-mcp/history.md`](../../develop/tools-mcp/history.md)。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-05-26（修订 05-28） | `web-browser-tools-requirement`（v1.1） | 浏览器工具能力面 | — |
| 2026-05-30 | `browser-network-access-settings-requirement`（v1.1） | 网络访问设置 | — |
| 2026-05-31 | `shell-command-tool-requirement`（v1.2） | `run_shell` 契约 | — |
| 2026-05-31 | `shell-output-display-requirement`（v1.0）、`shell-output-terminal-enhancement-requirement`（v1.5） | 输出显示与终端增强 | — |
| 2026-06-06 | `web-browser-rate-limit-requirement`（v1.0） | 浏览器限流 | — |
| 2026-06-20 | `browser-act-session-trust-requirement`（v2.3） | act 会话信任与确认界面通俗性 | — |
| 2026-07-12 | `cli-subagent-integration-requirement`（v1.8） | CLI 子代理集成 | — |
| 2026-07-25 | `read-file-tail-and-oversized-tool-result-requirement`（v1.1） | 文件 tail 与超大结果 | — |
| 2026-08-28 | `mcp-integration-requirement`（v1.2） | MCP 集成 | — |
| 2026-09-11 | `mcp-tool-call-card-display-requirement`（已定稿） | MCP 结果卡片化展示 | `59aae8df`（2026-10-05，表格化渲染） |
| 2026-09-12 | `shell-output-encoding-robustness-requirement`（v1.2） | 输出编码健壮性 | L2/L3 内核落地 |
| 2026-09-17 | `mcp-agent-driven-oauth-install-requirement` | OAuth 安装（**部分被取代**） | — |
| 2026-09-25 | `tool-invocation-reliability-requirement`（v1.3） | R1–R8 调用可靠性 | 批 A/B/C 全部落地 |
| 2026-10-10 | `mcp-im-automation-tools-requirement`（v1.0） | MCP 工具向 IM/automation 开放 | `33c57ffd` |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/shell electron/mcp electron/browser electron/tools
```
