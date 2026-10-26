# Renderer 与主进程 trace 关联

日期：2026-10-26  
方案依据：`会话切换性能优化方案.md` §2 AC-1  兼容约束：不新增 IPC 入参/返回字段。

## 实现

- preload 与主进程 handler 分别按 renderer page request 顺序递增 ordinal；renderer 的三个生产分页调用点统一经过 `requestChatMessagePageWithTraceMetadata`，在 contextBridge 已复制返回对象之后附加不可枚举 `Symbol.for(...)` 元数据。
- 首版曾在 preload 返回前附加 Symbol。隔离 Electron 实测该 Symbol 没有跨 contextBridge 复制，导致 renderer trace 丢失。现改在 renderer world 附加；主进程收到 renderer console envelope 时从当前 main frame 取得权威 PID，并拒绝与之不一致的候选 PID。最终 main trace 与 renderer trace 使用 `rendererProcessId + requestOrdinal` 关联。
- IPC request payload 与 response enumerable shape 均未改变。Symbol 元数据不进入 JSON、`Object.keys` 或业务类型；IPC 失败时原 Error 与 message 保留。
- renderer 记录分页 IPC 往返、失败原因 hydrate、store dispatch、React commit 到下一绘制机会。safe console envelope 被 main 的 `console-message` listener 严格解析后写入现有 AgentLogger；适配当前 Electron 的事件参数签名，并兼容 details-object 形状。无效 JSON、未登记阶段、正文/额外字段均被丢弃。
- main page trace 新增 `source-spill-discovery` 与 Worker startup/queue/read/transport/exit wait 阶段； Worker transport 为 IPC/structured-clone 往返扣除 Worker 内部阶段后的诊断估算，不能和其余阶段相加重复计时。
- main trace 的随机 traceId 与 renderer 输出的关联 traceId 不同；关联依据明确为 `(rendererProcessId, requestOrdinal)`，不得按 traceId 合并。

## 验证

- `src/shared/sessionSwitchTraceMetadata.test.ts`：不可枚举标记、JSON/对象键形状不变、错误对象元数据与原错误语义、renderer-only ordinal。
- `src/renderer/services/sessionSwitchTrace.test.ts`：contextBridge 复制之后的 renderer 元数据附加、trace 字段/阶段 allowlist 与 main console 前缀。
- `electron/consoleMessage.test.ts`：Electron console-message 回调文本提取，覆盖当前 deprecated callback 参数与 details-object 形状。
- `electron/agentLogger/agentLogProjection.test.ts`：安全 envelope 白名单解析、PID 权威注入/不一致拒绝、无效数据丢弃。
- 最近 renderer/main 关联定向测试 4 files、24 passed；随后 renderer-only metadata 与真实 Electron runtime 关联日志均通过。C1 存储边界 4 files、189 passed、6 skipped。最终 C5 性能矩阵 1 file、31 passed，各性能格 30 样本。
- 首次 C6 在边界门禁通过后发现 `queries.ts` 的 Worker 计时回调 union 未包含新阶段 `source-spill-discovery`；已扩展 union。阶段关闭时再次运行 `npm run build:electron:incremental`，本次退出码 0，全部边界门禁与 Electron 编译通过；详细证据见 `p0-attribution.md`。

## 隔离 Electron 运行验证（2026-10-27）

- 使用显式 `SPACEASSISTANT_DEV_USER_DATA_DIR=/tmp/spaceassistant-session-switch-isolated-userdata` 启动编译版 Electron；该目录只含合成会话。首次 300KiB 冷读 main trace 的 `rendererProcessId=5, requestOrdinal=1`，耗时 388.75ms，cachePath `cold`。
- 修正 contextBridge metadata 与 Electron console-message 参数后，再次启动同一候选编译版，DevTools 确认 renderer trace 输出；AgentLogger 中 requestOrdinal 2–16 的 main IPC 与 renderer IPC/render/paint trace 按 `(5, ordinal)` 成对。ready 切换正文 300KiB，样本未记录正文内容。
- renderer ordinal 1 为应用启动后首个空会话分页；ordinal 2 起为实际两个合成会话交替切换。日志显示空会话也计入共同序号，因此可检测并避免错配。
- 开发版中曾出现多条 `PROJECTION_BUILD_SUPERVISOR_FAILED`，只发生在直接改写过的隔离测试库生命周期中；不作为产品故障结论。以新隔离库重建 supervisor 矩阵仍是后续生命周期复核项。

## 适用边界

目前适用于单一主 renderer frame 的 `chatGetMessagePage` preload 调用序列；新增并行 renderer frame 或额外 IPC 绕行入口时，必须将调用接入统一 renderer wrapper 并复验 ordinal 一一对应。关联元数据只标识 renderer PID 和本地序号，不包含会话 ID、正文、标题、路径或凭据。
