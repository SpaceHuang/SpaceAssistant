# 产物决策远程 IM 入站接线 — 产品需求

> 版本：v1.2  
> 创建日期：2026-07-18  
> 状态：草案（已吸收首轮评审与 `docs/review/artifact-decision-remote-im-requirement-second-review.md`）  
> 前置依赖：  
> - [explicit-output-directory-candidate-requirement.md](./explicit-output-directory-candidate-requirement.md)（产物归属 / 输出位置 / 覆盖等决策语义）  
> - [feishu-integration-requirement.md](./feishu-integration-requirement.md)  
> - [wechat-integration-requirement.md](./wechat-integration-requirement.md)  
> - [remote-private-chat-security-optimization-requirement.md](./remote-private-chat-security-optimization-requirement.md)（私聊、绑定、入站守卫）  
> 关联实现（现状）：`artifactDecisionRemote.ts`（编解码已有）、`artifactDecisionBridge.ts`（桌面等待/提交）、`toolChatLoop.ts`（仅推桌面 IPC）、`FeishuConfirmManager` / `WeChatConfirmManager`（工具 Y/N 确认，**不含**产物决策）、`RemoteContext`（尚无统一决策出站能力）

---

## 1. 概述

### 1.1 背景与问题

工作产物管理会在写入前要求用户做 **产物决策**（输出位置、归属、覆盖、资料保留、草稿区 Git 策略等）。桌面端已通过：

1. 主进程 `artifact:decision-request` 推送决策卡；
2. 渲染进程 `ArtifactDecisionCard` 点选；
3. `artifact:decision-response` → `submitArtifactDecisionResponse` 唤醒 tool loop。

飞书 / 微信远程会话走同一 tool loop，但当前：

| 环节 | 现状 |
|------|------|
| 决策编解码库 | **已有**：`serializeArtifactDecisionForRemote` / `parseArtifactDecisionRemoteReply` / `resolveRemoteArtifactDecisionChoice` |
| 远程出站提示 | **未接**：决策出现时不向 IM 发编号选项文本；`RemoteContext` 无统一「向本次私聊发文本」能力 |
| 远程入站回复 | **未接**：用户回 `1` / `1 reports/final` 不会提交到 decision bridge，而被当成新指令 |
| pending 归属 | **不足**：bridge 仅有 `decisionId/requestId/sessionId/toolUseId/attempt`，无渠道 / 绑定用户 / 私聊目标 / origin 索引 |
| 提交结果 | **不足**：`submitArtifactDecisionResponse` 返回 `void`，无法区分成功 / 失效 / 绑定不匹配 |
| 工具写入 Y/N 确认 | **已有**：与产物决策是不同协议，不可互相替代 |

结果：远程用户无法在手机端完成产物决策，tool loop 只能等桌面卡片或超时失败；产物管理 AC 中「可完成选择」在远程场景不成立。并发远程会话（`maxParallelChatSessions`）下亦无安全匹配依据。

### 1.2 功能定位

把已有的产物决策 **文本编解码**，接到飞书 / 微信「用户回消息」真实链路：

```text
远程 tool loop 需要产物决策
  → 注册 RemoteArtifactDecisionOwner + pending（原子）
  → 建立 waiter → 序列化编号选项 → 经统一出站能力发到当前 IM 私聊
  → 用户回复「编号」/「编号 值」，或并发时「decisionId 编号」/「decisionId 编号 值」
  → 入站：私聊 + owner guard → 编解码抽取 decisionId → 按 owner 匹配 → 解析编号与输入
  → 原子提交（结果协议）→ resume 继续写入（可多轮决策）
```

桌面卡片路径保持不变；两端均可作答，**先到先得**（共用同一原子提交入口）。

### 1.3 目标

| ID | 目标 | 优先级 |
|----|------|--------|
| G1 | 远程会话出现产物决策时，向对应飞书/微信私聊发送可读的编号选项文本（含 decisionId） | P0 |
| G2 | 合法绑定用户对该决策的编号回复能解析并提交，tool loop 可推进到 ready / 下一决策 / 取消 | P0 |
| G3 | 带 `requiresInput` 的选项（改名、改目录）支持「编号 + 值」；`output-location` 的 `1 reports/final`（及并发前缀形）必须编码为 `change-directory:…` | P0 |
| G4 | 非法编号 / 缺值回复不消费决策，回用法提示，决策保持等待 | P0 |
| G5 | 与既有工具 Y/N 确认共存：协议互不抢答；入站优先序明确 | P0 |
| G6 | 桌面卡片与 IM 回复均可关闭同一 waiter；一方成功后另一方提交得 `stale`，不得二次消费 | P0 |
| G7 | 超时、用户取消会话、紧急停止时，IM 侧有可理解收尾（迟到回复得 `stale`） | P0 |
| G8 | 仅在会话已启用工作产物管理时走本链路；legacy 写目录确认不受影响 | P0 |
| G9 | 飞书与微信行为对齐（同一编解码、同一出站契约、同一优先级与安全边界） | P0 |
| G10 | 并发远程请求按 owner 隔离匹配；禁止跨会话 / 跨渠道误答 | P0 |
| G11 | 提交入口为原子、非抛出结果协议；IM 回执与桌面 IPC 均据此分支 | P0 |
| G12 | 并发歧义回复使用定稿的 `decisionId` 前缀协议；飞书/微信共用同一编解码扩展，禁止渠道私有方言 | P0 |

### 1.4 非目标

| 项 | 说明 |
|----|------|
| NG1 | 不在本期做 IM 富文本卡片 / 按钮组件；仅文本编号协议 |
| NG2 | 不改造工具写入 Y/N 确认协议（仍为 `Y`/`N` + confirmId） |
| NG3 | 不新增跨会话、跨渠道代答；决策只接受「该决策的 RemoteArtifactDecisionOwner」 |
| NG4 | 不把产物决策并入 `FeishuConfirmManager` / `WeChatConfirmManager` 的 Y/N 状态机（可共享入站钩子位置，但语义独立） |
| NG5 | 不在本期做「决策历史列表 UI」或设置页管理待决产物决策 |
| NG6 | 不改变产物决策 **种类语义**（归属/位置/覆盖等仍以产物需求与现有 resolver 为准） |
| NG7 | 不在本期做群聊产物决策 |
| NG8 | 不在本期持久化重启后的 IM 决策队列 |

---

## 2. 术语

| 术语 | 含义 |
|------|------|
| 产物决策 | `ArtifactDecisionKind`：`output-location` / `path-type` / `ownership` / `overwrite` / `reference-retention` / `git-ignore` |
| 决策编解码 | `electron/remote/artifactDecisionRemote.ts`：序列化、编号解析，及 §6.6 decisionId 前缀消歧 |
| 决策 bridge | `artifactDecisionBridge`：注册 pending、等待、原子提交 |
| 工具确认 | 远程对 `write_file` 等的 Y/N 确认（ConfirmManager） |
| 远程会话请求 | 由飞书/微信入站触发、带 `remoteContext` 的一次 chat/tool loop；lease 按 `(originSessionId, requestId)` 持有 |
| RemoteArtifactDecisionOwner | 远程产物决策的归属与匹配主键（见 §5.3.1） |
| 入站接线 | 出站发决策文本 + 入站按 owner 解析回复并原子提交，打通等待环 |
| 提交结果 | bridge 消费入口的原子枚举：`resolved` / `stale` / `binding_mismatch` / `invalid` |

---

## 3. 现状与缺口

```text
今日（桌面）:
  decision_required → IPC → UI 卡 → IPC response → bridge → resume  ✓

今日（远程）:
  decision_required → 仅 IPC（手机看不到）→ 用户 IM 回复当新指令  ✗
  编解码单测 / 库 API                                     ✓（未接线）
  pending 无渠道/绑定/origin 索引                         ✗
  submit 无成功/失效结果                                  ✗
  RemoteContext 无统一决策出站                            ✗

目标（远程）:
  decision_required → Owner 注册 + waiter → IM 文本 +（可选）桌面卡
  IM 编号回复 / 桌面点选 → 原子提交 → resume               ✓
  并发请求按 owner 隔离；歧义用 `<decisionId> 编号 [值]` 前缀  ✓
```

---

## 4. 用户故事

### US-01：远程指定输出目录

**作为** 飞书/微信远程用户，**当** Agent 首次创建工作包主成果但未指定目录时，**我希望** 在私聊收到编号选项，并回复 `1 reports/final`，**以便** 文件写入该目录而无需打开电脑。

### US-02：远程归属选择

**作为** 远程用户，**当** 出现归属决策（项目 / 工作包 / 草稿）时，**我希望** 回复 `1`/`2`/`3` 完成选择，**以便** 流程进入下一决策或直接写入。

### US-03：远程覆盖决策

**作为** 远程用户，**当** 目标路径已占用时，**我希望** 能覆盖、改名、改目录或取消，**以便** 与桌面卡片能力对等。

### US-04：误回复可恢复

**作为** 远程用户，**当** 我回了非法编号或改名选项却没带文件名时，**我希望** 收到简短用法提示且决策仍有效，**以便** 再次正确回复。

### US-05：电脑与手机任一端可答

**作为** 同时开着桌面端的用户，**当** 远程触发产物决策时，**我希望** 在手机或电脑任一侧完成选择即可继续，**以便** 不被双端卡住。

### US-06：并发远程会话互不串答

**作为** 同一渠道下同时跑多个远程请求的用户，**当** 多个会话都在等产物决策时，**我希望** 按出站示例回复 `<decisionId> 1` 或 `<decisionId> 1 reports/final`，**以便** 只推进正确的那次请求、且改目录/改名输入不被 decisionId 污染。

---

## 5. 行为需求

### 5.1 触发条件（出站）

同时满足时必须向 IM 发送产物决策文本：

1. 当前 tool loop 带有 `remoteContext`（`source` 为 `feishu` 或 `wechat`）；
2. 会话已启用工作产物管理（`metadata.artifactManagementEnabled === true`）；
3. `prepare` / `resume` 返回 `decision_required`，且已在 bridge 注册 pending，并已原子写入对应 `RemoteArtifactDecisionOwner`。

不满足 1 或 2 时：行为与现网一致（仅桌面 IPC，或不走产物决策）。

### 5.2 出站文案与统一 adapter

1. 文案至少包含：`decisionId`、决策标题/类型、编号选项列表、带输入项的提示，以及 **可照抄的回复示例**（见 §6.6）：
   - 单决策（兼容）：`1` / `1 reports/final`；
   - 并发消歧（定稿前缀）：`<本条 decisionId> 1` / `<本条 decisionId> 1 reports/final`（须代入真实 UUID，禁止占位符让用户猜）；
   - 并注明：同一私聊若同时有多条待决决策，必须使用带 decisionId 前缀的形式。
2. **唯一编解码入口**：出站必须使用 `serializeArtifactDecisionForRemote`（或与其输出契约一致的包装）生成上述文案；飞书/微信不得各写一套示例或前缀方言。
3. **统一出站能力**（需求级契约，实现名可微调）：
   - 在构建 `remoteContext` 时注入可 await 的 `sendDecisionText(text: string): Promise<void>`（或等价 `replyText`），授权目标 **固定为本次已守卫的私聊**（飞书 `chatId` / 微信对应用户），禁止实现侧再解析「发给谁」。
   - 飞书 / 微信各自在 adapter 内调用既有私聊文本出站能力；**不**经 `lark_*` / `wechat_reply` Agent 工具路径（避免嵌套确认）。
   - `toolChatLoop` / 决策桥 **只**依赖该统一能力，不得在 loop 内按 `source` 分支直连平台 SDK。
4. **`onDecisionRequired` 异步时序**（定稿）：
   1. 注册 pending + 写入 Owner + 建立 waiter；
   2. 若桌面窗口存在，仍可同步发 `artifact:decision-request`（与今日一致）；
   3. `await sendDecisionText(...)`；
   4. 发送成功后开始等待用户回复（waiter 已在步骤 1 建立，此处进入阻塞等待）。
5. **出站失败语义**（定稿）：
   - 记录审计 / CLI 日志（含 decisionId、channel、失败原因摘要，脱敏）；
   - **取消该 waiter**（registry / request / Owner 一并移除）；
   - 向 tool loop 返回可理解错误（远程用户可见的失败文案，非静默挂起）；
   - **桌面不再保留该次决策的等待**：若已推送桌面卡，后续桌面提交须得 `stale`；不采用「IM 失败但桌面继续等五分钟」的兜底（避免 G1 不可验收与幽灵 waiter）。
6. 同一 `decisionId` 在等待期间 **默认只发一次** 完整选项；用法提示可追加短消息，不重新注册决策。用法提示在候选 ≥2 时应再次给出带真实 decisionId 的可复制前缀示例。

### 5.3 入站解析与提交

#### 5.3.1 RemoteArtifactDecisionOwner 契约（定稿）

远程启动产物决策等待时必须创建并原子写入 Owner；决策结束 / 超时 / 取消 / 出站失败时原子移除。字段至少包含：

| 字段 | 含义 |
|------|------|
| `source` | `feishu` \| `wechat` |
| `authOwner` | 入站守卫认定的绑定主体（飞书 OpenId / 微信 userId 等） |
| `privateChatTarget` | 私聊目标（飞书 `chatId`；微信对应用户私聊标识） |
| `originSessionId` | 持有 lease 与助手消息的 origin 会话 |
| `requestId` | 本次远程请求 id（与 lease 一致） |
| `decisionId` | bridge 分配的决策 id |

索引与查询约定：

- 入站 **先** 完成私聊与绑定用户 guard，再以 `(source, authOwner, privateChatTarget)` 查询候选 Owner；
- 不得按「全渠道任意 pending」或「仅 decisionId 全局扫描」提交；
- Owner 与 bridge pending / waiter 生命周期一致：注册同事务（或等价原子步骤），移除同事务。

#### 5.3.2 并发与歧义策略（定稿）

远程请求按 `(originSessionId, requestId)` 持有 lease，配置允许 `maxParallelChatSessions > 1`，因此 **同一渠道、同一绑定用户** 上可同时存在多个 Owner。

用户回复字面格式见 **§6.6**（定稿）。匹配行为：

| 候选数 | 用户回复 | 行为 |
|--------|----------|------|
| 0 | 任意编号 / 前缀形态 | 不视为产物决策回复（`not_decision`），落入后续入站逻辑 |
| 1 | `编号` / `编号 值`（无前缀） | 匹配该唯一 pending；编解码解析 body |
| 1 | `<decisionId> 编号` / `<decisionId> 编号 值` 且 id 等于该候选 | 同上 |
| 1 | 前缀 id **不等于** 该候选 | `unknown_decision_id`：提示失效/不匹配，**不**消费，**不**落入新指令 |
| ≥2 | 无 decisionId 前缀（纯 `1` / `1 reports/final` 等） | **拒绝猜测**（`ambiguous`）：提示按出站示例使用 `<decisionId> …`，不消费任一决策 |
| ≥2 | 前缀 id 属于候选集合 | 仅匹配该 decisionId；再解析编号与剩余输入 |
| ≥2 | 前缀 id 合法 UUID 形态但不属于候选 | `unknown_decision_id`：提示失效，不消费，不落入新指令 |
| 任意 | 有 UUID 前缀但缺编号（如仅一个 UUID token） | `usage_hint`：提示补全编号；不消费 |

**禁止**：因「同渠道多个 pending」而拒绝 **全部** 合法并发请求的 IM 完成路径（旧草案 MVP「同渠道最多一个」作废）。

**禁止** 使用会污染自由输入的格式（如 `1 <decisionId> path`、`1 path #<decisionId>`）：此类不得作为本需求协议，编解码亦不得将其解析为合法 choice。

单次 tool loop 请求内决策仍串行（一轮一个 `decisionId`）；并发隔离的是 **不同** `(originSessionId, requestId)`。

#### 5.3.3 挂点与优先序

1. **挂点**：飞书 `remoteCommandRouter.handleInbound`、微信 `weChatCommandRouter` 入站处理中，在「已接受为绑定用户私聊文本」之后、**当作新 Agent 指令之前**。
2. **优先序**（自上而下，命中即 return，不进入新任务）：

   | 顺序 | 处理 |
   |------|------|
   | 1 | 既有工具 Y/N 确认（`confirmManager.tryResolveFromInbound`） |
   | 2 | **产物决策编号回复**（本需求新增；含 Owner 匹配与歧义处理） |
   | 3 | 工作区消歧、配对等既有特殊状态 |
   | 4 | 普通远程指令 → Agent |

3. **解析流水线**（必须走唯一编解码入口 `artifactDecisionRemote`，顺序定稿）：
   1. 对 raw 做 §6.6 规定的前缀抽取：得到 `replyDecisionId?` + `body`；
   2. 按 §5.3.2 用候选 Owner 集合消歧，得到目标 `decisionId`（或 ambiguous / unknown_decision_id 早退）；
   3. 将 `body` 与目标 pending 的 `options` 交给编号/输入解析（既有 `1` / `1 值` 规则）；
   4. 若为 `choice`：再 `resolveRemoteArtifactDecisionChoice` → 原子提交（§5.3.4）；
   5. 若为 `usage_hint`：回复用法提示（候选 ≥2 时附带真实 decisionId 前缀示例），**不** submit；
   6. 若为 `not_decision`：不视为产物决策回复，落入后续入站逻辑；
   7. 若为 `unknown_decision_id` / `ambiguous`：发对应提示，**不** submit，**不**落入新指令。

4. 提交字段必须与桌面 IPC 对齐：`decisionId` / `requestId` / `sessionId` / `toolUseId` / `attempt` / `choice`；`sessionId` 取 Owner 的 `originSessionId`（与桌面 pending 一致）。

#### 5.3.4 原子提交结果协议（定稿）

将 bridge 消费入口定义为 **原子、非抛出** 的结果协议（桌面 IPC 与 IM 入站共用同一入口；名称可实现微调）：

```text
submitArtifactDecisionResponse(payload) →
  'resolved' | 'stale' | 'binding_mismatch' | 'invalid'
```

| 结果 | 含义 | 副作用 |
|------|------|--------|
| `resolved` | 成功消费：waiter 存在且 binding 字段匹配 | **仅此结果**删除 registry/request/Owner、关闭 waiter、异步 resolve tool loop |
| `stale` | 无活跃 waiter，或决策已超时 / 已取消 / 已被另一端消费 / 进程重启后内存丢失 | 不二次消费；不抛错 |
| `binding_mismatch` | decisionId 存在或可查，但 `requestId`/`sessionId`/`toolUseId`/`attempt` 等与 pending 不一致 | 不消费 |
| `invalid` | payload 字段非法（缺字段、choice 空等） | 不消费 |

补充约定：

1. **禁止**依赖「先 `getArtifactDecisionRequest` 再 submit」做正确性判断：预检与 consume 之间存在竞态；超时后 request 亦可能短暂残留。正确性以单次原子提交结果为准。
2. cancel、timeout、出站失败取消、进程重启后的迟到提交，对调用方均表现为 `stale`（或重启后等价无 waiter → `stale`）。
3. IM bridge：仅 `resolved` 发成功回执；`stale` / `binding_mismatch` / `invalid` 发对应失效或错误提示，**不得**静默当成功。
4. 桌面 IPC：复用同一结果；UI 可对非 `resolved` 提示「已处理或已失效」。
5. 实现应避免把 binding 校验失败以未捕获异常冒泡成 router 崩溃；结果枚举即控制流。

### 5.4 多轮决策

ownership → output-location →（可能）overwrite 等链式决策：

1. 每一轮 `decision_required` 都重新出站完整选项（新 `decisionId` / 新 attempt / 新 Owner 记录）；
2. 上一轮 IM 回复不得被下一轮误用；
3. resume 必须携带更新后的 intent（与评审 v2 已修的桌面多轮语义一致）。

### 5.5 与工具确认的关系

| | 工具确认 | 产物决策 |
|--|----------|----------|
| 协议 | `Y`/`N` [confirmId] [TRUST] | `编号` / `编号 值`；并发时 `<decisionId> 编号` / `<decisionId> 编号 值`（§6.6） |
| 时机 | 路径已解析、即将执行写/高风险工具 | 路径归属/位置尚未 ready |
| 管理器 | ConfirmManager | Decision bridge + Owner 索引 + 本需求入站钩子 |

二者可在同一远程请求生命周期内先后出现（先产物决策，后写入确认），但 **同一条用户消息只应命中其中一种**。编号协议与 Y/N 协议字面冲突面小；若未来扩展导致歧义，以优先序表为准，并在实现中加回归测。

### 5.6 超时、取消与停止

| 事件 | 行为 |
|------|------|
| bridge 等待超时（现网约 5 分钟） | tool loop 按现网超时失败；移除 Owner；迟到 IM/桌面提交 → `stale`，IM 提示已失效 |
| 用户桌面取消决策 / 选 cancel | 与现网一致；移除 Owner；迟到提交 → `stale` |
| `chatCancel` / 紧急停止远程任务 | 取消 waiter 与 Owner；可选向 IM 发「已取消」；迟到提交 → `stale` |
| IM 出站失败 | 见 §5.2.5；提交侧后续均为 `stale` |
| 进程重启 | 内存 waiter / Owner 丢失；未完成决策视为失败；迟到提交 → `stale`；需用户重新发指令（MVP 不持久化） |

### 5.7 安全边界

1. **仅私聊**：群聊不得出站产物决策，也不得入站解析（与飞书/微信远程基线一致）。
2. **仅绑定/白名单发送者**：与 `evaluateImInboundGuard` / owner allowlist 一致；非授权用户消息不得 submit。
3. **Owner 隔离**：跨 `authOwner`、跨 `source`、跨非候选 `decisionId` 的回复不得消费；记审计。
4. **路径值校验不变**：`change-directory:` / `rename:` 解析后的路径仍走既有 workspace / safeTarget / 字面路径规则；IM 不额外放宽越界。
5. **不信任自由文本当路径**：仅当选项 `requiresInput` 且用户按「编号 值」或「decisionId 编号 值」格式提供时才编码；纯散文路径不走本协议。decisionId 不得出现在编号之后的值区域（§6.6 非法形式）。
6. **审计**：出站 / 出站失败 / 入站解析成功 / usage_hint / ambiguous / 提交各结果须写入飞书/微信既有审计或 CLI 日志事件（字段脱敏：不落完整用户长文，可记 decisionId、kind、choice key、result、是否含 input）。

### 5.8 Feature 与 legacy

1. `artifactManagementEnabled=false` 的会话：不发产物决策 IM，不解析编号为产物决策，不创建 Owner。
2. Legacy 扩展名写目录确认（`file-write-dir:confirm`）保持原远程行为，不纳入本编解码。

---

## 6. 协议契约（对编解码库）

本期以 `artifactDecisionRemote` 为 **唯一** 编解码真实来源；飞书与微信禁止私有方言。选项编号语义沿用现库，并 **定稿扩展** decisionId 前缀消歧（§6.6）。

### 6.1–6.5 选项编号语义（既有）

1. `output-location` 唯一选项 `custom` + `requiresInput: 'directory'`：body `1 reports/final` → choice `change-directory:reports/final`。
2. `overwrite`：body `2 name` → `rename:name`；`3 dir` → `change-directory:dir`；`1`/`4` → `overwrite`/`cancel`。
3. `ownership` / `path-type` / `reference-retention` / `git-ignore`：纯编号映射到 option key。
4. 需要输入但缺值：不得 submit 半成品 choice（应 `usage_hint`）。
5. 若协议演进，飞书与微信必须同步。

### 6.6 并发消歧：decisionId 前缀协议（定稿，原 Q4）

#### 字面格式

`decisionId` 与现网一致，为 UUID（`randomUUID()`，形如 `8-4-4-4-12` 小写/标准十六进制，大小写不敏感）。

**唯一合法的消歧回复形式**（前缀，不污染自由输入）：

```text
<decisionId> <编号>
<decisionId> <编号> <值…>
```

示例（代入真实 id）：

```text
a1b2c3d4-e5f6-7890-abcd-ef1234567890 1
a1b2c3d4-e5f6-7890-abcd-ef1234567890 1 reports/final
a1b2c3d4-e5f6-7890-abcd-ef1234567890 2 review-v2.md
```

**单候选兼容**（无前缀，保持现网）：

```text
1
1 reports/final
2 review-v2.md
```

**明确非法 / 不得实现为合法 choice 的形式**（会把 id 拼进 directory/rename 或无法抽取）：

```text
1 <decisionId> reports/final
1 reports/final #<decisionId>
```

#### 编解码解析顺序（扩展唯一入口）

对任意入站 raw（trim 后）：

1. **前缀抽取**：若首 token 匹配 UUID 形态 → `replyDecisionId = 该 token`（归一化小写），`body = 剩余文本`；否则 `replyDecisionId` 为空，`body = 全文`。
2. **编号与值**：对 `body` 按既有规则解析：首 token 为选项编号，其余 token 以空格拼接为输入值；编号越界 / 缺值 → `usage_hint`；`body` 空且已有前缀 → `usage_hint`（缺编号）；`body` 首 token 非数字且无前缀 → `not_decision`。
3. **decisionId 绑定**：`choice` 结果中的 `decisionId` 取 `replyDecisionId`（若有）；无前缀时由调用方填入唯一候选的 id（单候选路径）。编解码层可提供「抽取 + 解析 body」的组合 API，但 **不得** 在飞书/微信 router 内手写第二套拆词规则。
4. **返回类别**（在既有 `choice` / `usage_hint` / `not_decision` 之上，允许新增或由 IM bridge 映射等价枚举）：

| 类别 | 何时 | IM 行为 |
|------|------|---------|
| `choice` | 编号合法（及输入合法） | 进入 Owner 匹配与原子提交 |
| `usage_hint` | 编号非法、缺值、有前缀缺编号等 | 短提示；候选 ≥2 时附带可复制前缀示例；不 submit |
| `not_decision` | 无前缀且不像编号回复 | 落入后续入站逻辑 |
| `ambiguous` | 可由 bridge 在「候选 ≥2 且无前缀」时判定 | 提示使用前缀格式；不 submit；不落入新指令 |
| `unknown_decision_id` | 有前缀 UUID 但不在当前私聊候选集（或单候选 id 不符） | 提示决策无效/已失效；不 submit；不落入新指令 |

5. **出站**：`serializeArtifactDecisionForRemote` 必须输出含真实 `decisionId` 的可复制前缀示例（§5.2）；不得只写「请带上 decisionId」而无示例命令。

6. **测试要求（codec）**：单测至少覆盖 — 无前缀 `output-location` / `rename` / 改目录；有前缀的同类成功路径；未知 UUID 前缀；有前缀缺编号；非法编号；确认 `1 <uuid> path` **不会** 被解析为带 path 的 choice。飞书/微信集成测共用该 codec，不得分叉。

---

## 7. 验收标准

| ID | 验收项 |
|----|--------|
| AC-IM-01 | 远程 + 产物管理开启时，`output-location` 决策会向 IM 发出含编号与 decisionId 的文本。 |
| AC-IM-02 | 单候选下用户回复 `1 reports/final`（或等价前缀形）后，bridge 收到 `change-directory:reports/final` 且提交结果为 `resolved`，resume 达到 `ready` 或进入后续合法决策。 |
| AC-IM-03 | `ownership` 回复 `2`（工作包）后进入 `output-location` 或等价可完成路径，无死循环。 |
| AC-IM-04 | `overwrite` 的改名/改目录/覆盖/取消与桌面语义一致。 |
| AC-IM-05 | 非法编号只回用法提示，pending 仍在，再次合法回复可完成。 |
| AC-IM-06 | 工具 Y/N 确认与产物决策入站优先序符合 §5.3.3；`Y <id>` 不会被当成产物编号。 |
| AC-IM-07 | 桌面先点选（`resolved`）后，IM 迟到回复得 `stale`，提示失效且不二次消费。 |
| AC-IM-08 | IM 先回复（`resolved`）后，桌面卡提交得 `stale`（或 UI 提示已处理），waiter 只关闭一次。 |
| AC-IM-09 | 非绑定用户 / 群聊无法提交产物决策。 |
| AC-IM-10 | 关闭产物管理的会话不出现本 IM 决策链路。 |
| AC-IM-11 | 取消远程任务或 chat cancel 后，决策提交为 `stale`，不再可被 IM 推进。 |
| AC-IM-12 | 飞书与微信对同一决策 kind 的出站格式与入站解析结果一致（共享编解码与 `sendDecisionText` 契约）。 |
| AC-IM-13 | 回归：现有工具确认、远程普通指令、桌面产物决策卡不受破坏。 |
| AC-IM-14 | **并发隔离**：同一渠道两个并发远程请求各自有 pending 时，回复 `<正确 decisionId> 1`（或带值）只消费对应 Owner；错误 id / 跨会话字段不得 `resolved`。 |
| AC-IM-15 | **歧义拒绝**：同一私聊下 ≥2 个候选且回复为无前缀 `1` / `1 reports/final` 时，不消费任一决策，并提示可复制的 `<decisionId> …` 示例。 |
| AC-IM-16 | **跨渠道拒绝**：飞书 pending 不得被微信入站（及反向）消费。 |
| AC-IM-17 | **IM/桌面并发抢答**：两端近乎同时提交时，恰好一方 `resolved`、另一方 `stale`，无双 resolve、无抛错冒泡。 |
| AC-IM-18 | **无 waiter**：无活跃 waiter 时提交返回 `stale`，不抛错、不误发「已选择」。 |
| AC-IM-19 | **出站失败**：`sendDecisionText` 失败时取消 waiter、tool loop 得可理解错误；飞书、微信各至少一条集成测；且确认未走 Agent 工具出站路径。 |
| AC-IM-20 | **前缀编解码**：`artifactDecisionRemote` 对 `<uuid> 1 reports/final` 得到 `change-directory:reports/final` 且 decisionId 为该 uuid；对 `1 <uuid> reports/final` 不得得到合法 directory choice。 |
| AC-IM-21 | **未知 id / 缺编号**：未知 UUID 前缀 → `unknown_decision_id` 提示且不进 Agent；仅 UUID 无编号 → `usage_hint`；单候选无前缀路径回归仍通过。 |
| AC-IM-22 | **出站可复制示例**：序列化文案含代入真实 decisionId 的前缀回复示例；飞书与微信出站文本均来自同一 serialize。 |

---

## 8. 观测与排障

建议事件（名称可按现有 `feishu.*` / `wechat.*` 风格落地）：

- `*.artifact_decision.prompt`：已出站（decisionId、kind、channel、originSessionId、requestId）
- `*.artifact_decision.prompt_failed`：出站失败（含错误摘要）
- `*.artifact_decision.resolved`：提交 `resolved`（choice 摘要）
- `*.artifact_decision.hint`：usage_hint
- `*.artifact_decision.stale`：提交 `stale`（迟到/无 waiter/已取消）
- `*.artifact_decision.binding_mismatch` / `*.artifact_decision.invalid`：对应提交结果
- `*.artifact_decision.ambiguous`：多候选且无 decisionId 前缀
- `*.artifact_decision.unknown_id`：前缀 id 不在候选集

桌面「飞书/微信操作记录」审计与 CLI JSONL 的分工遵循现有飞书/微信日志规范。

---

## 9. 实现触点（需求级索引，非技术方案）

| 区域 | 预期改动方向 |
|------|----------------|
| `RemoteContext`（或平台 adapter） | 注入可 await 的 `sendDecisionText` / `replyText`；授权目标固定为本次私聊 |
| `toolChatLoop` / `resolveArtifactToolWriteWithDecision` | `onDecisionRequired` 改为可 await；按 §5.2.4–5 时序出站并处理失败 |
| `artifactDecisionBridge` | Owner 索引；提交改为原子结果协议；cancel/timeout/重启路径与 `stale` 对齐；桌面 IPC 复用 |
| `remoteCommandRouter` / `weChatCommandRouter` | 入站优先序插入产物决策解析；先 guard 再按 Owner 查询 |
| 新建或薄封装 `artifactDecisionImBridge`（建议） | Owner 匹配、歧义处理、编解码、原子提交、按结果回执，避免路由器堆业务 |
| `artifactDecisionRemote.ts` | **扩展**唯一编解码：UUID 前缀抽取、出站可复制示例、返回类别；禁止渠道私有解析 |
| 测试 | 飞书/微信入站集成测；ConfirmManager 优先序回归；并发 Owner 隔离；前缀 codec 单测（§6.6 / AC-IM-20–22）；IM/桌面抢答；出站失败；无 waiter |

详细模块拆分、错误码与类图留给后续 `docs/develop` 技术方案。

---

## 10. 已定稿决策与开放问题

### 10.1 已定稿

1. 文本编号协议，不做 IM 按钮卡。  
2. 编解码复用现有 `artifactDecisionRemote`，双端一致。  
3. 入站优先序：工具确认 → 产物决策 → 其它 → 新指令。  
4. 桌面与 IM 双通道，先到先得；共用原子提交结果协议。  
5. **Owner 归属模型**：`(source, authOwner, privateChatTarget, originSessionId, requestId, decisionId)`；允许同渠道多并发 pending；歧义时使用 §6.6 前缀协议，禁止全渠道一刀切拒绝。  
6. **提交结果**：`resolved | stale | binding_mismatch | invalid`；仅 `resolved` 关闭 waiter。  
7. **出站**：统一 `sendDecisionText`；时序为注册+waiter →（可选桌面 IPC）→ await 发送；发送失败则取消 waiter 并错误返回 tool loop，**不**保留桌面五分钟兜底。  
8. 不持久化重启后的 IM 决策队列；重启后迟到提交为 `stale`。  
9. **歧义回复字面格式（原 Q4）**：唯一合法前缀为 `<decisionId> <编号> [值…]`；单候选仍兼容无前缀 `编号` / `编号 值`；出站必须给出代入真实 id 的可复制示例。

### 10.2 开放问题（实现前可再拍）

| # | 问题 | 默认真值（若未另批） |
|---|------|----------------------|
| Q1 | 提交成功后是否总是发 IM 回执？ | **发极短回执**（便于手机确认）；仅 `resolved` 发成功回执 |
| Q2 | 用法提示是否附带完整选项重发？ | **不重发完整列表**，仅短 hint（候选 ≥2 时附带前缀示例）；用户可翻看上一条决策消息 |
| Q3 | 远程进度条/活动同步是否展示「等待产物决策」？ | **建议做**，但可作 P1；P0 以私聊文本为准 |

---

## 11. 发布与灰度

1. 随工作产物管理开关：仅启用产物管理的远程会话可见。  
2. 建议先飞书或微信单渠道灰度，再双端对齐（协议已共享，风险主要在 Owner 索引、提交结果与入站挂点）。  
3. 回滚：关闭出站/入站挂钩即可回退到「仅桌面可答」；编解码库与结果协议改动若已合入桌面路径，回滚时需保持桌面提交仍可工作（或桌面同步回退到兼容包装）。

---

## 12. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-07-18 | 首版：明确远程出站提示 + 入站解析提交产物决策 bridge 的需求边界与 AC |
| v1.1 | 2026-07-18 | 吸收评审：定稿 RemoteArtifactDecisionOwner、原子提交结果协议、统一出站 adapter 与失败/取消语义；作废「同渠道仅一个 pending」；补并发/抢答/出站失败 AC |
| v1.2 | 2026-07-18 | 吸收复审：定稿 `<decisionId> <编号> [值…]` 前缀协议；扩展唯一编解码解析顺序与返回类别；关闭 Q4；补 AC-IM-20–22 |
