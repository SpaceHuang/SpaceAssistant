# 微信 IM 确认提示发送失败修复计划

**状态：待实施**  
**日期：2026-10-10**  
**关联会话：** `e2e4143a-86e2-40ab-a7c0-3cf91866ab72`  
**范围：** 修复 IM 工具确认从“策略要求确认”到“提示发送状态被准确记录并反馈”之间的可观测性与失败体验。此计划不改变安全判定结果，也不假设发送调用成功就等于用户实际收到提示。

## 1. 目标

让每次 IM 确认都能区分以下状态：

1. 策略要求确认，应用登记了待确认项。
2. 本地前置检查失败、发送调用成功，或发送调用失败且投递结果未知。
3. 用户回答、请求超时或发送失败导致请求不可用。

发送失败时，工具必须保持未派发；系统必须保留脱敏后的失败原因，并由应用层基于结构化事实生成确定性的最终回执。只有能证明发送调用未开始的本地前置失败，才可告知“提示未发送”；发送调用 reject 时必须告知“无法确认是否送达”。不得把“确认请求已创建”或“发送调用成功”当成“微信已经收到提示”。

## 2. 故障证据与边界

### 2.1 已确认事实

本机只读记录显示，会话 `e2e4143a-86e2-40ab-a7c0-3cf91866ab72` 的 `run_script` 在本地时间 2026-10-10 01:29:26.552 被策略判定为 `script-path-unknown-confirm`。安全审计于 01:29:26.561 写入 `confirm.request`，01:29:26.562 写入 `confirm.outcome: unavailable`；History 随后记录 `CONFIRMATION_UNAVAILABLE`，该调用没有派发。它不是用户等待超时。

同一入站消息的普通进度回复在 01:29:11 成功；最终回复在 01:30:53 成功。确认提示路径当时没有对应的发送成功事件或底层异常记录。远程异步审批总闸为关闭状态，因此该请求走 IM 用户确认通道；关闭总闸本身不应阻止用户确认。

### 2.2 当前代码路径

- `electron/runtime/invocationAssembler.ts` 为 IM 工具确认装配 `ImChannel` 与当前消息上下文。
- `electron/wechat/weChatImChannel.ts` 的 `sendPrompt` 取得当前 bot 和原始入站消息，然后调用 `replyBot.reply(...)` 发送提示。
- `electron/confirmation/imChannel.ts` 先登记确认请求，再执行 `sendPrompt`。同步抛错或 Promise reject 都会被空 `catch` 捕获，并立即解析为 `unavailable`；当前没有保留发送是否已调用及投递状态的信息。
- 该 `catch` 没有记录异常对象，也没有区分“提示调用失败”与“用户没有回答”。因此当前数据只能定位到确认提示发送阶段，不能还原底层 SDK/API/传输错误。
- `electron/wechat/weChatImChannel.ts` 的确认文案还组合了两种回答说明：带确认码的 `Y <确认码>` / `N <确认码>`，以及不带确认码的通用 `Y/N` 尾句。入站解析器 `parseImConfirmReply` 要求确认码；提示和解析合同不一致。

### 2.3 尚不能断言的事项

历史日志没有保存这次 `replyBot.reply` reject 的错误类型或 API 错误码。因此不能断言具体是微信服务拒绝、传输故障、SDK 凭据状态，还是其他发送异常。相邻消息发送成功使 bot/上下文缺失不太符合证据，但不能替代对失败异常的捕获。

## 3. 设计原则

1. **确认请求、发送调用和消息投递是不同状态。** `approval-waiting` 表示 Turn 正等待策略确认；它不能代表消息已发送。`replyBot.reply` 成功也只表示发送调用成功，不代表有服务端投递回执或用户已读。
2. **发送失败继续 fail closed。** `unavailable` 必须继续阻止工具执行，不得因通知失败而自动批准或改走免确认策略。
3. **如实表达投递不确定性。** 本地前置失败可以标记 `not-attempted`；发送调用 reject 必须标记投递 `unknown`，不能声称提示确定未发出。
4. **不盲目重发。** 发送 API reject 可能发生在服务端已接受消息但客户端未收到响应之后。没有幂等发送凭据前，不自动重试，避免重复确认提示或误导用户。
5. **日志只含诊断元数据。** 不记录提示正文、工具完整参数、原始入站对象、上下文 token、访问令牌或用户消息正文。
6. **确定性投影最终回执。** 应用层读取本 Turn 的结构化失败事实并生成回执；该回执只陈述失败的受保护调用。存在该事实时不复用可能省略或与之矛盾的模型总结，也不使用“任务已完成”空文本回退。
7. **不扩大授权面。** 不更改远程浏览器、Shell、脚本、MCP 的策略，也不启用远程异步审批总闸。

## 4. 实施阶段

### 阶段 A：确认提示发送的结构化诊断

**目标文件**

- `electron/confirmation/imChannel.ts`
- `electron/confirmation/imChannel.test.ts`
- `electron/wechat/weChatImChannel.ts`
- `electron/wechat/weChatImChannel.test.ts`
- `src/shared/confirmation/types.ts`（若为跨层发送状态添加窄类型）
- 必要时 `electron/confirmation/types.ts`、`electron/confirmation/audit.ts`

**改动**

- 让微信发送适配器显式区分本地前置失败（`sendCall: not-attempted`）、发送调用 fulfilled（`sendCall: fulfilled`，投递未确认）与发送调用 rejected（`sendCall: rejected`、`delivery: unknown`）。在待确认项创建、发送调用开始、发送调用结束处形成可关联事件；至少带 `lane`、`sessionId`、`requestId`、内部确认 ID、`toolName`、发送调用状态、投递状态和时间。
- 捕获同步异常与 Promise reject 的原始对象，并映射成稳定的安全诊断分类，例如 `bot-unavailable`、`inbound-context-missing`、`credentials-unavailable`、`api-rejected`、`transport-failed`、`unknown`。
- 对微信 SDK 的已知错误仅记录安全字段：错误类名、允许列表中的错误码、HTTP 状态和 API `errcode`。不记录完整异常消息或 payload；若未来需要消息摘要，必须先制定字段级脱敏规则与长度限制。
- 保留现有外部结果 `unavailable` 兼容性，同时在审计/日志中明确 `prompt-send-failed`，使它不再与用户未回答或超时混淆。发送调用 reject 不能折算成“肯定未发送”；本地前置失败只有在发送函数保证尚未调用 `replyBot.reply` 时才记录 `not-attempted`。
- 日志写入失败不得改变确认的 fail-closed 结算，也不得让异常逃逸并破坏 History 终态。

**完成条件**

- 同步抛错和异步 reject 均落一条可关联的发送失败诊断，含稳定错误分类。
- fulfilled 记录只表示发送调用成功，投递状态保持 `unconfirmed`，不标记为用户已收到或已读；reject 记录投递 `unknown`。
- 测试证明诊断字段不含 prompt、完整工具参数、用户正文和凭据。

### 阶段 B：固定发送失败时的安全结算与确定性回执

**目标文件**

- `electron/confirmation/imChannel.ts`
- `electron/confirmation/agentSdkConfirmationPort.ts`
- `electron/confirmation/agentSdkSafetyPolicy.ts`（仅在确认结果投影确需调整时）
- `packages/agent-sdk/src/turn.ts` 及其测试（将结构化未派发事实持久化）
- `electron/remote/imRemoteAgent.ts`
- `electron/remote/imRemoteAgent.test.ts`
- 对应的 `*.test.ts`

**改动**

- 发送失败后立即将确认结算为 `unavailable`，释放短确认码和待确认注册；不等待完整确认超时。保留失败请求失效语义，迟到的 Y/N 不得恢复该请求或派发工具。
- 将发送状态作为窄范围结构化事实从 `ImChannel` 传到 `ConfirmOutcome`、`agentSdkConfirmationPort`、SDK 的确认结算结果，再写入本 Turn 的 `approval-resolved` 和 `tool-call-not-dispatched` History。事实至少区分 `not-attempted` / `rejected-delivery-unknown`，保留 `CONFIRMATION_UNAVAILABLE` 的 fail-closed 语义。
- 在 `electron/remote/imRemoteAgent.ts` 的最终摘要边界读取本次 Turn 的结构化 History 事实（按本次 invocation/turn ID 关联，不解析模型文字或错误字符串）。发现确认提示发送失败事实时，使用确定性回执替代模型 `res.content`，列出受影响的工具调用及未派发状态：本地前置失败可说明提示未发送；发送调用 reject 必须说明“确认提示发送调用失败，无法确认是否送达；本次确认已失效，相关操作未执行”。回执只对列出的受保护调用作结论，不把同一 Turn 中其他工具概括成未执行。
- 有结构化发送失败事实时，不拼接原模型总结，以免保留“相关操作已执行”的矛盾结论；模型文本为空时也不得落入“任务已完成。”回退。没有此类事实时，维持既有摘要路径。
- 不自动重试 IM 提示。若后续要加重试，必须先验证发送接口幂等性或能区分“确定未发送”与“结果未知”。
- 不引入面向所有工具的新审批协议；仅为确认提示发送失败添加跨层可持久化、可消费的窄范围字段。

**完成条件**

- 发送失败时，确认通道立即返回 `unavailable`；工具执行器调用次数为 0。
- History 同时保留 `unavailable`、未派发和发送投递状态；用户回执由应用层结构化投影生成，不依赖模型复述。
- fake model 分别返回省略失败说明的文本、空文本和声称相关操作已执行的文本时，最终回执都准确指出相关调用未派发，且不包含矛盾的成功结论。
- 同一 Turn 中一个工具调用成功、另一个确认提示发送失败时，回执只将失败调用标为未派发，不把成功调用描述为未执行。
- fake bot 模拟服务端已接受消息后 Promise reject 时，回执表述投递结果未知，不声称提示确定未发出；迟到的确认回答无法派发该工具，短确认码与待确认注册已清理。
- 发送成功后仍按原行为等待用户回答；用户拒绝、取消和超时的含义不变。

### 阶段 C：统一微信提示文案与回答解析合同

**目标文件**

- `electron/wechat/weChatImChannel.ts`
- `electron/wechat/weChatImChannel.test.ts`
- `electron/remote/imConfirmReply.ts`（仅当共享格式化器需要调整）
- 视影响补充飞书文案合同测试，不扩大实现范围

**改动**

- 确认提示只提供解析器实际接受的语法：`Y <确认码>` 批准、`N <确认码>` 拒绝，以及显式列出的受支持扩展语法。
- 删除或替换尾部不带确认码的泛化 `Y/N` 指令；提示中的有效时限与实际待确认超时保持一致。
- 测试提示文本中出现的批准/拒绝示例均能由 `parseImConfirmReply` 解析；裸 `Y/N` 仍按设计拒绝并给出使用提示。

**完成条件**

- 微信确认提示与实际 parser 输入合同一致，无互相矛盾的操作说明。
- 确认码、记忆档位、信任选项（若适用）继续通过已有身份、会话和授权代次校验。

### 阶段 D：端到端回归与运行记录

**测试范围**

- `electron/confirmation/imChannel.test.ts`：成功、同步抛错、异步 reject、超时、取消、并发待确认。
- `electron/wechat/weChatImChannel.test.ts`：bot 缺失、上下文缺失、API/传输错误分类、确认文案/parser 合同。
- `electron/confirmation/agentSdkConfirmationPort.test.ts`、`electron/confirmation/agentSdkSafetyPolicy.test.ts` 与 `packages/agent-sdk/src/turn` 测试：结构化失败事实写入规范 History、工具不派发、模型收到可解释原因。
- `electron/remote/imRemoteAgent.test.ts`：最终回执确定性投影，覆盖模型省略、空内容、矛盾成功总结，以及同 Turn 其他调用成功的情况。
- `electron/wechat/weChatRemoteAgent.test.ts`：微信远程 Turn 中发送调用 reject 后投递状态为未知、工具不执行、迟到回复不能授权且待确认资源清理。
- 共用通道受影响时，补充 `electron/feishu/feishuImChannel.test.ts` / 相关确认测试，确认本次诊断改动不改变飞书原有行为。

**人工验收**

- 使用 fake bot 分别模拟本地前置失败和“服务端已接受后 Promise reject”：检查无工具副作用、日志准确区分发送调用状态与投递状态，最终回执对后者说明无法确认是否送达。
- 对最终摘要使用 fake model 返回省略失败、空内容、错误声称已执行三种结果；最终用户仍收到确定性回执，且该回执只对失败的受保护调用作结论。
- 使用 fake bot 让发送成功：检查提示带确认码，按提示批准/拒绝能正确命中当前请求。
- 本机验收不调用真实账号或生产数据库。真实微信联调若要执行，另列独立验收记录并明确账号、构建版本和实际发送结果。

## 5. 总体验收标准

- 任一 IM 确认提示发送失败都可从日志中区分于用户拒绝、超时、取消和远程审批 Agent 不可用。
- 失败诊断通过 `requestId + sessionId + confirmId` 可与 `policy.decision`、`confirm.request/outcome`、`approval-resolved`、`tool-call-not-dispatched` 及最终回执关联。
- 本地前置失败记录 `sendCall: not-attempted` / `delivery: not-attempted`；发送调用 reject 记录 `sendCall: rejected` / `delivery: unknown`；发送调用 fulfilled 只记录 `sendCall: fulfilled` / `delivery: unconfirmed`。
- 确认提示发送失败时，最终用户回执由应用根据结构化 History 事实确定性投影；模型省略、空内容或作出矛盾成功总结都不能导致漏报或误报。
- 诊断不泄露消息正文、工具完整入参、上下文 token、密钥或服务端 payload。
- 失败路径在工具执行前结束，且任何失败或超时路径都不能绕过确认。
- 发送成功、用户批准、用户拒绝、取消、授权撤销和超时保持现有安全语义。
- 远程异步审批开关、工具策略、MCP 暴露面和浏览器远程开关不因该修复改变。
- 微信确认提示中的说明与回复 parser 一致。

## 6. 风险与明确不做事项

- **未知发送结果与重复提示：** 传输 reject 不必然证明服务端未收到消息；回执如实标记投递未知，本计划不自动重发。
- **安全日志隐私：** 微信 SDK 的异常对象可能携带用户标识、请求 payload 或令牌；实现必须按字段白名单记录，禁止直接序列化整个异常。
- **模型总结不可靠：** 用户侧回执不能只靠 prompt 建议；结构化发送状态必须持久化到本 Turn History，并由 `imRemoteAgent` 最终摘要边界确定性消费与投影。发生此类失败时替换模型总结，避免遗漏或与“相关调用未派发”冲突。
- 本计划不放宽 `allowRemoteSessions`，不把 `deny` 改成 `ask`，不开放远程 MCP，不调整脚本安全分类，也不默认启用审批 Agent。

## 7. 实施约束

- 每项行为改动先补针对性回归测试，再实现；优先使用 fake IM sender / fake bot，不调用真实微信接口。
- 执行前记录 `git status --short`，只修改本计划列出的实现与测试文件，不覆盖已有工作区改动。
- 完成阶段后更新本计划状态、具体文件和测试结果；本计划当前只记录待实施工作，不代表修复已完成。
