# agent-sdk 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧提交见 [`../../develop/agent-sdk/history.md`](../../develop/agent-sdk/history.md)。
> 证据源：需求文档版本段 + `git log`；冲突以 `git log` 为准。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-05-24 | `llm-service-profiles-requirement`（v1.1） | 模型服务画像口径建立 | `electron/llmServiceResolver.ts` |
| 2026-06-17 | `llm-multi-service-model-config-requirement`（v1.3） | 多服务模型配置 | — |
| 2026-09-05 | `llm-service-model-fetch-requirement`（v1.4） | 模型清单拉取 | — |
| 2026-09-16 | `llm-truncation-and-context-budget-requirement`（v1.1） | 截断与上下文预算 | — |
| 2026-09-19 | `thinking-effort-settings-requirement`（v1.6） | 思考强度设置 | — |
| 2026-09-25 | `llm-model-baseline-integration-requirement`（v1.3） | 模型基线接入 | — |
| 2026-10-01 | `macos-api-key-access-authorization-requirement`（v1.0） | macOS 密钥访问授权 | `17236274`（改用 AES-GCM 存储密钥） |
| 2026-10-02 | `agent-runtime-admission-policy-requirement` | 准入策略：已决策，按实际运行数据复查 | 准入与 turn 生命周期对齐 |
| 2026-10-07 | `agent-token-usage-stats-step-accounting-consistency-plan`（v1.0） | 步骤记账一致性方案（未实施） | 未见对应实现 |

## 存疑

- `tool-use-id-pairing-requirement.md`（v1.0，2026-07-03）无修订记录，但对应实现提交可追（`257a90a0 feat(tool-pairing): 引入 tool_use/tool_result…`）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- packages/agent-sdk/src electron/llmServiceResolver.ts electron/usageStats
```
