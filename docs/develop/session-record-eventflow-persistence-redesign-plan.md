# 会话记录事件流持久化重设计方案

> 状态：已落地（TDD 验证通过）
>
> 目标：一次性解决 v1–v8 复查中暴露的序号竞争、关键事件未落盘、chunk 队列无界、索引退化、重复事件和审计语义不清问题。

## 1. 设计结论

当前问题不是单个 `append()` bug，而是事件生产、排序、批处理、持久化确认和崩溃恢复没有被建模为一个完整协议。新的设计遵循以下原则：

1. 每个会话只有一个进程内 `SessionEventSink`，业务代码不能直接构造 writer。
2. 所有事件经过同一条 FIFO 提交链，由 sink 统一分配 `seq`。
3. 事件分为关键事件和流式事件：关键事件有持久化屏障，chunk 进入有界批处理队列。
4. 一批事件只做一次 JSONL append、一次 index 更新；关键事件提交前先提交所有更早的 chunk。
5. `events.jsonl` 是权威追加日志，`events.index.json` 是可重建派生索引。
6. 工具调用和 API retry 的审计事件必须在对应副作用之前提交。
7. 成功、失败、取消和顶层异常路径在返回前完成结束事件的持久化尝试。
8. 崩溃恢复只补闭事件，绝不重新执行工具或 API 请求。

核心不变量：

```text
同一 session 的落盘事件 seq 严格递增且唯一
工具执行前，对应 tool_call 已存在于 events.jsonl
下一次 API attempt 前，对应 request_retry 已提交
请求返回前，step_end / turn_end 已提交
pending chunk 的数量和字节数始终有上限
index 只能追平 JSONL，不能成为更高 seq 的来源
```

## 2. 根因分析

### 2.1 writer 所有权错误

即使提供 registry，只要业务层还能直接 `new SessionEventWriter()`，就可能绕过 registry。多个实例各自拥有 `queue`、`seq` 和初始化状态，会产生重复序号或索引回退。

### 2.2 append 责任过重

当前单条 append 同时承担初始化扫描、尾部修复、序号分配、JSONL 写入、stat、临时 index 和错误处理。把它用于每个 chunk 会让每个 delta 都支付完整的文件操作成本。

### 2.3 fire-and-forget 没有背压

不等待 Promise 只隐藏了延迟，没有限制内存队列。磁盘速度低于模型流速度时，payload 和 Promise 会持续积累；关键屏障最终仍要等待这条长队列。

### 2.4 fact 和审计混用

UI/Coordinator fact 可能被多个路径发送。由 fact bridge 隐式转换 `tool_result`，很容易产生重复结果，也无法明确哪个 owner 对审计负责。

## 3. 存储模型

保持现有目录：

```text
sessions/<sessionId>-<yyyyMMdd>/
  session.json
  messages.json
  events.jsonl
  events.index.json
```

事件格式：

```json
{"seq":42,"time":1789000000000,"type":"tool_call","payload":{"turnId":"t1","stepId":"r1","toolUseId":"u1","name":"run_shell","args":{}}}
```

索引格式：

```json
{"formatVersion":2,"seq":42,"eventCount":42,"bytes":123456,"lastAt":1789000000000}
```

索引字段必须描述同一次 JSONL batch append。索引写失败时 JSONL 仍是权威数据，重启时修复索引。

事件分类：

| 类型 | 事件 | 策略 |
| --- | --- | --- |
| turn/step 边界 | `turn_start`、`turn_end`、`step_start`、`step_end` | critical，等待提交 |
| 工具审计 | `tool_call`、`tool_result` | critical；调用前和结果事实后提交 |
| 请求审计 | `request_header`、`request_context`、`request_retry`、`request_usage` | critical |
| 流式过程 | `assistant_chunk` | buffered，批量、有界 |
| 恢复标记 | `session_end_seed` | critical |

业务幂等键：`toolUseId` 对应一条 call 和一条 result；`requestId + attempt` 对应一条 retry；`requestId` 对应一条最终 usage；结束事件按 turn/step id 幂等。

## 4. SessionEventSink

用不可绕过 registry 的 sink 替代公开 writer：

```ts
type SessionEventSink = {
  appendCritical(input: SessionEventInput): Promise<CommittedEvent>
  appendChunk(input: SessionEventInput): void
  flush(): Promise<FlushResult>
  close(): Promise<FlushResult>
}
```

通过 `getSessionEventSink(workDir, sessionId, createdAt)` 获取实例。registry key 是规范化绝对 `events.jsonl` 路径；同一路径只能有一个活跃 sink。关闭后从 registry 移除或标记 closed，不能继续接受事件。

sink 内部只有一条提交链：

```text
appendChunk ─┐
              ├─ bounded buffer → batch commit queue
appendCritical┘                         ↓
                           allocate seq → append JSONL
                                           → update index
```

序号只在 batch commit 时分配。初始化 promise 也由 sink 共享，避免并发首写执行两次。

首次初始化：创建目录、读取并校验 index、扫描 JSONL 最后合法事件、修复撕裂尾行和无换行尾行、取 `max(index.seq, jsonlLastSeq)`、重建落后 index，然后标记 initialized。正常 append 不再全量读取或排序 JSONL，只检查尾部字节。

## 5. 批量写入和背压

默认参数建议：

| 参数 | 默认值 | 作用 |
| --- | ---: | --- |
| 最大事件数 | 32 | 达到即提交 |
| 最大 batch 字节数 | 64 KiB | 防止单批过大 |
| 最大等待窗口 | 20 ms | 低流量及时提交 |
| soft pending limit | 256 events | 达到后暂停流消费 |
| hard pending limit | 512 events / 1 MiB | 绝不继续增长 |

事件数或字节数任一达到阈值即触发提交。窗口 timer 在 sink 内管理，`close()` 时取消。

`appendChunk()` 在 soft limit 以下立即返回；超过 soft limit 时，stream consumer 必须等待一次 flush 后再读取下一批；到达 hard limit 时采用硬背压。若产品允许丢弃 chunk，必须生成可观测的 `chunk_drop` 诊断事实；否则只能暂停消费，不能无界增长。

`appendCritical(event)` 的协议是：等待当前 batch timer，提交所有更早 chunk，将 critical event 放入同一 FIFO 提交链，等待 JSONL append 和 index rename 完成后返回。不能通过 `flush()` 后另起写入路径。

一次 batch commit 必须连续分配 seq、一次性写多行、一次 stat、一次临时 index + rename，并统一 resolve/reject 该 batch。`appendBatch()` 不得通过循环调用单条 `append()` 伪造批处理。

## 6. 关键时序

### 6.1 工具调用

```text
解析完整 tool_use
  → await appendCritical(tool_call)
  → 开始执行工具
  → 生成唯一 tool result
  → await appendCritical(tool_result)
  → 发送 UI/Coordinator fact
  → 发送下一轮模型请求
```

`tool_call` 和 `tool_result` 只能由 tool loop owner 写入。fact bridge 不得再转换出审计事件。每个 `toolUseId` 正常路径恰有一条 call 和一条 result，恢复路径最多补一条 synthetic result。

### 6.2 API retry

fetch wrapper 的 retry callback 必须支持 Promise：

```ts
onRetry: async (info) => {
  await sink.appendCritical({ type: 'request_retry', payload: info })
}
```

wrapper 在真实发起下一次 fetch attempt 前等待 callback。`backoffMs` 定义为前一次 attempt 完成到本次 attempt 发起之间的实际经过时间，并可附带 `previousAttemptFinishedAt`、`attemptStartedAt`；不再从 `Retry-After` 字符串猜单位。

### 6.3 请求结束和异常

统一使用幂等 `finalizeTurn(reason, error?)`，合并成功、业务失败、取消和顶层 catch：

```ts
await sink.appendCritical(step_end)
await sink.appendCritical(turn_end)
```

顶层 catch 也必须 await finalize。若写入失败，记录结构化错误并返回业务错误，但不能丢弃 Promise。`before-quit` 的 flush 只能兜底，不能替代请求路径屏障。

## 7. 失败模型和崩溃恢复

写入顺序固定为：

```text
append JSONL 成功 → committed seq 推进 → 写临时 index → rename index
```

JSONL 失败时 batch 未提交，不能推进 committed seq。JSONL 成功但 index 失败时，batch 已提交，内存 seq 必须保留；重启以 JSONL 恢复并重建 index。

如果 JSONL batch 写入失败，sink 立即进入 **fail-stop**：失败 batch 不回插到队列外，原提交链后续的 chunk 和 critical 事件全部失败，绝不允许越过失败 batch；关闭该 sink 后由新实例从权威 JSONL 恢复。这样既保持 FIFO，也避免后台自动重试形成无界等待或重复副作用。

fail-stop 会累计 `lostEvents/lostBytes`，并将失败路径附加到错误对象；因此 `flush()`、`close()` 和全局 shutdown flush 都必须失败返回，不能用清零后的 pending 计数伪装成刷盘成功。全局 flush 报错还必须包含具体 `eventsPath`，便于顶层 shutdown 日志定位。

启动恢复：先规范化尾行，再按 seq 解析，找出未闭合 turn/step/tool call，使用同一个 sink 的 critical batch 补 `step_end`、synthetic `tool_result` 和 `turn_end`。恢复只产生事件，不执行工具或 API 请求，并且重复运行结果不变。

退出顺序：停止接受新 turn → 停止流式生产 → `flushAllSessionEventSinks()` → 关闭工具、浏览器和 IM 资源 → 放行 quit。flush 有超时和结构化错误报告，超时不能伪装成成功。

## 8. 所有权边界

业务层不负责 seq、JSONL 扫描、index 更新、重试等待或 fact 转审计。业务层只表达：

- `appendCritical()`：副作用前、请求 retry 前、请求返回前；
- `appendChunk()`：高频流式过程；
- `flush()`：生命周期边界和 shutdown。

审计事件的唯一生产点：tool loop 写 tool call/result，fetch wrapper 写 retry，stream owner 写 chunk，turn orchestrator 写边界。`emitFactEvent` 只服务 UI/Coordinator。

## 9. TDD 实施计划

### Phase 0：契约

- 事件 schema、payload 校验和版本；
- seq 唯一递增；
- index 与 JSONL 权威关系；
- tool/request/turn 幂等键。

### Phase 1：单 sink 和真实 batch

- registry 返回同一实例；
- 并发 1000 事件得到 `1..1000`；
- index 落后/缺失时从 JSONL 恢复；
- index 写失败后不复用 seq；
- 1000 条 chunk 的 JSONL append/index 次数按 batch 数增长，而非按事件数增长；
- batch 失败后 sink 明确进入 fail-stop；失败 batch 不回 pending，后续 batch/critical 不得越过，关闭后可由新 sink 从 JSONL 恢复。

### Phase 2：背压

- pending 事件和字节数不超过 hard limit；
- soft limit 会暂停 stream consumer；
- 关键事件先提交更早 chunk；
- 关键事件不会被 chunk 饿死；
- shutdown 后无未提交 batch。

### Phase 3：关键时序

- 人为阻塞文件写入时，工具 executor 不早于 `tool_call` committed；
- retry event committed 后才发起下一 fetch；
- stream 抛异常时，execute 返回前可读 `step_end`/`turn_end`；
- 每个 toolUseId 只有一条 call/result；
- 多轮 request usage 可正确求和。

### Phase 4：恢复和集成

- 撕裂尾行、无换行尾行、index 缺失/落后都可修复；
- 补闭幂等且不执行工具；
- shutdown flush 后最后一个 turn_end 可读；
- 超时和写入失败无未处理 rejection。

验证命令：

```text
npm exec vitest run <focused tests>
npm run build:electron:incremental
npm run test:electron
npm test
git diff --check
```

## 10. 迁移、灰度与观测

首次打开旧目录时只修复尾行和 index，不静默重排已有合法事件；重复 seq 必须报告诊断并由显式迁移开关处理。保留 `sessionEventSinkEnabled`、chunk 模式、最大 pending 和 flush timeout 配置，便于灰度。

记录但不写入同一事件流的指标：batch 数和大小、flush 延迟、pending 峰值、chunk 丢弃数、critical barrier 失败数、index 修复数、synthetic event 数。避免诊断失败反过来阻塞审计链。

## 11. 最终验收标准

1. 同一 session 无法获得两个活跃 sink。
2. 并发事件 seq 严格递增、唯一，index 与 JSONL 一致。
3. 正常 append 不全量读取或排序 JSONL。
4. chunk 按批写入，pending 有硬上限。
5. 工具执行前 `tool_call` 已落盘；每次工具最多一条正常 result。
6. retry event 在下一次真实 attempt 前落盘，backoff 口径明确且可验证。
7. 所有返回路径的结束事件完成持久化尝试，正常成功路径已 committed。
8. shutdown flush 后没有已接受但未提交的 batch。
9. 尾行、index 和启动补闭恢复幂等，恢复不执行外部副作用。
10. Electron 全量测试、全量测试、增量构建和 diff 检查全部通过。

## 12. 推荐落地顺序

1. 实现 `SessionEventSink`、registry 和真实 `appendBatch`，禁止新代码直接构造 writer。
2. 迁移调用点，明确 critical/chunk 分类，删除 fact bridge 隐式审计转换。
3. 接入工具前、retry 前和统一 finalize 屏障。
4. 接入 chunk batching、soft/hard backpressure 和 shutdown flush。
5. 完成恢复迁移、指标和灰度开关，最后删除旧 writer 兼容层。

最终判断标准不是“append 返回了 Promise”，而是：任何外部副作用或 turn 结束边界发生时，审计日志已经成为可验证的持久化事实；高频流式路径也不会用无限内存换取表面的非阻塞。

## 13. 当前落地记录

本方案已在当前分支落地：

- `electron/sessionEvents.ts` 提供单 owner `SessionEventSink`、真实 batch commit、序号权威、尾行修复、index 原子更新、JSONL 失败 fail-stop、丢失量诊断、soft/hard 背压和失败可观测的 shutdown flush。
- Claude stream handler 已删除本地 chunk 队列，关键事件统一等待 `appendCritical()`；流式 delta 通过 sink 批量提交。
- 工具循环是 `tool_call` / `tool_result` 审计事件的唯一生产者，每个 `toolUseId` 的正常路径只写一条结果，且结果提交后才进入下一轮请求。
- retry callback 在下一次真实 fetch attempt 前等待，并记录实际 attempt 间隔；不可重试响应会结束当前 retry chain，避免相同请求误判。
- 成功、业务失败和顶层异常路径共用幂等 `finalizeTurn()`；退出时统一 flush 所有活跃 sink。
- TDD 验证：事件流 22 个 focused tests、工具审计屏障 7 个 tests、retry 2 个 tests；仓库全量 512 files / 3229 tests；Electron 增量构建通过。
