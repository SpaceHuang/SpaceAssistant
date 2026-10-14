# 工作目录 AGENTS.md 运行时基线

日期：2026-10-15
范围：阶段 0 代码核查，不改变运行时行为。

## 入口与逻辑请求边界

桌面 `electron/claudeStreamHandlers.ts` 在接收已受理 turn 后调用 `assembleInvocation`，再经 `runToolChatSession` 进入 hosted handoff。飞书 / 微信 `electron/remote/imRemoteAgent.ts` 以会话绑定构造 invocation 后同样调用 `runToolChatSession`。automation（butler、审批回答 Agent）也调用同一函数。`runToolChatSessionInner` 目前先基于 `buildFinalSystemPrompt` 构造系统提示，再把完整请求交 `onHostedTurnHandoff`；Hosted SDK 的 `runAgentTurn` 才执行模型轮、工具循环和后续模型请求。

SDK 在每一逻辑模型请求处追加 `model-request-started`（`requestId = invocationId:round:modelTurn`，包含 modelTurn/attempt/requestSnapshot），provider 恢复重试会以同一 requestId 写 attempt 2 并重用冻结请求模板。工具返回后 modelTurn 增长，创建新逻辑请求。审批等待与工具调用均位于响应之后；History 已有 approval/tool 事件可扩展携带来源 request 标识。此通用事件支持序列化元数据，不需新增产品专用 SDK API 或第二 event stream。

当前宿主 system prompt 只在 `runToolChatSessionInner` 开始时装配，因此 invocation 内 R2 不会重新读取。阶段 4 需在 SDK 通用 `prepareModelRequest` 边界增加宿主 callback，使每个 logical request 在请求冻结之前重装 host-owned 项目指令区块；同 request retry 复用已准备请求。`model-request-started` 事件可保存快照索引与有限正文；canonical History 的大 payload 已支持 spill/hydration，应复用它并验证其上限/恢复路径。

## 工作目录绑定与派发

`resolveWorkDirForSession` 根据 fixedWorkDir、会话 profile binding、active fallback 解析目录；`buildResolveWorkDirCallback` 每次实时读取绑定。工具 initial `createExecutionContext` 动态取目录；SDK 等待 approval、资源锁后再次 `prepareTool(recheck)`，host `refreshExecutionContext` 又动态取目录，`matchesRecheckBinding` 只比较该工具 initial 与 recheck 的 PermitBinding。`createPermitBoundToolExecutionPort` 在 claim 执行前校验 permit、revocation、authorization version，但没有来源 model request 的 workspace binding identity。

SDK `mapWithConcurrency` 并行处理同批工具；`beforeToolDispatch` 目前只检查重复语义失败，不绑定目录。`switch_work_dir` executor 修改会话绑定，同批 sibling 没有专门顺序屏障。因此计划阶段 5 必须在最终派发边界比较每工具来源请求 binding，且把经过校验的解析目录固定用于 executor context；同批 switch 需顺序执行并使 siblings 回传未派发。审批后仍需同一 binding 校验，不可只靠新 grant 或安全 recheck。

## History 与存储

`HistoryEvent` 是 canonical 序列事件；`model-request-started`、`model-response-committed`、tool 与 approval 事件足以关联 invocation/request/tool/approval。请求 snapshot 包含 provider request 的 hash 而不含 messages 正文；AGENTS 正文必须另以有界可序列化 snapshot payload 入同一事件或既有 spill payload，不能仅凭摘要承诺历史还原。SQLite History 实现有大 payload spill/hydration，重启恢复将未完成 invocation 写为 `interrupted`，继续保持只读历史语义。

会话数据库已有 JSON `Session.metadata`，创建、读取、更新均往返保存，无 schema migration；新开关可放在 metadata 的独立字段 `agentsMdEnabled`，缺省 true，不触碰旧 `projectMemoryEnabled`。

## 阶段 0.4 原型结论与 RED

通用 History 事件合同和宿主 `prepareModelRequest` observer 已覆盖请求观察，但 observer 当前只做计量与请求投影，不能更换 SDK 已准备的 request。阶段 4 需要增加中立、通用且可序列化/宿主计算的 model request preparation hook（由宿主返回最终 `PreparedModelCall` 或可替换 system/context 的纯数据），SDK 不识别文件名。RED 场景为：R1 捕获 A 规则；provider retry 期间磁盘改 B，attempt 2 仍是 A；工具返回后 R2 捕获 B。当前能力不能通过真实 provider capture，因而该回归应先失败再实现。

## 验收命令与隔离

阶段定向验证使用 `npm exec vitest run <受影响测试文件...>`；SDK 触及时加 `npm run check:agent-sdk`。阶段收尾及最终提交执行 `npm test`，最终再执行类型/i18n/`npm run build`。主工作区原有未提交项为 MCP 超时计划、projectMemory 测试、agent-sdk turn 实现与测试，以及两份其他未跟踪计划和两份需求；这些均未复制或纳入本 worktree。仅当前 AGENTS 计划、需求和关联评审文档作为本任务输入纳入基线。
