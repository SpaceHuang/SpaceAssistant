# 消息事实落库 Core 化：生产链路前置重构需求说明

> 状态：待实施
> 日期：2026-09-05
> 关联方案：[消息事实落库归 Core 重构方案](../develop/message-fact-persistence-core-refactor-plan.md)
> 目的：解决生产链路尚未具备统一事件 owner 的阻断问题，为后续 `TurnCoordinator` 接管消息事实创造可实施条件。

## 1. 背景与结论

当前系统的桌面、微信、飞书入口各自创建 user/assistant 消息，并在 renderer、tool loop、远程 router 中分别拼装正文、thinking、contentSegments、ToolCallRecord、skill hint 和终态。现有普通流与工具循环也有不同的生命周期和回调协议。

在这种结构下，直接接入 `TurnCoordinator` 会形成“双 owner”：新 Core 写一份事实，旧入口继续 append/patch 另一份事实，导致重复消息、首个 delta 早于占位、迟到事件覆盖终态和远程/桌面结果不一致。

因此，在继续实施消息事实落库 Core 计划前，必须先完成一轮生产链路重构：将所有模型执行入口统一为可消费的规范化事件 source，将消息创建、聚合、checkpoint、终止和恢复的所有权转移到主进程 Core；渠道只提交意图并消费权威投影。

## 2. 重构目标

完成后必须满足：

1. 每个 turn 只有一个 owner：`TurnCoordinator`。
2. user/assistant id 只由 Core 生成，renderer、微信、飞书不得生成权威消息 id。
3. assistant 在模型首个 delta 前已经以 `streaming` 落库。
4. 普通聊天和工具聊天共享一个执行生命周期；无工具仅是工具清单为空的同一路径。
5. 模型、工具、确认、恢复事件全部先规范化，再由同一个 reducer 生成 Message。
6. checkpoint/finalize/recovery 只更新既有 assistant，终态幂等且迟到事件不可复活。
7. 所有渠道收到相同的权威 Message、version 和 terminal outcome。
8. 取消、超时、窗口销毁、进程恢复均不会触发渠道私有补写。

## 3. 范围

### 3.1 必须重构

- `electron/claudeStreamHandlers.ts`
- `electron/toolChatLoop.ts`
- `electron/chatStreamService.ts`
- `src/renderer/components/Chat/ChatView.tsx`
- `src/renderer/services/chatRunnerService.ts`
- `src/renderer/services/chatToolSessionService.ts`
- `electron/wechat/weChatCommandRouter.ts`
- `electron/feishu/remoteCommandRouter.ts`
- 远程进度/回复服务及其 start/done 补写逻辑
- preload、shared API 和相关 IPC 测试/mocks

### 3.2 明确不改变

- 工具授权、确认策略、远程权限和工作目录决策规则
- 普通消息的主动编辑、删除、导入能力
- 模型供应商 SDK 的具体实现细节
- 现有消息字段语义；不新增 usage 字段

## 4. 目标架构

```text
Desktop / WeChat / Feishu
          │ TurnIntent
          ▼
    TurnCoordinator
      │ prepare/execute/cancel
      ▼
  ModelEventSource
      │ NormalizedEvent
      ▼
 AssistantFactAggregator
      ├── checkpoint/finalize ──► messages + turns
      ├── authoritative projection ──► renderer
      └── authoritative projection ──► remote channel
```

### 4.1 组件责任

| 组件 | 必须负责 | 禁止负责 |
| --- | --- | --- |
| `TurnCoordinator` | intent 校验、幂等、id/sequence、占位、事件串行化、checkpoint、终止、恢复 | SDK 解析、UI 文案、渠道发送 |
| `ModelEventSource` | 将普通流和工具循环转换为规范化事件 | 生成消息 id、写消息表、拼最终 Message |
| `AssistantFactAggregator` | 纯 reducer，维护 Message、工具状态、分段和 version | IO、随机数、授权决策 |
| renderer/IM adapter | 提交 intent、订阅投影、发送确认/取消 | append assistant、生成事实、补写终态 |
| 数据库 adapter | 原子 prepare、条件 checkpoint、turn 状态和 recovery 查询 | 推断渠道事实 |

## 5. 统一执行协议

### 5.1 TurnIntent

桌面和远程入口统一提交：

```ts
type TurnIntent =
  | { mode: 'create-user'; requestId: string; sessionId: string; input: ChatInput; excludeMessageIds?: string[]; config: TurnConfig }
  | { mode: 'reuse-user'; requestId: string; sessionId: string; userMessageId: string; excludeMessageIds: string[]; config: TurnConfig }
```

renderer 不再提交 `sourceMessages`、权威 user/assistant id 或工具事实。Core 根据数据库和 exclude 列表构建上下文。

### 5.2 两阶段生命周期

```text
prepare → prepared → execute → executing → terminal
                              ↘ waiting-confirm ↗
```

- `prepare` 原子完成 user（create 模式）和 assistant `streaming` 占位。
- prepare 返回 `turnId/requestId/sessionId/userMessage/assistantMessage/version/startToken`。
- prepare 完成前不得启动模型或发送 delta。
- `execute` 只能接受与 turn 绑定的一次性短期 token；重复 execute 返回原运行/终态。
- cancel/timeout 必须先中止模型、工具和确认等待，再进入统一终止流程。

### 5.3 规范化事件

至少支持：

- `content-delta`
- `thinking-delta`
- `tool-use`
- `confirm-requested`
- `tool-confirmed`
- `tool-progress`（带单调 seq）
- `tool-result`
- `skill-hint`
- `source-completed`
- `source-failed`
- `source-cancelled`
- `source-timeout`

事件必须携带 turn 关联信息；source 不得直接调用消息 append/patch API。

## 6. 生产迁移要求

### 6.1 模型执行层

1. 抽取统一 `ModelEventSource` 接口，普通流和工具 loop 都实现该接口。
2. Anthropic/SSE block 解析只负责转换事件，不负责 Message 聚合。
3. 工具确认、进度、结果、dependency recovery 和 skill hint 全部转换为规范化事件。
4. 无工具请求走同一 source，工具集合为空时自动退化为纯文本流。
5. usage 由统一 source 产生并关联 turn/message；最终 usage 只在 terminal 返回一次。

### 6.2 主进程 Core

1. `TurnCoordinator` 是唯一的消息事实 owner。
2. prepare 使用数据库事务原子创建 user/assistant，并写入 turn 元数据。
3. checkpoint 使用 assistant id + expected state/version 条件更新；禁止逐 token append。
4. finalize 统一处理 success/error/cancel/timeout/recovery，数据库成功后才广播 terminal。
5. 持久化 `turnId/requestId/assistantMessageId/state`，启动时先 recovery，再 restore 可恢复 turn。
6. unknown tool id、倒退 seq、重复事件、终态后事件必须诊断并忽略。

### 6.3 renderer

1. 发送前先订阅投影，再调用 prepare；不得自行创建 user/assistant id。
2. 删除新发送路径中的 assistant append、流式事实 reducer、ToolCallRecord registry 和事实 patch。
3. UI 只消费 progress/terminal 权威 snapshot；version 跳跃时用完整 Message 校准。
4. 保留主动编辑/删除等明确授权的通用 message mutation，不得将其误删。
5. 取消只发送 turn cancel，不再自行把 assistant patch 为 completed。

### 6.4 微信、飞书及其他远程入口

1. router 只提交 `TurnIntent`，不得 append user/assistant。
2. start/done/progress 的 id 必须来自 Coordinator 的 started/terminal snapshot。
3. 有无 `WebContents`、session switch、确认、取消和失败结果必须共享同一 Core 状态。
4. 远程出站回复可以独立跟随 outbound session，但不能改变 turn 的 owner session。
5. 删除 agent-done 补写和外层 assistant id 生成逻辑。

## 7. 兼容与切换策略

迁移必须分阶段，但每阶段只能有一个事实 owner：

1. **协议准备**：完成事件类型、source adapter、aggregator golden fixtures。
2. **Core shadow 验证**：允许 source 在测试中同时生成旧结果和 Core snapshot，但生产数据库只能由旧路径写入；比较结果后再切换。
3. **桌面切换**：启用 prepare/execute 和 Core projection，删除桌面新发送路径的事实写入。
4. **远程切换**：微信、飞书逐入口切换，保留仅展示兼容层，不保留补写兼容层。
5. **旧协议删除**：删除普通独立 stream 入口、renderer facts 和 remote patch service。

兼容层的唯一允许职责是参数转换、旧事件名称转发和 UI 展示；不得创建消息、生成权威 id 或更新 assistant 事实。

## 8. 测试与验收标准

### 8.1 单元与集成测试

- 同步首 delta 不早于 prepare resolve。
- create-user 原子产生恰好两行，reuse-user 恰好一行。
- 重复 prepare/execute/event/finalize 不新增消息。
- content/thinking 多段、多轮工具、确认、progress seq、skill hint 全字段一致。
- source error、zero delta、partial output、cancel、timeout、recovery 均生成同一 assistant id 的终态。
- 迟到 progress/result/terminal 不得覆盖已终态消息。
- SQLite 事务失败时 user/assistant 不得半成功。

### 8.2 跨入口验收

对 desktop-tools、desktop-no-tools、wechat、feishu 参数化验证：

- started/progress/terminal/DB/远程事件中的 id 一致；
- 每 turn user/assistant 数量符合 create/reuse 规则；
- 所有事实字段只由 Core 生成；
- 有无 WebContents、确认、取消、session switch 和恢复结果一致。

### 8.3 静态 owner 门禁

迁移完成前必须审查以下调用点：

- 新 turn 路径不得由 renderer/remote 调用 `appendMessage` 创建 user/assistant；
- 新 turn 路径不得由 renderer/remote 调用 `updateMessageContent` 写事实；
- 新 turn 路径不得生成 assistant/user 权威 id；
- source 不得直接访问 messages 表；
- 保留的 append/patch 必须能说明属于导入、编辑、删除或测试卡片等合法用途。

### 8.4 最终门禁

按仓库约定运行：

```text
npm test
npm run typecheck:shared
npm run typecheck:renderer
npm run i18n:check
npm run build:electron:incremental
npm run build
```

若全量测试受 jsdom/xterm 环境限制，必须单独修复测试环境或提供明确、可重复的白名单验证；不得以少量定向测试替代全量门禁。

## 9. 交付物

- 生产链路重构代码及配套 migration
- reducer/source/coordinator/跨入口 TDD 测试
- owner 调用点审计清单
- 迁移前后协议与兼容层说明
- 全量测试、类型检查、i18n、构建结果
- 与原消息事实 Core 计划的阶段映射和已知风险记录

## 10. 完成定义

只有当所有生产入口共享同一个 Coordinator owner、所有模型路径共享规范化事件协议、renderer/远程不再生成或补写权威消息事实，并且最终门禁全部有明确证据时，才允许继续执行消息事实落库 Core 计划的后续阶段或将本需求标记为完成。
