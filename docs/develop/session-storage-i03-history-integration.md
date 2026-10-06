# I-03 canonical History/projection transition 集成记录（2026-10-05）

## 集成合同

- 保留 `origin/main` 的 invocation-context/transcript-compacted replacement 语义、required user boundary 保留和跨 invocation snapshot 稳定身份 fold。
- 同时保留存储分支稳定 message ID 到/从 canonical model transcript 的映射；重复 snapshot 用 ID 对齐并更新既有位置，不将被替换 context 错误追加。
- projection fold 对 tool declaration/result 与 approval 生命周期采用既有 canonical transition 校验；malformed/未完成 dispatch 依终态规则 fail closed。session transcript 抽取不把工具执行结果当正文；消息骨架继续持有工具/审批流程状态。
- cache watermark 必须匹配 live session/generation、事件数和精确 anchor 的 event/invocation/session sequence/commit order；owner 或 allocator 漂移使 L1/L2 按协议失效。
- canonical-only session 在 legacy `messages.content` 缺失时仍只由 canonical owner 提供正文，不允许降级为空 legacy transcript。

## TDD finding

发现 snapshot suffix 比较用 `ids.join('\0')` 生成非唯一编码：message ID 本身含 NUL 时，`['a\0b','c']` 与 `['a','b\0c']` 会编码为相同字符串，导致重排的 overlap 被错误接受。

- 红：临时恢复旧 join 比较，`npx vitest run electron/runtime/canonicalHistory.test.ts -t "comparison separator"` 失败；断言原因为“expected [Function] to throw an error”。
- 绿：按索引逐个比较两个 ID 序列，同命令 1/1 通过。
- 改动：`electron/runtime/canonicalHistory.ts`；回归在 `canonicalHistory.test.ts`。

## 验证

- `canonicalHistory.test.ts`、`sessionTranscriptProjection.test.ts`、`sqliteAgentHistory.test.ts`：3 files / 307 tests 通过。
- 上述 suites 覆盖 replacement snapshots、稳定 ID/overlap fold、匿名 replay 过滤、pending tool 的 interrupted 语义、tool/approval transition、watermark/owner/generation 认证与 canonical-only cache miss。
- `npx tsc -p tsconfig.electron.json --noEmit`、`npm run typecheck:shared`、`npm run typecheck:agent-sdk`、`git diff --check` 均通过。
- 未运行模型请求或真实数据；fixture 均为隔离测试数据库。

## 状态

I-03 完成，无未处置 History/projection finding。下一项按顺序为 I-04 IPC 安全与 session 生命周期；I-05 outbound、I-06 标题仍留待各自切片。
