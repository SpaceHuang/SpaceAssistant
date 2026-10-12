# 远程 IM Intent Track 灰度与运维手册

本文对应 [远程 IM 意图归属与 Track 管理详细开发方案](2026-10-11-remote-im-intent-track-development-plan.md)。本机实现与测试已完成；Track 路由默认关闭，开启正式语义续接前必须先完成下述影子观测和评审。

## 功能开关

基础开关保存在应用配置表中，读取入口为 `readRemoteTrackFeatureGates()`。布尔配置值必须是字符串 `true` 才视为开启；缺失值等同关闭。所有 Track 功能还受 `remoteTrackRolloutChannels` 渠道名单限制；未列入名单的渠道保持旧路由，不能因为另一渠道开启 Track 而进入新路由。

通过现有维护命令一次性配置完整开关和渠道范围。命令会校验闭合 schema、依赖关系，并在同一事务内写入所有键；启用语义续接时还会即时重查影子质量门禁。配置前关闭应用，因为命令会打开数据库并执行 schema migrations：

```sh
npm run remote-track:shadow -- <database-path> gates '<完整的 version 1 gates JSON>'
```

| 配置键 | 用途 | 依赖 |
|---|---|---|
| `remoteTrackPersist` | 持久化 Track 归属 | 基础开关 |
| `remoteTrackShadowAttribution` | 记录脱敏分类样本、token、成本和人工标签 | 需要 `remoteTrackPersist` |
| `remoteTrackExecution` | 微信/飞书使用 Track 路由 | 需要 `remoteTrackPersist`、`remoteTrackRecovery`、`remoteTrackScopedModelInput` |
| `remoteTrackRecovery` | 启用 Track accepted-turn/work 恢复 | `remoteTrackExecution` 的前置项 |
| `remoteTrackScopedModelInput` | 强制模型输入使用 Track scope | `remoteTrackExecution` 的前置项 |
| `remoteTrackClarification` | 启用持久化任务澄清 | 需要 `remoteTrackExecution` |
| `remoteTrackConfirmationLink` | 将新确认请求关联 Track/toolUse | 需要 `remoteTrackExecution` |
| `remoteTrackSemanticContinuation` | 启用模型语义续接 | 需要澄清、影子观测及合格影子证据 |
| `remoteTrackRolloutChannels` | 允许哪些 IM 渠道消费上述 Track rollout 开关 | JSON 数组，仅含 `wechat` / `feishu`；缺失等同空数组 |

缺少依赖或语义续接证据时，路由读取配置会 fail closed 并抛出 `REMOTE_TRACK_FEATURE_GATE_INVALID`，错误中包含阻断原因。正式 Track 路由开启但持久 wake consumer 不可用时，新消息不会进入 Agent。

## 影子观测和样本复核

1. 可先只开启 `remoteTrackPersist` 与 `remoteTrackShadowAttribution` 做旧路由基线观察；它不会改变正式归属。但在 Track 候选为空的用户上，这一阶段只会记录确定性 `new-track`，不会产生分类器调用，不能单独满足 p95/成本启用门槛。用 `gates` 命令一次配置整个基线 profile，例如只采集微信：

   ```sh
   npm run remote-track:shadow -- <database-path> gates '{"version":1,"gates":{"persist":true,"shadowAttribution":true,"execution":false,"clarification":false,"recovery":false,"scopedModelInput":false,"confirmationLink":false,"semanticContinuation":false},"rolloutChannels":["wechat"]}'
   ```

2. 要采集有真实 provider 请求的分类质量样本，先部署包含影子采集的版本，再由操作者选择单通道 opt-in canary profile。该 profile 开启 Track execution 和澄清，会改变所选渠道的意图路由；语义自动续接仍关闭。名单外渠道继续走旧路由。分类器高分续接仍要求用户澄清，低于续接阈值的消息创建新 Track。只有用户确认该渠道进入 canary 后，才运行以下 profile（以微信为例）：

   ```sh
   npm run remote-track:shadow -- <database-path> gates '{"version":1,"gates":{"persist":true,"shadowAttribution":true,"execution":true,"clarification":true,"recovery":true,"scopedModelInput":true,"confirmationLink":false,"semanticContinuation":false},"rolloutChannels":["wechat"]}'
   ```

   14 天计时从部署并实际开始影子 provider 调用后开始，不是开发/构建的前置条件。不要把 `semanticContinuation` 设为 `true`；命令会在配置写入前核验影子 gate，数据不足时拒绝整次配置。
3. 应用关闭后，通过维护命令读取样本。输出只包含渠道、平台消息 ID、分类版本、决策码、候选 Track ID/分数、延迟和计价字段，不返回用户正文或身份键。
4. 使用平台消息 ID 和已有本地审计记录人工独立判断归属，随后调用 `reviewRemoteTrackAttributionObservation(db, { observationId, outcome, reviewedAt })`。只能标记 `correct`、`wrong` 或 `uncertain`；标签不可被相反标签覆盖。证据不足时标 `uncertain`，不要猜测。
5. 通过 `readRemoteTrackShadowGateReport(db)` 查看计数和 blockers。闸门要求实际 provider 分类请求最近连续覆盖 14 天、总计至少 500 条、微信和飞书各至少 200 条；有效口径为 `classifier_invoked=1 AND provider_call_made=1`。仅调用分类器函数但未发出 provider 请求的记录，以及零候选、未调用分类器的观察，不计入样本数、渠道配额或连续覆盖。窗口内所有观测仍须独立复核且无错误归属。p95 只统计实际 provider 请求，须不超过 2 秒；已知成本不超过每千次 1 美元。零候选影子样本只计入 `observations` 基线总数，不算分类质量证据。
6. 正式语义续接开启后，分类结果会作为同一条影子观测写入，不会额外调用一次模型。保持影子开关开启，以持续更新运行数据。

命令示例（`<database-path>` 必须是明确指定的应用数据库文件）。`report` 同时显示全部观测数和 `evaluatedObservations` / `evaluatedChannelObservations`，以便区分路由基线与真实分类器评估量：

```sh
npm run remote-track:shadow -- <database-path> report
npm run remote-track:metrics -- <database-path> metrics <from-ms> <to-ms>
npm run remote-track:shadow -- <database-path> list <from-ms> <to-ms> 100
npm run remote-track:shadow -- <database-path> review <observation-id> correct <reviewed-at-ms>
npm run remote-track:shadow -- <database-path> channels '["wechat","feishu"]'
npm run remote-track:shadow -- <database-path> gates '<完整的 version 1 gates JSON>'
```

`review` 的结果只会写入一次；相反标签会报冲突。`list` 可用 `from-ms`、`to-ms` 和 limit 分批取样。

## Track 运行指标

`metrics` 接受 UTC Unix 毫秒半开区间 `[from-ms, to-ms)`，输出方案 §13 的指标值、可用性、缺数原因及告警。报表只读 SQLite，不按 session、最近时间、正文或身份猜测关联；不返回用户正文、身份键、凭据或候选摘要。

指标来源和解释：

- `remote_track_attribution_total`、`remote_track_wrong_attribution_report_total`：归属观察和独立人工 wrong 标签；收到任意 wrong 标签会产生 critical `wrong-attribution-reported` 告警，立即暂停语义续接并复核。
- `remote_track_join_completeness`：按 event kind 的必需 request/turn/toolUse/confirmation/message 字段统计缺失。warning `track-join-fields-missing` 指向事件生产者，不尝试用其他字段补 join。
- `remote_clarification_delivery_total`：send attempt 状态分布；仍处于 `attempt-started` 的项产生 warning，需对账发送结果。
- `remote_clarification_resolution_latency`：已 resolve clarification 的 `updated_at - created_at`，按 channel 给出 p50/p95。
- `remote_clarification_stale_reply_total`：strict clarification control 消息的闭合结果码。`unknown` 大于零会产生 critical 告警，须确认未知句柄不会进入 Agent。
- `remote_track_work_recovery_total`：以 `work.updated_at` 在窗口内的 work 作为“最新状态观察”，报告状态、行内累计 attempt 和窗口结束时已过期的 claimed lease；它不是按时间还原的完整 state transition 流。`needs-reconciliation` 与过期 lease 会分别产生 warning，建议先对账，不自动重放。
- `remote_track_context_completeness`：provider view snapshot 当前不落库，所以规范 completeness 固定显示 `available: false` / `view-snapshots-not-persisted`。报告同时给出明确标记为 `track-model-message-event-reference-proxy` 的代理统计，检查 message/turn/session refs；不得把代理统计解读成 provider 实际收到的完整 view。
- `remote_track_terminal_transition_rejected_total`：reducer 持久化的 rejected transition 事件及其目标/原因。
- `remote_track_runtime_diagnostic_total`：运行时闭合诊断码，包括缺少 TrackContext、owner/epoch scope 不匹配、turn/todo Track 关联写失败。对应 critical 告警要求暂停受影响路径并对账，不存异常文本。

窗口没有来源行时，指标返回 `available: false` 和 `missingReason`，不会把缺失数据解释成零次错误。新诊断事件只存 channel、平台 message ID、闭合事件/原因码和时间，不存消息正文或身份键。

运行时入口告警还包括 `untracked-runtime-invocation` 和 `invalid-clarification-control-reply`。前者表示正式 Track execution 已开启但 IM runtime 未收到 TrackContext；后者表示收到旧格式或非法澄清选项。路由会消费这些输入并返回格式提示，不应为其创建 Agent turn。告警用于发现回归，不能代替 turn/outbox 对账。

## 分类器价格配置

配置键 `remoteTrackClassifierPricingUsdPerMillionV2` 接受 schema version 2 的费率 JSON。它替代旧 V1 key，旧格式不会被读取。费率按不包含 URL、密钥等凭据的 opaque classifier version 关联；每个模型端点都必须附费率来源、生效日、核验日和核验人。来源应指向当前 provider 的正式计价页：

```json
{
  "version": 2,
  "ratesByClassifierVersion": {
    "chat-0123456789abcdef": {
      "inputUsdPerMillion": 1.0,
      "outputUsdPerMillion": 4.0,
      "cacheReadInputUsdPerMillion": 0.1,
      "cacheCreationInputUsdPerMillion": 1.25
    }
  },
  "evidenceByClassifierVersion": {
    "chat-0123456789abcdef": {
      "sourceUrl": "https://provider.example/pricing",
      "effectiveAt": "2026-10-01",
      "verifiedAt": "2026-10-10",
      "verifiedBy": "operator-1"
    }
  }
}
```

费率必须来自当前模型服务的正式计价信息，并在价格或模型端点变更后更新对应版本。`sourceUrl` 必须是无账号、无查询参数/片段的 HTTPS URL；日期必须是有效 ISO 日期，核验日期不得早于生效日期；费率和证据必须对每个 classifier version 一一对应。每条 provider 观测会保存当时使用的证据，历史观测缺证据不能由之后设置的费率卡追认。成本是 provider 返回的 token usage 按该费率卡计算的估算值；缺失费率/证据、无效 JSON、版本不匹配或 provider 未返回完整 token 用量时，成本存为 `null`，闸门会保持关闭，绝不把未知成本算成零。

用 `list` 输出中的 `classifierVersion` 填入费率表，并在应用关闭时设置：

```sh
npm run remote-track:shadow -- <database-path> rates '<上面的完整 JSON>'
```

## 暂停和恢复

- 怀疑语义误续接或成本超限：先关闭 `remoteTrackSemanticContinuation`。用户后续消息使用显式关系或澄清策略。
- 暂停接收新 Track work：关闭 `remoteTrackExecution`。保留数据库中的 Track、work、Clarification 及兼容恢复 worker；不要手工删除或重置 pending 行。
- 仅暂停某个渠道的新 Track 路由：将 `remoteTrackRolloutChannels` 更新为剩余渠道，例如 `[]` 暂停两路，`["wechat"]` 只保留微信。已创建的 work/Clarification 仍由恢复 worker处理。
- 继续影子观测：保持 `remoteTrackPersist` 和 `remoteTrackShadowAttribution` 开启，之后重新满足完整 14 天样本门槛。
- 重新启用语义续接前重新读取 gate report，并确认双渠道样本、错误标注、p95 和成本均满足门槛。修改任一阈值或价格必须重新评估，不以旧的批准结果代替。

异步审批结果已持久化、但 completion wake 对应的 Agent turn 未完成时，wake consumer 会先调用 turn recovery 并重新读取 canonical turn。只有 `completed`/`parked` 才按成功消费；恢复为失败/中断时，不会重跑 Agent 或外部动作，而是经 lifecycle outbox 发送“操作结果已保存、后续回复中断”的说明，发送成功后才确认 completion outbox。若恢复仍无法给出终态，wake 保持 pending 供后续重试。

## 当前限制

维护命令使用主进程数据库代码，并会运行 schema migrations；操作前关闭应用，避免与在线 SQLite 连接竞争。没有可核验的模型费率和独立样本评审时，保持语义续接关闭。
