# 飞书 CLI 接入 — 文件日志机制需求文档

**版本：** 1.0  
**日期：** 2026-05-27  
**状态：** 待评审  

**关联文档：**
- [feishu-integration-requirement.md](./feishu-integration-requirement.md)
- [feishu-remote-status-sidebar-requirement.md](./feishu-remote-status-sidebar-requirement.md)
- [docs/develop/feishu-integration-phase2-design.md](../develop/feishu-integration-phase2-design.md)（§8 审计日志）
- 实现参考：`electron/agentLogger/`、`electron/feishu/feishuAuditLogger.ts`

---

## 1. 概述

为飞书 CLI 集成链路新增**按日滚动的 JSON Lines 文件日志**，用于开发调试与线上问题排查。日志在**目录策略**上与现有 `Agent-{YYYYmmdd}.log` 一致（开发模式 vs 打包模式），在**脱敏策略**上与 Agent 日志共用同一套规则，并**尽量覆盖**飞书相关主进程事件及其关键字段。

本需求**不替代**设置页/状态栏使用的「飞书操作记录」（`feishu-audit.log` + `FeishuAuditDrawer`），二者分工见 §4。

---

## 2. 背景与现状

| 项 | 现状 | 问题 |
|----|------|------|
| Agent 文件日志 | `Agent-{YYYYmmdd}.log`；开发：`{项目根}/logs/`；打包：`{workDir}/.agent/logs/` | 无飞书专用轨迹 |
| 飞书审计日志 | `{userData}/logs/feishu-audit.log`，5MB 轮转，供 UI `feishu:audit-query` | 路径与 Agent 不一致；**无** `sanitizeForLog`；事件不全（如 `lark_cli`、`confirm_request` 类型已定义但未写入） |
| 飞书子进程 | `FeishuEventService`、`LarkCliRunner`、`feishuIpc` 等多数路径无结构化文件日志 | 排障依赖控制台或复现 |
| 脱敏工具 | `electron/agentLogger/sanitize.ts`；`redactLarkCliArgsForDisplay` 仅用于展示 | 审计日志未接入 |

---

## 3. 目标与非目标

### 3.1 目标

| 编号 | 目标 |
|------|------|
| G1 | 与 Agent 日志相同的**开发/打包目录解析**（复用 `resolveAgentLogDir` 逻辑，见 §5） |
| G2 | 日志文件名 **`FeishuCli-{YYYYmmdd}.log`**，按自然日单文件 append |
| G3 | 写入前对整条 payload 执行与 Agent 相同的 **`sanitizeForLog`**，并叠加飞书专用字段规则（§7） |
| G4 | 覆盖 §8 事件清单中的**生命周期、IPC 设置流、事件订阅、入站路由、CLI 执行、远程 Agent、确认流**等 |
| G5 | 日志写入失败**不得**中断飞书主流程（与 `logAgentEvent` 一致：吞掉 IO 错误） |
| G6 | 应用启动时打一条 `feishu.logger.startup`（含 `logDir`、`isPackaged`、`workDir` 摘要） |

### 3.2 非目标

- 不在本需求内改造「飞书操作记录」Drawer 的数据源（可后续做「从文件日志聚合」的增强）。
- 不要求把 `lark-cli event +subscribe` 的**每一行**原始 NDJSON 全量落盘（仅记录解析结果与失败摘要，见 §8.4）。
- 不提供日志上传、远程采集、日志级别运行时动态开关（可预留 `enabled` 配置，默认开启）。
- 不记录用户消息正文、OAuth 完整 URL 查询串、App Secret、access_token 等（§7）。

---

## 4. 与现有「审计日志」的关系

| 维度 | `feishu-audit.log`（现有） | `FeishuCli-{date}.log`（本需求） |
|------|---------------------------|----------------------------------|
| 路径 | `{userData}/logs/` | 与 Agent 相同目录（§5） |
| 受众 | 产品 UI（操作记录表格） | 开发者 / 支持排障 |
| 粒度 | 业务里程碑（入站、agent_start、reply 等） | 全链路调试（含 IPC、重连、CLI exit、解析失败等） |
| 轮转 | 5MB × 5 备份 | 按日分文件（与 Agent 一致） |
| 脱敏 | 部分约定（设计文档：仅 length） | 统一 `sanitizeForLog` + §7 |

**实现建议（非强制）：**

1. **保留** `FeishuAuditLogger` 与现有 IPC（`feishu:audit-tail` / `feishu:audit-query`）。
2. 新增 `feishuCliLogger`（或 `logFeishuCliEvent`）作为文件日志唯一写入口。
3. `FeishuAuditLogger.append` 在写入 audit 文件的同时，可向文件日志打一条 **`feishu.audit.*`** 事件（字段与 audit 行一致），避免两套语义漂移；audit 专用字段仍遵守「不落正文」规则。

---

## 5. 日志路径与文件命名

### 5.1 目录解析（与 Agent 对齐）

复用 `electron/agentLogger/agentLogPaths.ts` 中的规则：

| 运行模式 | 日志目录 |
|----------|----------|
| 开发（`!app.isPackaged`） | `{项目根}/logs/`（由 `mainDirname` 上溯至仓库根，与 Agent 相同） |
| 打包（`app.isPackaged`） | `{workDir}/.agent/logs/` |

飞书 CLI 日志与 Agent 日志**共用同一目录**，仅文件名前缀不同。

### 5.2 文件命名

| 函数 | 返回值示例 |
|------|------------|
| `formatFeishuCliLogFileName(date)` | `FeishuCli-20260527.log` |
| 日期键 | `YYYYmmdd`，与 `formatAgentLogDateKey` 一致 |

### 5.3 初始化

在 `app.whenReady` 中于 `initAgentLogger` 之后（或并列）调用 `initFeishuCliLogger`，注入与 Agent 相同的 deps：

```typescript
{
  getWorkDir: () => workDirState,
  isPackaged: app.isPackaged,
  mainDirname: __dirname  // electron 编译输出目录
}
```

开发模式下可在控制台打印：`[FeishuCliLogger] 开发模式日志目录: …`（与 Agent 一致）。

---

## 6. 日志行格式

每行一条 **JSON**（JSON Lines），UTF-8，`appendFile` + 换行。

### 6.1 公共字段（每条必有）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | string | ISO 8601 时间戳 |
| `level` | `'info' \| 'warn' \| 'error'` | 与 Agent 一致 |
| `event` | string | 点分事件名，见 §8 |
| `…` | unknown | 事件专有字段，经脱敏后写入 |

### 6.2 写入 API（约定）

```typescript
logFeishuCliEvent(level: FeishuCliLogLevel, event: FeishuCliLogEventName, fields?: Record<string, unknown>): void
```

- 内部：`sanitizeForLog({ ts, level, event, ...fields })` → `JSON.stringify` → 串行写盘（Promise 链，与 `agentLogger` 相同）。
- 提供 `flushFeishuCliLogger()` 供测试使用。

### 6.3 大字段与截断

- 字符串默认遵循 `sanitizeForLog` 的 `DEFAULT_MAX_STRING_LENGTH`（128KB），超出则 `_truncated` / `_originalLength`。
- `stdout` / `stderr` **预览**：默认最多 **4KB** 字符（与 `runLarkCliExecutor` 进度切片一致）；完整输出不落盘，仅 `stdoutLen` / `stderrLen` / `exitCode` / `timedOut`。

---

## 7. 脱敏规则

### 7.1 复用 Agent 规则

对整条记录调用 `electron/agentLogger/sanitize.ts` 的 `sanitizeForLog`，包括：

- 敏感键名：`api_key`、`password`、`secret`、`token`、`authorization` 等 → `[REDACTED]`
- 字符串内：`sk-ant-*`、`Bearer …`、超长 Base64 → 替换为占位符

**实现要求：** 将 `sanitize.ts` 抽为可被 `agentLogger` 与 `feishuCliLogger` 共用的模块（例如 `electron/logSanitize.ts`），避免复制。

### 7.2 飞书专用规则（在 sanitize 之后或作为预处理）

| 数据类型 | 落盘策略 |
|----------|----------|
| 用户消息 `content` / `rawContent` | **禁止**全文；记录 `contentLen`、`contentHash`（8 位 hex，与 `FeishuAuditLogger.contentHash` 算法一致） |
| `FeishuInboundMessage` | 记录 `messageId`、`chatId`、`chatType`、`senderOpenId`、`msgType`、`mentionsBot`、`createTime`、附件元数据（`kind`、`fileName`、`mimeType`），**不含** `localPath` 绝对路径（可记 `localPathBasename`） |
| `lark-cli` 参数 `args` | 使用 `redactLarkCliArgsForDisplay` 逻辑：隐藏 `--secret`、含 token 的参数值；`--data` 仅记 `dataLen` + `dataHash`，不记 JSON 正文 |
| OAuth / 配置 URL | 仅保留 origin + pathname；`user_code`、`state`、`token` 等 query **剥离** |
| `appId` / `appSecret` | 仅 `appIdSuffix`（后 4 位）或 `configured: true`；永不记录 Secret |
| `senderOpenId` / `chatId` | 允许记录（排障需要）；若未来合规要求可改为 `openIdSuffix` |
| 环境变量 | 不记录 `process.env` 快照 |

### 7.3 与审计日志的一致性

写入 `feishu.audit.*` 时，字段约束**不得弱于** Phase 2 设计（§8.4 隐私）：不记录 message 全文、不记录 App Secret。

---

## 8. 事件清单（尽量全覆盖）

事件名采用 `feishu.<域>.<动作>`；下列「建议字段」为排障最小集，实现可增加 `durationMs`、`error` 等。

### 8.1 日志器与服务生命周期

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.logger.startup` | info | `initFeishuCliLogger` 后 | `logDir`, `isPackaged`, `workDir` |
| `feishu.service.bundle_created` | info | `createFeishuBundle` | `hasRunner`, `remoteEnabled`（读配置） |
| `feishu.service.shutdown` | info | `shutdownFeishuServices` | — |
| `feishu.config.persist` | info | `persistFeishuConfig` | 变更键名列表 `keys[]`，**不**记录完整配置对象 |

### 8.2 IPC — CLI 安装与凭据（`feishuIpc.ts`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.ipc.detect_cli` | info | `feishu:detect-cli` 完成 | `installed`, `version`, `nodeAvailable`, `npmAvailable` |
| `feishu.ipc.install_cli` | info/warn | `feishu:install-cli` | `success`, `timedOut`, `stderrPreview` |
| `feishu.ipc.install_skill` | info/warn | `feishu:install-skill` | 同上 |
| `feishu.ipc.config_init` | info | `feishu:config-init` 开始/结束 | `success`, `timedOut`, `authUrlHost`（无 query） |
| `feishu.ipc.config_init.progress` | info | `onProgress` 行（节流：每 2s 最多 1 条） | `linePreview`（≤300 字符） |
| `feishu.ipc.auth_login` | info | `feishu:auth-login` | `success`, `timedOut`, `browserOpened` |
| `feishu.ipc.auth_status` | info | `feishu:auth-status` | `authorized`, `exitCode` |
| `feishu.ipc.check_cli_update` | info | `feishu:check-cli-update` | `latest` |
| `feishu.ipc.event_start` | info | `feishu:event-start` | 返回的 `FeishuEventStatus` |
| `feishu.ipc.event_stop` | info | `feishu:event-stop` | 同上 |
| `feishu.ipc.health_check` | info | `feishu:health-check`（可选采样：仅错误时） | `cli.installed`, `event.state`, `pendingConfirms` |
| `feishu.ipc.auto_start` | info/warn | `autoStartFeishuEventIfNeeded` | `started`, `reason`（未启用的原因枚举） |

### 8.3 事件订阅子进程（`FeishuEventService`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.event.subscribe_spawn` | info | `spawnSubscribe` | `cliPath`, `args`（固定数组可原样） |
| `feishu.event.state` | info | `setState` | `state`, `lastErrorPreview` |
| `feishu.event.line_parse_ok` | info | 解析出 `FeishuInboundMessage` | §7.2 脱敏后的 inbound 字段 |
| `feishu.event.line_parse_skip` | warn | JSON 解析失败或 `parseCompactInboundEvent` 返回 null | `linePreview`（≤500 字符） |
| `feishu.event.stderr` | warn | stderr 有数据 | `stderrPreview`（≤500） |
| `feishu.event.process_close` | warn/info | 子进程 `close` | `exitCode`, `intentionalStop` |
| `feishu.event.restart_scheduled` | warn | `scheduleRestart` | `exitCode`, `delayMs`, `attempt`, `restartsInHour` |
| `feishu.event.restart_give_up` | error | 超过 `maxRestartsPerHour` | `maxRestartsPerHour` |

### 8.4 入站消息路由（`RemoteCommandRouter` + `feishuInboundParser`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.inbound.received` | info | `handleInbound` 入口 | 脱敏 inbound 摘要 |
| `feishu.inbound.accept` | info | `shouldAcceptInbound` 且 `accept` | `reason`, `contentLen`, `contentHash` |
| `feishu.inbound.reject` | info | `!accept.accept` | `reason`（`empty`/`too_long`/`no_mention`/…） |
| `feishu.inbound.allowlist_reject` | warn | 不在 `remoteSenderAllowlist` | `senderOpenId` |
| `feishu.inbound.rate_limit` | warn | 限速 | `senderOpenId` |
| `feishu.inbound.duplicate` | info | `processedStore.has` | `messageId` |
| `feishu.inbound.disambiguation` | info | 工作目录歧义 | `profileIds[]`, `chatId` |
| `feishu.inbound.sensitive_workdir` | warn | `profile.sensitive` | `profileId` |
| `feishu.inbound.parallel_full` | warn | 远程 Agent 并行已满 | `maxParallel` |
| `feishu.inbound.confirm_resolved` | info | `confirmManager.tryResolveFromInbound` 为 true | `decision`（y/n，无工具 input） |

与 audit 对齐（可同时写 audit + 下列 event）：

| event | 对应 audit `type` |
|-------|-------------------|
| `feishu.audit.inbound` | `inbound` |
| `feishu.audit.agent_start` | `agent_start` |
| `feishu.audit.agent_done` | `agent_done` |
| `feishu.audit.reply` | `reply` |
| `feishu.audit.rate_limit` | `rate_limit` |
| `feishu.audit.workdir_switch` | `workdir_switch` |

建议字段在 audit 类型基础上增加：`sessionId`、`requestId`、`isNewSession`（若有）。

### 8.5 会话与工作目录（`feishuSessionResolver`、`feishuWorkDirResolver`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.session.resolved` | info | `resolveFeishuSession` | `sessionId`, `isNew`, `chatId`, `mergeWindowMs` |
| `feishu.workdir.resolved` | info | `resolveWorkDirFromFeishuCommand` | `profileId`, `profileName`, `ambiguousCount` |

### 8.6 CLI 执行（`LarkCliRunner`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.cli.run.start` | info | `run()` 开始 | `argsRedacted`, `timeoutSec`, `cwd` |
| `feishu.cli.run.done` | info | `run()` 结束 | `exitCode`, `timedOut`, `durationMs`, `stdoutLen`, `stderrLen`, `stdoutPreview`, `stderrPreview` |
| `feishu.cli.run.spawn_error` | error | `spawnCommandSafe` 返回 error | `error` |
| `feishu.cli.detect` | info | `detect()` | 与 `FeishuCliDetectResult` 一致 |

**说明：** 所有经 `LarkCliRunner.run` 的调用（含 `replyFeishuText`、`run_lark_cli` 工具、auth/status）均应经过上述埋点，避免遗漏回复失败。

### 8.7 Agent 工具 — `run_lark_cli`（`runLarkCliExecutor` + `toolChatLoop`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.tool.run_lark_cli` | info/warn | 工具执行结束 | `sessionId`, `argsRedacted`, `success`, `writeOp`（`isLarkCliWriteOperation`）, `durationMs`, `error` |
| `feishu.tool.run_lark_cli.rejected` | warn | `assertSafeLarkCliArgs` 失败 | `error` |

**补齐 audit：** 实现 `FeishuAuditEvent` 中已有但未写入的 `{ type: 'lark_cli', … }`（至少远程会话与桌面会话中 `source=feishu` 时）。

### 8.8 远程 Agent（`feishuRemoteAgent`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.agent.remote.start` | info | `runFeishuRemoteAgent` 入口 | `sessionId`, `requestId`, `workDir`, `planMode`, `confirmPolicy` |
| `feishu.agent.remote.plan_branch` | info | 走 Plan 分支 | `planDocPath`（仅相对 workDir 路径） |
| `feishu.agent.remote.done` | info | 正常结束 | `ok`, `pendingConfirm`, `summaryLen` |
| `feishu.agent.remote.error` | error | catch | `error`, `sessionId` |

### 8.9 确认流（`FeishuConfirmManager`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.confirm.request` | info | `requestConfirm` | `confirmId`, `kind`, `sessionId`, `toolName`, `messageId`, `chatId`, `expiresAt` |
| `feishu.confirm.resolved` | info | `resolve` | `confirmId`, `decision`（y/n/timeout） |
| `feishu.confirm.cancel` | info | `cancel` | `confirmId` |

**补齐 audit：** `{ type: 'confirm_request', confirmId, decision? }`。

### 8.10 回复（`feishuReply`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.reply.send` | info | `replyFeishuText` 完成 | `messageId`, `textLen`, `truncated`, `exitCode` |

### 8.11 npm/npx 辅助（`npmCommandRunner`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.npm.command` | info | `runNpmCommand` / `runNpxCommand` 结束 | `command`（`npm`/`npx`）, `argsRedacted`, `success`, `timedOut`, `durationMs` |

### 8.12 去重存储（`FeishuProcessedStore`）

| event | level | 触发时机 | 建议字段 |
|-------|-------|----------|----------|
| `feishu.processed.mark` | info | `mark` | `messageId`, `entryCount`（当前 store 条数） |

---

## 9. 埋点位置汇总（实现检查表）

| 模块 | 文件 | 必须埋点 |
|------|------|----------|
| 日志器 | `electron/feishu/feishuCliLogger.ts`（新建） | API + 路径 |
| 主进程启动 | `electron/main.ts` | `initFeishuCliLogger` |
| IPC | `electron/feishu/feishuIpc.ts` | §8.2 各 handle |
| 事件服务 | `electron/feishu/feishuEventService.ts` | §8.3 |
| 路由 | `electron/feishu/remoteCommandRouter.ts` | §8.4 + audit 双写 |
| CLI 运行器 | `electron/feishu/larkCliRunner.ts` | §8.6 |
| 回复 | `electron/feishu/feishuReply.ts` | §8.10 |
| 确认 | `electron/feishu/feishuConfirmManager.ts` | §8.9 |
| 远程 Agent | `electron/feishu/feishuRemoteAgent.ts` | §8.8 |
| 工具 | `electron/tools/runLarkCliExecutor.ts` | §8.7 |
| 审计 | `electron/feishu/feishuAuditLogger.ts` | 可选转发 `feishu.audit.*` |

---

## 10. 非功能需求

| 项 | 要求 |
|----|------|
| 性能 | 单条日志序列化 + 排队写入；热路径（如 event 每行）对 `line_parse_ok` 可配置采样（默认**不采样**，全部记录） |
| 并发 | 与 Agent 相同：全局 `writeChain` 串行化，避免交错行 |
| 磁盘 | 按日分文件；无单文件 5MB 轮转（与 Agent 一致）；由用户自行清理旧日期文件 |
| 测试 | `feishuCliLogger` 单测：路径解析、脱敏字段、`flush` 后文件存在；`larkCliRunner` 可对 `run.done` 做集成 mock 测试 |
| 文档 | 在 `CLAUDE.md` 或飞书开发文档中增加一节「排障：查看 FeishuCli-*.log」 |

---

## 11. 验收标准

1. 开发模式运行 `npm run dev` 后，在 `{项目根}/logs/FeishuCli-{今天}.log` 能看到 `feishu.logger.startup`。
2. 打包模式下，日志出现在 `{workDir}/.agent/logs/FeishuCli-{今天}.log`。
3. 完成一次「检测 CLI → 启动事件订阅 → 手机发消息触发远程 Agent」全流程后，文件中**至少**包含 §8.2、§8.3、§8.4、§8.6、§8.8 各类事件各 1 条。
4. 任意含 `token`、`secret`、用户消息正文的字段在文件中均为 `[REDACTED]` 或 `contentHash`，**无**明文长消息。
5. `run_lark_cli` 执行后，audit 文件（若保留）与 FeishuCli 日志均有 `lark_cli` / `feishu.tool.run_lark_cli` 记录。
6. 模拟日志目录不可写时，飞书收发与 CLI 调用仍成功，无未捕获异常。

---

## 12. 实现阶段建议

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| P1 | `feishuCliLogger` + 路径 + sanitize 共用 + `main` 初始化 | P0 |
| P1 | `LarkCliRunner.run` / `FeishuEventService` / `RemoteCommandRouter` 核心埋点 | P0 |
| P2 | `feishuIpc` 全量 + `FeishuConfirmManager` + `runLarkCliExecutor` + audit 双写 | P0 |
| P3 | `npmCommandRunner`、ProcessedStore、health_check 采样、配置变更日志 | P1 |

---

## 13. 待确认问题

| 编号 | 问题 | 建议默认 |
|------|------|----------|
| OQ-1 | 是否与 Agent 共用同一物理目录？ | **是**（仅文件名不同） |
| OQ-2 | `line_parse_ok` 高频是否采样？ | **否**（先全量，后续加配置） |
| OQ-3 | 长期是否废弃 `userData/logs/feishu-audit.log`？ | **否**，本阶段保留 UI 专用 audit |
| OQ-4 | 文件名用 `FeishuCli` 还是 `Feishu`？ | **`FeishuCli`**，与 Agent 命名风格一致 |

---

## 14. 相关文件（实现时）

- `electron/agentLogger/agentLogPaths.ts` — 目录解析（可提取 `resolvePackagedLogDir` 复用）
- `electron/agentLogger/sanitize.ts` — 脱敏
- `electron/feishu/*.ts` — 埋点调用方
- `src/shared/feishuTypes.ts` — `FeishuAuditEvent` 类型扩展
- `src/renderer/components/Config/FeishuAuditDrawer.tsx` — 不受本需求破坏
