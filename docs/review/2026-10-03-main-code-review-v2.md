# main 代码复评（2026-10-03，`847fb37d`）

## 范围与方法

以 `origin/main..847fb37d` 的 11 个提交为重点，在独立 worktree 检查纯 `HEAD`，排除主工作区未提交修改的影响。按正确性、架构、安全、性能和验证五个维度，逐一检查续接受理与 SDK 派发、目录授权与手动压缩、计划任务配置与执行、会话标题、Renderer 交互、数据库迁移及其测试。以下只列出有具体触发条件和代码依据的问题；完整测试通过不代表这些边界已被覆盖。

## 阻断项

### 1. Required：续接输入的忙时竞态会直接抛错，跳过排队降级

- 位置：`electron/outbound/outboundAcceptor.ts:617-643`，对照同文件 `665-697`。
- 触发：用户发送“继续检查”等携带稳定 `requestId` 的输入；受理快照显示会话空闲，但在 `startTurn` 前另一请求先占用会话。`TurnCoordinator.prepare` 会抛 `SESSION_TURN_BUSY`。
- 实际：续接分支在 `try/catch` 之外直接 `await deps.startTurn`，异常传给 IPC，既不返回结构化拒绝，也不将输入排队。普通分支已有 `SESSION_TURN_BUSY → enqueueDecision` 处理。用纯 `HEAD` 的临时 Vitest 用例注入此竞态，稳定观察到 `submitOutbound` reject；临时用例未保留在仓库。
- 影响：用户输入可能在这一竞态下没有持久化，违背出站受理“忙时排队、消息不丢”的契约。
- 建议：把续接分支纳入同一 `startTurn` 错误处理；忙时使用 `queueContinuation` 保留原 `requestId`、附件和续接上下文，并加入竞态回归测试。

### 2. Required：任务工作目录校验把无读取权限的目录判为可访问

- 位置：`electron/butler/taskConfigValidation.ts:9-20`。
- 触发：选定一个存在但没有读取/进入权限的目录。`access(canonical)` 未指定权限模式，默认只检验存在性。
- 实测：对权限设为 `000` 的临时目录，`validateTaskWorkDir` 返回 `{ok:true}`，同一进程 `readdir` 返回 `EACCES`。
- 影响：创建和运行入口均使用该校验，任务可保存并开始执行，却无法在固定工作目录中读取或列举文件；需求明确要求在运行前拒绝不可访问目录。
- 建议：按执行所需能力验证目录至少可读取和进入，并在运行前重新验证；补充权限拒绝测试。具体写权限仍由工具操作自身判定。

### 3. Required：预选不支持 Thinking 的模型时，新建任务表单可能无法保存

- 位置：`electron/butler/butlerIpc.ts:64-75`，`src/renderer/components/Config/ButlerTaskSettings.tsx:130-149,329-335`，`electron/butler/taskConfigValidation.ts:35-39`。
- 触发：桌面默认模型 `supportsThinking=false`，全局 `config.thinkingEffort` 为 `low` 或更高。`butler:get-defaults` 原样返回全局强度；`openCreate` 预填该值。模型选择的 `onChange` 才会把强度改为 `off`，预填不会触发它；同时强度选择框因模型不支持 Thinking 被禁用。
- 实际：用户直接保存会被主进程以“所选模型不支持思维强度”拒绝，且禁用的控件不能改为 `off`。必须临时改选模型再选回才能保存。
- 建议：在默认值解析或表单初始化时按预选模型能力将有效强度设为 `off`，并覆盖“预选不支持 Thinking + 全局非 off”的创建测试。

## 其他发现

- `electron/ipc/agentProtocolIpc.ts:846-853` 的 `findRetrySource` 仅按全会话“恰好一个失败 assistant”选来源，未检查其后是否已有成功的新任务。发送普通“继续”时可能把新 Turn 的 `retry_of_*` 关系错误指向更早的失败；Renderer 还用时间戳启发式重建关系，未消费持久关系。建议按最新任务边界选取并用持久关系显示。此项未判为本轮阻断，因为目前主要影响关系记录和 UI 标注。

## 验证与结论

- 上次阻断用例 `Automation Hosted handoff rejects stale legacy transcript when canonical session History exists`：单独重跑通过。
- `npm test`：852 个文件通过、1 个文件跳过；7769 项通过、106 项跳过，退出码 0。
- `npm run typecheck:renderer`、`typecheck:shared`、`typecheck:agent-sdk`、`i18n:check`、`check:agent-sdk`、`npm run build`：均通过。构建有现存的大 chunk / ineffective dynamic import 警告，未作为本轮阻断。
- 续接忙时竞态与目录权限用临时复现验证；模型预选问题由默认值、表单禁用条件和主进程校验的确定性组合确认。

**结论：请求修改。** 上次阻断已修复，但上述三个边界仍需处理并补回归测试。
