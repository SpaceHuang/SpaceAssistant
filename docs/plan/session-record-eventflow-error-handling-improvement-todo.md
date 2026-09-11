# Session EventFlow 错误处理改进 TODO 计划

## 1. 目标

本计划用于收敛 session eventflow 相关逻辑中的错误处理风险，重点解决以下问题：

- 单个会话的恢复失败不应阻断整个应用启动；
- 所有后台异步诊断写入都必须有明确的 rejection 归属；
- 持久化事件损坏不能被静默丢弃；
- 业务错误与审计/持久化错误必须同时可观测；
- shutdown 清理必须尽可能完成所有资源的关闭；
- 从事件重算 usage 时必须能够安全处理损坏或不完整 payload。

最终保证：事件持久化失败可以进入明确的 degraded/fail-stop 状态，错误不会形成未处理 rejection、静默数据丢失或错误成功报告，同时不因单个 session 的辅助恢复失败而使整个应用无法启动。

## 2. 设计约束与统一原则

- [x] 明确错误分类：
  - `primary operation error`：模型请求、工具执行、IPC 请求本身的错误；
  - `event persistence error`：JSONL 写入、关键事件屏障、flush/close 的错误；
  - `derived metadata error`：index 写入、诊断记录、缓存更新等可重建数据错误；
  - `cleanup error`：shutdown 或资源释放错误。
- [x] 明确错误传播规则：
  - 关键事件写入失败必须拒绝对应屏障，并阻止后续依赖该事件的业务动作；
  - 派生数据写入失败不得伪装成 JSONL 未提交；
  - 后台任务必须由发起方等待，或由统一的 safe fire-and-forget 辅助函数接管 rejection；
  - 多资源清理采用 all-settled 语义，不允许首个失败短路后续清理；
  - 任何持久化数据损坏都必须记录路径、行号/会话和处理结果。
- [x] 为错误结果定义可测试的结构，至少包含：`code`、`message`、`eventsPath/sessionId`（适用时）、`cause`（适用时）以及是否可能存在数据丢失。
- [x] 不在本计划中改变事件 JSONL 的权威性、seq 分配规则、FIFO 提交链和关键事件屏障语义。

## 3. TODO 清单

### P1：启动恢复错误隔离与可观测性

涉及：`electron/sessionEvents.ts`、`electron/main.ts`

- [x] **目标：** 单个 session 的恢复读取、补闭事件追加、index 更新或 retention 删除失败时，不阻断其他 session 和主窗口启动。
- [x] **修改方式：**
  - 将 `reconcileSessionEventFiles()` 改为按 session 独立处理，每个 session 返回成功/失败结果；
  - 对 `readSessionEvents()`、补闭 JSONL append、stat、临时 index 写入、rename 分别保留错误上下文；
  - JSONL 已成功追加但 index 更新失败时，明确标记为“事件已提交、索引待修复”，不得重复追加补闭事件；
  - 对 JSONL 追加失败、尾行修复失败等不可确认提交的情况，记录 degraded 状态并继续扫描其他 session；
  - `main.ts` 启动流程消费汇总结果，记录 warning/error，但不因单 session 失败而跳过 IPC 注册和窗口创建；
  - retention 删除采用同样的单目录隔离策略，删除失败只影响该目录并进入诊断结果。
- [x] **验证办法：**
  - 测试某一 session 的 events.jsonl 无权限/读取失败时，其他 session 仍继续恢复；
  - 模拟 JSONL append 失败，验证不会写 index，且启动流程继续；
  - 模拟 JSONL 成功、index rename 失败，验证事件不重复追加，结果标记为 index stale/degraded；
  - 模拟一个 session 的 retention 删除失败，验证其他过期 session 仍尝试删除；
  - 集成测试验证 `app.whenReady()` 不会因单个 session 恢复失败而提前结束。

### P1：统一接管后台诊断写入 rejection

涉及：`electron/mcp/mcpDiagnostics.ts`、`electron/mcp/mcpConnectionManager.ts`、`electron/mcp/mcpIpc.ts`、`electron/toolChatLoop.ts`

- [x] **目标：** MCP stderr、transport diagnostic、transport close、refresh failure 等诊断写入失败时，不产生 `unhandledRejection`，且不覆盖原始业务结果。
- [x] **修改方式：**
  - 增加统一的 `safeAppendDiagnostic()` 或等价 helper；
  - helper 负责调用 `appendDiagnostic()`、捕获 rejection、记录最小化的 fallback 日志，并避免递归写诊断；
  - 将所有 `void appendDiagnostic(...)` 和 `void this.appendDiagnostic?.(...)` 替换为统一入口；
  - 明确 `McpConnectionManagerOptions.appendDiagnostic` 的错误策略：诊断回调失败不得改变 transport callback 的同步行为，也不得让工具主流程出现未处理 Promise；
  - `mcp:refresh-tools` 的 catch 分支先保留原始刷新错误，再以 best-effort 记录诊断。
- [x] **验证办法：**
  - mock `getSecret()` reject，验证 transport stderr/close 回调不会产生未处理 rejection；
  - mock `setConfigValue()` throw，验证工具循环仍返回原始工具/请求错误；
  - 注册 `process.on('unhandledRejection')` 测试探针，所有诊断失败测试均不得触发；
  - 验证诊断成功时仍保留原有 code、message、脱敏和截断行为。

### P1：持久化事件损坏禁止静默丢失

涉及：`electron/sessionEvents.ts`、`electron/sessionBackupManager.ts` 及其测试

- [x] **目标：** 非尾部 malformed JSON、合法 JSON 但非法事件结构、无法修复的尾行都必须可观测，不能被当作不存在的事件。
- [x] **修改方式：**
  - 为 `readSessionEvents()` 定义明确的损坏报告结果，至少包含 `eventsPath`、行号、错误类别和是否已截断；
  - 初始化、备份读取、启动 reconcile 均传入统一的 malformed handler，禁止生产路径依赖“未传 callback 即静默跳过”；
  - 区分可安全处理的 torn tail 与中间损坏/非法事件：前者截断并记录，后者保留诊断并标记 session degraded；
  - 重建 index 时记录“基于部分可解析事件重建”，不得让调用方误以为事件文件完整；
  - 为恢复结果增加数据完整性状态，供启动日志和后续 UI/诊断查询使用。
- [x] **验证办法：**
  - 构造中间 malformed 行，验证读取结果包含损坏报告且不会静默成功；
  - 构造合法 JSON 但缺少 `seq/type/payload` 的行，验证同样被报告；
  - 构造可识别 torn tail，验证只截断尾部、不影响前序事件；
  - 验证损坏报告不会导致 JSONL 再次追加重复事件；
  - 验证 `SessionBackupManager` 和启动 reconcile 对损坏结果的处理一致。

### P1：业务错误与 finalize 持久化错误合并返回

涉及：`electron/claudeStreamHandlers.ts`

- [x] **目标：** 顶层异常路径中，`step_end`/`turn_end` finalize 失败不能被忽略；同时保持结构化错误返回，不让错误处理路径再次抛异常。
- [x] **修改方式：**
  - 在顶层 catch 中保存 `finalizeTurn()` 的结构化结果；
  - 当 primary error 与 finalize error 同时存在时，使用稳定的错误 code/字段表达二者，而不是只拼接不可机器解析的字符串；
  - 明确返回优先级：保留原始业务错误，同时增加 `eventPersistenceFailed`、`eventPersistenceError` 等字段；
  - 保证 finalize 内部所有事件分别尝试，日志记录本身失败也不得污染结构化返回；
  - 对成功路径、业务失败路径、取消路径、初始化失败路径分别定义终态。
- [x] **验证办法：**
  - 模拟模型请求失败 + step_end 写入失败，验证 handler 返回结构化双错误；
  - 模拟 turn_end 写入失败，验证不会出现 rejected handler Promise；
  - 验证 step_end 失败后仍会尝试 turn_end；
  - 验证正常成功、工具失败、用户取消和启动阶段失败的既有错误语义不回退。

### P1：shutdown 清理采用 all-settled 语义

涉及：`electron/main.ts`、`electron/sessionEvents.ts` 以及各资源 shutdown API

- [x] **目标：** session sink flush 失败时，Stagehand、飞书、微信及其他资源仍能继续关闭；同时最终退出结果保留全部失败信息。
- [x] **修改方式：**
  - 将 `runShutdownCleanup()` 拆为独立 cleanup task；
  - 使用 `Promise.allSettled()` 或逐项 `try/finally` 执行所有 cleanup；
  - 保留 session sink 的 `lostEvents/lostBytes/eventsPath` 细节，并合并其他资源关闭错误；
  - shutdown flush 超时后明确报告哪些任务未完成，不把 timeout 当作成功；
  - 清理 timeout timer，避免正常完成后晚到的“cleanup exceeded”误报；
  - 数据库关闭、logger flush 和 `app.quit()` 必须位于最终清理阶段，不被单个资源异常跳过。
- [x] **验证办法：**
  - 模拟 sink flush reject，验证 Stagehand、飞书、微信 cleanup 仍被调用；
  - 模拟多个 cleanup 同时失败，验证最终日志包含全部错误；
  - 模拟超时，验证应用按既定策略退出且报告未完成资源；
  - 验证正常快速退出不会产生延迟 timeout 日志。

### P2：usage 重算函数防御损坏 payload

涉及：`electron/sessionEvents.ts`

- [x] **目标：** 从事件重算 usage 时，单条损坏的 `request_usage` 不应使整个恢复流程抛异常。
- [x] **修改方式：**
  - 校验 `payload.usage` 是否为对象后再读取字段；
  - 对每个 token 字段只接受有限、非负、可安全累加的数值；
  - 对非法 usage 记录完整诊断上下文，并继续处理其他合法 usage 事件；
  - 对 overflow、`NaN`、`Infinity` 等异常值定义明确策略；
  - 保持多轮请求按事件累加，而不是只取最后一轮。
- [x] **验证办法：**
  - 测试缺少 usage、usage 为 null、字段为字符串/NaN/负数的事件；
  - 测试一条坏 usage 夹在多条正常 usage 中时，正常事件仍正确累加；
  - 测试多轮 request_usage 的总量、cacheSemantics 和未知字段兼容性。

## 4. 回归测试矩阵

- [x] `electron/sessionEvents.test.ts`：恢复、损坏、index、fail-stop、flush/close/shutdown 错误。
- [x] `electron/claudeStreamHandlers*.test.ts`：finalize 双错误、取消、异常路径和结构化返回。
- [x] `electron/toolChatLoop*.test.ts`：MCP 诊断 rejection、工具错误、request retry 审计失败。
- [x] `electron/mcp/mcpConnectionManager.test.ts`：所有 transport diagnostic callback 的异步失败。
- [x] `electron/mcp/mcpIpc.test.ts`（如缺失则新增）：refresh 失败时诊断失败不产生未处理 rejection。
- [x] `electron/main.test.ts` 或等价集成测试：启动恢复失败隔离、shutdown all-settled、timeout 清理。
- [x] 增加统一 `unhandledRejection` 探针测试，覆盖所有新增 safe fire-and-forget 路径。

## 5. TDD 推进顺序

- [x] 先为每个 P1 问题增加失败测试（RED），测试必须先证明当前错误行为确实存在。
- [x] 实现最小错误模型和 safe async boundary（GREEN）。
- [x] 重构启动恢复和 shutdown 流程，保持事件写入主链行为不变。
- [x] 增加损坏数据和多错误组合的回归测试。
- [x] 完成 P2 usage 防御后，再运行全量验证。

建议每个子任务独立提交，提交信息使用 Conventional Commit，例如：

- `test(session-events): cover recovery failure isolation`
- `fix(mcp): contain diagnostic write rejections`
- `fix(session-events): surface malformed event records`
- `fix(claude): return finalize persistence failures structurally`
- `fix(main): settle all shutdown cleanup tasks`

## 6. 最终验收标准

- [x] 任意单个 session 的恢复或 retention 失败不会阻断应用启动。
- [x] 相关路径无未处理 Promise rejection。
- [x] 任意事件损坏都会被记录，且不会被静默当作不存在。
- [x] 关键事件落盘失败能阻断依赖动作，并在返回值/日志中可识别。
- [x] primary error 与 event persistence error 可以同时被机器解析。
- [x] shutdown 会尝试所有资源清理，并报告全部失败和未完成任务。
- [x] usage 重算对损坏输入具有容错性，并正确累加多轮 usage。
- [x] focused tests、全量测试、Electron 构建和 `git diff --check` 全部通过。

## 7. 实施记录

### v12 复审补充：shutdown 生产闸门

- [x] **目标：** shutdown flush 开始前停止新事件进入，保证 flush 成功后不会再有尾部事件被接受却来不及落盘。
- [x] **修改方式：** `before-quit` 和 `runShutdownCleanup()` 同步调用 `beginSessionEventShutdown()`；现有 writer 进入 closing 状态，已接受队列继续 drain，新 writer/新事件明确拒绝；shutdown flush 使用 `close()` 并等待其结果。
- [x] **验证办法：** `electron/sessionEvents.test.ts` 验证闸门前已接受 chunk 能落盘、闸门后 chunk/critical 被拒绝；Electron 构建及完整回归通过。

本计划已按 TDD 完成：先增加损坏事件、恢复隔离、索引提交边界、诊断 rejection、finalize 双错误、shutdown all-settled 和 usage 防御测试，再实现最小修复并回归。

- `electron/sessionEvents.ts`：增加 `readSessionEventsDetailed()`、session 级恢复/retention 汇总、稳定错误上下文、index 派生状态和安全 usage 累加。
- `electron/mcp/mcpDiagnostics.ts`、`electron/mcp/mcpConnectionManager.ts`、`electron/mcp/mcpIpc.ts`、`electron/toolChatLoop.ts`：统一接管诊断写入的同步异常与异步 rejection。
- `electron/claudeStreamHandlers.ts`：finalize 逐事件尝试，并以结构化字段同时返回 primary error 与 persistence error。
- `electron/shutdownCleanup.ts`、`electron/main.ts`：清理任务 all-settled，保留全部失败并报告超时未完成任务。
- `electron/sessionBackupManager.ts`：备份事件读取复用统一 integrity issue 报告。

最终验证结果：focused session/handler/MCP/shutdown 测试 47 个通过；完整 Electron 测试 290 个文件、1945 个测试通过；仓库全量测试 513 个文件、3237 个测试通过；`npm run typecheck:shared`、`npm run build:electron:incremental`、`git diff --check` 均通过。
