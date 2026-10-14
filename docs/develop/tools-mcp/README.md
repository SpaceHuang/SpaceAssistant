# tools-mcp —— 工具能力与外部接入

> 定位：shell（`run_shell`）、文件工具、grep/rg、browser、subagent、工具调用可靠性、MCP（集成/延迟加载/SSE/超时隔离）。
> 主要代码域：`electron/shell/`、`electron/tools/`、`electron/browser/`、`electron/mcp/`、`electron/fileIpc.ts`、`src/shared/toolResultContract.ts`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状与设计文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [web-browser-tools-design.md](./web-browser-tools-design.md) | 设计（v1.1） | 浏览器自动化工具设计 |
| [cli-subagent-integration-design.md](./cli-subagent-integration-design.md) | 设计（v1.0） | 子代理集成设计 |
| [ripgrep-integration-technical-design.md](./ripgrep-integration-technical-design.md) | 设计（评审整改版） | rg 集成；本地必做项已完成 |
| [tool-invocation-reliability-improvement-technical-design.md](./tool-invocation-reliability-improvement-technical-design.md) | 设计（v1.4） | R1–R8 工具可靠性 |
| [golden-data/](./golden-data/)（2 json） | 证据数据 | shell / python 切换后的漂移证据，随宿主设计 |

## 在途（in-flight）

- [run-shell-dialect-mismatch-false-positive-and-fatal-turn-abort-improvement-plan.md](./in-flight/run-shell-dialect-mismatch-false-positive-and-fatal-turn-abort-improvement-plan.md) —— v1.4 定案 D-1/D-7/D-8，待重审

## 归档（已完成迭代/过程产物）

见 [`../archive/tools-mcp/`](../archive/tools-mcp/)（19 件）：

- **shell 簇（矛盾最集中的 6 篇已全部收口）**：`bash-run-shell-current-state-and-optimization-review.md`、`run-shell-and-tool-execution-lifecycle-optimization-plan.md`（已实现并合入 main `1f6e794`）、`run-shell-command-failure-diagnosis-and-remediation-plan.md`、`run-shell-windows-host-init-failure-diagnosis-and-improvement-plan.md`、`run-shell-agent-safe-boundary-hardening-plan.md` 在 safety-approval
- **grep/rg**：`grep-recursive-search-capability-release-plan.md`、`grep-tool-0.1.7-ripgrep-unavailable-investigation.md`、`grep-tool-large-file-fallback-optimization-plan.md`
- **MCP**：`mcp-integration-development-plan.md`、`mcp-deferred-tool-loading-delivery.md`、`mcp-sse-transport-plan.md`、`mcp-im-automation-tools-release-note.md`、`mcp-timeout-turn-failure-isolation-plan.md`
- **工具可靠性/其他**：`tool-invocation-reliability-acceptance-evidence.md`、`tool-path-field-alias-normalization-tdd-plan.md`、`tool-result-invariants-scan-report.md`、`edit-file-match-failure-diagnosis-and-improvement-plan.md`、`cli-subagent-integration-verification-plan.md`、`web-browser-tools-test-plan.md`、`shell-output-encoding-robustness-implementation-record.md`

## 状态滞后提示（文档自述 ≠ 代码事实）

| 文档 | 文档自述 | 代码事实 |
| --- | --- | --- |
| `mcp-timeout-turn-failure-isolation-plan.md`（已归档） | 「复评修订版尚未复评」 | 阶段 A–E 已实现：`a01a6d49 fix(agent): isolate timed out turn execution`（2026-10-14）、`e6f1c510`（merge） |

核验命令：`git log --date=short --format='%ad %h %s' --grep='isolation' -30`、`rg -n 'timed out\|timeout' electron/mcp`.

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/shell electron/tools electron/mcp electron/browser
git log --date=short --format='%ad %h %s' --grep='mcp' -30
```
