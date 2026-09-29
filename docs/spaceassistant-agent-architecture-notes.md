# SpaceAssistant Agent 架构说明与代码量

本文档对应架构图 [spaceassistant-agent-architecture.html](./spaceassistant-agent-architecture.html)，按图中的模块逐项说明职责，并标注对应的源码位置与代码量。

## 统计口径

- 代码量 = 源码物理行数，括号内为「去除空白行后的非空行数」。
- 统计范围仅包含 `*.ts / *.tsx / *.css / *.js / *.jsx`，排除 `node_modules`、`dist`、`dist-electron` 等生成物。
- 采用 PowerShell `Get-Content` 逐文件统计。
- 有少量文件跨模块复用（最典型的是 `electron/tools/builtinExecutors.ts`，它既是执行器注册表，也内联实现了文件与脚本执行器），文中已单独说明，模块计数存在少量重叠。
- 除单独注明外，各模块的代码量都包含测试文件（`*.test.ts` / `*.test.tsx` 及 `__mocks__` 目录）；「集成工具」一节额外拆分了实现 / 测试。

## 总体规模

- 主进程 `electron/`：489 个文件，约 63,213 行（57,090 非空行）。
- 渲染与共享代码 `src/`：544 个文件，约 63,941 行（57,166 非空行）。

## 模块总览

| 图中模块 | 对应代码 | 文件数 | 代码量（总 / 非空） |
| --- | --- | ---: | ---: |
| 渲染进程 UI | `src/renderer/` | 398 | 51,839 / 46,327 |
| 主进程 IPC 入口 | `preload.ts` + `claudeStreamHandlers.ts` + `appIpc.ts` | 3 | 2,741 / 2,531 |
| Agent 工具循环 | `toolChatLoop.ts` 及循环助手 | 6 | 2,487 / 2,380 |
| Anthropic API（外部） | SDK 接入与请求校验文件 | 7 | 942 / 829 |
| 上下文注入（Skills / 项目记忆） | `electron/skills/` 及记忆/提示词 | 23 | 2,365 / 2,068 |
| 工具确认闸门 | `toolConfirmRegistry.ts` | 1 | 86 / 73 |
| 工具执行器注册表 | `builtinExecutors.ts` + 工具定义/过滤 | 5 | 1,581 / 1,527 |
| 文件工具 | `builtinExecutors.ts` 内执行器 + 独立助手 | 7 | 855 / 775（助手部分） |
| Shell 工具 | `runShellExecutor.ts` + `electron/shell/` | 33 | 5,275 / 4,774 |
| 集成工具（浏览器 / 飞书 / 微信 / 远程） | 见下方细分 | 181 | 22,082 / 19,931 |
| SQLite 持久化 | `electron/database/` + 编解码/备份 | 19 | 2,994 / 2,721 |

## 各模块说明

### 1. 渲染进程 UI

Electron 渲染进程，React 18 + Ant Design，通过 `window.api` 与主进程通信。包含聊天界面、设置弹窗、会话/文件/搜索面板、工具调用卡片等。

- 目录：`src/renderer/`
- 规模：398 个文件，51,839 行（46,327 非空行）

### 2. 主进程 IPC 入口

渲染进程与主进程之间的桥接层。`preload.ts` 通过 `contextBridge` 暴露 `window.api`；`claudeStreamHandlers.ts` 注册 `claude-chat-create-with-tools` 等流式聊天入口；`appIpc.ts` 承担会话、消息、配置、文件、搜索等应用级 IPC。

- `electron/preload.ts`：423 / 397
- `electron/claudeStreamHandlers.ts`：530 / 484
- `electron/appIpc.ts`：1,788 / 1,650
- 小计：3 个文件，2,741 / 2,531

### 3. Agent 工具循环

Agent 的核心编排器，多轮调用 Anthropic Messages Stream，解析 `text / thinking / tool_use` 增量，把工具结果回填后继续推理，直到 `end_turn`。

- `electron/toolChatLoop.ts`：2,140 / 2,056
- 助手：`claudeToolLoopStreamParams.ts`、`toolLoopModelOptions.ts`、`toolInputGuards.ts`、`stopReason.ts`、`toolUseInputMerge.ts`
- 小计：6 个文件，2,487 / 2,380

### 4. Anthropic API（外部）

Anthropic 是外部 LLM 服务，本地不包含其服务端代码，图中该节点对应的是 SDK 接入与请求侧代码。

- `electron/anthropicClientFactory.ts`、`anthropicUsageNormalize.ts`、`anthropicToolPayload.ts`、`claudeRequestGuards.ts`、`llmServiceResolver.ts`
- `src/shared/anthropicToolSanitize.ts`、`src/shared/llmModelConfig.ts`
- 小计：7 个文件，942 / 829

### 5. 上下文注入（Skills / 项目记忆）

为模型组装系统提示词：Skills 扫描/匹配/路由，项目记忆缓存，以及提示词拼接。

- `electron/skills/`：18 个文件，1,870 / 1,626
- `electron/projectMemory.ts`、`electron/llmSystemPrompt.ts`、`src/shared/skillPrompt.ts`、`recommendedSkills.ts`、`skillHintRecords.ts`
- 小计：23 个文件，2,365 / 2,068

### 6. 工具确认闸门

高危工具执行前等待用户确认/拒绝/信任。核心是 `toolConfirmRegistry.ts`（86 / 73）；工具风险等级判定位于 `src/shared/domainTypes.ts`，Shell 信任判定位于 `electron/shell/shellCommandTrust.ts`。

### 7. 工具执行器注册表

把模型返回的 `tool_use` 名称映射到具体执行器。`builtinExecutors.ts` 既是注册表，也内联实现了文件与脚本执行器。

- `electron/tools/builtinExecutors.ts`：1,036 / 1,000
- `electron/tools/types.ts`：140 / 129
- `electron/toolsConfigRuntime.ts`：59 / 55
- `src/shared/builtinToolDefinitions.ts`：316 / 314
- `src/shared/toolsConfigFilter.ts`：30 / 29
- 小计：5 个文件，1,581 / 1,527

### 8. 文件工具

`read_file / list_directory / edit_file / write_file / grep` 的执行器在 `builtinExecutors.ts` 内；独立的文件读写助手负责流式读取、自动审批、写冲突检测、路径校验与工作目录切换。

- 助手文件：`electron/tools/readFileStreaming.ts`、`writeFileAutoApproval.ts`、`electron/toolWriteConflict.ts`、`toolPathField.ts`、`fileStateCache.ts`、`electron/tools/workDirExecutors.ts`、`src/shared/readFileRange.ts`
- 小计（不含 builtinExecutors 内执行器）：7 个文件，855 / 775

### 9. Shell 工具

`run_shell` 的执行与安全预检，以及脚本内容安全分析。`run_script` 的 `runScriptExecutor` 位于 `builtinExecutors.ts`，其脚本内容分析在 `electron/shell/scriptContentSecurity.ts`。

- `electron/tools/runShellExecutor.ts`：320 / 291
- `electron/shell/`：32 个文件，4,955 / 4,483
- 小计：33 个文件，5,275 / 4,774

### 10. 集成工具

覆盖浏览器、飞书、微信以及远程会话能力。以下按「实现 / 测试」拆分，测试文件指 `*.test.ts` 及 `__mocks__` 目录。

| 子模块 | 对应代码 | 实现文件 | 实现行数（总 / 非空） | 测试文件 | 测试行数（总 / 非空） |
| --- | --- | ---: | ---: | ---: | ---: |
| 浏览器 | `electron/browser/` + `browserExecutor.ts` + `browserDetectExecutor.ts` | 20 | 2,914 / 2,617 | 16 | 1,595 / 1,389 |
| 飞书 | `electron/feishu/` + `runLarkCliExecutor.ts` + `readFeishuAttachmentExecutor.ts` | 24 | 3,550 / 3,230 | 21 | 2,629 / 2,363 |
| 微信 | `electron/wechat/` + `wechatExecutors.ts` + `weChatToolExecutor.ts` | 15 | 2,204 / 2,010 | 14 | 1,597 / 1,467 |
| 远程会话 | `electron/remote/` + `remoteSessionExecutors.ts` | 38 | 4,255 / 3,836 | 33 | 3,338 / 3,019 |
| **合计** | | **97** | **12,923 / 11,693** | **84** | **9,159 / 8,238** |

实现代码量较大的原因：每个渠道都要维护一套完整纵向能力，包括命令路由、IPC、确认回执桥接、CLI / 子进程管理、浏览器自动化、安全策略、远程 Agent 编排与状态机等；而核心 Agent 循环只负责调度，具体逻辑都下沉到了这些模块。

#### 10.1 四条线明细

按实现代码量从大到小排列，行数为「总行数 / 非空行数」。

**远程会话（实现 4,255 / 3,836）**

- `electron/remote/remoteTaskController.ts`：328 / 294
- `electron/remote/artifactDecisionImBridge.ts`：270 / 252
- `electron/remote/imProcessedStore.ts`：252 / 232
- `electron/remote/artifactDecisionRemote.ts`：223 / 207
- `electron/remote/remoteWriteGrantRegistry.ts`：214 / 196
- `electron/remote/imRemoteAgent.ts`：170 / 159
- `electron/remote/remoteSessionSwitchAudit.ts`：168 / 156
- `electron/remote/remoteAgentRegistry.ts`：163 / 144
- `electron/tools/remoteSessionExecutors.ts`：183 / 163
- 其余 29 个实现文件合计约 2,284 行

**飞书（实现 3,550 / 3,230）**

- `electron/feishu/remoteCommandRouter.ts`：842 / 783
- `electron/feishu/feishuIpc.ts`：525 / 482
- `electron/feishu/feishuConfirmManager.ts`：306 / 277
- `electron/feishu/feishuOwnerBind.ts`：283 / 253
- `electron/feishu/feishuEventService.ts`：217 / 200
- `electron/feishu/larkCliRunner.ts`：196 / 175
- `electron/feishu/npmCommandRunner.ts`：154 / 136
- `electron/feishu/larkCliImpactPolicy.ts`：142 / 126
- `electron/tools/runLarkCliExecutor.ts`：118 / 111
- `electron/tools/readFeishuAttachmentExecutor.ts`：44 / 41
- 其余 14 个实现文件合计约 723 行

**浏览器（实现 2,914 / 2,617）**

- `electron/tools/browserExecutor.ts`：467 / 434
- `electron/browser/stagehandService.ts`：393 / 361
- `electron/browser/actDangerAssessor.ts`：249 / 231
- `electron/browser/playwrightBrowserHost.ts`：225 / 202
- `electron/browser/rateLimiter.ts`：223 / 193
- `electron/browser/browserDependencyDetect.ts`：218 / 193
- `electron/browser/browserUserErrors.ts`：213 / 182
- `electron/browser/browserActionPolicy.ts`：135 / 124
- `electron/browser/rateLimitService.ts`：122 / 110
- `electron/tools/browserDetectExecutor.ts`：24 / 20
- 其余 10 个实现文件合计约 645 行

**微信（实现 2,204 / 2,010）**

- `electron/wechat/weChatCommandRouter.ts`：546 / 499
- `electron/wechat/weChatIpc.ts`：352 / 319
- `electron/wechat/weChatBotService.ts`：296 / 275
- `electron/wechat/weChatConfirmManager.ts`：281 / 248
- `electron/wechat/weChatRemoteAgent.ts`：110 / 108
- `electron/wechat/weChatSessionResolver.ts`：74 / 72
- `electron/wechat/weChatReplyService.ts`：60 / 54
- `electron/wechat/weChatCliLogFields.ts`：57 / 51
- `electron/tools/weChatToolExecutor.ts`：127 / 118
- `electron/tools/wechatExecutors.ts`：99 / 97
- 其余 5 个实现文件合计约 202 行

### 11. SQLite 持久化

会话、消息、配置、token 用量等分表存储，WAL 模式；`messageCodec.ts` 负责消息与工具调用的序列化/反序列化。

- `electron/database/`：14 个文件，2,534 / 2,307
- `electron/messageCodec.ts`：208 / 195
- `electron/sessionBackupManager.ts`：148 / 130
- `electron/debouncedSessionBackupManager.ts`：74 / 63
- `electron/dbSaveScheduler.ts`：29 / 25
- `electron/database.ts`：1 / 1（re-export）
- 小计：19 个文件，2,994 / 2,721

## 补充说明

- 架构图中的「Anthropic API」是外部服务，本地只有 SDK 接入代码；图中其他模块均为本仓库实现。
- `docs/develop/cli-subagent-integration-design.md` 描述的 `electron/subagent/` 子代理目前只是设计草案，仓库中尚未实现对应目录，因此未纳入本次统计。
