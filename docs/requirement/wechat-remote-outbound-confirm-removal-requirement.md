# 微信远程出站确认移除需求规格

> 版本：v1.1  
> 创建日期：2026年7月13日  
> 修订日期：2026年7月15日  
> 状态：草案  
> 前置依赖：[wechat-integration-requirement.md](./wechat-integration-requirement.md)、[remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md)  
> 后续衔接：[remote-private-chat-security-optimization-requirement.md](./remote-private-chat-security-optimization-requirement.md)（访问控制替代 `remote_read_only`）  
> 关联实现：`toolChatLoop.toolNeedsConfirmation`、`evaluateRemoteToolBlock`、`WeChatConfirmManager`、`remoteConfirmBridge`、`wechatExecutors`、`wechatPrompts`

---

## 0. 与后续需求的关系（v1.1）

本需求**仅**移除微信 `wechat_reply` / `wechat_send` 的出站**确认**。

关于「远程禁止出站」的**访问控制**：

| 阶段 | 行为 |
|------|------|
| **本需求落地期（过渡）** | 仍可通过既有 `remoteConfirmPolicy=remote_read_only` 硬拒绝出站（见 §3.3） |
| **安全优化需求落地后** | `remote_read_only` **策略枚举废弃**；同等能力迁移为 `remoteDenyOutbound=true`（并可配合 `remoteAllowLocalWrite=false`）。详见 [remote-private-chat-security-optimization-requirement.md §2.3.2](./remote-private-chat-security-optimization-requirement.md) |

因此：v1.0 中「永久保留 `remote_read_only`」的 G5 / 非目标 **已废止**，改为「过渡期保留策略分支 → 由后续需求迁移」。本需求的 G1–G4、G6–G9（出站确认移除）不变。

---

## 1. 概述

### 1.1 背景与问题

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

**结论**：确认机制既拦不住真正的安全威胁，又在 `wechat_reply` 场景下多余；其流程成本（打断、等待、超时）不抵收益。**移除 `wechat_reply` / `wechat_send` 的出站确认。**

### 1.3 功能定位

**移除微信远程出站消息确认**：Agent 调用 `wechat_reply` / `wechat_send` 即直接发送，不再创建 pending confirm、不再发 Y/N 提示、不再弹桌面确认卡片。

| 项 | 处置 |
|----|------|
| `wechat_reply` / `wechat_send` 确认 | **移除**（调用即发送） |
| `wechatSendRequiresConfirm` 配置 | **废弃** |
| `remoteConfirmPolicy` 的 `always` / `wechat_confirm` / `inherit` | 确认语义**废弃**，等价「允许出站、不确认」 |
| `remoteConfirmPolicy` 的 `remote_read_only` | **过渡期保留**访问控制语义；长期由 `remoteDenyOutbound` 替代（见 §0） |
| `WeChatConfirmManager` 本体 | **保留**——仍服务其他远程工具写操作确认（如 `write_file`） |

### 1.4 目标

| ID | 目标 | 优先级 |
|----|------|--------|
| G1 | `wechat_reply` / `wechat_send` 调用即发送，无确认中间态 | P0 |
| G2 | 微信端不再产生 Y/N 确认提示 | P0 |
| G3 | 桌面端不再弹出微信出站确认卡片 | P0 |
| G4 | `wechatSendRequiresConfirm` 废弃，旧配置值不引发异常 | P0 |
| G5 | ~~`remote_read_only` 仍禁止出站（永久）~~ → **过渡期**仍禁止出站；长期能力移交安全优化需求的 `remoteDenyOutbound` | P0（过渡） |
| G6 | `always` / `wechat_confirm` / `inherit` 旧配置平滑兼容（不触发确认） | P0 |
| G7 | `WeChatConfirmManager` 服务其他工具确认的能力不受影响 | P0 |
| G8 | 出站 `send` / `reply` 审计事件正常记录 | P0 |
| G9 | 微信远程 system prompt 移除「出站需确认」表述 | P0 |

### 1.5 非目标

| 项 | 说明 |
|----|------|
| 在本需求内完成 `remote_read_only` → `remoteDenyOutbound` 迁移 | 归属 [remote-private-chat-security-optimization-requirement.md](./remote-private-chat-security-optimization-requirement.md) |
| 移除 `WeChatConfirmManager` 本体 | 仍服务其他远程工具写确认（`remoteSessionExecutors` 流控） |
| 移除飞书 `run_lark_cli` 写操作确认 | 本需求范围外；飞书写确认默认值变更见安全优化需求 P1 |
| 引入「事后撤回」 | 微信 Bot 消息不可撤回，技术上不可行 |
| 改其他工具确认 | `write_file` / `run_shell` 等本地写确认不变（安全优化需求另案处理） |

---

## 2. 现状分析

### 2.1 确认链路（现网）

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
| `toolNeedsConfirmation`（`toolChatLoop.ts:1661`） | `wechat_reply`/`wechat_send` -> `wechatSendRequiresConfirm ?? true` | 返回 `false` |
| `remoteConfirmBridge` 出站路径 | 为 `wechat_reply`/`wechat_send` 创建 pending | 不再创建 |
| `WeChatConfirmManager.requestConfirm` 用于出站 | 发 Y/N + 桌面卡片 | 出站不再调用 |
| `wechatPrompts` 出站确认表述 | "出站消息使用 wechat_reply / wechat_send 工具（需用户确认）" | 移除"需用户确认" |
| 桌面 `wechat:confirm-request` 事件 | 弹出站卡片 | 出站工具不再触发 |

### 2.3 保留环节（过渡）

| 环节 | 说明 |
|------|------|
| `evaluateRemoteToolBlock` 出站硬拒绝 | 过渡期：`remote_read_only` 仍拒绝 `wechat_reply`/`wechat_send`；迁移后改为读 `remoteDenyOutbound` |
| `WeChatConfirmManager` 本体 | 其他远程工具写确认仍用 |
| `tryResolveFromInbound` | 随出站确认废弃，Y/N 解析不再因出站触发；若其他工具仍用则保留 |
| `send` / `reply` 审计 | 仍记录出站事件 |

---

## 3. 需求详情

### 3.1 出站确认移除（P0）

`wechat_reply` / `wechat_send` 调用即发送，无确认中间态：

```
Agent 调 wechat_reply / wechat_send
  -> toolNeedsConfirmation = false（不再确认）
  -> evaluateRemoteToolBlock: 出站硬拒绝？（过渡：remote_read_only；其后：remoteDenyOutbound）
  -> 放行则直接 wechatReplyExecutor / wechatSendExecutor 发送
  -> 审计记录 send / reply 事件
```

**实现**：`toolChatLoop.ts:1661` 的 `wechat_reply` / `wechat_send` 分支返回 `false`（或直接移除该分支，落到 `builtinToolNeedsConfirmation` 默认 `false`）。

### 3.2 配置废弃与兼容（P0）

| 配置 | 处置 |
|------|------|
| `wechatSendRequiresConfirm` | 废弃。读取时忽略其值（视为 `false`）；旧配置存在不引发异常，可在升级时清理 |
| `remoteConfirmPolicy` | 过渡期：枚举保留；`always` / `wechat_confirm` / `inherit` 不再触发确认；`remote_read_only` 仍禁止出站。安全优化需求落地后停止消费该枚举，按迁移矩阵写入 `remoteDenyOutbound` 等 |

**迁移（本需求范围）**：`mergeWeChatConfig` 仍接受旧 `remoteConfirmPolicy` 值，但**确认**逻辑不再消费它（过渡期仅 `remote_read_only` 仍影响**拒绝**）。`remoteWechatConfirm` 废弃标志位维持现状。

### 3.3 出站硬拒绝：过渡期与移交（P0）

**过渡期（本需求）：**  
`evaluateRemoteToolBlock` 对 `source === 'wechat'` + `policy === 'remote_read_only'` + `wechat_reply`/`wechat_send` 仍返回拒绝。这是访问控制，与确认无关。

**移交（安全优化需求）：**

| 旧 | 新 |
|----|-----|
| `remoteConfirmPolicy=remote_read_only` | `remoteDenyOutbound=true`（+ 若需禁本地文件写则 `remoteAllowLocalWrite=false`） |
| 运行时 `policy === 'remote_read_only'` 分支 | 改为读 `remoteDenyOutbound`；旧枚举值平滑迁移后忽略 |

本需求实现时**不要删除** `remote_read_only` 拒绝分支，除非与安全优化需求同版本合并且迁移测试已通过。

### 3.4 `WeChatConfirmManager` 范围（P0）

`WeChatConfirmManager` 本体保留，仅 `wechat_reply` / `wechat_send` 不再调用 `requestConfirm`：

- 其他远程工具（如 `write_file` 在微信远程下）的写确认链路不变（直至安全优化需求移除逐次确认）
- `remoteSessionExecutors.hasPendingForSession` 流控不变
- `tryResolveFromInbound`（Y/N 解析）：若废弃出站确认后无其他调用方，可一并清理；若有其他工具复用则保留

> 实现需核查 `requestConfirm` 的所有调用方，确认移除 `wechat_reply`/`wechat_send` 路径后其他工具确认不受影响。

### 3.5 system prompt 文案（P0）

`wechatPrompts.WECHAT_REMOTE_SKILL_HINT` 中「出站消息使用 wechat_reply / wechat_send 工具（需用户确认）」改为：

> 出站消息使用 wechat_reply / wechat_send 工具，调用即发送。

避免 LLM 误以为需等待确认而停滞。

### 3.6 审计（P0）

| 事件 | 处置 |
|------|------|
| `send` / `reply`（`WeChatAuditEvent`） | 保留，记录出站目标、长度、成功与否 |
| `confirm_request` | 出站工具不再产生；若其他工具仍确认则保留事件 |

### 3.7 飞书侧一致性说明（P0）

本需求移除的是**微信**出站确认。飞书侧需保持逻辑一致，但飞书确认机制与微信不同，处置如下：

| 飞书环节 | 机制 | 处置 |
|----------|------|------|
| Agent 回复用户 | 系统层 `replyFeishuText`（`feishuRemoteAgent` loop 结束直发），**不经过工具确认** | 本就无确认，已与微信去掉后一致 |
| `run_lark_cli` 写操作确认 | `feishuConfirmManager`，受 `larkCliWriteRequiresConfirm` 控制 | **本需求保留**；默认值是否改为 `false` 见安全优化需求 P1 |
| `browser` 危险操作确认 | `feishuConfirmManager` | **本需求保留**；远程作用域见安全优化需求 |

**差异根因**：微信 `wechat_reply` / `wechat_send` 是工具、且出站仅发给用户自己，确认无意义；飞书回复用户走系统层本就无确认，而飞书 `run_lark_cli` 是可操作第三方资源的工具，确认有把关价值。两者「一致」体现在**回复用户侧均无确认**，而非全部确认移除。

> 飞书 Bot 当前支持 `p2p` 与 `group`；群聊是否接受入站由安全优化需求改为 p2p only。`run_lark_cli` 的外部副作用说明仍成立。

---

## 4. 交互变化

### 4.1 现网流程

```
用户发指令 -> Agent 组织回复 -> 【等待确认：发 Y/N 提示 + 桌面卡片】-> 用户 Y -> 发送 -> 用户收到
```

### 4.2 目标流程

```
用户发指令 -> Agent 组织回复 -> 直接发送 -> 用户收到
```

- 无「等待确认」中间态、无 Y/N 提示、无桌面确认卡片
- Agent 出错时：用户收到回复后发现不对，发新指令纠正（一对一对话的自然交互）

### 4.3 进度提示

现网确认等待期间会发「【进度】等待确认：wechat_reply」心跳。移除确认后，该心跳不再产生。Agent 执行期其他进度提示（`remoteProgressMode`）不受影响。

---

## 5. 实现要点

| 文件 / 符号 | 改造 |
|-------------|------|
| `electron/toolChatLoop.ts:1661` | `wechat_reply` / `wechat_send` 不再返回 `wechatSendRequiresConfirm`，确认改为 `false` |
| `electron/toolChatLoop.ts:1701` | **过渡期**保留 `remote_read_only` 拒绝；与安全优化需求合并时改为 `remoteDenyOutbound` |
| `electron/remote/remoteConfirmBridge.ts` | 出站工具不再经此创建 pending |
| `electron/wechat/weChatConfirmManager.ts` | `requestConfirm` 不再被出站工具调用；本体保留；核查 `tryResolveFromInbound` |
| `electron/wechat/weChatIpc.ts` | 出站相关确认事件评估保留（其他工具可能用） |
| `src/shared/wechatTypes.ts` | `wechatSendRequiresConfirm` 标记 `@deprecated`；`remoteConfirmPolicy` 注释标注过渡期语义 |
| `src/shared/wechatPrompts.ts` | 移除「需用户确认」表述 |
| `src/renderer/` | 微信出站确认卡片相关 UI 评估移除（若仅服务出站确认） |
| 桌面「微信操作记录」/ 设置页 | 确认相关 UI 入口评估清理 |

---

## 6. 验收标准

| ID | 验收项 | 优先级 |
|----|--------|--------|
| AC1 | `wechat_reply` 调用即发送，无 Y/N 提示、无确认中间态 | P0 |
| AC2 | `wechat_send` 调用即发送，无 Y/N 提示、无确认中间态 | P0 |
| AC3 | 桌面端不弹出微信出站确认卡片 | P0 |
| AC4 | **过渡期**：`remote_read_only` 下出站仍被拒绝；**迁移后**：改为验收 `remoteDenyOutbound=true`（见安全优化需求 AC-Outbound-Deny） | P0 |
| AC5 | 旧配置 `wechatSendRequiresConfirm=true` 不触发确认、不报错 | P0 |
| AC6 | 旧配置 `remoteConfirmPolicy=always/wechat_confirm/inherit` 不触发确认 | P0 |
| AC7 | 其他远程工具（如 `write_file`）写确认行为在本需求范围内不变 | P0 |
| AC8 | `send` / `reply` 审计事件正常记录 | P0 |
| AC9 | 微信远程 system prompt 不再含「出站需确认」 | P0 |
| AC10 | 确认等待期「【进度】等待确认」心跳不再产生 | P0 |

---

## 7. 风险与权衡

| 项 | 说明 | 接受 / 缓解 |
|----|------|------------|
| Agent 出错回复用户自己 | `wechat_reply` / `wechat_send` 出站内容有误 | **接受**：出站仅发给用户自己，用户收到即见，发新指令纠正 |
| 配置废弃兼容 | 旧 `wechatSendRequiresConfirm` / `remoteConfirmPolicy` | `mergeWeChatConfig` 容忍旧值，不报错；升级可清理 |
| `WeChatConfirmManager` 误删 | 本体服务其他工具 | 仅移除出站路径，本体保留；实现期核查调用方 |
| 与安全优化需求时序 | 若先删 `remote_read_only` 分支而未上 `remoteDenyOutbound` | **禁止**：须按 §0 / §3.3 过渡，或同版本合并并跑迁移 AC |

---

## 8. 演进方向

| 方向 | 说明 |
|------|------|
| 飞书 `run_lark_cli` 确认 | 默认值与细化见安全优化需求 P1 |
| 事后澄清引导 | Agent 检测用户「发错了」语义时，主动建议发送澄清消息 |
| 出站速率 / 频次限制 | 移除确认后，可补 `remoteRateLimitPerMinute`（安全优化需求定为默认 60） |
| 群聊场景 | 入站群聊由安全优化需求改为拒绝；若未来再入群需单独评估 |
| `wechat_send` userId 防御约束 | 产品上出站仅发给用户自己，但 `executeWeChatSend` 代码层仍接受任意 `userId`；可在代码层约束其 `userId` 仅限当前会话用户 |

---

## 9. 文档沿革

- v1.1（2026-07-15）：废止「永久保留 `remote_read_only`」表述；明确出站硬拒绝过渡期语义，长期移交 `remoteDenyOutbound`（对接远程私聊安全优化需求）。出站确认移除目标不变。
- v1.0（2026-07-13）：初版。移除 `wechat_reply`/`wechat_send` 出站确认，保留 `remote_read_only` 访问控制与 `WeChatConfirmManager` 本体。
