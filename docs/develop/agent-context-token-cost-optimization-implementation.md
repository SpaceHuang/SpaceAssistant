# Agent 上下文与 Token 成本优化：实施记录

> 文档日期：2026-09-21
> 对应计划：`docs/develop/agent-context-token-cost-optimization-plan.md`（v1.4）
> 实施分支：`feature/agent-context-token-cost-optimization`（worktree `.worktrees/agent-context-opt`）
> 实施方式：TDD（每个改动先写红测试 / 更新特征化断言，再实现转绿），按计划 §6 阶段推进

## 1. 实施总览

| 阶段 | 计划项 | 状态 | 结果 |
|---|---|---|---|
| Phase 0 | 静态比对（§3.4.5） | ✅ 完成 | **定位到 2 处 wire 面真实差异**（见 §2） |
| Phase 0 | P0-1 双面埋点（§5.2） | ✅ 完成 | `messagePrefixStats` + `cacheBreakpoints` 落 `request_header` |
| Phase 0 | 核实 system/tools 读取方（§5.1.4 / N5） | ✅ 完成 | **无其他读取方**（见 §4） |
| Phase 1 | P0-2 turn 边界失效消除（§5.3） | ✅ 完成 | 2 处差异修复，rebuildParity 测试转绿 |
| Phase 1 | P1-3(a) 删 `edit_file.diff`（§5.1.3） | ✅ 完成 | 事件流不再携带 diff 全文 |
| Phase 1 | P1-3(b) `request_header` 去重（§5.1.4） | ✅ 完成 | 首见全量 + 指纹未变省略 |
| Phase 1 | P1-3(c) checkpoint 增量编码（§5.1.4c） | ✅ 完成 | 仅写相对上一请求新增的 toolUseId |
| Phase 2 | P1-4 上限下调 + 中段截断（§5.4） | ✅ 完成 | 10,000 tokens 上限，头尾保留 |
| Phase 2 | P1-5 重复读取去重提示（§5.5） | ✅ 完成 | 只提示不拒绝，护栏不受影响 |
| Phase 3 | P1-6 tools 前缀懒加载（§5.6） | ⏸ 暂缓 | 评估结论见 §6（与计划 §5.6.4 一致） |
| — | 断点位置重设计 / 轮内批量（§5.7、§9） | ➖ 不做 | 与计划一致 |

## 2. Phase 0 静态比对的结论（候选 A 实锤）

新增 `electron/claudeStreamHandlers.rebuildParity.test.ts`：测试内**前向驱动完整 turn** 捕获 `runToolChatSession` 返回的 `finalSurfaceMessages`（`messagesForApi` 是局部变量，不可事后复现——计划 §3.4.5 v1.3 更正），与次轮 `round:1` 经 `buildToolChatMessagesFromSource` → `normalizeAndValidateClaudeMessagesWithContentBlocks` 的重建产出逐 item 比对（wire 面 = `serializeProviderMessages` 口径 / surface 面 = 剥离 id/timestamp 口径）。

**首轮（修复前）捕获到 2 处 wire 面真实分歧**：

1. **skillFragments 注入位置随尾移动（最严重，分歧 item #0）**：fragment 在 turn 内插在「当时的最后一条 user 之前」（即历史最前部），但 fragment 不落 DB——次轮 `round:1` 重建历史不含上一 turn 的 fragment，前缀**从 item 0 整段错位**。若启用 skills，每个 turn 边界整个历史前缀全部失效。这与实测「#18 的 `cache_read` 几乎精确回到该 turn 起始前缀深度」的形态吻合。
2. **最终 assistant 回复的 wire 形态差异（分歧 item #末尾）**：实时累积追加 text 块数组 `[{type:'text',text:'done'}]`，历史重建输出纯字符串 `'done'`（`ensureApiTextContent`）——次轮 `round:1` 前缀从上一 turn 的最终回复处分歧，失效量 = 上一轮回复 + 新增内容。

## 3. P0-2 修复（§5.3.3 方案 1：使两条路径产出逐字节一致）

| 差异 | 修复 | 落点 |
|---|---|---|
| fragment 位置移动 | 注入位置固定为**第一条 user 消息之前**（turn 1 两种语义等价；跨 turn 位置稳定） | `toolChatLoop.ts` 初始化处 |
| assistant 内容形态 | 实时追加与 turn-boundary 快照统一经 `normalizeAssistantContentForHistoryParity`（纯 text 块数组 → `ensureApiTextContent` 同源规范化，从 `claudeToolHistory` 导出复用）；含 tool_use/thinking 块不转换 | `toolChatLoop.ts` |

修复后 rebuildParity 全部场景转绿（基础 / skillFragments / 一轮多工具）；`usageStream` 的 turn-boundary 快照特征化断言同步更新（最终回复现为字符串形态）。

**残留观察（未修复，影响面小）**：① 混合 text 多块 + tool_use 的轮，重建侧合并为单 text 块而实时侧保留多块（罕见）；② thinking 开启时实时侧保留 thinking 块而重建不重建（与 effort 链路相关，超出本计划范围）。

## 2.1 代码评审修复（2026-09-21，评审：docs/review/20260921-agent-context-token-cost-optimization-code-review.md）

评审结论：无 P0；2 个 P1 建议合并前处理 + 2 个主要观察。处理记录：

**P1-1（已修复）：read_file 去重仅以 mtime 判新鲜度，可与 edit 护栏形成不可自愈死循环。**
FAT32 2s 精度 / 同步软件保留时间戳时 mtime 相同但内容已变：read 返回提示（空内容）→ edit 护栏内容比对报「外部修改请重读」→ 重读又命中提示。双层修复：
- 读侧：`FileState` 增加 `size?: number`（完整快照的磁盘字节），去重判定改为 mtime + size 双重校验（size 缺省保守放行重读）；
- 护栏侧：`assertDiskMatchesReadCache` 报「外部修改」时失效缓存（edit/write 两处调用），保证随后重读必然绕过提示拿到真实内容——同 size 同 mtime 的极端改动也自愈。
测试：`builtinExecutors.fileState.test.ts` 两个评审场景（不同 size / 同 size 同 mtime）。

**P1-2（已修复）：`isTruncatedToolResultContent` 仅 `.includes()` 判幂等，天然包含 marker 字面量的超限原文（如 grep 本仓库源码）会跳过压缩，最坏 2 MiB 原文进上下文。**
修复：幂等识别加长度约束——「含 marker 且长度 ≤ maxChars + marker 预算（400）」；真截断产物长度必 ≤ maxChars，天然含 marker 的超限原文不再误判。测试：`oversizedToolResult.test.ts` 评审场景。

**观察 1（已修复）：tool_use 轮中空白 text 块的 parity 缺口。**
重建侧只保留非空白正文（`m.content?.trim()` 判断），实时侧若保留空白 text 块，混合数组与前缀从该项分歧。`normalizeAssistantContentForHistoryParity` 规范化前先剔除空白 text 块。测试：`rebuildParity.test.ts` 新增场景（空白 text + tool_use 轮）。

**观察 2（记录，不改）：埋点对 text 形态分歧（数组 vs 字符串）的监控盲区。**
这是 `canonicalizeSurfaceMessages` 口径的固有特性而非缺陷——计划 §5.2.3-1 明确要求 messages 面比较基于「模型可见语义」（剥离 cache_control、合并纯 text 块数组），形态差异在该口径下不可见是**有意为之**（否则 §3 的形态修复会表现为每次 turn 边界的假分歧）。wire 面形态分歧由独立的 `cacheBreakpoints`（positions/tailIsString/moved）覆盖观测；若未来需要形态级取证，可在 messages 面旁增设「wire 严格口径」的第二组 digest，属增强项。


## 4. Phase 0-3 调研结论（P1-3(b) 前提）

- `request_header` 的唯一程序化读取方 `computeContextPressureFromEvents`（`contextMeter.ts`）只读 `requestId` + `surfaceSnapshot`，**不读 `system`/`tools`**；
- 渲染层对 `request_header` 事件零引用；`payload.tools` 的全部命中均为配置 IPC 链路（configIpc/configSlice/toolExposureService），与事件流无关；
- 结论：N5 判断成立，去重对任何读取方无影响。压缩 summary 的 checkpoint 走内存对象（`onTurnBoundary`），不读事件流——P1-3(c) 增量编码的读取方风险为零，但 `onTurnBoundary` 必须继续传**全量**（恢复语义），已同步修正。

## 5. 实现要点与落点

### P0-1 双面埋点

- `src/shared/requestContext.ts`：
  - `MessagePrefixStats`（itemCount/prevItemCount/commonPrefixItems/firstDivergedIndex/divergedReason/prevItemDigest/currItemDigest）；`computeMessagePrefixStats` + `digestSurfaceItems`（canonicalizeSurfaceMessages 口径，剥离 cache_control；prev 只存 digest 列表，§5.2.3-6 内存口径）；
  - `CacheBreakpoints`（count/positions/tailIsString/prevPositions/moved）；
  - `RequestHeaderPayload` 追加两个可选字段，既有 10 字段不变（§7.1 断言 7）。
- `electron/claudeToolLoopStreamParams.ts`：`computeCacheBreakpointPositions` 与注入逻辑同文件同源；消息级断点不受 cacheControl 开关控制（与实现一致）。
- `electron/toolChatLoop.ts`：按 `contextWindowId`（缓存域）维护跨 turn prev 状态（digests + 断点位置 + header 指纹 + checkpoint 全量，上限 500 域）；`request_header` 事件自动携带埋点。
- **运行时验证**（headerEconomy 集成测试）：`round:2` 的 `cacheBreakpoints.positions=['system']`（消息级断点消失）且 `moved=true`、messages 面 `divergedReason='appended'`——与生产实测形态一致，为候选 B 结案提供运行时证据（§5.3.4）。

### P1-3 事件流体积

- (a) `AutoApprovedWriteMeta` 删除 `diff` 字段（`domainTypes.ts`）+ 写入点移除（`toolChatLoop.ts`）；`path/added/removed/bytesWritten` 保留。实测收益 ≈10.83 MB/会话。
- (b) `elideConstantHeaderFields`（requestContext.ts 纯函数）：首见或指纹变化写全量，指纹未变省略 `system`/`tools`（指纹引用保留在 surfaceSnapshot）；`lastRequestHeader` 本体保持完整版，elide 只作用于事件流落盘副本；测试验证 `computeContextPressureFromEvents` 结果不变。收益 ≈13.65 MB/会话。
- (c) `completedToolUseIds` 改为增量（类型注释声明语义）；`onTurnBoundary` 改传现场全量。收益 ≈0.81 MB/会话。

### P1-4 中段截断

- `toolResultLimits.ts`：`TOOL_RESULT_MAX_TOKENS = 10_000`；`MAX_TOOL_RESULT_CONTENT_CHARS = ceil(10_000 × 3.5) = 35_000`（不再同源 2 MiB）。
- `READ_FILE_MAX_CHARS` 保持 2 MiB（执行器能力不变）；`MAX_API_MESSAGE_TEXT_CHARS` 保持 2 MiB（IPC 防御性上限独立，§5.4.4 评估后不动）。
- `oversizedToolResult.ts`：`compactOversizedToolResultContent` 改中段截断——保留头（70%）+ 尾（30%）+ 标记（`…[tool_result truncated: N chars omitted…; originalLength; estimatedTokens; totalLines]`）+ read_file offset/limit 指引；旧版占位符幂等识别保留（历史会话兼容）。
- 特征化测试同步更新：`claudeToolHistory.test.ts`、`claudeStreamHandlers.pairing.test.ts`（占位符断言 → 截断断言，`is_error`/pairing 语义保持）。

### P1-5 重复读取提示

- `builtinExecutors.ts` `readFileExecutor`：完整读取（无 range）且 FileStateCache 中存在**完整快照**（`!isPartial && !isRangeView`）且 mtime 未变时，返回 `{ path, content:'', unchangedSinceLastRead: true, byteSize, note }` 而不重发全文。
- 逃生通道：需要区间传 `offset/limit`；需要全文传 `offset=0`。不写缓存 → `edit_file` 的 hasBeenRead/磁盘一致性护栏不受影响（测试覆盖）。

## 6. P1-6 评估结论（暂缓）

按计划 §5.6.4 / §9 维持**暂缓**，本轮不做实现。评估依据：

1. **收益上限 ≤3.3%**（≤179,872 等效 tokens），且当前命中率已 98.16%，收益在基数不在命中率；
2. **风险与本次修复的核心资产冲突**：tools 前缀稳定性（`toolsFingerprint` 恒定）是 98.16% 命中率的根基；懒加载必然引入 tools 集合动态变化，若没有 Codex 式「内容寻址 id + append-notice」双保障，每轮前缀失效反而恶化——而候选 A 的教训（本文档 §2）恰恰说明前缀稳定性破坏的代价远大于收益；
3. **前置条件未满足**：P1-6 需要「按需检索加载」的工具暴露层改造（ToolExposure::Deferred + BM25 量级），属专项方案，不适合随本计划搭车实施。

**重启条件**：若埋点运行数据显示 tools 前缀在长会话成本占比显著上升，或 MCP 工具数量增长使初始 tools 超过上下文预算的合理比例，再立项专项方案。

## 7. 测试清单

| 测试文件 | 覆盖 |
|---|---|
| `electron/claudeStreamHandlers.rebuildParity.test.ts` | Phase 0 静态比对（wire/surface 双口径 + 特征化报告） |
| `src/shared/requestContext.prefixStats.test.ts` | §7.1 messages 面断言 1–7 |
| `electron/claudeToolLoopStreamParams.cacheBreakpoints.test.ts` | §7.1 wire 面断言 8–10 |
| `electron/toolChatLoop.headerEconomy.test.ts` | P0-1 + P1-3(b)(c) 集成（两请求轮） |
| `src/shared/requestContext.headerElide.test.ts` | §7.2 断言 6–9（去重 + 读取侧等价） |
| `src/shared/oversizedToolResult.test.ts` | P1-4 中段截断（含幂等/历史兼容） |
| `electron/tools/builtinExecutors.fileState.test.ts`（新增 describe） | P1-5 四场景（含护栏回归） |
| `electron/toolChatLoop.fileAutoApprove.test.ts` | P1-3(a) 回归 + §7.2 断言 4 |
| `electron/toolChatLoop.usageStream.test.ts` | turn-boundary 快照特征化更新 |

## 8. 验收对照（计划 §7.3 总验收）

1. **可观测（双面）** ✅ ——任意 `request_header` 可回答「messages 在第几项分歧、是追加还是替换」与「wire 断点位置、是否移动」；
2. **归因闭环** ✅ ——静态比对定位 2 处具体环节（fragment 位置 + assistant 形态）并修复；候选 B 的运行时证据形态（round:2 无消息级断点 + moved=true）已可落盘结案；
3. **口径正确** ✅ ——体积论断标注面；P1-3 收益按 UTF-8 字节；P1-4 上限改 tokens 口径；
4. **无效果损失** ✅ ——edit_file 诊断集成测试、护栏测试、pairing 测试全绿；
5. **前缀不退化** ✅ ——本轮全部改动不触碰 system/tools 内容生成路径（elide 只作用于落盘副本），指纹生成逻辑未动；
6. **命中率** ——运行时指标，需真实会话复测（见 §9 待验证项）；
7. **磁盘** ——预期 events.jsonl 下降 ≈20%（10.83 + 13.65 + 0.81 MB 口径），需真实会话复测；
8. **零安全回退** ✅ ——`sanitizeAgentText` / `projectGenericData` / 写路径四道护栏未改动（P1-5 只读缓存）。

## 9. 待真机验证项（无法单测验收）

- **命中率与失效量**：修复后需在真实长会话中观察 `round:1` 未命中合计是否显著低于 438,640 基线（埋点已提供 `firstDivergedIndex`/`divergedReason`/`cacheBreakpoints.moved` 观测面）；
- **events.jsonl 体积**：需一个真实会话生命周期验证 ≈20% 的下降比例；
- **skillFragments 位置变化的模型体感**：fragment 移至会话开头后对长会话中模型注意力的影响，建议观察一轮真实使用后评估是否需要在 checkpoint/摘要机制中补偿。
