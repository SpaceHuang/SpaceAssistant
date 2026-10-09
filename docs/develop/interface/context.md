# 会话 / 调用上下文端口（context.ts、contextIdentity.ts）

对应源码：`packages/agent-sdk/src/context.ts`、`packages/agent-sdk/src/contextIdentity.ts`。

这是会话存储重构落在 SDK 侧的新公共面（宿主侧实现与切换见 `25f8692f` / `c69b5873`，端口与登记表由 `413674a1` 新增、`430b2dab` 补全身份规则、`6d2a3f41` 冻结跨 await 的候选）：把「谁能改上下文、改成什么、谁确认提交」从循环体内联逻辑收口为一个**单一 writer 的端口 + 登记表**。

三个不变量：

1. **只有登记过的候选才能提交**：`commitReplacement` 只接受 `ContextRegistrar.registerTransformation` 产出的候选（携带不透明 evidence token），装配方无法自造。
2. **替换不得凭空造消息**：输出的每个 `ContextItem` 必须能追溯到输入项的 `sourceMessageIds`；确实新增的"检查点消息"必须带 checkpoint 证据（见「登记表校验」）。
3. **提交是能力受限的**：`ContextPort` 只暴露 `readCurrent` / `commitReplacement`；签发入口（`ContextRegistrar`、session / invocation 适配器、`commitProjection`）都在 SDK 内部面。

## 导出面

`src/index.ts` 对 `./context` **只做 type 导出**，且只导出下列 11 个符号：

```ts
export type {
  JsonValue, ContextScope, ContextItem, ContextFrame, ContextFence, ContextSnapshot,
  ContextTransformationEvidence, ContextCandidate, ContextCommitReceipt, ContextCommitResult, ContextPort
} from './context'
```

以下均为**内部面**（可从 `@spaceassistant/agent-sdk/src/context` 直读源码，但不经包入口导出，装配方不应依赖）：`ContextRegistrar`、`createContextRegistrar`、`ContextRegistrationBinding`、`ContextTransformationProof`、`ContextReplacement`、`ContextProjectionCommitter`、`createContextPortRouter`、`SessionContextCapture`、`SessionContextPersistResult`、`SessionContextAdapter`、`createSessionContextPort`、`createSessionContextAdapter`、`InvocationContextCapture`、`InvocationContextAppendResult`、`InvocationContextBinding`、`createInvocationContextPort`。

`contextIdentity.ts` 不经包入口导出任何符号（模块内 `export` 的 `surfaceItemIdentity` / `surfaceItemIdentities` 只供 SDK 内部与 `context.ts` 复用）。

> 注意副作用：`turn.ts` 的端口字段（`contextProjectionCommitter?: ContextProjectionCommitter`）与 `runHostedAgentTurn` 入参引用了内部类型。装配方若显式声明这些字段的类型，只能从包内路径直读或做结构化类型，不能从包入口 import。

## DTO

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type ContextScope =
  | Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'invocation'; sessionId: string; invocationId: string }>

type ContextItem = Readonly<{
  replayIdentity: string                 // 重放身份（stable id / 内容哈希 / 来源继承）
  sourceMessageIds: readonly string[]    // 本项由哪些源消息折叠而来；空数组 = 检查点合成项
  message: CanonicalModelMessage
  sourceData: Readonly<Record<string, JsonValue>>
}>

type ContextFrame = Readonly<{
  items: readonly ContextItem[]
  system: string
  windowId: string
  requiredUser?: Readonly<{ id: string; message: CanonicalModelMessage }>
  pendingTools: readonly CanonicalToolCall[]
}>

type ContextFence = Readonly<{ token: <不透明能力令牌> }>
type ContextSnapshot = Readonly<{ scope: ContextScope; frame: ContextFrame; fence: ContextFence }>
type ContextTransformationEvidence = Readonly<{ token: <不透明能力令牌> }>
type ContextCandidate = Readonly<{ base: ContextSnapshot; output: ContextFrame; evidence: ContextTransformationEvidence }>

type ContextCommitReceipt = Readonly<{
  operationId: string
  windowId: string
  inputFingerprint: string
  outputFingerprint: string
  historyVersion?: number
}>

type ContextCommitResult =
  | Readonly<{ status: 'committed'; snapshot: ContextSnapshot; receipt: ContextCommitReceipt }>
  | Readonly<{ status: 'stale' | 'busy' | 'no-op' | 'uncompressible' }>
  | Readonly<{ status: 'commit-uncertain'; receipt?: ContextCommitReceipt; error: Error }>
```

- `fence` / `evidence` 都是**不透明令牌**，由登记表生成并保管映射；`cloneFreeze + structuredClone` 保证被登记对象是深冻结副本（调用方持有的入参再改也不会影响已登记内容）。
- `snapshot.frame` 是"读到的当前上下文"；`candidate.output` 是"打算写入的新上下文"。

## ContextPort

```ts
interface ContextPort {
  readCurrent(scope: ContextScope): Promise<ContextSnapshot>
  commitReplacement(input: Readonly<{
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    candidate: ContextCandidate
  }>): Promise<ContextCommitResult>
}
```

`reason` 是**调用方声明**的动因，适配器不改写：turn 循环在 preflight / turn-boundary / provider 恢复三处按 `output.windowId !== base.frame.windowId` 取 `'window-transition'`，否则取 `'auto-compact'`；手工压缩入口由宿主传 `'manual-compact'`。

### 提交结果语义

| status | 含义 | 谁产生 | 调用方该做什么 |
| --- | --- | --- | --- |
| `committed` | 已落库（含宿主投影），`snapshot` 是新的当前上下文 | 适配器 | 用 `snapshot` 替换本地状态，继续 |
| `stale` | base 已过期：宿主侧指纹 / frame / 相位 / epoch 与登记时不符，或 append 撞版本冲突 | 适配器 | 丢弃候选并重读，重算替换 |
| `no-op` | 仅 invocation 适配器：输出与 base 深等价且无 `commitProjection` | invocation 适配器 | 视作成功，不写事件 |
| `uncompressible` | 宿主声明压缩不可行（append 返回 `uncompressible`） | 宿主 append 钩子 | 保持原上下文继续（必要时走预算拒绝） |
| `commit-uncertain` | 写入结果未知（提交抛错，或落库成功但 `commitProjection` 失败，后者带 `receipt`） | 适配器 | **不得**当作失败重放；按 `interrupted` 语义处置与对账 |
| `busy` | 保留值：并发提交互斥由宿主 `persist` 实现表达 | 宿主适配器 | 退避重试或降级 |

`commit-uncertain` 是这层唯一的"不确定"出口；调用方（turn 循环）把它转成 `AgentTurnBoundaryProjectionError`，从而去重终态结算。

## 登记表（ContextRegistrar）

```ts
type ContextRegistrationBinding = Readonly<
  | { kind: 'session'; surfaceFingerprint: string }
  | { kind: 'invocation'; phase: 'preflight' | 'boundary'; epoch: number; expectedHistoryVersion: number }
>

type ContextTransformationProof = Readonly<{
  historyPayload: Readonly<Record<string, JsonValue>>
  sourceBindings: readonly Readonly<{ outputIdentity: string; inputIdentities: readonly string[] }>[]
  checkpoint?: Readonly<Record<string, JsonValue>>
  shadowedRanges: readonly Readonly<{ start: string; end: string }>[]
  commitProjection?: () => void | Promise<void>
}>

interface ContextRegistrar {
  captureFrame(input: { scope; frame; binding }): ContextSnapshot
  registerTransformation(input: { base; output; proof }): ContextCandidate
  readBinding(snapshot): ContextRegistrationBinding
  resolveCandidate(candidate): { candidate; proof }     // 反查登记内容（校验身份未被篡改）
  readEvidence(candidate): ContextTransformationProof
  release(candidate): void                              // 释放候选 + 其 base 快照
  releaseSnapshot(snapshot): void
}

function createContextRegistrar(): ContextRegistrar
```

`captureFrame` 校验：`scope.sessionId` 非空；invocation scope 还需 `invocationId` 非空；session 绑定要求 `surfaceFingerprint` 非空；invocation 绑定要求 `epoch` / `expectedHistoryVersion` 为非负整数。

`registerTransformation` 的强制规则（违规抛裸 `Error`，`message` 即大写错误码）：

- `base` 必须是登记表内的快照且深等价（`CONTEXT_BASE_NOT_REGISTERED`）。
- `historyPayload` / `sourceBindings` / `shadowedRanges`（以及可选 `checkpoint`）必须是**规范 JSON**：plain object / array / string / 有限 number / boolean / null；不得有自定义原型、循环引用、symbol（`CONTEXT_PROOF_NOT_JSON`）。
- `scope` 与 base 一致（`CONTEXT_SCOPE_MISMATCH`）。
- `requiredUser`、`pendingTools` 必须与 base **深等价**——替换不得改动必需 user 消息与待派发工具（`CONTEXT_REQUIRED_USER_MISMATCH` / `CONTEXT_PENDING_TOOLS_MISMATCH`）。
- base 与 output 各自的 `replayIdentity` 不得重复（`CONTEXT_BASE_IDENTITY_DUPLICATE` / `CONTEXT_OUTPUT_IDENTITY_DUPLICATE`）；`sourceBindings` 的 `outputIdentity` 不得重复（`CONTEXT_SOURCE_BINDING_MISMATCH`）。
- 输出项逐项校验来源：
  - `sourceMessageIds` 为空的项，要么是"零来源输入项的原样保留"（message 深等价且该输入项本身 `sourceMessageIds` 为空），要么必须带 checkpoint 证据——`proof.checkpoint.identity ?? proof.checkpoint.replayIdentity` 等于该项 `replayIdentity`（`CONTEXT_CHECKPOINT_EVIDENCE_REQUIRED` / `CONTEXT_CHECKPOINT_EVIDENCE_MISMATCH`）；checkpoint 消息本体取 `proof.checkpoint.checkpointMessage ?? proof.historyPayload.sessionLedger.summary.candidate.checkpointMessage`，必须与该输出项 message 深等价。
  - `sourceMessageIds` 非空的项，必须由 `sourceBindings` 覆盖，且绑定指向的输入项必须存在；其 `sourceMessageIds` 拼合结果必须与输出项**逐序一致**（`CONTEXT_SOURCE_BINDING_MISMATCH`）。
- 所有 `sourceBindings.outputIdentity` 必须指向输出集合内存在的项。

## 适配器

### createContextPortRouter（会话域路由）

```ts
function createContextPortRouter(): Readonly<{
  port: ContextPort
  bind(scope: ContextScope, port: ContextPort): () => void
}>
```

按 `scope` 把 `readCurrent` / `commitReplacement` 路由到已绑定端口（key：`session:<sessionId>` / `invocation:<sessionId>:<invocationId>`）；未绑定抛 `CONTEXT_SCOPE_NOT_BOUND`，重复绑定抛 `CONTEXT_SCOPE_ALREADY_BOUND`；`bind` 返回值是解绑函数（只会解绑自己那次绑定）。

### createSessionContextPort / createSessionContextAdapter（会话级）

```ts
type SessionContextCapture = Readonly<{ frame: ContextFrame; surfaceFingerprint: string }>
type SessionContextPersistResult =
  | Readonly<{ status: 'committed'; historyVersion?: number }>
  | Readonly<{ status: 'stale' | 'busy' | 'uncompressible' }>

function createSessionContextPort(input: {
  scope: Extract<ContextScope, { kind: 'session' }>
  registrar: ContextRegistrar
  capture(): Promise<SessionContextCapture>
  persist(input: {
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    expectedSurfaceFingerprint: string
    inputFingerprint: string
    outputFingerprint: string
    output: ContextFrame
    historyPayload: Readonly<Record<string, JsonValue>>
  }): Promise<SessionContextPersistResult>
}): ContextPort

function createSessionContextAdapter(input: Parameters<typeof createSessionContextPort>[0]): SessionContextAdapter
// SessionContextAdapter = { port: ContextPort; registerTransformation(input): ContextCandidate }
```

- `readCurrent`：scope 必须与本端口声明的 session scope 深等价（否则 `CONTEXT_SCOPE_MISMATCH`）；`capture()` 后登记为 session 快照，绑定 `surfaceFingerprint`。
- `commitReplacement`：`operationId` 必须非空（`CONTEXT_OPERATION_ID_REQUIRED`）→ 反查候选 → 绑定必须是 session（`CONTEXT_BINDING_MISMATCH`）→ 重新 `capture()`；**指纹或 frame 任一变化即 `stale`**（并释放候选）→ 计算 `inputFingerprint`（= base 绑定里的 surfaceFingerprint）与 `outputFingerprint`（= `sha256(JSON.stringify(output.items.map(i => i.message)))`）→ 调宿主 `persist`。
- `persist` 抛错 → `commit-uncertain`；返回非 `committed` → 直接转该状态（宿主可自行判 `stale` / `busy` / `uncompressible`）；返回 `committed` → 先执行 `evidence.commitProjection?.()`，成功则把输出帧登记为新快照（`surfaceFingerprint = outputFingerprint`）并返回 `committed`，失败则 `commit-uncertain`（带 `receipt`）。
- 摘要：**宿主 `persist` 负责真源事务，`commitProjection` 负责投影（UI / 索引）；两者顺序固定为事务先、投影后**。

### createInvocationContextPort（调用级）

```ts
interface InvocationContextBinding {
  readonly scope: Extract<ContextScope, { kind: 'invocation' }>
  capture(): Promise<InvocationContextCapture>   // { frame, phase, epoch, expectedHistoryVersion }
  appendReplacement(input: { epoch: number; expectedHistoryVersion: number; payload: Readonly<Record<string, unknown>> }): Promise<InvocationContextAppendResult>
  applyCommitted(input: { frame: ContextFrame; epoch: number; historyVersion: number }): void
}

function createInvocationContextPort(input: { binding: InvocationContextBinding; registrar: ContextRegistrar }): ContextPort
```

- `readCurrent`：scope 必须深等价；`capture()` 登记为 `{ kind: 'invocation', phase, epoch, expectedHistoryVersion }` 绑定。
- `commitReplacement`：`operationId` 非空 → 反查候选 → 绑定必须是 invocation → 重新 `capture()`，**phase / epoch / expectedHistoryVersion / frame 任一变化即 `stale`** → 输出与 base 深等价且无 `commitProjection` → `no-op`。
- 载荷拼装：保留键 `messages`、`inputFingerprint`、`outputFingerprint`、`requiredUserMessage`（仅当输出有 `requiredUser`）由 SDK 覆盖写；若 `proof.historyPayload` 里已有同键但值不同，直接抛 `CONTEXT_HISTORY_PAYLOAD_CONFLICT:<key>`（防止宿主证据与 SDK 事实互相覆盖）。
- `appendReplacement` 结果判定：抛 `version-conflict` 或 `CONTEXT_EPOCH_STALE` → `stale`；抛 `TransactionCommitUnknownError`（或 `code === 'commit-uncertain'`）→ `commit-uncertain`；其他错误原样上抛；返回 `{ status: 'uncompressible' }` → `uncompressible`；返回其他带 `status` 的对象 → 抛 `CONTEXT_APPEND_RESULT_INVALID`。
- 成功路径：`receipt.historyVersion = appended.version` → `commitProjection` → 登记新快照（`epoch + 1`、`expectedHistoryVersion = 新版本`）→ `binding.applyCommitted(...)` → `committed`；`commitProjection` 抛错则 `commit-uncertain`（带 `receipt`）。

## contextIdentity（重放身份规则）

`contextIdentity.ts` 的职责是给"没有显式 id 的消息"产出一个**内容等价即相等**的重放身份，避免同一条消息在多次重建 frame 时换身份：

- `surfaceItemIdentity(value, fallbackIndex)`：message 形态（`role` + `content`）→ 先做展示面归一 → JSON 串 → `hashIdentity`（FNV-1a 32 位）→ `surface-<8 位 hex>`。有字符串 `id` 的项直接用 `id`；否则回退 `index:<n>` 的哈希。
- `surfaceItemIdentities(values)`：同内容重复出现时，第 2 次起追加 `#1`、`#2` 后缀。
- 展示面归一（assistant / user）：
  - assistant 文本 `trim()`，空串归一为单个空格；
  - assistant 同时含 `tool_use` 时只保留 text 块拼合，不再 trim 成空格；
  - user 消息含 `tool_result` 块时剔除这些块，剩余若全为 text 则按 assistant 文本规则归一。
- 导出 `type ContextIdentityMessage = CanonicalModelMessage` 仅作类型对齐断言。

## 与 turn 循环的接线

存活路径只有三条（见 [turn-loop.md](./turn-loop.md)「循环阶段概览」）：

| 场景 | 触发 | 提交途径 |
| --- | --- | --- |
| preflight 恢复 | 请求投影超预算或需要裁剪 | `planContextReplacement({ phase: 'preflight' })` → invocation 适配器 → `transcript-compacted` |
| turn boundary | 已接受响应、工具派发之前的窗口切换 / 压缩 | `planContextReplacement({ phase: 'turn-boundary' })` → invocation 适配器 |
| provider 恢复 | `recoverProviderAttempt` 返回替换后的 messages | 同一 invocation 适配器（`recordTranscriptCompaction !== false` 时） |

`turn.ts` 另导出 `contextFrameFromMessages(messages, windowId, requiredUserMessage?, pendingTools?, base?, checkpoint?)`——**标注 `@internal`，只供契约回归测试**，用它把 canonical 消息数组重建为 `ContextFrame`（保留 `replayIdentity` 与 `sourceMessageIds` 继承，`base` 提供身份来源，`checkpoint` 给出检查点项的合成身份）。

## 错误码

`context.ts` 不定义错误类，全部抛裸 `Error`，`message` 即下列稳定码（装配方与宿主适配器按字符串判定）：

| 码 | 触发 |
| --- | --- |
| `CONTEXT_SCOPE_NOT_BOUND` / `CONTEXT_SCOPE_ALREADY_BOUND` | 路由器未绑定 / 重复绑定 |
| `CONTEXT_SCOPE_REQUIRED` | `captureFrame` 的 scope 缺 id |
| `CONTEXT_BINDING_MISMATCH` | 绑定类型与 scope 类型不符 |
| `CONTEXT_SCOPE_MISMATCH` | 请求 scope 与端口 / base 的 scope 不符 |
| `CONTEXT_BASE_NOT_REGISTERED` | base 快照未被登记（或已被 release） |
| `CONTEXT_EVIDENCE_NOT_REGISTERED` | evidence 未登记 |
| `CONTEXT_EVIDENCE_CANDIDATE_MISMATCH` | 候选的 base / output 与登记内容不符（被篡改） |
| `CONTEXT_PROOF_NOT_JSON` | proof 不是规范 JSON |
| `CONTEXT_BASE_IDENTITY_DUPLICATE` / `CONTEXT_OUTPUT_IDENTITY_DUPLICATE` | 身份重复 |
| `CONTEXT_SOURCE_BINDING_MISMATCH` | 来源绑定缺失 / 越界 / 顺序不符 |
| `CONTEXT_REQUIRED_USER_MISMATCH` / `CONTEXT_PENDING_TOOLS_MISMATCH` | 替换改动了必需 user 消息 / 待派发工具 |
| `CONTEXT_CHECKPOINT_EVIDENCE_REQUIRED` / `CONTEXT_CHECKPOINT_EVIDENCE_MISMATCH` | 合成项缺 checkpoint 证据 / 证据与消息不符 |
| `CONTEXT_OPERATION_ID_REQUIRED` | `commitReplacement` 缺 operationId |
| `CONTEXT_EPOCH_STALE` | append 前复检发现 epoch 漂移（适配器转 `stale`） |
| `CONTEXT_HISTORY_PAYLOAD_CONFLICT:<key>` | 宿主证据与 SDK 保留字段冲突 |
| `CONTEXT_APPEND_RESULT_INVALID` | append 钩子返回值形态非法 |
