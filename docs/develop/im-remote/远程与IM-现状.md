# 远程与 IM —— 现状

> **核对基线**：`main` `17236274`（2026-10-14）｜**窗口**：`git log 17236274..HEAD -- electron/feishu electron/wechat electron/remote electron/outbound`（开工点即基线，窗口为空）
> **口径**：只写「今天代码是什么样」的事实，每条给可复现命令；历史过程见 [history.md](./history.md)。

## 1. 飞书链路（`electron/feishu/`）

| 环节 | 文件 | 复现命令 |
| --- | --- | --- |
| CLI 进程流与日志 | `feishuCliFlow.ts`、`feishuCliLogger.ts`、`feishuCliLogFields.ts` | `ls electron/feishu/feishuCli*.ts` |
| 事件服务与入站解析 | `feishuEventService.ts`、`feishuInboundParser.ts` | `ls electron/feishu/feishu{EventService,InboundParser}.ts` |
| 附件下载与登记 | `feishuInboundAttachmentDownload.ts`、`feishuAttachmentRegistry.ts` | `ls electron/feishu/feishu*{Attachment,Registry}*.ts` |
| IM 通道 | `feishuImChannel.ts` | `rg -n 'export' electron/feishu/feishuImChannel.ts` |
| 归属绑定与去重 | `feishuOwnerBind.ts`、`feishuProcessedStore.ts` | `ls electron/feishu/feishu{OwnerBind,ProcessedStore}.ts` |
| 审计与 IPC | `feishuAuditLogger.ts`、`feishuIpc.ts` | `ls electron/feishu/feishu{AuditLogger,Ipc}.ts` |

**日志位置约定（飞书 CLI 全链路）**：JSON Lines 格式，文件 `FeishuCli-{YYYYmmdd}.log`；开发模式在 `{项目根}/logs/`，打包模式在 `{workDir}/.agent/logs/`（同目录另有 Agent 日志）。注意：设置页「操作记录」读的是 `{userData}/logs/feishu-audit.log`，与上述全链路日志是**两份不同的日志，互不替代**。

## 2. 微信链路（`electron/wechat/`）

| 环节 | 文件 | 复现命令 |
| --- | --- | --- |
| Bot 服务与日志 | `weChatBotService.ts`、`weChatCliLogger.ts`、`weChatCliLogFields.ts` | `ls electron/wechat/weChat{ BotService,CliLogger,CliLogFields}.ts` |
| 命令路由 | `weChatCommandRouter.ts` | `rg -n 'export' electron/wechat/weChatCommandRouter.ts` |
| 入站解析与引用绑定 | `weChatInboundParser.ts`、`weChatQuoteBinding.ts` | `ls electron/wechat/weChat{InboundParser,QuoteBinding}.ts` |
| 去重 | `weChatProcessedStore.ts` | `ls electron/wechat/weChatProcessedStore.ts` |
| IM 通道与确认投递 | `weChatImChannel.ts`、`weChatConfirmationPromptAdapter.ts` | `ls electron/wechat/weChat{ImChannel,ConfirmationPromptAdapter}.ts` |
| 审计与 IPC | `weChatAuditLogger.ts`、`weChatIpc.ts` | `ls electron/wechat/weChat{AuditLogger,Ipc}.ts` |

**日志位置约定（微信 CLI 全链路）**：JSON Lines 格式，文件 `WeChatCli-{YYYYmmdd}.log`；路径规则与飞书相同（开发 `{项目根}/logs/`、打包 `{workDir}/.agent/logs/`）。设置页「操作记录」读的 `{userData}/logs/wechat-audit.log` 与它**互不替代**。

## 3. 远程会话、澄清与延迟审批（`electron/remote/`）

| 环节 | 文件 | 复现命令 |
| --- | --- | --- |
| 远程进度上下文 | `buildRemoteProgressContext.ts` | `rg -n 'export' electron/remote/buildRemoteProgressContext.ts` |
| 澄清（clarification）三件套 | `clarificationHandle.ts`、`clarificationInbound.ts`、`clarificationPrompt.ts` | `ls electron/remote/clarification*.ts` |
| 延迟审批族 | `deferredApproval{Runtime,Ingress,Notification,NotificationDelivery,NotificationSender,CloseCoordinator}.ts` | `ls electron/remote/deferredApproval*.ts` |
| 确认 ID 与失败回执 | `confirmId.ts`、`confirmationFailureReceipt.ts` | `ls electron/remote/confirm{Id,ationFailureReceipt}.ts` |

## 4. 出站受理

| 结论 | 复现命令 |
| --- | --- |
| 出站意图统一由 `outboundAcceptor` 受理（start-turn 或降级排队） | `rg -n 'export\|startTurn\|queue' electron/outbound/outboundAcceptor.ts` |

## 5. 意图 Track 与归因

| 结论 | 复现命令 |
| --- | --- |
| Track 契约在共享层 | `ls src/shared/remoteTrack.ts typeTests/remoteTrack.typecheck.ts` |
| 归因 / 观测 / 诊断 / 运维指标 | `ls electron/database/remoteTrack*.ts` |
| 远程 Track 路由 | `rg -n 'remoteTrack' electron/feishu/feishuInbound* electron/wechat/weChatInbound*` |

## 6. 审批归属（跨主题）

远程确认不落桌面端：`rg -n 'keep remote confirmations off desktop' -- .`（提交 `ba142372`）；策略侧的 IM 来源分类见 [`../safety-approval/确认与审批-现状.md`](../safety-approval/确认与审批-现状.md) §4。

## 7. 本主题的现状/设计文档与口径

| 文档 | 类型 |
| --- | --- |
| [im-architecture-refactor.md](./im-architecture-refactor.md) | 架构设计（v2.1） |
| [feishu-integration-phase1-design.md](./feishu-integration-phase1-design.md) 等 3 篇 | 分阶段设计 |
| [wechat-integration-phase1-design.md](./wechat-integration-phase1-design.md) | 设计 |
| [artifact-decision-remote-im-technical-design.md](./artifact-decision-remote-im-technical-design.md) | 设计（v1.2） |
| [remote-im-intent-track-operations-runbook.md](./remote-im-intent-track-operations-runbook.md) | 运维手册 |
| [`../../requirement/im-remote/需求基线.md`](../../requirement/im-remote/需求基线.md) | 需求口径 |
| [`../archive/im-remote/`](../archive/im-remote/) | 已归档迭代（5 件） |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/feishu electron/wechat electron/remote electron/outbound
rg -n 'imChannel|deferredApproval|remoteTrack|outboundAcceptor' electron
```
