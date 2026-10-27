# P3-04 分页查询接入与两阶段复核

日期：2026-10-27

前置：P3-03 `3a5aca0a`
范围：会话消息分页的 ready 缓存读取、cold source locator 查询、后台回填等待和并发校验；未改 IPC、preload 或消息页 API 形状。

## RED / GREEN

- RED：新增冷页查询用例，要求 locator 完整时直接返回本页正文、不等待全局投影准备，并在来源变化时重新选择页面。初始路径只会等待投影准备，无法满足该行为。
- GREEN：`readChatPageAfterPreparation` 先尝试有效的分页缓存；缓存不可用时尝试本页 source locator；locator 未完成时请求注册的后台回填 owner，并异步等待数据库状态，不在调用线程重放完整 History。无可调度 owner 时保留既有准备/回退路径。
- 两阶段复核：开始时固定会话代次、source identity 和页骨架；Worker 在后台读取且校验本页 locator 正文与必需 source spill；返回后重新验证 source identity 和页骨架。source revision/page drift 最多重新选择一次；损坏的来源 blob 明确失败，不吞错回退到旧正文。
- ready 路径先按缓存分页块读取，不扫描 locator。cold 路径仅查询当前页的 canonical message IDs 与对应 locator；source spill 依赖读取由 P3-03 的按页依赖读取器限制在目标页。
- 旧会话回填与单页请求并发的集成用例确认等待期间 event loop 继续运行；回填完成后冷页读回来源正文，不调用投影准备。准备中的 source locator 不以部分页面对外可见。

## 调用边界核对

`rg -n "readChatPageAfterPreparation\\(|readSourceChatPage\\(" electron --glob '!**/*.test.ts'` 结果：生产入口只有 `electron/ipc/agentProtocolIpc.ts` 的两处分页 IPC 调用；两处均经过 `readChatPageAfterPreparation`。`readSourceChatPage` 只有 session storage 内部 query 接入，没有绕过公开协调器的生产调用。IPC / preload 参数与返回类型未变。

## 验证

```text
npx vitest run electron/sessionStorage/application/readChatMessages.test.ts electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfill.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceDependencyReader.test.ts electron/sessionStorage/pageBodyReadPrototype.test.ts electron/sessionStorage/projectionPageSourceFallback.test.ts electron/sessionStorage/sessionSwitchPerformance.test.ts electron/sessionStorage/sessionStorage.test.ts
7 files passed; 118 tests passed; 24 skipped (scale benchmark cases require the dedicated opt-in environment); 0 failed
```

```text
npx vitest run electron/sessionStorage/sqliteProjectionBuildTask.test.ts -t 'prepares a chatBodyV1 scope|loads accepted turn context|segments one oversized spilled message item' --testTimeout=120000
1 file passed; 3 tests passed; 8 skipped; 0 failed; no unhandled errors
```

```text
npm run build:electron:incremental
exit 0：pi-ai runtime closure、session-storage cleanup/module graph（31 个 illegal-edge probes）、agent provider build 与 Electron TypeScript 编译通过。

git diff --check
通过。
```

生产调用点审计：

```text
rg -n "readChatPageAfterPreparation\\(|readSourceChatPage\\(" electron --glob '!**/*.test.ts'
```

## 相邻失败与范围

本轮曾对 `sqliteProjectionBuildTask.test.ts` 全文件运行回归。其中两个大历史 projection preparation 用例失败并抛出 `PROJECTION_PREPARATION_DEFERRED_LARGE`：

- `segments a canonical-writable single History event above the source staging cap`
- `segments large same-snapshot message facts instead of embedding them in the root manifest`

这两个用例执行 `ensureChatBodyV1` 构建任务，不经过本次新增的 `readSourceChatPage` 冷页路径；本任务未修改该构建/归约路径。它们的独立修复与验收不计入 P3-04 通过项，也未被本记录宣称通过。P3-06 的规模矩阵、旧会话后台完成时间及峰值内存仍待后续任务验收。
