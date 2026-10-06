# A-05 M4-2 observation logger/report/CLI 审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：agent logger allowlist、观察报表 reducer、离线 CLI 及对应测试。
- 方法：只读静态审阅；未运行测试、未改产品代码。此前 M4-2 定向测试运行证据见技术方案 v385。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| 日志版本标记与窗口过滤 | `agentLogger.ts:97-104`；reducer `sessionProjectionObservation.ts:44-57`；CLI `session-projection-observation-report.ts:60-75,110-115` | `agentLogger.test.ts:48-65` 验证 appVersion 注入；`sessionProjectionObservationReport.test.ts:14-31` 验证按版本/窗口读取 | 发现 F-A05-01：只有 appVersion，缺少精确 build/artifact identity；同版本不同产物的日志会被混合。 |
| 事件 schema、未知 outcome、错误/recovery/cutover 事故 | CLI validator `session-projection-observation-report.ts:29-58`；reducer `sessionProjectionObservation.ts:58-101` | `sessionProjectionObservationReport.test.ts:58-91` 拒绝未知 outcome/不稳定错误码；`sessionProjectionObservation.test.ts:5-65` 覆盖 recovery、cutover、failed read | 通过。 |
| 正文与敏感细节脱敏 | `agentLogProjection.ts:53-96` allowlist；logger `agentLogger.ts:97-116` | `agentLogProjection.test.ts:32-78` 和 `agentLogger.test.ts:48-65` 断言 transcript/private error 不落日志 | 通过静态映射。 |
| 空样本、损坏日志及 p95 越预算 fail closed | `sessionProjectionObservation.ts:77-101`；CLI `session-projection-observation-report.ts:89-107,118-129` | `sessionProjectionObservation.test.ts:25-53`；`sessionProjectionObservationReport.test.ts:33-91` | 发现 F-A05-02：当前无最低 read/shadow 样本数和必需路径覆盖参数；只要有 read 和 shadow 且其余无异常，极少量样本即可 `observationComplete=true`。

## Findings

### F-A05-01 — [P2] 观察日志未绑定发布 build/artifact identity

- 位置：logger 仅注入 `appVersion`（`agentLogger.ts:101-104`）；CLI 只接受 `--version`（`session-projection-observation-report.ts:6,60-75`）；reducer 仅按 appVersion 过滤（`sessionProjectionObservation.ts:54-57`）。
- 风险：同一 appVersion 如果对应不同 commit/安装包，观察报表会把两份产物数据合并，无法证明通过观察的是指定 R build。
- 建议修复：在观察事件及 CLI/report identity 中纳入稳定的 build identity（至少 commit/build identity，正式 R 可绑定 artifact SHA）；若项目选择由外部 manifest 绑定，则 CLI 必须验证日志 build identity 与该精确 manifest 相符。
- 责任任务：A-10 闭环，并同步 R-06/R-07 的协议字段。

### F-A05-02 — [P1] 观察通过门槛缺少协议规定的最低样本数/路径覆盖

- 位置：reducer 仅要求 `reads.length > 0` 与 `shadows.length > 0`（`sessionProjectionObservation.ts:77-89`）；CLI 未提供最小样本或 path-coverage 参数（`session-projection-observation-report.ts:6,60-75`）。当前测试的通过样本也只有 2 条 read、1 条 shadow（`sessionProjectionObservation.test.ts:5-22`）。
- 依据：技术方案 R-06 要求开窗前批准最低 read/shadow 样本数和必需路径覆盖；R-07 明确样本不足判 no-go。
- 风险：仅极少数观测即可将 `observationComplete` 标为 true，后续可能据此放行旧 reader 退役。
- 建议修复：报表输入应绑定批准协议（build identity、最低 read/shadow 计数、路径覆盖及预算），不足时明确报告不足并返回 no-go；增加单样本不能通过的断言。
- 责任任务：A-10 闭环；真实观察协议仍由 R-06 单独批准。

## 结论

A-05 审阅切片完成，但 M4-2 observation gate **未通过放行**；F-A05-01、F-A05-02 交 A-10 修复复审。此结论不要求当前执行真实发布观察，也不替代 R-06 owner 协议。
