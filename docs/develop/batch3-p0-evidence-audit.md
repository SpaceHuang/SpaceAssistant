# 第三批 P0 证据复测销号表

> 复测时点:2026-09-20 | worktree:`.worktrees/batch3` | 分支 `codex/batch3-runtime-admission-sdk-reuse` @ `5bb10766`(与计划声明基线一致)
> 复测方式:计划 §1 表全部证据命令逐条重跑;无「文件 / 路径不存在」级失败,不触发整表复核纪律。

## 销号结果

| 偏差 | 命令 | 复测结果 | 与计划差异 | 销号 |
| --- | --- | --- | --- | --- |
| 23 | `rg -n -e admission -e rateLimit -e quota src/shared electron --glob '!*.test.ts'` | 命中全在 butler(仅拦 butlerInvoker)与 browser 域、config 类型 | 一致 | ✅ |
| 23 | `rg -n submit-outbound electron` | `agentProtocolIpc.ts:532`、`preload.ts:40` | 一致 | ✅ |
| 23 | `rg -n createOutboundAcceptor electron` | `outboundAcceptor.ts:202`(定义)、`agentProtocolIpc.ts:454`(消费) | 一致 | ✅ |
| 23 | `rg -n listActive electron/ipc/agentProtocolIpc.ts` | `:525` / `:539` / `:587` | 一致 | ✅ |
| 17 | `rg -n -e resolveWorkDir -e resolveApiKey -e getBrowserDetectContext -e turnBoundary src/shared/agent/invocation.ts` | `:166`(resolveWorkDir 函数属性)、`:172`(resolveApiKey 接口方法)、`:275`(getBrowserDetectContext 接口方法)、`:280`(turnBoundary 函数属性) | 一致;P0 专项补充:`:166`/`:280` 为函数属性形态(待清),`:172`/`:275` 为接口方法形态(合法) | ✅ |
| 18 | `rg -n -e "const registry" -e TypedToolRegistry electron/tools/builtinExecutors.ts` | `:38`(import)、`:1303`(`const registry = new TypedToolRegistry()`) | 一致 | ✅ |
| 18 | `rg -n "let singleton" electron/confirmation/audit.ts` | `:11` | 一致 | ✅ |
| 18 | MCP semaphore | `mcpToolExecutor.ts:31`(globalSemaphore)、`:32`(perServerSemaphores 声明)/`:39`/`:42`(消费);`semaphore.ts:4`(class)、`:32`(withSemaphore) | 一致 | ✅ |
| 18 | `rg -n globalConfirmIds electron/remote/confirmId.ts` | `:6`(Set 声明)及 `:19`/`:20`/`:28`/`:33`/`:37` 消费 | 一致 | ✅ |
| 18 | 注册入口 | `chatCancelRegistry.ts`(:18 registerChatCancel / :26 signalChatCancel / :32 clearChatCancel / :36 throwIfChatCancelled / :41 cancelAllActiveChats);`toolRevocationRegistry.ts`(:7 / :11 / :21 / :27) | 一致 | ✅ |
| 19 | `rg -n "from 'electron'" electron/toolChatLoop.ts` | 0 命中;`^import` 共 117 条 | 一致 | ✅ |
| 19 | `rg -n '"workspaces"' package.json` | 0 命中 | 一致 | ✅ |
| 20 | `electron/toolChatLoop.inMemoryPorts.test.ts` | 存在 | 一致 | ✅ |
| 15 | `rg -n -e strict -e loose src/shared/policy/policyPackages.ts` | 档位语义注释 `:6-7`、desktop transforms `:72-74`、im transforms `:79-80`、availablePackages `:85`/`:91`/`:97` | 一致 | ✅ |
| 13 | `rg -n menuLabels src/shared electron --glob '!*.test.*'` | 仅 `electron/menu.ts:3`(`getMenuLabels`) | 一致 | ✅ |
| 14 | `rg -n -e retention -e rotate -e prune electron/agentLogger/` | 仅 `types.ts:131`(`usageStats.retention.cleaned` 事件类型),无轮转实现;`agentLogPaths.ts:15`(dev 目录)/`:25`(发布态 `.agent/logs`) | 一致 | ✅ |
| 24 | `rg -n enforceSessionEventRetention electron/sessionEvents.ts` | `:635` / `:636` / `:639` | 一致 | ✅ |
| 24 | `rg -n enforceSessionEventRetentionDetailed electron/main.ts` | `:39`(import)、`:443`(调用,硬编码 `100`) | 一致 | ✅ |

## 23 号专项:调用发起入口盘点(接线清单)

| # | 入口 | 位置 | lane | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 桌面受理端口 `chat:submit-outbound` | `electron/ipc/agentProtocolIpc.ts:532` → `outboundAcceptor.submitOutbound` | user | 准入挂发起前 |
| 2 | 远端发起 `runImRemoteAgent` | `electron/remote/imRemoteAgent.ts:43` | user | 准入挂发起前 |
| 3 | 管家发起 `butlerInvoker` | `electron/butler/butlerInvoker.ts:112-116` | automation | 现 ButlerAdmission(并发=1+小时上限)收敛为 automation lane 配置 |
| 4 | 嵌套调用 `invokeApproval` | `electron/confirmation/agentChannel.ts:87`(装配)/`:173`(调用) | 继承等待方 | 优先级继承 + 有界等待 + 保留位 |

排水器不单列(`outboundAcceptor.ts:379` `drain` 复用 `submitOutbound` 同源)。
`butlerAdmission` 消费点:`butlerInvoker.ts:19/112/113/116`、`main.ts:13/597/630`、`approvalAgent.ts:247`(注释:内层不取票防自锁)。

## 17 号专项:契约内函数形态清单

| 位置 | 符号 | 形态 | 处置 |
| --- | --- | --- | --- |
| `invocation.ts:166` | `AgentWorkspacePorts.resolveWorkDir?: () => string` | 函数属性(非方法简写) | 改方法简写或归并宿主端口 |
| `invocation.ts:172` | `AgentCredentialsPorts.resolveApiKey(): Promise<string \| null>` | 接口方法 | 合法,白名单 |
| `invocation.ts:275` | `AgentHostPorts.getBrowserDetectContext?()` | 接口方法 | 合法,白名单 |
| `invocation.ts:280` | `AgentHostPorts.turnBoundary?: (input: unknown) => Promise<void>` | 函数属性 | 改方法简写或清出 |

A1 实际改造面以本清单为准(可能缩为「方法简写归一 + 形状断言防退化」)。

## 18 号专项:消费方符号级盘点(另见 A2 阶段补充)

- `builtinExecutors` registry:`getToolExecutor`(`:1330`)、`getRegisteredTool`(`:1334`)及 `electron/tools/` 内注册方;
- `audit` singleton:`electron/confirmation/audit.ts` 导出函数群;
- MCP semaphore:`mcpToolExecutor.ts` 内 `:137` 等消费;
- confirmId:`electron/remote/confirmId.ts` 导出函数群(远程确认一次性消费);
- chatCancelRegistry / toolRevocationRegistry:导出函数群,消费方在 toolChatLoop / cancel IPC / revocation IPC。
