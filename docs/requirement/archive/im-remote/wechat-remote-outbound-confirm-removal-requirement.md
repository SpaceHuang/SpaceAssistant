# 微信远程出站确认移除需求规格

> 版本：v1.2 (2026-10-12 controlled-reply overlay)
> 创建日期：2026年7月13日  
> 修订日期：2026年7月15日  
> 状态：草案  
> 前置依赖：[wechat-integration-requirement.md](./wechat-integration-requirement.md)、[remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md)  
> 后续衔接：[remote-private-chat-security-optimization-requirement.md](./remote-private-chat-security-optimization-requirement.md)（访问控制替代 `remote_read_only`）  
> 关联实现：`toolChatLoop.toolNeedsConfirmation`、`evaluateRemoteToolBlock`、`WeChatConfirmManager`、`remoteConfirmBridge`、`wechatExecutors`、`wechatPrompts`

---

## 当前外发契约覆盖（2026-10-12）

本节取代 v1.1 中按 `wechat_reply` / `wechat_send` 工具名直接放行的条款；历史实现/评审记述仅说明当时为何移除 Y/N 确认，不能作为当前无限制外发许可。共同 IM 策略与 [IM 安全审核改进需求](./2026-10-11-im-security-review-improvement-requirement.md) 为当前规范。

- `wechat_reply` 只有在主进程将发送绑定到当前活动任务、当前已认证 owner 的原微信单聊、冻结的原入站目的地，且正文分类通过（无凭据、敏感/越权数据、第三方指令或批量本地导出）时，才可走受控普通任务回复例外。
- `wechat_send` 的任意 `userId`、第三方收件人、群聊、转发、系统消息/media、附件、重试，以及工具或模型给出的 recipient 均不因“回复”工具名而豁免；按主动外发策略逐次人工或拒绝。模型不能改变主进程绑定的收件人。
- 任务交付附件仅在用户明确要求且路径、来源、内容、目标和内容版本都通过最终检查时可随受控回复发送。敏感目录、凭据、任意本地文件/批量数据导出及检查后内容变化均不得借 reply 豁免。
- 所有工具出口、系统 reply/progress/error、媒体和 retry 通过相同主进程 outbound 分类与 final check；缓存命中、确定性 allow、Agent approve 或 notification 标记均不能绕过。hard-deny 不可由人工覆盖。
- `remoteConfirmPolicy`、`remoteDenyOutbound` 和渠道配置均不是当前单一生效源；旧值作为固定行为版本的一次性迁移输入。迁移完成后的规则与许可由共同 im policy 决定。

v1.1 中以下条款被本节替代：§1.2 关于出站确认成本的结论仅适用于“原 owner 普通任务回复”；§1.3/G1、§3.1/§3.3/AC1–AC2 的“工具调用即发送”仅适用于上述受控回复路径；§1.3/§3.2 关于旧 `remoteConfirmPolicy` 将普通确认值等价为允许，及 §3.3 将 `remote_read_only` 迁移为独立 `remoteDenyOutbound` 活动字段，改为一次性冻结语义迁移；§5 风险接受条款中“用户事后纠正即可”不适用于第三方、敏感内容或本地数据外流。

## 0. 与后续需求的关系（v1.2）

本需求历史范围仅移除微信出站 Y/N 确认；当前安全例外限于本页“当前外发契约覆盖”定义的受控 owner 任务回复。

关于「远程禁止出站」的**访问控制**：

| 阶段 | 行为 |
|------|------|
| **当前迁移** | 所有旧渠道策略字段仅由固定行为版本迁移器读取；普通外发由共同 IM policy 与统一最终检查裁决 |

因此：v1.0/v1.1 的策略字段迁移路径及 G1–G4、G6–G9 工具名级放行均由本页当前外发契约和共同 IM 安全策略替代。历史“移除 Y/N”只说明旧行为，不授权主动外发。

---

## 1. 概述

### 1.1 背景与问题（v1.1 历史威胁假设；当前收件人授权见顶部覆盖）

现网微信远程会话下，Agent 通过 `wechat_reply` / `wechat_send` 发送出站消息前，需经用户 Y/N 确认（`wechatSendRequiresConfirm` 默认 `true`，`remoteConfirmPolicy` 默认 `always`）。该机制设计初衷是把关出站内容，但经分析其**拦截能力与成本不匹配**：

| 威胁 / 场景 | 确认能否拦截 | 说明 |
|-------------|-------------|------|
| 账号被盗 / 手机被偷 | **否** | 攻击者直接回复 Y 即可通过，确认形同虚设 |
| Agent 出错回复用户自己 | **无意义** | 产品定位为与用户一对一私聊，`wechat_reply` / `wechat_send` 出站均发给用户自己；用户收到自然可见，发新指令纠正即可，前置确认是多余的双重查看 |

### 1.2 决策依据

本产品微信 Bot 运行于**与用户的一对一私聊**（非群聊）：

- **无社交尴尬**：不存在「发错群」——出站目标始终是用户自己。
- **无预览泄露面**：确认提示发给用户自己；唯一泄露途径是用户设备被偷，但被偷时攻击者会回 Y，确认拦不住。
- **真威胁靠设备安全**：账号被盗 / 设备失窃应靠设备锁、登录保护、会话过期解决，不是确认机制的职责。
- **Agent 出错靠事后纠正**：用户收到回复即见内容，发现不对则发新指令纠正——这是一对一对话的自然交互，无需前置确认打断。

**历史结论的当前适用范围**：对发回当前已认证 owner、内容普通且属于当前任务的 `wechat_reply`，重复 Y/N 确认没有必要；这一结论不适用于 `wechat_send` 任意目标、第三方/群聊、敏感正文/附件或批量本地数据。

### 1.3 功能定位

**移除普通任务回复的重复 Y/N 确认**：只有满足当前外发契约的 owner 单聊回复可免逐次确认；工具调用本身不授予发送许可。其他出站按共同策略执行人工待办或禁止。

| 项 | 处置 |
|----|------|
| `wechat_reply` 受控普通回复 | **只在主进程目的地/内容/附件绑定且 final check 通过后免 Y/N** |
| `wechat_send` 任意收件人/主动外发 | 不适用普通回复例外；按共同策略逐次审核或禁止 |
| `wechatSendRequiresConfirm` 配置 | **废弃** |
| `remoteConfirmPolicy` / `remoteWechatConfirm` | 仅为旧行为版本的一次性迁移输入；不能推导新版本“允许外发” |
| `WeChatConfirmManager` 本体 | **保留**——仍服务其他远程工具写操作确认（如 `write_file`） |

### 1.4 目标

| ID | 目标 | 优先级 |
|----|------|--------|
| G1 | 满足受控任务回复契约且 final check 通过时可免 Y/N；其他 `wechat_send`/主动外发不能按工具名自动发送 | P0 |
| G2 | 微信端不再产生 Y/N 确认提示 | P0 |
| G3 | 桌面端不再弹出微信出站确认卡片 | P0 |
| G4 | `wechatSendRequiresConfirm` 废弃，旧配置值不引发异常 | P0 |
| G5 | 旧 `remote_read_only` 仅由版本化迁移器解释；新版本由共同 IM policy 决定主动外发的禁止/人工规则 | P0 |
| G6 | 旧 `always` / `wechat_confirm` / `inherit` 可由冻结迁移器读取，但不得据此允许任意主动外发 | P0 |
| G7 | `WeChatConfirmManager` 服务其他工具确认的能力不受影响 | P0 |
| G8 | 出站 `send` / `reply` 审计事件正常记录 | P0 |
| G9 | 微信远程 system prompt 移除「出站需确认」表述 | P0 |

### 1.5 非目标

| 项 | 说明 |
|----|------|
| 旧字段迁移到共同 IM policy | 归属本项目固定行为版本迁移与统一策略存储任务；不得建立独立 `remoteDenyOutbound` 运行源 |
| 移除 `WeChatConfirmManager` 本体 | 仍服务其他远程工具写确认（`remoteSessionExecutors` 流控） |
| 移除飞书 `run_lark_cli` 写操作确认 | 本需求范围外；飞书写确认默认值变更见安全优化需求 P1 |
| 引入「事后撤回」 | 微信 Bot 消息不可撤回，技术上不可行 |
| 改其他工具确认 | `write_file` / `run_shell` 等本地写确认不变（安全优化需求另案处理） |

---

## 2. 现状分析

### 2.1 确认链路（v1.1 历史现状，非当前目标链路）

```
Agent 调 wechat_reply / wechat_send
  -> toolChatLoop.toolNeedsConfirmation = wechatConfig.wechatSendRequiresConfirm ?? true  // 默认 true
  -> evaluateRemoteToolBlock: policy === 'remote_read_only' ? 拒绝 : 放行进入确认
  -> remoteConfirmBridge 创建 WeChatPendingConfirm { toolInput, ... }
  -> WeChatConfirmManager.requestConfirm()
     -> replyBot.reply(inboundMsg, Y/N 提示)        // 微信端
     -> wc.send('wechat:confirm-request', ...)       // 桌面卡片
  -> 用户 Y/N/确认/取消 或桌面批准 或 5min 超时
  -> resolve('y') -> wechatReplyExecutor / wechatSendExecutor 实际发送
```

### 2.2 待移除环节

| 环节 | 现网 | 目标 |
|------|------|------|
| 工具入口/安全出口 | 历史实现按 `wechatSendRequiresConfirm` 决定是否询问 | 入口不因工具名创建独立确认；必须创建绑定的 outbound intent 并由统一 final check 裁决，未满足受控回复条件则人工/拒绝 |
| `remoteConfirmBridge` 出站路径 | 为 `wechat_reply`/`wechat_send` 创建 pending | 不再创建 |
| `WeChatConfirmManager.requestConfirm` 用于出站 | 发 Y/N + 桌面卡片 | 出站不再调用 |
| `wechatPrompts` 出站说明 | 历史提示未区分普通回复和主动发送 | 明确受控 owner 回复窄例外；任何工具调用都不是自动发送许可 |
| 桌面 `wechat:confirm-request` 事件 | 弹出站卡片 | 出站工具不再触发 |

### 2.3 保留环节（过渡）

| 环节 | 说明 |
|------|------|
| outbound hard-deny | 新行为版本由共同 IM policy 决定；旧 `remote_read_only` / 独立 boolean 只作为迁移夹具，不作运行时读取 |
| `WeChatConfirmManager` 本体 | 其他远程工具写确认仍用 |
| `tryResolveFromInbound` | 随出站确认废弃，Y/N 解析不再因出站触发；若其他工具仍用则保留 |
| `send` / `reply` 审计 | 仍记录出站事件 |

---

## 3. 需求详情

### 3.1 出站确认移除（P0）

受控 `wechat_reply` 满足目的地、正文/附件与最终检查后可发送；其他发送不因工具名放行：

```
Agent 调 wechat_reply / wechat_send
  -> 主进程冻结 deliveryPurpose / owner / originSession / recipient / 内容版本
  -> outbound classifier + 共同 IM policy + final check
  -> 仅受控 owner task reply 可免 Y/N；其他出站走精确待办或 deny
  -> executor 只消费已复检的绑定 intent
  -> 审计记录 send / reply 事件
```

**实现（新契约）**：不得以工具名直接返回 allow。所有工具出口都要检查主进程绑定的目的/来源/内容/附件事实；实现见当前 IM 安全改进计划 §6。

### 3.2 配置废弃与兼容（P0）

| 配置 | 处置 |
|------|------|
| `wechatSendRequiresConfirm` | 废弃。读取时忽略其值（视为 `false`）；旧配置存在不引发异常，可在升级时清理 |
| `remoteConfirmPolicy` | 固定旧行为版本的一次性迁移输入；运行时不得据此放行或拒绝新策略动作 |

**迁移（当前方案）**：存量 `remoteConfirmPolicy` / `remoteWechatConfirm` 只由冻结迁移解析器读取并记录源行为版本；不再运行时读取。旧行为保持与新标准切换必须分开，切换需用户明确选择、revision/epoch 更新和待办授权撤销。

### 3.3 出站硬拒绝：过渡期与移交（P0）

**当前访问控制：** 共同 IM policy 在冻结行为版本下裁决 hard-deny / human-required / auto-eligible；主动外发需按精确目标、正文和附件逐次审核或禁止。旧 `remote_read_only` 与独立 boolean 仅在迁移时解释，不能作为并行运行分支。

### 3.4 `WeChatConfirmManager` 范围（P0）

`WeChatConfirmManager` 本体保留，仅 `wechat_reply` / `wechat_send` 不再调用 `requestConfirm`：

- 其他远程工具（如 `write_file` 在微信远程下）的写确认链路不变（直至安全优化需求移除逐次确认）
- `remoteSessionExecutors.hasPendingForSession` 流控不变
- `tryResolveFromInbound`（Y/N 解析）：若废弃出站确认后无其他调用方，可一并清理；若有其他工具复用则保留

> 实现需核查 `requestConfirm` 的所有调用方，确认移除 `wechat_reply`/`wechat_send` 路径后其他工具确认不受影响。

### 3.5 system prompt 文案（P0）

`wechatPrompts.WECHAT_REMOTE_SKILL_HINT` 应说明仅受控的当前任务 owner 单聊回复可能免 Y/N，所有发送仍须遵守主进程绑定目标和内容检查；模型不得将工具调用理解为自动发送许可。具体文案纳入本项目 7.1 与 i18n 验收。

### 3.6 审计（P0）

| 事件 | 处置 |
|------|------|
| `send` / `reply`（`WeChatAuditEvent`） | 保留安全脱敏事件；关联绑定目的/任务/策略版本及 final-check 结果，不记敏感正文 |
| 审批/待办事件 | 仅主动外发按策略需要时产生，绑定原渠道身份和精确动作 |

### 3.7 飞书侧一致性说明（P0）

本需求移除的是**微信**出站确认。飞书侧需保持逻辑一致，但飞书确认机制与微信不同，处置如下：

| 飞书环节 | 机制 | 处置 |
|----------|------|------|
| Agent 回复用户 | 系统层 `replyFeishuText`（`feishuRemoteAgent` loop 结束直发），**不经过工具确认** | 本就无确认，已与微信去掉后一致 |
| `run_lark_cli` 写操作确认 | `feishuConfirmManager`，受 `larkCliWriteRequiresConfirm` 控制 | **本需求保留**；默认值是否改为 `false` 见安全优化需求 P1 |
| `browser` 危险操作确认 | `feishuConfirmManager` | **本需求保留**；远程作用域见安全优化需求 |

**当前出口原则**：微信工具、飞书系统 reply 与其他 IM 出口都受主进程绑定目的地、内容/附件分类和最终检查约束。只有原 owner 单聊的当前任务普通回复可以进入窄例外；工具名、系统层路径和渠道差异不构成绕过理由。

> 飞书 Bot 当前支持 `p2p` 与 `group`；群聊是否接受入站由安全优化需求改为 p2p only。`run_lark_cli` 的外部副作用说明仍成立。

---

## 4. 交互变化

### 4.1 现网流程

```
用户发指令 -> Agent 组织回复 -> 【等待确认：发 Y/N 提示 + 桌面卡片】-> 用户 Y -> 发送 -> 用户收到
```

### 4.2 目标流程（v1.1 历史示意；当前范围仅受控回复）

```
用户发指令 -> Agent 组织受控 owner 回复 -> 主进程最终检查 -> 发送 -> 用户收到
```

- 对满足 owner、当前任务、目的地、正文/附件约束的普通回复，无「等待确认」中间态、无 Y/N 提示、无桌面确认卡片；主动外发仍依共同策略人工待办或拒绝
- Agent 出错时：用户收到回复后发现不对，发新指令纠正（一对一对话的自然交互）

### 4.3 进度提示

现网确认等待期间会发「【进度】等待确认：wechat_reply」心跳。移除确认后，该心跳不再产生。Agent 执行期其他进度提示（`remoteProgressMode`）不受影响。

---

## 5. 实现要点

| 文件 / 符号 | 改造 |
|-------------|------|
| `electron/toolChatLoop.ts` / outbound dispatch | 删除按工具名直接 false/allow 的出口；所有发送先建绑定 intent 并通过共同策略 final check |
| `electron/toolChatLoop.ts` / outbound dispatch | 移除旧字段行为读取；接入共同 IM policy 的目的、内容分类与最终派发检查 |
| `electron/remote/remoteConfirmBridge.ts` | 出站工具不再经此创建 pending |
| `electron/wechat/weChatConfirmManager.ts` | `requestConfirm` 不再被出站工具调用；本体保留；核查 `tryResolveFromInbound` |
| `electron/wechat/weChatIpc.ts` | 出站相关确认事件评估保留（其他工具可能用） |
| `src/shared/wechatTypes.ts` | 旧字段仅保留迁移读取/类型兼容；迁移完成后删除运行写入与读取 |
| `src/shared/wechatPrompts.ts` | 只描述受控回复条件和共同外发检查；不得暗示任意调用即发送 |
| `src/renderer/` | 微信出站确认卡片相关 UI 评估移除（若仅服务出站确认） |
| 桌面「微信操作记录」/ 设置页 | 确认相关 UI 入口评估清理 |

---

## 6. 验收标准

| ID | 验收项 | 优先级 |
|----|--------|--------|
| AC1 | 受控 owner 任务回复在 final check 通过后免 Y/N；任意目标/内容不能由工具名直接放行 | P0 |
| AC2 | `wechat_send` 任意 userId 仍按主动外发逐次审核或禁止；不得继承 reply 例外 | P0 |
| AC3 | 桌面端不弹出微信出站确认卡片 | P0 |
| AC4 | 旧 `remote_read_only` / `remoteDenyOutbound` 只作迁移输入；迁移后由共同 IM policy 的 hard-deny / human-required 裁决 | P0 |
| AC5 | 旧 `wechatSendRequiresConfirm` 可被兼容读取但不得创建活动策略旁路；行为由共同 IM policy 决定 | P0 |
| AC6 | 旧确认配置仅由冻结迁移器解释；不能等价转换为“允许任意外发” | P0 |
| AC7 | 其他远程工具（如 `write_file`）写确认行为在本需求范围内不变 | P0 |
| AC8 | `send` / `reply` 审计事件正常记录 | P0 |
| AC9 | 微信远程 system prompt 不再含「出站需确认」 | P0 |
| AC10 | 确认等待期「【进度】等待确认」心跳不再产生 | P0 |

---

## 7. 风险与权衡

| 项 | 说明 | 接受 / 缓解 |
|----|------|------------|
| Agent 生成敏感或错误外发 | 由主进程内容/目的地检查拦截；仅受控普通任务回复可窄例外，第三方/敏感/批量数据不得以事后纠正替代审核 |
| 配置废弃兼容 | 旧 `wechatSendRequiresConfirm` / `remoteConfirmPolicy` | 仅迁移器读取并记录行为版本；迁移后运行时不再读取/写入，不能推导活动允许规则 |
| `WeChatConfirmManager` 误删 | 本体服务其他工具 | 仅移除出站路径，本体保留；实现期核查调用方 |
| 与统一策略迁移 | 旧字段分支与新共同 policy 并行生效 | **禁止**：单事务迁移、固定 behaviorVersion 和最终策略门禁后删除旧运行读写 |

---

## 8. 演进方向

| 方向 | 说明 |
|------|------|
| 飞书 `run_lark_cli` 确认 | 默认值与细化见安全优化需求 P1 |
| 事后澄清引导 | Agent 检测用户「发错了」语义时，主动建议发送澄清消息 |
| 出站速率 / 频次限制 | 移除确认后，可补 `remoteRateLimitPerMinute`（安全优化需求定为默认 60） |
| 群聊场景 | 入站群聊由安全优化需求改为拒绝；若未来再入群需单独评估 |
| `wechat_send` userId 防御约束 | 主进程必须忽略模型 recipient 并从已验证上下文冻结目的地；任意 userId/第三方目标不得继承 task-reply 例外 |

---

## 9. 文档沿革

- v1.1（2026-07-15，历史）：曾将 `remote_read_only` 移交 `remoteDenyOutbound`；该活动字段迁移方式已由 2026-10-12 统一 policyBehaviorVersion 迁移覆盖。
- v1.0（2026-07-13）：初版。移除 `wechat_reply`/`wechat_send` 出站确认，保留 `remote_read_only` 访问控制与 `WeChatConfirmManager` 本体。
