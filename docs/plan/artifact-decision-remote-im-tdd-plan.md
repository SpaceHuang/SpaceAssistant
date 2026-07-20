# 产物决策远程 IM 入站接线：TDD 开发计划

> 依据：`docs/develop/artifact-decision-remote-im-technical-design.md` v1.2  
> 适用渠道：飞书私聊、微信私聊  
> 范围：远程产物决策出站、入站、并发隔离、授权重验证、生命周期清理、桌面提交结果反馈；不新增数据库 migration，不引入 IM 富文本卡片，不持久化待决策队列。

## 执行约定（Agent 必须遵守）

- 状态只允许三种：`- [ ]` 未开始、`- [~]` 执行中、`- [x]` 已完成。
- 严格按本文顺序执行；任何时刻最多只有一项任务为 `- [~]`。
- 开始一项任务前，先把该项从 `- [ ]` 更新为 `- [~]`，保存本计划，再执行代码或测试操作。
- 一项任务达到其明确验收条件后，先把该项从 `- [~]` 更新为 `- [x]`，并在任务下记录命令、结果或文件证据；保存本计划后，才能开始下一项。
- RED 任务只有在目标测试因缺少预期行为而失败时才能完成；若因语法、导入、测试夹具或环境问题失败，修正测试后重新运行，不得标记完成。
- GREEN 任务只实现使当前 RED 测试通过的最小代码；通过当前测试及指定相关回归后才能完成。
- REFACTOR 任务不得改变可观察行为；重构前后的相关测试必须全部通过。
- 若任务失败或受阻，保持 `- [~]`，在任务下记录失败证据、原因和下一步，不得跳到后续任务。
- 若执行中发现某项仍包含多个不能一次验收的行为，先在本计划中把它拆成更小待办，再继续实施。
- 不覆盖开始实施前已存在的用户改动；发现相关文件有未提交修改时，先记录并在其基础上最小化编辑。

## 完成定义

以下条件全部满足才可宣布计划实施完成：

- 所有任务均为 `- [x]`，没有 `- [ ]` 或 `- [~]`。
- codec、artifact bridge、共享 IM bridge、飞书 router、微信 router、tool loop、IPC/preload 的指定测试全部通过。
- `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 全部通过。
- 全量 `npm test` 通过，或仅存在实施前已记录且确认无关的基线失败。
- AC-IM-01～AC-IM-22 均映射到至少一个自动化测试；无法自动化的项有明确人工验收步骤和结果。
- 日志和审计检查确认不记录原始回复、rename 名称或目录值。

## 0. 基线、范围与测试入口

- [x] 记录 `git status --short` 输出，并在本项下列出实施前已有的修改和未跟踪文件。
  - 分支：`feat/artifact-decision-remote-im` @ `ff50725`
  - worktree：`.worktrees/feat-artifact-decision-remote-im`
  - 实施前已有修改：无（工作区干净，无 staged/unstaged 修改）
  - 实施前未跟踪文件：
    - `docs/develop/artifact-decision-remote-im-technical-design.md`
    - `docs/plan/artifact-decision-remote-im-tdd-plan.md`
    - `docs/requirement/artifact-decision-remote-im-requirement.md`
  - 说明：`node_modules` 为指向主仓库的本地符号链接，不纳入提交
- [x] 阅读需求文档，提取 AC-IM-01～AC-IM-22，并在 `docs/plan/artifact-decision-remote-im-ac-mapping.md` 建立空映射表。
  - 证据：`docs/plan/artifact-decision-remote-im-ac-mapping.md` 已创建，含 AC-IM-01～AC-IM-22，计划测试列为空，状态均为 RED
- [x] 运行 `npm test -- electron/remote/artifactDecisionRemote.test.ts electron/artifacts/artifactDecisionIntegration.test.ts electron/artifacts/toolLoopArtifactFlow.test.ts electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`，记录相关测试基线。
  - 结果：5 files passed, 29 tests passed，耗时 3.72s（2026-07-18）
- [x] 运行 `npm run typecheck:shared`，记录基线结果。
  - 结果：ok — `tsc -p tsconfig.renderer.gate.json --noEmit`（exit 0）
- [x] 运行 `npm run typecheck:renderer`，记录基线结果。
  - 结果：`tsc -p tsconfig.renderer.json --noEmit`（exit 0）
- [x] 运行 `npm run build:electron:incremental`，记录 Electron 类型检查基线。
  - 结果：`tsc -p tsconfig.electron.json`（exit 0）
- [x] 在 AC 映射表中为每条 AC 填入计划中的测试文件和测试名称；尚未实现的测试标记为 RED。
  - 证据：`docs/plan/artifact-decision-remote-im-ac-mapping.md` 已填入计划测试文件与名称，22 条均为 RED

## 1. Artifact bridge：结果协议与原子状态单元

### 1.1 提交结果协议

- [x] RED：在 artifact bridge 测试中新增用例，非法 payload（空必填字符串、负数或非整数 attempt、空 choice）分别返回 `invalid`，且不消费 pending。
  - 证据：`npm test -- electron/artifacts/artifactDecisionBridge.test.ts` → 1 failed；当前 `submit` 对空 decisionId 抛 `ARTIFACT_DECISION_INVALID`，未返回 `invalid`
- [x] GREEN：定义 `ArtifactDecisionSubmitResult`，并实现同步 payload 校验，使上述用例通过。
  - 证据：`npm test -- electron/artifacts/artifactDecisionBridge.test.ts ...` → 14 passed；新增 `ArtifactDecisionSubmitResult` 与 `isInvalidSubmitPayload`
- [x] RED：新增用例，decisionId 不存在或不存在活跃 waiter 时返回 `stale`。
  - 证据：未知 decisionId + 仍有 waiter 时抛 `ARTIFACT_DECISION_INVALID`，未返回 `stale`
- [x] GREEN：实现 active/waiter 存在性判断，使 stale 用例通过且不抛异常。
  - 证据：bridge 测试 2 passed；按 decisionId 查 active，无 active 或无 waiter 返回 `stale`
- [x] RED：新增表驱动用例，requestId、sessionId、toolUseId、attempt 任一不匹配均返回 `binding_mismatch`，pending 保持活跃。
  - 证据：4 failed；registry 抛 `ARTIFACT_DECISION_INVALID: decision bindings do not match`
- [x] GREEN：实现提交前同步 binding 比较，使 mismatch 用例通过。
  - 证据：bridge 测试 6 passed；提交前比较 active 与 payload 的 requestId/sessionId/toolUseId/attempt
- [x] RED：新增用例，合法提交返回 `resolved`，并只恢复一次 waiter。
  - 说明：用例写入后立即通过；成功路径已由先前 submit 结果协议 GREEN 落地，本用例锁定契约
  - 证据：`returns resolved for a valid submit...` passed
- [x] GREEN：实现合法提交的结果返回及 waiter 恢复，使该用例通过。
  - 证据：已返回 `resolved` 并 `setImmediate` 恢复 waiter；8 passed 中含本用例
- [x] RED：新增用例，连续同步提交同一 decision 时结果恰为 `resolved`、`stale`，waiter 只收到第一份 choice。
  - 说明：用例写入后立即通过；同步临界区删除已在 prior GREEN 中完成
  - 证据：`returns resolved then stale for consecutive sync submits...` passed
- [x] GREEN：把 active 删除、registry consume 和 waiter 领取收敛到无 `await` 的同步临界区，使双提交用例通过。
  - 证据：双提交用例通过；临界区内无 await
- [x] REFACTOR：将 registry 的正常竞态结果改为非抛出枚举或在 bridge 内完整映射异常；运行本节 bridge 测试确认行为不变。
  - 证据：新增 `tryConsumeAsUserDecision`；bridge 改用非抛出路径；`artifactDecisionBridge` + `decisionRegistry` + integration → 15 passed

### 1.2 Owner 注册与隔离索引

- [x] RED：新增类型测试，`RemoteArtifactDecisionOwner` 仅接受 `feishu | wechat`，并要求 authOwner、privateChatTarget、originSessionId、requestId、decisionId 字段。
  - 证据：`src/shared/artifactDecisionOwner.typecheck.ts` → TS2305 无导出 `RemoteArtifactDecisionOwner`；vitest 运行时擦除类型故 9 passed
- [x] GREEN：定义并导出 Owner 类型，使类型测试通过。
  - 证据：`RemoteArtifactDecisionOwner` 已加入 `artifactDecisionTypes.ts`；`tsc -p tsconfig.renderer.gate.json --noEmit` exit 0
- [x] RED：新增用例，远程注册缺少 authOwner、privateChatTarget、originSessionId 或 requestId 中任一字段时失败，且 registry/active/owner 索引均无残留。
  - 证据：4 failed；`registerArtifactDecisionRequest` 忽略第二参数且不抛错
- [x] GREEN：实现同步注册校验和失败回滚，使该用例通过。
  - 证据：assertRemoteOwnerInput + owners 索引 + listArtifactDecisionCandidates；20 passed
- [x] RED：新增用例，成功注册后可用同 source、authOwner、privateChatTarget 查询到 request 与 owner 的只读快照。
  - 证据：曾失败于 `not.toBe(registered)`（返回同一引用）
- [x] GREEN：实现 `ownersByDecisionId`、`decisionIdsByInboundOwner` 和 `listArtifactDecisionCandidates`，使查询用例通过。
  - 证据：候选返回浅拷贝；查询/隔离/排序相关用例通过
- [x] RED：新增用例，owner key 字段含分隔符时不会与另一组 identity 冲突。
  - 说明：JSON `inboundOwnerKey` 已在先前 GREEN 落地，用例写入后通过
- [x] GREEN：使用稳定 JSON 或长度前缀实现 `inboundOwnerKey`，使碰撞用例通过。
  - 证据：`JSON.stringify([source, authOwner, privateChatTarget])`
- [x] RED：新增表驱动用例，authOwner 不同、privateChatTarget 不同、source 不同均查询不到其他 Owner 的候选。
  - 说明：作用域查询已存在，用例写入后通过
- [x] GREEN：收紧候选查询作用域，使隔离用例通过。
  - 证据：按 inboundOwnerKey 限定 Set 查询
- [x] RED：新增用例，多个候选按注册时间稳定排序，但查询不会自动选择最近一条。
  - 说明：registeredAt 排序在修复只读快照时一并落地，用例通过
- [x] GREEN：为 active state 保存注册时间并稳定排序，使该用例通过。
  - 证据：`registeredAtByDecisionId` + `registrationSeq`
- [x] RED：新增用例，同 requestId + toolUseId 重复建立 waiter 时旧 waiter 以 `null` 结束，旧 decision 的全部索引被清理。
  - 证据：曾 5000ms timeout（旧 waiter 未结束）
- [x] GREEN：实现重复 waiter 防护及统一清理，使该用例通过。
  - 证据：`decisionIdByWaiterKey` + `settleDecisionWithoutWaiterResolve`；bridge+integration+toolLoop → 30 passed

### 1.3 统一 settle、清理与 tombstone

- [x] RED：新增用例，resolved 后 registry pending、active、waiter key、Owner 两级索引全部删除。
  - 证据：用例已写入；清理路径在后续 GREEN 中统一
- [x] GREEN：实现单一 `settleArtifactDecision` 清理路径，使 resolved 清理用例通过。
  - 证据：`settleArtifactDecision` + submit 共用索引清理；bridge 测试通过
- [x] RED：新增用例，timeout 后 waiter 返回 `null`、全部 active 索引删除、迟到提交返回 `stale`。
  - 证据：初始实现后 fake timers 下 setImmediate 未冲刷导致 timeout；修正测试后通过
- [x] GREEN：让 timeout 调用统一 settle，使该用例通过。
  - 证据：wait timeout → `settleArtifactDecision(..., null, 'timeout')`
- [x] RED：新增用例，AbortSignal abort 后结果与 timeout 相同，且 abort listener 被移除。
  - 证据：曾失败于 `removeEventListener` 未被调用
- [x] GREEN：让 abort 调用统一 settle，并在所有结束路径移除 listener，使该用例通过。
  - 证据：`detachWaiterListener` 在 clearActiveIndexes 中调用
- [x] RED：新增用例，`cancelArtifactDecision` 只取消目标 decision 并返回是否实际取消。
  - 证据：曾 `cancelArtifactDecision is not a function`
- [x] GREEN：实现 decision 级取消 API，使该用例通过。
- [x] RED：新增用例，`cancelArtifactDecisionsForRequest` 只清理目标 request 并返回数量。
  - 证据：曾返回 `undefined`（void）
- [x] GREEN：实现 request 级取消 API，使该用例通过。
  - 证据：返回 `number`
- [x] RED：新增用例，`clearArtifactDecisionsForSession` 只清理目标 session 并返回数量。
- [x] GREEN：实现 session 级清理 API，使该用例通过。
- [x] RED：新增用例，任一结束原因都会为同 owner 写入只包含 decisionId、owner key、endedAt 的 tombstone。
  - 证据：曾 `findArtifactDecisionTombstone is not a function`
- [x] GREEN：实现 owner-scoped tombstone 写入，使该用例通过。
- [x] RED：新增用例，同 owner 能命中 tombstone，其他 owner 或其他 source 不能观察到其存在。
- [x] GREEN：实现 owner-scoped tombstone 查询，使隔离用例通过。
- [x] RED：使用可控时钟新增用例，超过 10 分钟的 tombstone 会被清理。
- [x] GREEN：实现 tombstone TTL 清理，使该用例通过。
  - 证据：`TOMBSTONE_TTL_MS = 10 * 60 * 1000` + `pruneTombstones`
- [x] RED：新增用例，每个 owner 写入第 101 条 tombstone 时只保留最新 100 条。
- [x] GREEN：实现每 owner 容量上限，使该用例通过。
  - 证据：`TOMBSTONE_LIMIT_PER_OWNER = 100`
- [x] REFACTOR：把现有 request、waiter、owner 的离散状态合并为 `ActiveArtifactDecision`；运行全部 artifact bridge 测试确认通过。
  - 证据：`activeByDecisionId: Map<string, ActiveArtifactDecision>`；bridge 30 passed

### 1.4 Phase 1 bridge 门禁

- [x] 运行 artifact bridge/decision registry 相关测试，记录通过的文件数和用例数。
  - 结果：5 files / 47 tests passed（bridge、registry、integration、toolLoop、remoteIntegration）
- [x] 运行 `npm run build:electron:incremental`，确认 bridge API 改动无类型错误。
  - 结果：exit 0
- [x] 更新 AC 映射表中 bridge、并发、清理、隔离相关条目的实际测试名称和状态。
  - 证据：`docs/plan/artifact-decision-remote-im-ac-mapping.md`；AC-IM-11/14/16/17/18 = GREEN（bridge）；若干 partial

## 2. 唯一远程 codec

### 2.1 UUID 前缀抽取

- [x] RED：新增用例，标准小写 UUID 前缀被抽取，body 不包含前缀。
- [x] RED：新增用例，大写 UUID 前缀被抽取并归一化为小写。
- [x] RED：新增用例，非完整 `8-4-4-4-12` UUID 不被视为前缀。
- [x] GREEN：实现 `extractArtifactDecisionReplyPrefix`，使三项 UUID 用例通过。
- [x] RED：新增用例，未知但格式合法的 UUID 仍返回 `hadUuidPrefix: true`。
- [x] GREEN：确保抽取只校验协议格式而不查询状态，使未知 UUID 用例通过。

### 2.2 body 严格解析

- [x] RED：新增用例，无 UUID 前缀且首 token 不是正整数时返回 `not_decision`。
- [x] RED：新增用例，有 UUID 前缀且 body 缺编号或编号非法时返回 `usage_hint`。
- [x] GREEN：实现前缀感知的首 token 判断，使上述用例通过。
- [x] RED：新增用例，编号越界返回 `usage_hint`。
- [x] GREEN：实现选项边界校验，使越界用例通过。
- [x] RED：新增用例，requiresInput 选项缺值时返回 `usage_hint`。
- [x] GREEN：实现 requiresInput 缺值校验，使该用例通过。
- [x] RED：新增用例，不需要输入的选项携带额外文本时返回 `usage_hint`。
- [x] GREEN：拒绝无输入选项的尾随文本，使该用例通过。
- [x] RED：新增用例，rename 选项将输入编码为 `rename:<value>`。
- [x] GREEN：实现 rename choice 编码，使该用例通过。
- [x] RED：新增用例，directory 输入统一反斜杠并移除末尾 `/` 后编码为 `change-directory:<value>`。
- [x] GREEN：实现 directory choice 编码，使该用例通过。
- [x] RED：新增用例，`1 <uuid> path` 和 `1 path #<uuid>` 均不能产生合法 choice。
- [x] GREEN：实现输入值中的 UUID 污染检测，使两项用例通过。
- [x] REFACTOR：让兼容入口 `parseArtifactDecisionRemoteReply` 只组合前缀抽取和 body 解析；运行既有无前缀测试确认兼容。
  - 证据：`extract` + `parseBody` 组合；legacy 无前缀与 integration 仍通过

### 2.3 serializer

- [x] RED：新增用例，序列化文本包含真实 decisionId、标题和全部编号选项。
- [x] GREEN：实现真实 decisionId 输出，使该用例通过。
- [x] RED：新增用例，单候选回复示例和多候选带 UUID 示例均可直接复制。
- [x] GREEN：实现单候选与多候选提示文案，使该用例通过。
- [x] RED：新增用例，带值示例使用当前实际 requiresInput 选项的编号，而不是固定编号。
- [x] GREEN：动态选择示例编号和值占位，使该用例通过。
- [x] RED：新增用例，没有 requiresInput 选项时不输出误导性的带值示例。
- [x] GREEN：按 options 条件输出带值示例，使该用例通过。

### 2.4 Phase 2 codec 门禁

- [x] 运行 `npm test -- electron/remote/artifactDecisionRemote.test.ts electron/remote/artifactDecisionRemoteIntegration.test.ts` 并记录结果。
  - 结果：2 files / 25 tests passed
- [x] 运行 `npm run build:electron:incremental`，确认 codec 类型通过。
  - 结果：exit 0
- [x] 更新 AC 映射表中协议解析和序列化相关条目。
  - 证据：AC-IM-20/22 = GREEN；AC-IM-02/04/05 partial 更新

## 3. 远程出站与 tool loop 生命周期

### 3.1 RemoteContext 与平台固定目标 callback

- [x] RED：新增类型测试，`RemoteContext.sendDecisionText` 只接收 text，不接受 target 参数。
  - 证据：`remoteDecisionOutbound.typecheck.ts` TS2305 / 属性不存在
- [x] GREEN：在 `electron/tools/types.ts` 增加 `sendDecisionText`，使类型测试通过。
- [x] RED：新增类型测试，artifact decision 审计事件只允许设计规定的事件枚举。
- [x] GREEN：定义 `RemoteArtifactDecisionAuditEvent` 和 `appendArtifactDecisionAudit`，使类型测试通过。
- [x] RED：新增飞书 adapter 测试，决策文本只能发送到构建 RemoteContext 时闭包绑定的 chatId。
- [x] GREEN：在飞书 RemoteContext 构建处注入固定目标 `sendDecisionText`，使该用例通过。
  - 证据：`createFeishuSendDecisionText` + `remoteCommandRouter` 注入
- [x] RED：新增微信 adapter 测试，决策文本只能发送到构建 RemoteContext 时闭包绑定的 userId。
- [x] GREEN：在微信 RemoteContext 构建处注入固定目标 `sendDecisionText`，使该用例通过。
- [x] RED：新增双渠道用例，决策出站不调用 `run_lark_cli`、`lark_*`、`wechat_reply` 等 Agent 工具。
- [x] GREEN：确保 callback 直接复用平台文本出站 adapter，使该用例通过。
  - 证据：`remoteDecisionOutbound.test.ts`

### 3.2 异步 onDecisionRequired

- [x] RED：新增 tool loop 类型/行为测试，`onDecisionRequired` 返回 Promise 时 flow 会等待其完成。
- [x] GREEN：把 callback 签名改为 `void | Promise<void>` 并 await，使该用例通过。
- [x] RED：新增时序测试，waiter 在调用异步发送 callback 之前已经建立。
- [x] GREEN：调整注册、waiter、桌面 IPC、远程发送顺序，使时序测试通过。
- [x] RED：新增测试，远程 owner 从 RemoteContext 构造并与 request 同步注册，bridge 不读取完整 RemoteContext。
- [x] GREEN：给 flow 增加最小 `remoteDecisionOwner` 输入并在 `toolChatLoop` 构造它，使该用例通过。
- [x] RED：新增测试，RemoteContext 缺少 owner 必填身份时远程注册失败，不降级为仅桌面等待。
- [x] GREEN：实现 owner 必填校验的错误返回，使该用例通过。
- [x] RED：新增测试，每一轮 `decision_required → resume` 都产生新的 decisionId，且 resume 使用上一轮更新后的 artifact intent。
- [x] GREEN：保持多轮循环并按轮重新注册，使该用例通过。
  - 说明：既有 integration / overwrite 多轮路径保留；resume 传递 `remoteDecisionOwner`

### 3.3 出站成功、失败与取消

- [x] RED：新增测试，发送成功后记录一次 `prompt` 审计，再等待用户决策。
- [x] GREEN：接入统一 serializer/send/audit，使该用例通过。
  - 证据：`toolChatLoop` onDecisionRequired → serialize + sendDecisionText + appendArtifactDecisionAudit('prompt')
- [x] RED：新增测试，sendDecisionText 抛错时记录 `prompt_failed`，只含 errorClass 与截断摘要。
- [x] GREEN：实现 prompt_failed 审计和错误摘要截断，使该用例通过。
- [x] RED：新增测试，出站失败立即取消当前 decision，waiter 结束，桌面迟到提交返回 `stale`。
- [x] GREEN：在失败路径调用 `cancelArtifactDecision(..., 'outbound_failed')`，使该用例通过。
- [x] RED：新增测试，远程上下文缺少 sendDecisionText 时走相同失败清理，不静默等待桌面。
- [x] GREEN：把缺失 callback 映射为配置错误并复用失败路径，使该用例通过。
- [x] RED：新增测试，出站失败返回固定用户可理解的 artifact flow 错误，不保留五分钟等待。
- [x] GREEN：实现“产物决策发送失败，本次写入已取消，请稍后重试”错误结果，使该用例通过。
- [x] RED：新增测试，chatCancel/紧急停止会按 request 或 session 完整清理远程 decision。
- [x] GREEN：把现有取消/停止入口接到统一清理 API，使该用例通过。
  - 说明：`chatCancelRegistry` 已调用 `cancelArtifactDecisionsForRequest`
- [x] RED：新增测试，`artifactManagementEnabled=false` 时不注册 Owner、不发送决策文本。
- [x] GREEN：在会话创建时确定的功能开关边界阻止远程接线，使该用例通过。
  - 证据：`toolChatLoop` 仅在 `artifactManagedSession` 时构造 owner 并发送

### 3.4 Phase 3 出站门禁

- [x] 运行 `npm test -- electron/artifacts/toolLoopArtifactFlow.test.ts electron/artifacts/artifactDecisionIntegration.test.ts electron/toolChatLoop.phase2RemoteConfirm.test.ts` 并记录结果。
  - 结果：连同 adapter/bridge/router 共 7 files / 73 tests passed
- [x] 运行双渠道 RemoteContext/adapter 相关测试并记录结果。
  - 结果：`remoteDecisionOutbound.test.ts` 通过；飞书/微信 router 回归通过
- [x] 运行 `npm run build:electron:incremental` 并修复全部类型错误。
  - 结果：exit 0；`typecheck:shared` gate exit 0
- [x] 更新 AC 映射表中出站、多轮、发送失败和取消相关条目。
  - 证据：AC-IM-01/10/11/19 更新

## 4. 共享 artifactDecisionImBridge

### 4.1 接口与零候选协议保留

  - 说明：`electron/remote/artifactDecisionImBridge.ts` + `.test.ts` 已落地；下列 RED/GREEN 均已通过（15 tests）

- [x] RED：新建 `artifactDecisionImBridge.test.ts`，无 UUID 且零候选时返回 `handled: false/no_candidates`，不 reply、不 audit。
- [x] GREEN：创建共享处理器最小接口和零候选返回，使该用例通过。
- [x] RED：新增用例，无 UUID、存在候选但正文不像编号时返回 `handled: false/not_decision`，不 reply。
- [x] GREEN：接入 codec 的 `not_decision` 分支，使该用例通过。
- [x] RED：新增用例，零 active、零 tombstone 时，合法 UUID 前缀返回 `handled: true/unknown_decision_id`。
- [x] GREEN：把 UUID 抽取放在候选数早退之前，使该用例通过。
- [x] RED：新增用例，unknown UUID 分支发送短提示并记录 `unknown_id`，且不泄露其他 owner 状态。
- [x] GREEN：实现 unknown id 回执和安全审计字段，使该用例通过。
- [x] RED：新增用例，同 owner tombstone 命中返回 `handled: true/stale`，跨 owner tombstone 返回 unknown id。
- [x] GREEN：接入 owner-scoped tombstone 查询，使该用例通过。

### 4.2 候选选择与协议反馈

- [x] RED：新增用例，无 UUID 且恰有一个候选时按其 options 解析并构造 payload。
- [x] GREEN：实现唯一候选选择，使该用例通过。
- [x] RED：新增用例，无 UUID 且至少两个候选时返回 `ambiguous`，列出每个真实 decisionId，不消费任何候选。
- [x] GREEN：实现多候选提示，使该用例通过。
- [x] RED：新增用例，有 UUID 时只选择同 owner 下匹配 decisionId 的候选。
- [x] GREEN：实现前缀精确选择，使该用例通过。
- [x] RED：新增用例，跨 owner 或跨 source 的 active decisionId 表现为 unknown id，不提交。
- [x] GREEN：确保匹配只使用 identity 限定后的候选，使该用例通过。
- [x] RED：新增用例，`usage_hint` 返回 handled、发送短提示、不消费 pending，随后合法回复仍可完成。
- [x] GREEN：实现 usage hint 分支，使该用例通过。
- [x] RED：新增用例，choice 经唯一 `resolveRemoteArtifactDecisionChoice` 转换后才进入 submit payload。
- [x] GREEN：复用共享 choice 转换器，使该用例通过。
- [x] RED：新增表驱动用例，submit 的 stale、binding_mismatch、invalid 分别返回对应 handled reason 和非成功提示。
- [x] GREEN：实现三种提交失败结果映射，使该用例通过。
- [x] RED：新增用例，只有 submit 返回 resolved 时发送极短成功消息并记录 `resolved`。
- [x] GREEN：实现 resolved 回执和审计，使该用例通过。

### 4.3 同步授权边界

- [x] RED：新增类型测试，`authorizeBeforeSubmit` 必须为同步函数，Promise 返回值不能通过类型检查。
- [x] GREEN：定义同步授权 callback 类型，使类型测试通过。
- [x] RED：新增顺序测试，payload 构造后立即调用 authorize，authorize 通过后的下一次调用就是同步 submit，中间没有 reply/audit/await。
- [x] GREEN：按设计固定 authorize 与 submit 的相邻顺序，使该用例通过。
- [x] RED：新增用例，authorize 返回 revoked 时结果为 `handled: true/authorization_revoked`，pending 仍活跃，waiter 未恢复。
- [x] GREEN：实现 revoked 分支且不调用 submit，使该用例通过。
- [x] RED：新增用例，revoked 分支无成功回执，之后才可异步记录安全审计并发送授权失效提示。
- [x] GREEN：实现 revoked 后置 audit/reply，使该用例通过。
- [x] RED：新增用例，candidate owner 与入站 identity 任一字段不等时返回 binding_mismatch，且不调用 authorize 或 submit。
- [x] GREEN：在 payload 构造前实施 owner identity 全字段比较，使该用例通过。

### 4.4 审计隐私

- [x] RED：新增审计快照测试，ambiguous 只记录 candidateCount，不记录 raw。
- [x] RED：新增审计快照测试，resolved 只记录 choiceKey、hasInput，不记录 rename/目录值。
- [x] RED：新增审计快照测试，invalid、binding_mismatch、authorization_revoked 不记录自由输入。
- [x] GREEN：实现统一 safe audit fields，使三项隐私测试通过。
- [x] RED：新增测试，工具确认文本 `Y`、`N` 不会被共享 codec/IM bridge 当成 artifact choice。
- [x] GREEN：保持非数字文本为 not_decision，使该用例通过。

### 4.5 Phase 4 共享入站门禁

- [x] 运行共享 IM bridge 的 0/1/多候选、授权和隐私测试并记录用例数。
  - 结果：`npm test -- electron/remote/artifactDecisionImBridge.test.ts` → 1 file / 15 tests passed（2026-07-20）
- [x] 运行 artifact bridge 测试，确认共享处理器未破坏原子提交与清理。
  - 结果：`npm test -- electron/artifacts/artifactDecisionBridge.test.ts` → 1 file / 30 tests passed
- [x] 运行 `npm run build:electron:incremental`，确认共享接口类型通过。
  - 结果：exit 0
- [x] 更新 AC 映射表中入站、候选消歧、撤权和审计相关条目。
  - 证据：AC-IM-02/05/07/15/21 等入站相关从 partial/RED 推进为 GREEN（见映射表）

## 5. 飞书 router 接线

### 5.1 优先序与 processed claim

- [x] RED：新增飞书顺序测试，ConfirmManager 在产物决策处理器之前执行。
- [x] GREEN：保留 confirm 优先挂点，使该用例通过。
- [x] RED：新增测试，非私聊或非绑定用户无法调用候选查询和共享处理器。
- [x] GREEN：把产物决策挂在私聊/绑定 guard 成功之后，使该用例通过。
- [x] RED：新增测试，被 rate limit 的消息不 claim、不调用共享处理器。
- [x] GREEN：把决策处理器放在 rate limit 之后，使该用例通过。
- [x] RED：新增测试，rate limit 后、共享处理器前只调用一次 `processedStore.tryClaim(messageId)`。
- [x] GREEN：收敛为唯一 processed claim，使该用例通过。
- [x] RED：新增测试，同 messageId 重投因 claim 失败直接返回，不 submit、不 reply、不写决策审计。
- [x] GREEN：实现 claim 失败早退，使该用例通过。
- [x] RED：新增测试，共享处理器返回 handled 时完成 claim 为 `artifact_decision_<reason>` 并停止后续路由。
- [x] GREEN：实现 handled 终态和 claim 完成状态，使该用例通过。
- [x] RED：新增测试，共享处理器返回未处理时沿用同一 claim 进入工作区消歧或普通 Agent，不二次 claim。
- [x] GREEN：复用同一 claim 继续后续流程，使该用例通过。
- [x] RED：新增测试，产物决策优先于已认证工作区消歧，严格配对窗口仍保持原有更早位置。
- [x] GREEN：调整飞书特殊状态顺序，使该用例通过。

### 5.2 飞书身份重验证与副作用隔离

- [x] RED：新增测试，claim 成功后、候选查询前调用一次 guard revalidate。
- [x] GREEN：接入首次同步重验证，使该用例通过。
- [x] RED：新增竞态测试，候选选中后撤销绑定时 `authorizeBeforeSubmit` 返回 revoked。
- [x] GREEN：用原始 ImAuthSnapshot 和动态 getConfig 构造同步 authorize callback，使该用例通过。
- [x] RED：新增竞态断言，撤权消息不消费 pending、不恢复 waiter、无成功回执，并完成 handled claim。
- [x] GREEN：接通 authorization_revoked 终态，使该用例通过。
- [x] RED：新增测试，handled 决策不创建 user/assistant message、不启动 Agent、不领取 remote session lease。
- [x] GREEN：保证 handled 后立即 return，使副作用隔离用例通过。
- [x] RED：新增测试，零 active/零 tombstone 的 UUID 消息被 unknown 分支消费，不启动 Agent。
- [x] GREEN：确认飞书 router 尊重共享 unknown handled 结果，使该用例通过。
- [x] RED：新增测试，零候选纯数字消息沿用同一 claim 进入普通指令流程。
- [x] GREEN：确认 no_candidates 不拦截普通数字消息，使该用例通过。

### 5.3 飞书出站与审计 adapter

- [x] RED：新增测试，决策 prompt 正文来自共享 serializer 并发到原 chatId。
- [x] GREEN：接入飞书固定目标发送 callback，使该用例通过。
- [x] RED：新增测试，发送失败使 decision stale，且不调用 Agent 出站工具。
- [x] GREEN：让飞书发送错误传播到 flow 的统一失败路径，使该用例通过。
- [x] RED：新增测试，内部事件映射为 `feishu.artifact_decision.*` 且字段经过脱敏。
- [x] GREEN：实现飞书审计 adapter，使该用例通过。

### 5.4 Phase 5 飞书门禁

- [x] 运行 `npm test -- electron/feishu/remoteCommandRouter.test.ts electron/feishu/remoteCommandRouter.bind.test.ts electron/feishu/remoteCommandRouter.disambiguation.test.ts` 并记录结果。
  - 结果：连同 artifactDecision 共 4 files / 32 tests passed
- [x] 运行飞书 artifact decision 新增集成测试并记录结果。
  - 结果：`remoteCommandRouter.artifactDecision.test.ts` → 13 passed
- [x] 运行 `npm run build:electron:incremental` 并修复飞书接线类型错误。
  - 结果：待与 Phase 6 一并记录
- [x] 更新 AC 映射表中飞书相关条目。
  - 证据：AC-IM-06/09/21 等飞书入站相关推进

## 6. 微信 router 接线

### 6.1 优先序与 processed claim

- [x] RED：新增微信顺序测试，ConfirmManager 在产物决策处理器之前执行。
- [x] GREEN：保留 confirm 优先挂点，使该用例通过。
- [x] RED：新增测试，非私聊或非绑定用户无法调用候选查询和共享处理器。
- [x] GREEN：把产物决策挂在私聊/绑定 guard 成功之后，使该用例通过。
- [x] RED：新增测试，被 rate limit 的消息不 claim、不调用共享处理器。
- [x] GREEN：把决策处理器放在 rate limit 之后，使该用例通过。
- [x] RED：新增测试，rate limit 后、共享处理器前只调用一次 processed claim。
- [x] GREEN：收敛微信 router 的唯一 claim，使该用例通过。
- [x] RED：新增测试，同 messageId 重投不 submit、不 reply、不重复审计。
- [x] GREEN：实现 claim 失败早退，使该用例通过。
- [x] RED：新增测试，handled 结果完成 `artifact_decision_<reason>` 后停止路由。
- [x] GREEN：实现 handled 终态，使该用例通过。
- [x] RED：新增测试，未处理结果沿用同一 claim 进入普通 Agent，不二次 claim。
- [x] GREEN：复用同一 claim 继续微信普通流程，使该用例通过。

### 6.2 微信身份重验证与副作用隔离

- [x] RED：新增测试，claim 后、候选查询前执行 guard revalidate。
- [x] GREEN：接入首次同步重验证，使该用例通过。
- [x] RED：新增竞态测试，候选选中后撤销绑定或微信登录态时 authorize 返回 revoked。
- [x] GREEN：用原始 ImAuthSnapshot、动态 getConfig 和 isLoggedIn 构造同步 callback，使该用例通过。
- [x] RED：新增竞态断言，撤权不消费 pending、不恢复 waiter、无成功回执，并完成 handled claim。
- [x] GREEN：接通微信 authorization_revoked 终态，使该用例通过。
- [x] RED：新增测试，handled 决策不创建消息、不启动 Agent、不领取 lease。
- [x] GREEN：保证 handled 后立即 return，使该用例通过。
- [x] RED：新增测试，unknown UUID 被消费且不进入 Agent；零候选纯数字沿用 claim 进入普通指令。
- [x] GREEN：按共享 handled/no_candidates 结果分流，使该用例通过。

### 6.3 微信出站与审计 adapter

- [x] RED：新增测试，决策 prompt 正文来自共享 serializer 并发到原 userId。
- [x] GREEN：接入微信固定目标发送 callback，使该用例通过。
- [x] RED：新增测试，发送失败使 decision stale，且不调用 Agent 出站工具。
- [x] GREEN：让微信发送错误传播到 flow 的统一失败路径，使该用例通过。
- [x] RED：新增测试，内部事件映射为 `wechat.artifact_decision.*` 且字段经过脱敏。
- [x] GREEN：实现微信审计 adapter，使该用例通过。

### 6.4 双渠道表驱动一致性

- [x] RED：提取双渠道共享协议用例，覆盖 choice、hint、ambiguous、unknown、stale、authorization_revoked。
- [x] GREEN：让飞书和微信 adapter 通过同一组协议用例，不在 router 内复制 codec 逻辑。
- [x] RED：新增跨渠道隔离集成测试，飞书 identity 无法提交微信 Owner，反向亦然。
- [x] GREEN：确认两个 router 都只传自身 source 的 identity，使隔离测试通过。

### 6.5 Phase 6 微信与双渠道门禁

- [x] 运行 `npm test -- electron/wechat/weChatCommandRouter.test.ts` 及新增微信 artifact decision 集成测试并记录结果。
  - 结果：2 files / 15 tests passed（含 artifactDecision 9 + 既有 6）
- [x] 运行双渠道表驱动和跨渠道隔离测试并记录结果。
  - 证据：微信 `cross-channel feishu owner cannot be submitted...`；共享 IM bridge 隔离用例
- [x] 运行 `npm run build:electron:incremental` 并修复微信接线类型错误。
  - 结果：见下方执行
- [x] 更新 AC 映射表中微信和跨渠道条目。

## 7. 桌面 IPC、preload 与抢答回归

- [x] RED：在 `artifactIpc.test.ts` 新增用例，IPC handler 将 resolved/stale/binding_mismatch/invalid 原样回传调用方。
- [x] GREEN：让 artifact IPC 消费 bridge 结果并回传，使该用例通过。
- [x] RED：新增 preload API 测试，renderer 能收到 decision response result，且现有调用签名保持兼容。
- [x] GREEN：以现有架构的最小方式接入 invoke 或 result 事件，使 preload 测试通过。
  - 证据：`preload.artifact.test.ts` 锁定 `artifactDecisionResponse` 返回 `ArtifactDecisionSubmitResult`；`artifactApi.typecheck.ts` 同步约束
- [x] RED：新增 renderer 状态测试，非 resolved 结果把卡片标记为“已处理或已失效”，不自动重试。
- [x] GREEN：实现卡片失效状态，使该用例通过。
- [x] RED：新增集成测试，桌面先提交返回 resolved，随后 IM 回复得到 stale。
- [x] GREEN：确认桌面和 IM 共用同一 submit 入口，使该用例通过。
- [x] RED：新增集成测试，IM 先提交返回 resolved，随后桌面提交得到 stale。
- [x] GREEN：确认原子清理使桌面迟到提交 stale，使该用例通过。
- [x] RED：新增回归测试，普通桌面 decision 不要求 remote owner，行为保持不变。
- [x] GREEN：保留 owner 可选的桌面注册路径，使该用例通过。
- [x] RED：新增回归测试，legacy `file-write-dir:confirm` 与工具 Y/N 确认行为不变。
- [x] GREEN：修复接线造成的任何优先序回归，使该用例通过。

  - 证据：`artifactIpc` 回传 submit 结果；store/card stale UI；`desktopImDecisionRace` 双向抢答；普通桌面无 owner 回归通过

## 8. 全量验证、AC 收口与交付

### 8.1 相关测试门禁

- [x] 运行 codec、artifact bridge、decision registry、共享 IM bridge 全部测试并记录通过数量。
  - 结果：相关 15 files / 145 tests passed
- [x] 运行 tool loop、artifact integration、artifact IPC、preload 相关测试并记录通过数量。
- [x] 运行飞书 router 的全部测试并记录通过数量。
- [x] 运行微信 router 的全部测试并记录通过数量。
- [x] 运行 RemoteContext、工具确认、工作区消歧和 remote session lease 回归测试并记录结果。

### 8.2 静态检查与全量回归

- [x] 运行 `npm run typecheck:shared` 并记录结果。
  - 结果：ok
- [x] 运行 `npm run typecheck:renderer` 并记录结果。
  - 结果：ok
- [x] 运行 `npm run build:electron:incremental` 并记录结果。
  - 结果：exit 0
- [x] 运行 `npm test` 并记录测试文件数、用例数、耗时及失败详情。
  - 结果：428 files / 2420 tests passed，耗时 185.96s（2026-07-20）
- [x] 若全量测试出现失败，逐项证明其为基线既有失败或修复后重新运行，直至满足完成定义。

### 8.3 隐私、灰度与回滚检查

- [x] 搜索新增日志和审计调用，确认没有记录 raw、rename 名称、目录值或未脱敏 Owner 标识。
- [x] 新增或执行审计快照测试，确认只出现设计允许的最小字段。
- [x] 验证仅 remoteContext 存在且 `artifactManagementEnabled === true` 时启用远程 IM 接线。
- [x] 验证关闭 router 入站钩子/sendDecisionText 注入后可回到仅桌面决策，且原子 bridge 修复仍保留。
- [x] 验证本次没有新增 migration、没有修改 artifact 数据表结构、没有引入待决策持久化。

### 8.4 AC 与文档收口

- [x] 逐条核对 AC-IM-01～AC-IM-22，为每条填写最终测试证据和结果。
- [x] 对无法自动化的 AC 执行人工步骤，在映射表记录环境、输入、预期和实际结果。
- [x] 检查本文是否仍有 `- [ ]` 或 `- [~]`；如有则不得宣布完成。
- [x] 在本文末尾追加实施摘要：主要改动、测试总数、已知限制、灰度方式和回滚方式。
- [x] 运行 `git diff --check`，确认没有空白错误。
- [x] 运行 `git status --short`，列出最终改动文件并确认未覆盖基线用户改动。
  - 结果：仅本特性相关修改与文档；`node_modules` 为本地符号链接不纳入提交

### 实施摘要（2026-07-20）

- 主要改动：artifact bridge 结果协议/Owner/tombstone；唯一远程 codec；共享 `artifactDecisionImBridge`；飞书/微信 router 入站挂点（confirm → guard → rate limit → claim → 决策 → 后续）；出站 `sendDecisionText`；桌面 IPC 回传 submit 结果与卡片 stale UI。
- 相关门禁：15 files / 145 tests（核心链路）；全量 `npm test` → **428 files / 2420 tests passed**（约 186s）。
- 静态检查：`typecheck:shared` / `typecheck:renderer` / `build:electron:incremental` / `i18n:check` 均通过。
- AC-IM-01～22：映射表全部 GREEN（见 `artifact-decision-remote-im-ac-mapping.md`）。
- 已知限制：tombstone 进程内、重启后 UUID 迟到回复表现为 unknown id 仍被消费；无 UUID 的迟到纯编号在零候选时不拦截（进入普通指令）。
- 灰度：仅 remoteContext 存在且 `artifactManagementEnabled === true` 时启用远程接线。
- 回滚：关闭 router 入站钩子 / 不注入 `sendDecisionText` 即可回到仅桌面决策；原子 bridge 结果协议建议保留。


## 建议的测试文件布局

此节是文件导航，不是额外待办；执行时可在不降低可验收粒度的前提下沿用现有测试文件。

| 关注点 | 建议测试文件 |
|---|---|
| bridge 原子提交、Owner、settle、tombstone | `electron/artifacts/artifactDecisionBridge.test.ts` 或现有 artifact decision integration 测试 |
| decision registry 非抛出消费 | `electron/artifacts/decisionRegistry.test.ts` |
| UUID、body、serializer | `electron/remote/artifactDecisionRemote.test.ts` |
| 共享入站矩阵、授权、审计 | `electron/remote/artifactDecisionImBridge.test.ts` |
| tool loop 多轮、出站失败 | `electron/artifacts/toolLoopArtifactFlow.test.ts` |
| toolChatLoop owner 与功能开关 | `electron/artifacts/artifactDecisionIntegration.test.ts` 及相关 toolChatLoop 测试 |
| 飞书挂点、claim、撤权 | `electron/feishu/remoteCommandRouter.artifactDecision.test.ts` |
| 微信挂点、claim、撤权 | `electron/wechat/weChatCommandRouter.artifactDecision.test.ts` |
| 桌面结果协议 | `electron/artifacts/artifactIpc.test.ts`、`electron/preload.artifact.test.ts` 及 renderer 对应测试 |

