# 远程 IM 意图归属与 Track 管理 — 详细开发方案

> **状态：** 技术开发方案 v1.2，已按用户确认固定 v1 参数，并以历史运行日志完成现有平台行为分析；新协议仍须通过实现后的灰度日志门槛。
> **日期：** 2026-10-11
> **范围：** 微信、飞书远程 IM；桌面链路不在本期接入。
> **需求基线：** [远程 IM 意图归属与 Track 管理需求初稿](../requirement/remote-im-intent-track-requirement-draft.md)
> **评审基线：** [第三轮需求重审报告](../review/2026-10-11-remote-im-intent-track-requirement-review-v3.md)
> **既有安全契约：** [远程 IM 异步审批安全需求](../requirement/remote-im-async-approval-security-requirement.md)
> **修订依据：** [开发计划评审报告](../review/2026-10-11-remote-im-intent-track-development-plan-review.md)
> **执行状态（2026-10-11）：** 本分支已完成本机实现与自动化验收，执行记录见 [开发与测试计划 §9](../plan/remote-im-async-interaction-development-plan.md)。14 天双渠道影子质量门槛尚未取得，因此正式语义续接仍关闭，不能宣告产品启用完成。

---

## 1. 执行摘要

本方案新增远程 IM 的统一交互归属层：入站消息先经过身份、安全与去重校验，再由一个 `TrackAttributionService` 得到唯一的 `new-track`、`continuation`、`ambiguous` 或 `rejected` 结论。结论持久化后生成不可变 `TrackContext`，后续 session 选择、request/turn、工具调用、confirmation、出站回执和异步恢复都只传播该上下文，不再各自猜测“是不是同一意图”。

本期采用以下技术选择：

1. **SQLite 是 Track、事件、映射和 Clarification 的事实源。** 在现有数据库迁移体系中增加表和索引；不把归属生命周期塞进 session metadata 或进程内 Map。
2. **Track 状态由单一 reducer/事务服务结算，终态必须通过聚合门禁。** CAS 只解决并发写入；它不能证明终态合法。Reducer 依据事务内一致的 child-work 快照验证未完成 turn、confirmation、todo、parked input 和恢复 work。
3. **入口归属先确定性、后语义。** 平台引用映射、严格句柄和确认协议优先；普通消息才进入候选与分类。分类器使用接口隔离，首阶段影子运行，启用阶段采用规则 + 语义的混合方案；不可用时不推测性续接。
4. **Clarification 选择通过事务型 parked-input/outbox 协议恢复。** 消费选择与原消息从 parked 转为 ready 在同一 SQLite 事务内完成；执行 work 固定映射到 session、request、turn，并按 turn 的持久阶段恢复，覆盖 accepted 后未开始、执行中及结果未知的崩溃窗口。
5. **澄清句柄不依赖平台 messageId。** 按评审通过的句柄协议进行精确关联；每次发送 attempt 独立记录。SDK 真正可提供的发送/引用能力仍需微信、飞书实测，不得用 mock 回显替代证据。
6. **confirmation 和异步审批只增加 Track 关联。** 不合并它们的状态机；同步 waiter 重启失效，持久 todo 和已消费动作严格沿用既有恢复、epoch、撤销 fencing 与 invocation 契约。
7. **分阶段开放。** 先做存储与事件关联，再影子分类，随后单通道灰度；未满足第 12 节启用门槛时只保留影子观测或关闭功能开关。

### 1.1 端到端目标流程

```text
IM 入站
  → 身份/owner/授权代际/渠道/去重校验
  → 显式引用、确认协议、Clarification 句柄的确定性解析
  → 普通消息候选查询与意图归属
  → 事务写入 Track/MessageEvent/Attribution + inbox/outbox 状态
  → 选择 session，并构造 TrackContextPackage（必要时）
  → Runtime request/turn/toolUse 显式携带 trackId
  → confirmation/todo 以子对象方式关联 Track
  → 出站边界记录 event 与平台消息事实
  → 单一 settlement owner 结算状态、回执与取消
```

### 1.2 不变量

- 已接受的每条入站消息只会被一个 Track 消费一次，或留在明确 parked/终态；不得出现“无归属但继续执行”。
- 一次消息的归属结果在执行开始后不可重新分类；后续层只校验授权和上下文有效性。
- session 相同、时间最近、文本相似都不能单独构成 confirmation 授权或 Track 唯一命中。
- `completed/cancelled/expired/failed` Track 不回到活动态；后续工作建立 successor。
- 所有迟到事件必须携带自身 `eventId`/`attemptId`/`version`，只能更新其所属记录。
- Track/context 永不携带可继承的工具授权、confirmation 决定、todo 消费或 dispatch permit。
- Clarification resolve 与 parked 原消息的消费入队原子提交；入队执行可恢复且幂等。
- 平台消息引用能力缺失是明确的 `unavailable/unbound` 事实，不得伪报成功或归到最近 Track。

---

## 2. 当前代码边界与实施位置

以下是本方案的初始改造定位。开发首个阶段先对目标分支逐符号复核，文件若已移动则按职责定位替换，不以路径变更为理由复制实现。

| 职责 | 现有入口/组件 | 本方案改造方向 |
|---|---|---|
| 微信消息接入与唤醒 | `electron/wechat/weChatCommandRouter.ts`、微信 poller/adapter | 安全守卫和去重后调用统一归属入口；保留 wake 和既有执行事实；剥离局部猜测归属 |
| 飞书消息接入 | `electron/feishu/` 对应 router/adapter | 与微信共享 domain/application service；只留平台解析和发送能力实现 |
| IM session 选择 | `electron/remote/imSessionResolver.ts`、`src/shared/remoteSessionResolve.ts` | session policy 仍单独存在；未终结 Track continuation 优先 origin session，超 idle 按 Track context 包决定承接 |
| 微信确认 | `electron/confirmation/imChannel.ts`、`electron/wechat/weChatImChannel.ts` | 创建/结算 confirmation 时加入 Track 与 toolUse 引用；不改独立安全匹配规则 |
| 异步审批与恢复 | `electron/confirmation/deferredTodoStore.ts`、`electron/remote/` deferred approval/wake 模块 | 给新建 todo 写入 Track ref；迁移历史行标记 legacy；既有恢复流程不由 Track 接管 |
| SQLite 与迁移 | `electron/database/sqliteStore.ts`、`electron/database/migrations*`、IM inbox/mapping 存储 | 新增 Track schema、原子事务、幂等和迁移测试；先复用已有 IM inbox/事件基础设施 |
| Runtime 上下文 | `src/shared/agent/invocation.ts`、`electron/runtime/`、`electron/toolChatLoop.ts` 及 remote invocation 装配 | 增加可选/必需的 IM Track context 契约；本地/桌面调用不带该字段仍正常 |
| 日志及审计 | `electron/agentLogger/`、`electron/confirmation/securityAuditLog.ts` 等 | 增加闭合事件类型和脱敏字段投影；纠正“解析/批准/结算”事件语义 |
| UI 与用户文案 | `src/renderer/i18n/resources/{zh-CN,en-US}`；IM 由主进程发消息 | 澄清提示、stale/expired/需重述文案经统一 message key；不在主进程拼随机自由文案 |

具体文件清单在实现前按当前分支的真实符号刷新，禁止为满足此表而引入重复 router 或第二套 todo 存储。

---

## 3. 目标架构与责任边界

### 3.1 分层

| 层 | 新增职责 | 明确禁止 |
|---|---|---|
| Platform Adapter | 解析 sender、平台 messageId、引用字段；声明能力；发送并返回 acknowledgement/echo 事实 | 按“最近 Track”选归属；批准工具 |
| Inbound Application Service | 安全校验、幂等接收、编排归属、持久化结果、安排执行 | 依赖进程全局 current Track；不持久化就先执行 |
| Attribution Domain | 确定性关系解析、候选集、分类器调用、唯一归属结果、阈值/降级策略 | 修改 confirmation/todo 权限状态 |
| Track Repository/Reducer | 事务、唯一约束、事件追加、生命周期迁移、park/unpark、恢复游标 | 调用 SDK、LLM 或工具执行 |
| Session/Context Builder | 按已定 Track 选择执行 session，构造 Track-scoped 模型输入视图 | 把同 session 其他 Track 的消息、授权或摘要混入实际模型输入 |
| Runtime Adapter | 把不可变 `TrackContext` 传到 request/turn/toolUse 和完成事件；所有 provider/history 入口只读同一 scoped view | 二次做语义归属；旁路读取完整 session transcript |
| Confirmation/Approval | 执行各自精确匹配、安全复核、TTL、撤销与恢复合同 | 以 Track 命中代替授权 |
| Settlement/Outbox Worker | 领取执行/发送/恢复任务，记录 attempt 并幂等结算 | 以 SDK fulfilled 推断平台绑定或 Agent 已执行 |

### 3.2 领域数据契约（设计目标）

最终 schema 可按仓库 SQL 风格调整，但以下语义必须保留：

```ts
type TrackState =
  | 'open' | 'processing' | 'waiting-user' | 'waiting-async-approval'
  | 'resuming' | 'cancelling' | 'reconciliation-blocked'
  | 'completed' | 'cancelled' | 'expired' | 'failed'

type TrackContext = Readonly<{
  trackId: string
  channel: 'wechat' | 'feishu'
  identityKey: string
  ownerId: string
  authorizationEpoch: number // 对应 remote_authorization_epochs 持久单调值，不是进程内 generation
  rootMessageId: string
  parentTrackId?: string
  originSessionId?: string
  attributionEventId: string
}>

type InboundAttribution =
  | { kind: 'new-track'; trackId: string; reasonCode: string }
  | { kind: 'continuation'; trackId: string; confidence: number; evidenceCodes: string[] }
  | { kind: 'ambiguous'; clarificationId: string; candidateTrackIds: string[]; reasonCode: string }
  | { kind: 'rejected'; reasonCode: string }
```

不持久化 classifier 自由文本 chain-of-thought；仅保留版本、分数/区间、有限 evidence code、候选 ID 和必要脱敏摘要。ID 使用随机 UUID/既有 ID helper；公开句柄与 Track UUID 命名空间隔离。

### 3.3 推荐表与关键约束

| 表（建议名） | 关键列与约束 | 用途 |
|---|---|---|
| `remote_tracks` | `track_id PK`、`channel`、`identity_key`、`owner_id`、`authorization_epoch`、`state`、`root_message_id`、`origin_session_id`、`parent_track_id`、时间戳、终态原因、版本 | Track 当前投影；活动候选按 owner/channel/state/时间索引 |
| `remote_track_events` | `event_id PK`、`track_id FK`、`event_kind`、`parent_event_id`、`idempotency_key UNIQUE`、`message_id/request_id/turn_id/tool_use_id/confirmation_id`、安全 payload JSON、时间 | 追加式审计和恢复事实 |
| `remote_track_message_map` | `(channel, platform_message_id) UNIQUE`、`track_id`、`event_id`、方向、绑定状态 | 可靠引用映射；缺失 ID 记录为 unavailable，不伪造键 |
| `remote_clarifications` | `clarification_id PK`、source message 唯一键、owner/epoch、state、current_version、expires_at、resolved_by_message_id、parked input ref | Clarification 聚合生命周期 |
| `remote_clarification_versions` | `(clarification_id, version) UNIQUE`、`handle UNIQUE`（含 identity scope）、候选 snapshot/hash、state、created_at | immutable 选项含义及旧句柄 tombstone |
| `remote_clarification_send_attempts` | `send_attempt_id PK`、version、state、started_at、finished_at、platform_message_id | 每次 SDK 请求的独立投递事实；回调只更新该行 |
| `remote_track_work_queue` | `work_id PK`、source key UNIQUE、track/event、kind、state、lease/attempt、payload ref、`session_id/request_id/turn_id` | inbox/Clarification 到 runtime 的事务型 outbox；固定 work→session→request→turn 映射。若现有 wake queue 可安全扩展则复用，不再造重复队列 |
| `remote_track_children`（或等价可查询投影） | `track_id + child_kind + child_id UNIQUE`、child state/version、terminal result ref | 聚合 turn、parked input、confirmation、async todo、resume/execution work；状态更新与子对象事实用同事务或可靠事件对账 |

**约束注意：**

- 活动 Track 唯一性不能只靠“每个用户最多一个活动 Track”约束；需求允许并发多个 Track。唯一性由入站 message 幂等键、Clarification 原消息消费键和各对象自己的 ID 保证。
- 需有 `(channel, identity_key, owner_id, state)` 候选索引、source message 唯一约束、handle 全局唯一索引、event idempotency 唯一索引。Child projection 不能替代源子对象；必须能从 turn/todo/confirmation/work 源表核验聚合状态。
- owner/auth epoch 必须是既有持久绑定/撤销版本的快照；若当前只有内存 generation，先扩充其持久来源并写测试，禁止用启动时从零计数。
- Track 事件中隐私正文使用现有会话/Inbox 引用或加密/脱敏 payload，避免复制整段 transcript；遵守 session 删除与 tombstone 最小留存策略。
- schema 升级采用新增表/nullable association，保持旧数据库启动兼容；迁移不可扫描全部 transcript 猜 Track。

### 3.4 原子提交与恢复协议

接收普通新消息：一个 SQLite 事务写入平台 inbox（或复用已写行）、幂等 receipt、Track/事件/归属结果及 `track-execute` outbox work。事务提交后才 ACK 平台消息/唤醒执行；重复投递命中相同 receipt，不创建第二次执行。

Clarification 选择：一个 SQLite 事务执行：

1. 条件更新 `clarification.state=pending AND version=:current AND handle=:handle AND owner/epoch 匹配`；
2. 插入唯一 `resolvedByMessageId`/selection event；
3. 将 parked source input 标成 consumed，并插入唯一 `track-execute` work，`source_key=clarificationId`；
4. 若 session/Track 状态和候选 snapshot 校验不再成立，则写 stale/invalidated 结果，不生成执行 work；
5. 提交后返回已接收。后续 worker 使用稳定 `workId`/source key 对照已持久化的 `sessionId + requestId + turnId + userMessageId`；执行阶段由 §6.4 的恢复表决定继续、对账或显式终结，不能把“turn 已存在”直接当作“work 已完成”。

这使“Clarification 已 resolved、Agent turn 尚未开始”的崩溃结果明确为 **resolved + work pending**，而非丢失或二次处理。worker 持久 lease 带过期时间，lease 超时可以重领；但 lease 只保护 work consumer，不证明 runtime 可重入，也不替代 session lease、全局并发额度和 turn 恢复。执行恢复细则见 §6.4；若历史确认显示工具是否派发不确定，则沿现有 dispatch fencing 规则不重放。

---

## 4. 归属算法与策略

### 4.1 入口次序

1. 解析原始消息字段并保留 raw reference 证据；非法/不支持消息在执行前结算为 rejected。
2. 运行渠道登录、allowlist、owner、授权 epoch、payload 校验、速率限制和重复消息检查。
3. 写入/读取幂等 inbox receipt，确保同一平台 `messageId` 只归属一次。
4. 严格句柄回复先匹配 Clarification；确认/Todo 协议回复走原安全 resolver；二者消费结果不是 Agent 普通指令。
5. 显式引用通过 platform message map 解析。唯一有效命中活动 Track -> continuation；命中完成 Track -> successor；失效引用不能回退到其他 Track。
6. 查询同 `channel + identity + owner + authorizationEpoch` 下有限候选 Track；过滤状态、continuation window、容量和来源有效性。
7. 先应用确定性规则，仍无法唯一归属时调用 classifier。归属结果事务写入后才交由 Session Resolver。

### 4.2 归属分类器接口

推荐接口为无副作用的纯应用端口：

```ts
interface IntentAttributor {
  classify(input: {
    message: NormalizedInboundMessage
    candidates: TrackCandidateSummary[]
    classifierVersion: string
    deadlineMs: number
  }): Promise<AttributionClassification>
}
```

- 候选摘要只含 Track 摘要、状态、近期相关事件/约束和时间，不含 session 中其他 Track 的数据、确认凭据或工具权限。
- 输出使用闭合 schema：`new | continuation(trackId) | ambiguous(candidateIds) | unavailable`，严格验证候选 ID 属于输入集、数值有限、候选不重复；额外字段拒绝或忽略并记录 schema violation。
- 第一版算法建议“显式关系 > 确定性命令/状态规则 > 语义分类”。模型供应商、模型调用或本地分类实现由 feature provider 注入，不让 router 直接请求模型。
- **v1 具体实现选择：** 确定性规则优先；仅当存在 1–5 个合理候选且显式关系未命中时，调用该远程 IM 当前已配置的 chat model 做单次受限分类，不引入新供应商/独立模型配置。请求只提供规范化当前消息和候选摘要，不带工具、不开放 MCP、不复用会话完整 transcript；要求严格 JSON 输出每个候选的归属分数，外层 schema 校验和阈值判断由本地代码负责。影子阶段用人工标注样本校准分数；在模型/配置版本未通过门槛前，分数只记录，不驱动正式 continuation。时限 2 秒；超时走 unavailable。成本超过 §4.3 上限则保持 classifier 开关关闭，不能放宽阈值或增加调用次数。
- 分类器 timeout、异常、非法结构统一为 `unavailable`。确定性显式关系仍可完成归属；其余不凭相似度臆断。若有合理有限候选则创建 Clarification；没有合理候选则按需求的新 Track 策略处理，但必须在启用前定稿并通过产品确认。
- 语义 continuation 只允许单一候选超过批准阈值且领先第二名的 margin；多候选接近则 ambiguous。阈值不可写死在 router；配置版本、取值和来源写入 attribution event。
- 分类输出不得触发 allow/deny/confirmation 操作。每次 downstream tool invocation 重新经过既有策略。

### 4.3 已定初始参数

按用户确认采用下表值。它们作为 v1 初始常量进入实现和测试；启用后的调整必须改动配置版本、事件审计和边界测试，不能由环境变量静默覆盖。

| 参数 | v1 固定值 | 说明/门槛 |
|---|---:|---|
| 完成 Track continuation window | 30 分钟 | 仅普通语义候选窗口；命中后建 successor，父 Track 不重开；有效显式引用可在窗口外发起 successor |
| Clarification TTL | 5 分钟 | 到期终结 Clarification，parked 原消息明确提示重发/重述，不自动执行 |
| 句柄迟到拒绝保留期 | 24 小时 | tombstone 保留期；窗口内返回 stale。超过窗口也严格识别句柄命令格式并拒绝，不落入普通指令路径 |
| 句柄格式 | Crockford Base32 的 13 个随机字符，显示为 `XXXX-XXXX-XXXXX` | 65 bit 随机空间；排除易混字符 `I/L/O/U`；不含权限语义，不使用两位 confirmation code |
| 每 identity 活动 Track 上限 | 10 | 达上限不淘汰任何有工作 Track；新意图提示用户结束/等待或重述 |
| Clarification 候选数上限 | 5 | 超过 5 个合理候选不截断后挑选；不展示不完整候选列表，要求用户引用原消息或重述 |
| continuation 判定 | `score >= 0.85` 且领先次高 `>= 0.15` | 分类器输出版本化 0–1 分数；候选未超过阈值/差距时进入澄清或 unavailable 策略 |
| 影子运行最低门槛 | 连续 14 天、累计 500 条实际发出 provider 请求的可评估普通消息；微信/飞书各至少 200 条实际 provider 请求 | 期间正式语义自动续接保持关闭；仅分类器函数被调用、但未发出 provider 请求的记录，以及未调用分类器的零候选观察，均不计入数量、渠道配额或连续覆盖；数据不足任一通道则不开放语义续接 |
| 影子误归属门槛 | 500 条样本中确认的错误自动续接为 0 | 任一确认错误即修正规则/模型并重新完整观察期；不是统计上对未来零风险的保证 |
| 分类器性能/成本门槛 | p95 ≤ 2 秒；≤ USD 1 / 1,000 次有效分类 | p95 记录实际 provider 请求耗时；成本按 provider 返回的完整 token usage 与已核验且有来源/生效日证据的当前费率卡计算，任一缺失即阻断；超限退回确定性规则与 Clarification，不阻塞新 Track |

Clarification 超时/窗口计算统一使用 UTC wall clock 存储。句柄按密码学安全随机生成 13 个独立 Crockford Base32 字符，数据库 unique 冲突时重新生成；固定长度便于严格 parser。上述灰度门槛是本方案 v1 的明确启用规则，后续变更需通过新版本评审。

---

### 4.4 历史运行证据与适用范围

历史日志分析可替代“为了摸清现有平台协议而重复手工发消息”的基线调查；它不能替代新代码上线后的行为验证，也不能证明日志未记录的 wire 字段。

截至 2026-10-11，对工作区既有脱敏运行日志和当前 SDK/API/解析器代码进行核对，得到：

| 通道/证据 | 观察事实 | 可得结论 | 证据边界 |
|---|---|---|---|
| 微信 SDK `node_modules/@wechatbot/wechatbot/dist/core/client.d.ts` | `send()`、`reply()`、`sendRaw()` 的返回类型均为 `Promise<void>` | 不能从公开 SDK 返回值取得发送 message ID；Track/Clarification 不应依赖它 | 声明文件证明 API 契约形状，不单独证明服务端未提供 echo |
| 微信历史运行日志（2026-10-11，目标工作树本机日志，已按事件统计） | 18 条确认提示投递记录均为 send fulfilled，其中 9 条被应用后续绑定、9 条为 unbound；12 条 `quote_wire` 观察中 5 条无 raw ref，7 条有 ref 容器，其中 4 条解析出 string message ID；SDK quoted text 在观察样本中缺失 | poller/echo 在部分场景能建立绑定，但能力并非每次可用；引用有时从 wire 缺失，不能把引用或 echo 当唯一关联协议 | 日志只保留事件投影；不能证明 echo 事件原始 payload 全字段或对未来版本稳定 |
| 微信发送返回诊断 | 一条投递诊断只记录到 `message_id` key 名；解析器标记可用 message ID 缺失，echo ID 也缺失 | 字段名存在不等于字段值/类型可用；不得由 key 名推断绑定 | 仅一个诊断样本 |
| 飞书历史运行日志（2026-10-11） | 记录 CLI 调用完成摘要（exit code、耗时、stdout preview），没有结构化入站引用/发送 ID 关联事件 | 现存日志不足以证明飞书引用闭环或消息回显时序 | 不要求重做已有功能的手工演示；飞书新 Track 协议启用前，需用后续脱敏结构化运行日志补齐缺失字段 |
| 当前解析器与测试 | 微信解析 `item_list[].ref_msg.message_id/messageId`；飞书解析 `parent_id/parentId`，对应测试构造这些字段 | 证明本地 parser 对这些形状的处理，不证明真实平台每次提供这些字段 | Mock/fixture 不是平台历史证据 |

因此正式设计采用句柄作为 Clarification 必需关联机制；平台引用/echo 是可用时的附加 join 能力。现有微信历史数据已足以取消重复的“手工确认 SDK send 是否返回 ID/引用是否总存在”调查。飞书只在实际缺失项上以结构化灰度日志取证；不要求操作人员重复走整套确认演示。

## 5. Clarification 技术设计

### 5.1 句柄生成和解析

- 用密码学安全随机源生成 13 个 Crockford Base32 字符，展示为 `XXXX-XXXX-XXXXX`（65 bit 随机空间）；排除 `I/L/O/U`，在唯一索引冲突时重新生成。不可使用递增计数或两位 confirmation code。
- 每个语义版本有独立句柄。相同 snapshot 的重试复用句柄，新增独立 `sendAttemptId`；候选集合、顺序、label/含义或授权 owner epoch 改变即创建新 version/handle。
- 精确 parser 接受规范语法 `选择 <handle> <option>`，只容忍首尾空白和大小写规则中明确允许的形式；不得把裸 `1`、部分匹配、模糊别名识别成合法选择。
- `handle` 解析先查全局/identity-scoped唯一索引，再检查 owner、epoch、current version、attempt-started、TTL、候选快照 hash 和选项；未知/旧句柄消息以控制回复处理，不继续到普通 Agent pipeline。
- 任何存在于旧格式短句柄空间的消息只在 strict parser 匹配后消费；未命中时还需具备有效的新指令形态才可走新 Track。窗口外句柄仍不能落入工具确认处理。

### 5.2 版本/发送竞争

版本发布事务先写版本与句柄、将前版置为 superseded、更新 current_version，然后插入发送 outbox；只有事务成功后 adapter 才能发。发送 worker 写 `attempt-started` 后调用 SDK。回调只根据 `sendAttemptId + version` 更新该 attempt；如果收到合法句柄回复，resolve 事务获胜后任何发送回调不能改变 Clarification 状态。

同内容重试：同 version + 新 attempt；内容更新：新 version + 新 handle。发送 rejected 只是该 attempt 的事实，不证明用户没看到提示；后到的合法当前句柄回复仍可 resolve。相反，没有 attempt-started 时任何 handle reply 均不得结算。

### 5.3 恢复与保留

应用启动时扫描 pending Clarification：

- TTL 未过期：current version 原样恢复，候选顺序和句柄不变；outbox 中未完成 send work 可恢复/按 attempt 策略重试。
- 已过期：条件转 expired，parked 输入终结并安排用户回执。
- superseded version：保留 tombstone 至迟到窗口结束；不得删掉后导致其被解析为新消息。
- owner/authorization epoch 已变：条件转 invalidated；旧选择不可执行。
- 保留到期后的清理必须保留严格格式防误执行策略。删除句柄 row 不能使旧回复回落成 Agent 命令。

---

## 6. Track 生命周期、session 与上下文

### 6.1 Reducer 迁移

以显式事件驱动状态转换，而不是由多个回调各自写状态：

| 当前状态 | 事件 | 下一状态 | 条件 |
|---|---|---|---|
| `open` | execution-started | `processing` | 同一 Track 有幂等工作项 |
| `processing` | needs-user-input | `waiting-user` | 原调用已经完成本轮但有明确待补信息 |
| `processing` | confirmation-pending | `waiting-user` | 同步 waiter 仍由 confirmation 自己持有；Track 聚合显示等待用户确认，不得标 completed |
| `waiting-user` | continuation-accepted | `processing` | attribution 已持久化、上下文和 owner 有效 |
| `processing` | async-approval-pending | `waiting-async-approval` | todo 已成功持久化，todo 自己拥有恢复生命周期 |
| `waiting-async-approval` | resume-accepted | `resuming` | 既有恢复器已复核 todo/epoch/invocation |
| `resuming` | execution-started | `processing` | 同一原 invocation/合法 completion wake |
| 非终态 | terminal-requested | 聚合检查后终态或保持非终态 | reducer 在事务内重新读取所有未完成 child；CAS 只是最后一步，不是完成条件 |

终态不可逆。平台发送失败是 outbound delivery 状态，不反向把执行 Track 从 completed 改回 processing。事件可乱序追加，但 reducer 拒绝非法覆盖并记录原因。

#### 6.1.1 聚合终态门禁

每个会改变 child-work 状态的事务都必须在同一事务内更新 Track 聚合投影/版本，或追加足以让 startup reconciler 可重建的持久事件。`terminal-requested` 事务按 `track_id + aggregate_version` 读取源对象，而非只信缓存计数。至少纳入：非终态 request/turn、sync confirmation waiter、parked input/Clarification、合法 pending async todo、resume work、execution outbox work、已消费但 dispatch 状态不确定的 action。

| 请求终态 | 合法条件 | 有未完成 child 时的行为 |
|---|---|---|
| `completed` | 所有 turn/request 都有终态且 outcome 可解释；无 waiting-user/sync confirmation；无 parked input；无合法 pending todo；无 queued/claimed resume 或 execution work；无未对账派发结果。任何带可恢复工作的 parked turn 都视为未完成聚合工作 | 拒绝终态请求并返回聚合原因；保留/推导 `processing`、`waiting-user`、`waiting-async-approval` 或 `resuming` |
| `cancelled` | 明确的用户/owner/系统取消事件；先为可取消的同步 waiter、turn、Clarification 和 work 发出取消命令并记录结果。异步 todo 严格按原撤销/取消契约处理 | 仍在取消/对账中的 child 时保持 `cancelling`（新增非终态）或等价状态，完成子项结算后再转终态；不得先终结 Track 丢失级联工作 |
| `expired` | 到期策略已分别结算所有可超时 child；不得因 Track TTL 覆盖仍合法的异步 todo | 有不可由 Track expiry 取消的 todo/work 时不允许 expired，继续相应 waiting 状态或经既有 owner 操作取消 |
| `failed` | 本 Track 的失败请求已终结，且无仍可恢复/执行 child；失败不代表所有子对象自动失败 | 有其他仍合法的并行 turn/todo/clarification 时只记 child failure，Track 保持非终态并继续聚合 |

因此，同 Track 有两个 todo 时一个完成只结算其 todo、invocation 和 child event；另一个仍 pending，Track 必须继续 `waiting-async-approval`。`completed` 是整个意图的聚合事实，不是任意一个 turn 的回调。

并发 continuation 入队与 terminal-requested 通过同一 Track 聚合事务序列化：continuation 先登记 child，则终态检查看到新 child 并拒绝；terminal 先通过门禁，则 continuation 只能创建 successor 或得到 stale/closed 结果，不能向已完成 Track 添子工作。CAS 冲突时调用方重新读状态并重新执行门禁，不能把失败重试为无条件终态写入。

启动时 reconciliation 以 source tables/events 重建 child projection；缺少/冲突事实进入 `needs-reconciliation` 并禁止 completed，不能猜测终态。

### 6.2 Session 选择和 Track-scoped 模型输入

- 继续活动 Track：优先 origin session，即使普通 idle timeout 已过；若 session 不可用但仅 idle 过期，可选择新 session 并构造 Track-scoped model input view。
- 用户新 Track 可复用现有 session，归属与 session 独立。用户同一 session 的其他 Track 不注入实际模型输入。
- 明确引用完成 Track/唯一语义命中完成 Track：创建 successor，parent 指向父 Track。父摘要/允许引用的产物可供上下文 builder，confirmation/permit/todo 状态绝不复制。
- **Session 仍是持久存储容器，不再是模型可见 transcript 边界。** 对每个 IM request 必须构造 `TrackModelInputView`，它是唯一允许交给模型 provider、hosted HistoryPort、compaction 和恢复代码的消息读取接口。禁止 `imRemoteAgent` 或下游因 `sessionId` 直接 `readMessages(sessionId)`/`historyFor(sessionId)` 并把全量 transcript 作为模型上下文。
- `TrackModelInputView` 根据 Track event ledger 映射以下全部对象：当前 accepted user message snapshot、该 Track 的历史 user/assistant 消息、该 Track 的 tool call/result、允许的 parent Track 事件及已验证 artifact；默认排除同 session 其他 Track 的任何 message、accepted snapshot、tool result、summary/compaction 内容。没有 Track event mapping 的 legacy message 不自动混入；仅通过显式继承白名单可纳入 parent 内容。
- **实际 provider 边界**：`imRemoteAgent.ts` 当前从 accepted turn 或 session messages 构建 `rawMessages`，随后传 `messages`、`historyForSession` 和 hosted handoff。新实现必须将这三条入口替换为同一个不可变 scoped view：`loadAcceptedMessages` 的返回需按本 turn Track 边界验证；`buildClaudeToolChatMessages` 与 `ensureToolResultPairing` 只消费过滤后消息；`assembleInvocation.messages`、`historyForSession` 和 `createHostedTurnHandoff` 使用同一个 scoped reader。任何一条无法提供 filtered view 时，本次 request fail closed，不回退完整 session history。
- **HistoryPort**：增加 scoped history adapter（例如 `historyForTrack(trackId, sessionId, permittedParentTrackIds)`），底层仍可复用 session canonical/history storage，但 `read/list/snapshot/search/compact` 的结果逐个通过 allowlist event/message ID 过滤。Hosted provider 只拿 adapter，拿不到原始 `HistoryPort`；tool result 及 assistant 输出也只有在对应 turn/toolUse 已绑定同 Track 后才能读取。
- **Compaction 与恢复**：compaction 的输入、生成摘要和写回均带 `trackId + includedEventIds + viewVersion`；session-wide canonical snapshot 不得被当作 Track 摘要。若既有存储只保留不可拆分的 session-wide summary，则对该 Track 不提供该 summary，并从可验证 event 重建；重建不完整时标 `partial/unavailable` 并在模型调用前停止/向用户要求补上下文。恢复 accepted turn 时从其 frozen scoped message snapshot 与 Track event watermark 重建完全相同的 view，不能读取恢复时最新的 session 全量历史。
- `TrackContextPackage` 只是一部分经筛选的内容与来源元数据，不能替代模型输入过滤。Package、message list、accepted snapshot、HistoryPort、hosted handoff 和 compaction 必须共用同一 `TrackModelInputView` 及 view version。
- `TrackModelInputView` 附 `completeness`、source event refs、permitted parent track IDs、included message/event IDs 与内容摘要 hash。包不可用、历史已删除、owner/epoch 变更时，停止依赖该上下文的动作并要求用户重述。
- `sessionId`、`requestId`、`turnId`、`toolUseId` 仍按现有机制生成；在 remote invocation/wake payload 中携带不可变 `trackContext + modelInputViewRef`。所有新 IM request 必须存在；桌面和历史 legacy turn 可以无字段，但不得进入 Track 路径。

### 6.3 并发、取消与 lease

- 同一入站消息通过 `(channel, platformMessageId)` 去重；缺平台 ID 时使用 adapter 提供的稳定 inbox id，不能对正文 hash 做长期身份判断。
- worker lease 仅限制 work item 执行，不作为归属证据；过期 lease 可接管，效果由 source key/accepted turn 幂等保护。
- cancel/owner revoke/session delete/channel disconnect 是不同领域事件。命令经统一 lifecycle coordinator 执行各自的级联范围；先撤销执行能力/取消有效 waiter，再写终态和 outbox 回执。异步 todo 按现有撤销 fencing。
- 任何待派发/已派发不确定工具调用都不能因 Track worker 重试而重新执行；调用既有 invocation 和 dispatch-state 查询。

### 6.4 Accepted turn 恢复协议

稳定 `requestId` 只负责识别同一逻辑 turn，不代表该 turn 已完成，也不保证其执行函数可安全重入。恢复器必须读取 work、turn、accepted transcript、session lease、invocation checkpoint 和 tool dispatch 事实后做决策。当前 turn 持久状态至少包含 `configuring`、`prepared`、`executing`、`waiting-confirm`、`terminal(outcome)`；开发前以目标分支实际枚举/表结构为准，新增 Track 层状态不得覆盖 turn 源状态。

每个 work 在第一次创建/准备 turn 时原子或可恢复地固定 `workId → sessionId → requestId → turnId → userMessageId → trackId/viewVersion`。同一 work 重试不得换 request/turn，也不得拿已变化 session transcript 重组 accepted input。恢复前按标准顺序重新取得 session 单飞 lease 和全局并发额度；work lease 不能替代这两项。attempt fencing 令过期 worker 的迟到结果只能追加自己的 attempt fact，不能写 turn terminal、ack work 或越过当前 owner。

| 持久 turn / 调用事实 | 恢复动作 | 禁止动作/结算 |
|---|---|---|
| work queued，尚无 turn mapping | 建立唯一 request/turn；持久化 frozen TrackModelInputView 和 execution config 后继续 | 不允许先运行模型再补 Track/view 映射 |
| `configuring`，配置尚未冻结 | 不作为 accepted execution 自动启动；终结为明确 `failed-before-start` 并要求用户重发，使新消息获得新的归属/输入快照 | 不得默默覆盖原 accepted input 或换模型配置后继续 |
| `prepared`，尚未启动 runtime | 在持有 session lease/global admission 后使用同一 turnId/requestId、冻结配置和 accepted snapshot 启动原 turn。该分支只有在确认当前 startup recovery coordinator 尚未将其终结时才可执行 | 不得因 prior turn exists 而直接拒绝并无限重投；不得创建第二 turn |
| `executing`，运行进程/lease 已失联 | 当前实现没有完整 Agent-turn checkpoint resume API。先检查 canonical history/session ledger：若有完整成功终态则 reconcile 成 completed；否则由现有 startup recovery 将其明确终结为 `recovered/interrupted`，失败化尚未完成的工具调用并通知用户 | 不得因“看起来未派发”就重跑整轮；不得把未知工具结果当未执行 |
| `waiting-confirm` / parked | 同步 waiter 重启按原契约失效并结算为 interrupted/rejected confirmation；合法异步 todo 保持 todo 契约，由原 deferred recovery/wake API 恢复原 invocation；Track 保持 waiting 状态或待 reconciliation | 不得因 Track worker 重试而重建同步 waiter或取消合法 async todo |
| `terminal(completed/parked)` 且最终持久事实一致 | 将 work 标为完成/parked、按幂等补交 inbox ack；Track 聚合 reducer 消费 turn terminal 事实 | 不得再调用模型/工具 |
| `terminal(failed/cancelled/interrupted/outcome-unknown)` | 幂等结算 work 与用户可见失败/中断回执；按明确用户重试创建新 Track event/request，必要时引用旧 Track | 不得把 failed turn 原位改 completed 或自动重放未知派发 |
| turn 与 history/checkpoint/dispatch ledger 冲突或缺失 | 转 `needs-reconciliation`，冻结相关 work 和 Track 完成结算；审计输出缺失事实并走恢复/人工可见失败通道 | 不得采用“prior turn incomplete”永久抛错循环，也不得跳过 work 标成功 |

**现有恢复能力调查结论：** `SessionStorage` coordinator 会从 canonical history/session ledger 对账，并调用 `recoverPersistedTurn` 把有完整终态证据的 turn 补为 completed；缺少完成证据的 executing turn 会变为 `recovered` 并收敛 streaming assistant/tool 状态。`recoverProviderAttempt` 处理的是一次仍在运行的 hosted turn 内的单次模型请求恢复，不是进程重启后的整 turn resume。当前没有可证明安全的整轮 checkpoint resume，因此 v1 明确不恢复重启前 `executing` 的 turn；只有 turn 尚为 `prepared` 且原输入/配置/view 完整时才重进原 turn。

**API 与接线要求：** 新增/复用单一 `recoverRemoteTrackWork(workId)` application service，调用既有 turn coordinator/session execution/history recovery/accepted-turn APIs。新 Track recovery 必须接入 SessionStorage startup recovery 顺序，在通用 residue recovery 终结 prepared turn 之前识别 Track work：满足 prepared 安全条件则恢复，否则交给既有 canonical history recovery 做明确终态对账。微信 `dispatchWakeEventSet` 的 `WECHAT_WAKE_PRIOR_TURN_INCOMPLETE` 与 completion wake 的 `WECHAT_COMPLETION_WAKE_PRIOR_TURN_INCOMPLETE` 分支必须改为交给该恢复服务，不能直接拒绝 pending work；恢复服务仍复用 router 当前的 remote session lease、`maxParallelChatSessions` 和 completion/deferred wake 安全校验。若启动顺序不能安全保留 prepared turn，则该 work 按 `recovered/interrupted` 明确失败并告知用户，绝不重新配置后从头重跑。

**work ack 条件：** 只有 turn 已有可验证的 terminal/parked 事实、Clarification/Inbox source receipt 对应正确、Track event append 成功后才可 ACK source work。source ack 失败可以幂等重试；ack 重试路径只读取终态并补交，不再次运行 Agent。accepted/configuring/prepared/executing 一律不是 work 完成态。

---

## 7. Confirmation、异步审批和工具执行接线

### 7.1 同步 confirmation

- 扩展 `ImPendingConfirm` 或其持久/内存 envelope 加入 `trackId`、`trackEventId`、`toolUseId`。创建处必须拿到不可变 TrackContext；缺失时 IM remote 的确认创建 fail closed 并产生契约告警。
- confirmation 表/待处理结构以自己的 `confirmationId` 作主键；Track 只是外键/事件关联，不按 Track 自动批准。
- 入站确认语法先用原 confirmation resolver 精确匹配；resolve 时把 confirmation terminal event、回复 message map 和 Track event append 关联起来。一个事务/settlement owner 确保 approve/deny/expire/cancel 最多一个终态。
- 重启仍让同步 waiter 失效，不因 Track 持久化而“复活”。记录 `invalidated-on-restart` 到 Track event，防止旧提示回复造成新批准。

### 7.2 异步审批 todo

- 创建 todo 时写 `track_id` 和创建事件引用，保持原 `invocationId`、`originSessionId`、授权快照、epoch/revocation facts、通知版本和 TTL 原义。
- schema 增 nullable 列；历史行均 `track_id=NULL` / `legacy-unattributed`。不凭 session 或时间自动补绑，不影响 pending todo 既有合法恢复。
- resume/wake 沿既有恢复链路执行：先 epoch/撤销/执行日志对账，使用原 invocation 和 origin session。Track 只能成为关联/聚合显示，不能换 execution session 或 permit。
- todo completion/cancel/expire/revoke 事件回写关联 Track；若旧数据无 Track，保持 legacy 流程。

### 7.3 执行结果和出站投递

每次 Agent/runtime/outbound 事件都写明确父子关系。消息 send 返回 `attempted/fulfilled/rejected/outcome-unknown` 与可选平台 ID；平台 echo/bind 是独立事件。工具未派发、确认不可用、发送成功但无引用绑定等结果均保留对应事实码，不混成“发送失败”。

---

## 8. 事件、日志、隐私与诊断

### 8.1 事件类型（建议闭合）

至少需要以下 event kind：

```text
track.created | track.attribution.decided | track.state.changed
track.inbound.accepted | track.inbound.parked | track.inbound.consumed
track.context.built | track.context.unavailable
track.request.started | track.turn.started | track.tool_use.created
track.confirmation.created | track.confirmation.settled | track.async_todo.linked
track.outbound.attempt_started | track.outbound.send_result | track.outbound.message_bound
clarification.created | clarification.version_published | clarification.send_attempt
clarification.reply_rejected | clarification.resolved | clarification.expired | clarification.invalidated
track.execution_work.queued | track.execution_work.claimed | track.execution_work.completed
track.terminal | track.lifecycle.rejected_transition
```

按适用性记录 `trackId/eventId/parentEventId/channel/identityKey/messageId/sessionId/requestId/turnId/toolUseId/confirmationId/todoId/attemptId/version`。未知值使用明确 absent reason，不伪造默认 ID。

### 8.2 日志与隐私

- 增加 agentLogger 闭合联合、字段白名单与 reader 投影；审计类型沿 security audit 现有 schema 同步。
- 正文不写入通用日志；必要的 parked 文本引用既有 inbox/message 存储，日志只记 `sourceMessageId`、脱敏/摘要指纹和大小。
- 分类器日志只写 classifier version、时延、有限候选 ID、分数/阈值结果、reason code；不写隐藏推理文本。
- 用户可见失败/澄清文案经 i18n；主进程发送 message key/有限参数或复用现有平台文案映射。
- 数据删除流程必须覆盖 Track events、映射和 Clarification 正文引用；保留的最小 tombstone 不包含正文，并有确定期限及安全需求依据。

---

## 9. 分阶段 TDD 开发计划

执行纪律：每项行为先写可失败测试，确认 Red，再实现最小改动到 Green，最后重构并跑该阶段回归。并发行为优先用可控 deferred Promise、屏障/事务冲突或多连接 SQLite 测试，不依赖随机 sleep。测试失败记录保留首错、expected/received 和项目栈。测试范围遵守仓库要求：focused → 全套及相关 typecheck/i18n；实现任务按本项目 TDD 目标执行验证。

### 阶段 0：基线与设计冻结

**目的：** 固定参数、接口和现状契约，避免 schema 和 router 同时返工。

**工作项：**

1. 在目标分支复核 §2 文件/函数/数据库迁移机制，确认已有 IM inbox 是否能作为 transaction source；记录序列图和实际平台 wire 样本。
2. §4.3 v1 参数已经冻结；阶段 0 只将常量映射到配置/schema/parser/test，不再等待产品选值。句柄格式固定 Crockford Base32 13 字符并按 4-4-5 分组显示。
3. Track 使用现有 SQLite `remote_authorization_epochs` 的 `getAuthorizationEpoch(channel)`；禁止使用 `getGeneration(channel)` 作为跨重启 Track 授权身份（后者是进程内 generation）。
4. 定义错误码、事件 kind、归属 output schema、SQLite transaction API 和 feature flags。
5. 对已有微信、飞书历史日志做脱敏统计，建立代码/SDK 契约与真实运行观察的证据表。历史数据缺失的字段列为“未观测”，不要求重复做已被日志覆盖的手工操作；新协议部署后的灰度日志用于验证新增 handle 和 work-recovery 行为。

**退出条件：** v1 参数和句柄协议无 TBD；历史平台证据、SDK 类型/API 契约、解析代码和测试各自的证明边界有记录；现有异步审批恢复回归边界有基线用例。

### 阶段 1：SQLite schema、Repository 与 reducer（先纯后持久）

**TDD Red：**

- 新建 Track 时产生 open Track + root inbound event；同 message id 重复调用只返回原 Track。
- 不同 owner/channel/epoch 不得命中同一活动 Track。
- terminal 状态不可回到 processing；非法状态迁移拒绝且保留原状态。
- 同 event idempotency key 重放不重复事件；父事件跨 Track 引用拒绝。
- migration 从空库和当前旧 schema 启动；旧 todo 行不被删除、状态不变且 Track 为空。
- Track terminal request 与并发 child insert/update 在 SQLite 同事务竞争；任何未完成 child 都阻止 completed。

**实现：**

- 先实现纯 `trackReducer`/transition table 与 domain types/test。
- 增 migration、typed repository、事务包装、唯一索引、幂等 API。
- 写 migration rollback/upgrade 兼容性测试（若仓库 migration 策略只前滚，则覆盖重复启动与部分 schema 失败恢复）。

**验证：** database focused tests、migration suite、shared/electron typechecks。

### 阶段 2：统一归属服务与影子分类

**TDD Red：**

- 显式引用唯一活动消息映射命中 continuation；显式引用 completed 建 successor；失效引用不落到其他活动 Track。
- classifier 有效唯一高置信候选 continuation；差距不足/多候选 ambiguous；零候选 new。
- classifier timeout、throw、malformed output、外部 trackId 均不能假装 continuation。
- confirmation 与 clarification 严格消息在普通 classifier 之前分流；classifier 永不批准 confirmation。
- identity/owner/epoch/channel 候选隔离；已终结候选过滤正确。

**实现：**

- 增 `TrackAttributionService`、`TrackCandidateRepository`、`IntentAttributor` interface 和 closed output validator。
- 先启影子模式：只追加 shadow attribution event，不改变既有 router 行为；日志字段脱敏。
- 建离线 fixture corpus（匿名化/合成的 new/continuation/ambiguous/explicit reference），对 classifier version 做确定性回放。

**退出门槛：** shadow 中 `classifier_invoked=1 AND provider_call_made=1` 的可评估普通消息连续覆盖至少 14 天、累计至少 500 条且两个通道各至少 200 条；确认误续接为 0；实际 provider 调用 p95 ≤ 2 秒且按完整 token usage 与有来源/生效日证据的费率卡计算的分类成本 ≤ USD 1 / 1,000 次。费率证据缺失的历史 provider 调用保持 unpriced，不能被后来新增的费率卡追认。只调用分类器函数但没有发出 provider 请求的记录，以及没有候选而未调用分类器的观察，只作为基线，不计入分类质量样本量、渠道配额或连续覆盖。阈值需在独立标注样本上校准。任一条件不满足就保持规则确定路径 + 用户澄清，不开启自动语义 continuation。

### 阶段 3：入站入口、Track 传播与事务性执行 work

**TDD Red：**

- 入站安全 guard / dedupe 发生在归属前；被拒绝消息不建活动 Track、不运行 Agent。
- Track/归属事件/work outbox 在同一事务提交；事务失败时不 ACK/不启动 runtime。
- 平台重复投递、worker 重启、lease 过期只执行一次 accepted turn。
- 两条并发消息归属不同 Track 时不通过共享 mutable `currentTrack` 串线。
- Track Context 沿 wake event、session lease、runtime request/turn 传递；缺失的 IM context 明确 fail closed/兼容旧队列策略。
- 建立 session 同时含 A/B Track 的真实存储 fixture；A request 的 accepted snapshot、常规 messages、tool results、HistoryPort/list/search/snapshot 及 hosted handoff 都不得暴露 B 的事件。
- 对 A/B 交错、引用 A 旧输出的 successor，再验证 provider 最终输入仅含 A 与显式允许的 parent 事件；不仅检查 context package。
- session-wide compaction 存在 A/B 混合摘要、Track mapping 缺失或视图版本过期时，scoped reader 不回退到 full transcript。
- provider request 和 hosted HistoryPort 调用处断言收到相同 `trackId + viewVersion + allowedEventIds`；filtered view 缺失时在模型网络请求前 fail closed。

**实现：**

- 在微信接入点按 `安全守卫 → receipt → attribution → transaction → work enqueue → ack/wake` 编排。
- 先微信单平台；统一 application/domain 接口后接飞书 adapter。
- 拆出 `TrackContext` 和 `TrackModelInputView` 类型；改造 `electron/remote/imRemoteAgent.ts` raw message 构造、`assembleInvocation.messages`、HistoryPort 注入、hosted handoff 及恢复/compaction 入口，强制共用 view；接入 remote context/invocation 和 `requestId`/`turnId` 审计日志，不将 Track 加进 session ID 语义。
- 若现有 IM inbox/wake queue 可承载执行工作，扩展其 payload 与幂等 source key；否则新增 outbox 表，明确唯一 consumer。

**验证：** router/inbox/wake/database integration tests，重复/乱序/transaction failure 矩阵。

### 阶段 4：Clarification 持久闭环与崩溃恢复

**TDD Red：** 先按 §10.2 事件矩阵逐项建用例，至少覆盖：

- pending clarification 创建并 parked 原消息；不创建 Agent user turn。
- send attempt 未开始时句柄 reply 拒绝；attempt started 后平台 ID 缺失/fulfilled/unknown/rejected 时有效回复 resolve。
- resolve 与 ready work 插入原子性；模拟 commit 前崩溃、commit 后 worker 前崩溃、worker claim 后崩溃。
- work 重领不重复 message/user turn/tool dispatch；dispatch outcome unknown 不自动重放。
- v1/v2 并发选择与更新两种先后、旧 callback、重启后的 tombstone、选项重排、owner epoch 变更。
- 同一版本重复发送使用不同 attemptId；相同选择幂等；并行 clarification 乱序隔离。
- TTL 边界、候选失效、过期后句柄不被普通命令路径执行。
- accepted turn 持久化后、runtime 尚未启动时崩溃，原 work 必须恢复同一 request/turn 并执行一次；不能因 prior turn 非终态直接永久拒绝。
- `executing` turn 分别模拟：无 dispatch 事实、已派发且结果确定、已派发且结果未知、checkpoint 可恢复/不可恢复；各自按恢复表执行或显式终结。
- work claim、session 单飞 lease、global admission 额度、old worker 迟到回调竞争；不能由 work lease 独占推导可运行。
- turn terminal 已提交但 source work 未 ack 时，重启仅幂等补 ack，不重进 runtime。
- 对照真实 `configuring/prepared/executing/waiting-confirm/terminal` 状态和 accepted input/history revision，view/config 漂移时不得改写原 accepted turn。

**实现：**

- 按 §3.4 建事务 resolve；持久 work queue/lease/attempt API；稳定 source key 对齐 accepted turn。
- 加入 `work→session→request→turn→userMessage→track/viewVersion` 持久映射与 `recoverRemoteTrackWork`；复用/补充 turn recovery API，修正微信 inbound 与 completion wake 既有 prior non-terminal turn 拒绝路径。
- 首版若无安全 checkpoint resume 能力，只恢复 `prepared` turn；对无法证明可继续的 `executing` 状态明确结算 `interrupted/outcome-unknown`，不得整轮重跑。
- 新版本发布、send attempt、回复消费统一走 repository application commands，禁止 adapter 自行 settle。
- SDK 发送状态与 Track/Clarification 状态分列持久化。
- adapter 暴露 `send()` 实际 ack 与 echo/bind 两类事实；不假设 `send()` 返回 platform messageId。

**验证：** 多连接 SQLite 测试真实事务锁竞争；模块测试所有排列；integration restart 测试使用真实数据库文件而非只测 mock。

### 阶段 5：Session 承接、successor 与生命周期协调

**TDD Red：**

- active Track 超 idle continuation 仍选 origin session；origin 被删时不可重建已删除上下文。
- 完成 Track 在 window 内唯一高置信/显式引用时创建 successor；父 Track 不变；多候选走澄清。
- context package 只包含目标 Track events/constraints/artifact refs；同 session 另一 Track 内容与授权不泄露。
- partial context 阻止依赖缺失信息的工具动作并提示补齐；unavailable 要求重述。
- session deletion、owner revoke、channel disconnect 并发与 continuation 时以规则确定唯一终态和审批级联。
- 同 Track 两个 async todo：一项完成而另一项仍 pending 时 Track 保持 waiting；pending todo 可恢复且不被 completed 覆盖。
- 多 turn 并行时一项 completed、另一项 executing/confirmation-pending 时不允许 Track completed。
- 新 continuation 入队与 Track terminal gate 并发；只允许一方先提交，terminal 先赢时创建 successor/stale，continuation 先赢时终态拒绝。
- parked clarification、resume work、execution outbox 或 outcome-unknown dispatch 任一存在时不得 completed。
- cancel/expire/failed 聚合语义分别验证，不把 completed 门禁简单复用为强制级联，也不遗留未结算 child。

**实现：** `TrackModelInputViewBuilder`、scoped HistoryPort adapter、Session Resolver 的 Track-aware overload 和 lifecycle coordinator；session history 仍是共享存储容器，provider/hosted history 只可见 Track allowlist 视图。Track ledger 负责归属，避免复制整段 transcript。

**验证：** context isolation、session deletion、restore、state transition races。

### 阶段 6：confirmation 与异步审批关联

**TDD Red：**

- 每个新同步 confirmation 必须只对应一个 Track/toolUse；同 Track 两个 toolUse 不能串项。
- Track match 不替代确认精确校验；无匹配、旧句柄、过期、owner/epoch 错误均 fail closed。
- Track 关闭和 waiter settle 竞争只有一个 confirmation terminal result。
- restart 时同步 waiter invalidated；异步 todo 仍按现有合法 TTL/epoch 恢复。
- 历史 todo nullable track association 不改变原 invocation/origin session；已 consumed 未知派发结果不重放。
- successor 不复制 confirmation/todo/permit。

**实现：** 同步 confirmation / deferred todo 添加 Track ref 与关联事件；迁移只新增 nullable 列；更新 deferred completion wake、audit reader 和历史兼容投影。

**验证：** 跑现有 deferred approval 恢复、撤销、dispatch fencing 全量定向测试，再加 Track join tests；任何既有审批契约差异都是阻断。

### 阶段 7：平台能力、日志、指标、灰度及收敛

**TDD/验证：**

- contract tests 验证微信、飞书 adapter 能力声明与 wire parser（quote missing、duplicate echo、echo before ack、ack no ID、unknown outcome）。
- agentLogger/audit reader 对新闭合事件和投影有 round-trip tests；隐私扫描断言不包含原正文、令牌或自由分类理由。
- 指标按 Track/event 聚合，缺字段保持 missing reason，禁止 fallback 到 session/time。
- feature flags 可以分别关闭 semantic continuation、Clarification、Track-aware confirmation 接线；关闭时已建立 Track 的恢复行为仍安全。

**实现与发布：** 微信 shadow → 微信 opt-in canary → 微信默认关闭验证窗 → 微信逐步开放 → 飞书重复同一 gates。清理旧重复推断仅在两平台稳定后作为独立提交；保留可回滚开关及 legacy adapter。

---

## 10. TDD 事件顺序与验收矩阵

### 10.1 归属/生命周期

| 排列 | 核心断言 |
|---|---|
| duplicate inbound → retry attribution | 同一 receipt/track/work；不重复 turn |
| attribution transaction fail → redelivery | 第一次无执行；重投后一个 Track/一个 work |
| two candidate Track, same owner → ambiguous | parked，不按最近时间择一 |
| classifier timeout + explicit reference | 显式关系仍可归属；分类器不被调用或不影响结果 |
| classifier timeout + no explicit relation | 不做猜测性 continuation；按冻结的 unavailable 规则走 new/clarification |
| terminal Track + late ref → successor | parent terminal unchanged；旧 confirmation 仍 terminal |
| lifecycle terminal event race | CAS/事务只接受一项终态，其他事件保留且标记 no-op/rejected |
| worker lease expires while old worker returns | attempt fencing 阻止旧 worker覆盖新 owner/终态 |
| two async todos, one completed and one pending | track remains waiting-async-approval; second todo remains recoverable |
| one of concurrent turns completes while another is executing/waiting-confirm | no track completed event |
| continuation insertion races terminal gate | transaction winner decides; losing continuation goes successor/stale or terminal is rejected after re-read |
| parked clarification/resume/execution work or dispatch outcome unknown remains | terminal completed rejected until child settles/reconciles |
| session-scoped accepted messages contain A+B, current track=A | provider messages, hosted HistoryPort and compaction view contain A plus explicitly permitted parent events only |
| track A references parent A while session has unrelated B | successor A cannot see B message, tool result, summary or accepted snapshot |
| accepted turn is `prepared` after restart | resume same turn/request with frozen config and model input view |
| accepted turn is `executing`, tool dispatch unknown | don't replay; reconcile or settle outcome-unknown/interrupted |
| turn terminal committed but work ack missing | acknowledge idempotently without runtime invocation |

### 10.2 Clarification 协议

| 事件顺序 | 预期结果 |
|---|---|
| persist v1 → send attempt not started → reply | 拒绝，不消费 parked input |
| persist v1 → attempt started → reply before ack | reply 可 resolve 并入队一次；迟到 ack 不回滚 |
| attempt rejected/unknown → valid current handle reply | reply 证明提示可达并 resolve；send outcome 原样保留 |
| no send attempt → forged current-looking handle | 不 resolve |
| v1(A/B) → v2(B/C) → late `v1+1` | stale，绝不解释成 v2 的 B |
| reply commit races v2 publish | winner 决定；输方不能覆盖状态/snapshot |
| v2 published → v1 send callback | 只更新 v1 attempt row |
| resolve transaction commits → process crashes before worker | restart 完成唯一 work，不丢失/重复原输入 |
| worker starts → process crashes before accepted turn commit | lease reclaim，幂等恢复 |
| accepted turn commits → process crashes before work ack | 依 §6.4 恢复原 turn；只有 terminal/parked 已核验后幂等补 ack，accepted 本身不视为完成 |
| owner epoch changes → stale handle reply | invalidated；无 Agent work |
| clarification expires → late handle text | stale/expired 控制回复；不进入普通 command pipeline |

### 10.3 审批/恢复兼容

覆盖需求 §12.3 所列所有同步 waiter、异步 todo、consumed dispatch 状态、撤销 epoch、session 删除、旧 confirmation 回复排列。执行既有 suite 作为 compatibility gate，并验证 Track ID 缺失的 legacy todo 可保持原行为。不得用 Track 自动取消全部 pending todo。

---

## 11. 迁移、兼容与回滚

### 11.1 迁移顺序

1. 先发布只新增表/nullable 字段与索引的迁移，旧版本读取不受影响。
2. 新版本双写 Track 事件但 shadow mode 不改变路由；旧事件标记 `legacy-unattributed`，不猜测回填。
3. 影子观测通过后，启用显式归属与新消息 Track 路由；旧 pending 的同步 waiter按既有重启语义处理，异步 todo不变。
4. Clarification、Track-aware confirmation 分独立开关逐项开放。
5. 只有稳定之后才清理旧模块本地的重复关联字段/推断逻辑；先确认历史查询和恢复不依赖这些字段。

#### 11.1.1 功能开关依赖矩阵

| 开关 | 可以启用的行为 | 必需前置 | 关闭时行为 |
|---|---|---|---|
| `remoteTrackPersist` | schema、事件/关联双写 | migration 与旧数据兼容 | 仅停止新事件双写；不删已有 Track 数据 |
| `remoteTrackShadowAttribution` | 记录影子分类，不改变路由 | persist、脱敏日志、分类 timeout | 原路由完全不变 |
| `remoteTrackExecution` | 新消息走正式 Track 归属、outbox 和 Track-aware turn | repository/reducer、TrackModelInputView、accepted-turn recovery、session lease/global admission、关闭/恢复策略 | 不接收新的 Track work；已创建 work 必须继续被兼容 worker 消费或明确终结 |
| `remoteTrackClarification` | ambiguous 消息 parked、句柄回复恢复 | execution 前置项、持久版本/attempt、strict parser、resolve transaction、worker recovery | 不允许仅靠 Track execution 开新路由；ambiguous 输入 fail closed 并回复需重述/稍后重试，不能旧路由猜测处理 |
| `remoteTrackConfirmationLink` | 新 confirmation/todo 写 Track association | execution、Track event 映射、既有确认/异步恢复回归全通过 | 对已创建关联继续读写；不移除关联列/事件 |
| `remoteTrackSemanticContinuation` | 对普通消息自动语义续接/完成 Track successor | execution + TrackModelInputView + clarification + 影子质量 gate + 参数冻结 | 显式引用/确定性规则可按单独策略运行；语义候选歧义则澄清或 fail closed |
| `remoteTrackRolloutChannels` | 将全局 rollout 开关限制到显式列出的 IM 渠道 | 只接受闭合 JSON 数组 `wechat`/`feishu`；缺失或空数组表示两路均关闭 | 名单外渠道走现有路由；不影响已持久化 work 的恢复 worker |

依赖关系强制为：`semanticContinuation → clarification → execution → recovery + scopedModelInput + storage`；Track-aware confirmation 依赖 execution 和既有 confirmation 安全契约，但不反向要求开启语义 classifier。router/runtime 必须将真实 IM channel 传给 gate reader；全局布尔开关不能绕过 `remoteTrackRolloutChannels`。任一硬前置未就绪，启动时配置校验必须拒绝启用依赖开关。

### 11.2 回滚能力

- 新路由尚未开放前可使用旧路由。正式 Track execution 开启后，关闭开关只能停止接收新 Track work；已落盘 Track/Clarification work 必须由同版本的 Track recovery worker 继续处理或明确终结，不能直接回退旧路由重复消费。
- 数据库只做向前兼容 schema additive migration；回滚应用时旧版本忽略新表/nullable 列。不要在回滚中删除已经创建的安全审计事实。
- 老版本不认识新协议时，不能仅凭 schema additive 就降级启动：若存在 pending clarification、Track outbox、非终态 Track work 或新 confirmation handle，启动必须执行兼容门禁并阻止旧二进制处理这些消息。受支持的回滚方式是同版本关闭新入口但保留恢复 worker；跨版本回滚必须先 drain/终结新协议 pending work，或运行经验证的兼容 worker 后再降级。
- classifier 故障时可关闭语义 continuation，保留确定性引用、严格 confirmation、Clarification 新句柄或安全的新 Track 策略。
- 如发现错误归属，关闭 auto-continuation，保留证据并停止受影响 Track 的依赖动作；不能通过重绑已结算 confirmation 修复。
- 开关配置和迁移版本需启动自检；按 §11.1.1 校验开关依赖，不兼容旧版本时禁止降级运行，而不是忽略 pending work。

---

## 12. 启用前硬门槛

以下条件必须全部完成，才能启用自动语义 continuation 或将此模型设为远程 IM 默认：

> **门槛范围：** 本节是自动语义续接的运行期启用门槛，不是代码开发、代码评审、合并或打包门槛。实现必须先以默认关闭语义续接的状态交付；部署该实现并实际启用影子采集后，14 天观察窗口才开始。不得用“尚无 14 天样本”阻止开发交付，也不得在样本收集完成前打开自动语义续接。

1. **参数定稿：** v1 参数以 §4.3 固定值实施；运行时不得由未审计环境变量改写，参数变更须版本化并更新测试/审计。
2. **授权 epoch 闭环：** 使用现有 SQLite `remote_authorization_epochs` 持久 epoch (`getAuthorizationEpoch(channel)`)，重启不归零；不得使用进程内 `getGeneration()`；owner 变更和撤销与 clarification/track reply 并发用例通过。
3. **事务恢复通过：** clarification resolve + parked input outbox 与 worker crash matrix 通过真实 SQLite restart tests。
4. **平台能力证据：** 现有协议基线按 §4.4 历史日志和 SDK/API/parser 证据验收，不重复要求手工实机演示；当前微信证据已显示 send fulfilled 与 message binding 是分离事实、引用字段可能缺失。飞书历史证据不足的字段仅需在新协议灰度中通过现成结构化事件采集补齐；mock 自造字段不计为平台证据。
5. **审批回归：** 现有异步 todo restart、撤销 fencing、session deletion、unknown dispatch 不重放的契约全绿。
6. **分类质量：** `classifier_invoked=1 AND provider_call_made=1` 的影子观测至少连续 14 天、500 条且每通道不少于 200 条；仅调用分类器函数但未发出 provider 请求的记录、未调用分类器的零候选观察均不计入样本、渠道配额或覆盖；确认错误自动续接为 0；实际 provider 调用 p95 ≤ 2 秒且基于完整 token usage 和有来源/生效日证据费率卡估算的成本 ≤ USD 1 / 1,000 次有效分类。任何误续接或超限都关闭语义自动续接并重新完整观察。
7. **可观测性：** 能按 event/track 找到入站→归属→执行→确认→工具派发→回执完整链，字段脱敏；不依赖最近时间猜 join。
8. **运维准备：** feature flags、暂停/恢复手册、待处理 Clarification 清理与 stale 回复文案、schema downgrade 兼容策略完成。

历史日志足以决定现有协议设计，不要求重演已被观测的场景。新代码的投递/回显与恢复正确性仍以自动化事件序列测试为主，并用灰度结构化日志核对线上事实；若日志不能观测所需字段，就先补观测能力，不以人工重复发消息替代缺失的审计数据。

---

## 13. 可观测指标与告警

| 指标 | 维度 | 触发关注 |
|---|---|---|
| `remote_track_attribution_total` | channel/kind/reason/classifierVersion | ambiguous/unavailable 突增、显式关系失败 |
| `remote_track_wrong_attribution_report_total` | channel/version | 用户报告接错意图；任何确认后应暂停语义自动续接 |
| `remote_track_join_completeness` | event kind | request/turn/toolUse/confirmation/outbound 缺 Track ref |
| `remote_clarification_delivery_total` | result/attempt/version | attempt error、长期 parked、重复投递 |
| `remote_clarification_resolution_latency` | channel | 接近 TTL 或超时率变化 |
| `remote_clarification_stale_reply_total` | stale reason | 旧版本回流、未知句柄误入普通 pipeline（应为 0） |
| `remote_track_work_recovery_total` | state/reclaim count | lease 多次超时、accepted turn 对不上 |
| `remote_track_context_completeness` | complete/partial/unavailable | unavailable 不可继续依赖上下文执行 |
| `remote_track_terminal_transition_rejected_total` | from/to/reason | 迟到覆盖、并发冲突或代码路径绕过 reducer |

告警至少包括：无 Track Context 的新 IM runtime invocation、句柄 parser 未识别旧控制语法后却创建 Agent turn、Clarification 已 resolved 但长期无 work 完成、活动 Track 卡在 processing 超出阈值、todo/Track 关联写失败、owner epoch mismatch。

---

## 14. 完成定义

### 开发交付完成

- 需求 §12 的全部归属、confirmation 和事件顺序不变量有自动化测试，尤其包括 Clarification 两个阻断修复点与第三轮 review 的四项启用前事项。
- 微信、飞书远程新消息经过统一归属入口；下游不再自行按 session/时间/正文推测 Track。
- Track 事件贯通入站、session/request/turn/toolUse、confirmation/todo、出站消息和回执；缺失关联会显式告警。
- resolve/parked input/execution work 在事务、崩溃和重试下无丢失、无重复 Agent turn/工具派发。
- 已有同步确认重启失效、异步 todo 恢复、epoch 撤销 fencing 和未知派发不重放语义完全保持。
- 代码评审、typecheck、i18n、focused tests 和仓库要求的完整回归均记录在交付记录；不提交生成输出、隐私数据或无关工作区变更。

开发交付完成不等于生产功能已经启用。交付版本必须保持 `remoteTrackSemanticContinuation` 默认关闭；缺少运行期影子数据不阻止代码完成、评审、合并或打包。

### 自动语义续接启用完成

- 只有部署含影子采集能力的版本，并在明确选择的渠道打开影子采集后，才开始计算第 12 节规定的连续窗口和实际样本量。
- 第 12 节的运行期质量、平台证据、参数与运维门槛全部满足后，才能为对应渠道开启自动语义续接或将其设为默认。历史日志可以满足已发生的平台协议分析项，不能代替新分类器的实际调用质量样本。

## 15. 代码评审阻断修复记录（2026-10-11）

针对 [代码评审报告](../review/2026-10-11-wechat-confirmation-prompt-delivery-failure-code-review.md) 中的四项 P1，本轮已按 TDD 补上跨会话 inbox 迁移、飞书 chatId 澄清解析、异步审批 Track 上下文恢复及澄清工作结算后的 Track 终态重聚合。四项修复的边界和复核证据见该报告“修复复核”节。

定向验证：5 个 Electron 测试文件、112 项测试通过；Electron/shared/renderer 类型检查及 `git diff --check` 通过。该记录不代表全仓回归、平台账号联调或自动语义续接的运行期启用门槛已完成。

## 16. 第二轮代码评审阻断修复记录（2026-10-12）

针对 [第二轮评审报告](../review/2026-10-12-wechat-confirmation-prompt-delivery-failure-code-review-v2.md) 的两项 P1，已统一路由器与 Agent 的 Turn 绑定事件 ID，并强化同身份重复绑定的幂等检查；Clarification 创建 successor 时持久继承原 Track 的来源会话，工作恢复识别 accepted 归属事件。实现细节及逐项回归见第二轮报告“阻断修复复核”。

定向验证：7 个 Electron 测试文件、288 项测试通过；Electron 类型检查及 `git diff --check` 通过。未运行全仓 `npm test`、完整构建或平台账号联调。

## 17. 第三轮代码评审阻断修复记录（2026-10-12）

针对异步审批完成续跑复用原用户消息后模型输入视图被判为 `partial` 的问题，先增加 WeChat/Feishu 双渠道回归，确认两个 invocation 对同一消息的两条 ledger 事件会产生 `partial`（RED）。随后调整视图完整性规则：消息 ID 去重只用于 provider 输入 allowlist；事件级 invocation 关联仍逐条保留。相同消息在多 invocation 下合法复用；session、角色或内容不一致仍会标为 partial，缺少 accepted message/current invocation 仍为 unavailable。

验证：Track 输入视图/过滤、Agent、WeChat 与 Feishu 路由定向测试通过；Electron 类型检查及 `git diff --check` 通过。范围和命令详见第三轮评审报告“修复复核”。
