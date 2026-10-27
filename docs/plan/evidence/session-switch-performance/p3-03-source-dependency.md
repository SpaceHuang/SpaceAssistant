# P3-03 本页来源依赖归约

日期：2026-10-27  
实现提交：`15e1a6a8`；来源样本对拍测试：`b22a59eb`（位于本计划 worktree）  
前置：P3-02 `a2c8f138`  
范围：canonical History 分段页、source locator backfill reducer 与按页来源依赖读取；未改数据库 schema 或对外 API。

## RED / GREEN

- RED：`projectionSourceArtifactStaging.test.ts` 新增 33 MiB 正文的分段来源 Worker 探针。初次运行因 segmented History event 被当成普通 snapshot 解析而失败：`invalid canonical transcript snapshot: segmented-source-context`。
- GREEN：来源读取器在超过 32 MiB 但不超过既有 128 MiB segmented budget 时，把 message/fact segments 复制到受限临时目录，主进程只传递 manifest/locator；source reducer Worker 验摘要并逐消息归约。33 MiB 正文被完整读回，摘要一致。
- 端到端 GREEN：`projectionInvocationSourceReader.test.ts` 从 SQLite History 与 message facts 构造超过 32 MiB 的真实来源页，经 source reader 和 source reducer Worker 完整往返；主进程拿到的 invocation 序列化小于 20 KiB、`messageFacts` 为空，最终正文长度与 SHA-256 均匹配源正文。iterator 结束后临时目录消失。
- 失败释放：模拟页序号错误，确认 invocation 组装失败仍会释放分段文件。

## 来源与页范围验证

- `projectionChatBodySourceReducer.test.ts` 对 compaction、required-user ID、跨事件 assistant 正文聚合、图片块与 `tool_use` 块进行 source locator 输出断言；生产 reducer 矩阵另外覆盖 compaction 覆盖旧 ID、assistant chunks、replay 图片、assistant 图片与 tool_use、tool lifecycle 依赖及 mixed authority。
- `projectionSourceDependencyReader.test.ts` 以目标页消息 locator 读取依赖：100 条无关 History 事件不增加目标页 payload 读取量，实际 `payload_json` 查询只返回目标页所需的一行；坏掉无关事件正文不影响目标页。缺 locator、缺 invocation 事件与 source event drift 均明确失败。
- source spill 丢失/摘要错误仍由 chunk reader 和 dependency reader 的现有 fail-closed 覆盖；本任务没有加入全历史同步重放。

## 验证

最终 source-reader/Worker 重点复跑：

```text
npm exec vitest run electron/sessionStorage/infrastructure/sqlite/projectionInvocationSourceReader.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceArtifactStaging.test.ts
2 files passed; 10 tests passed; 0 failed
```

P2 来源定位原型矩阵与 P3 生产来源链路联合回归：

```text
npm exec vitest run electron/sessionStorage/infrastructure/sqlite/projectionInvocationSourceReader.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceArtifactStaging.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceDependencyReader.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSegmentedChatBodyReducer.test.ts electron/sessionStorage/infrastructure/sqlite/projectionChatBodySourceReducer.test.ts electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfill.test.ts electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfillTask.test.ts electron/sessionStorage/pageBodyReadPrototype.test.ts
8 files passed; 39 tests passed; 0 failed
```

最终 Electron TypeScript 检查：

```text
npx tsc -p tsconfig.electron.json --noEmit
exit 0
```

本阶段增量构建期间，pi-ai runtime closure、session-storage cleanup/module graph（31 个 illegal-edge probes）与 agent provider 构建通过；最终代码类型另由上面的 `tsc --noEmit` 复核。`git diff --check` 通过。

## 边界与未覆盖

- segmented source 页仍遵守 chunk reader 的 128 MiB 上限；超过该规格上限会显式 deferred/fail，不在本任务中提高存储预算。
- 本任务证明大分段回填不在主进程物化正文，不代表首次冷页已经绕开全量 projection prepare。冷页按依赖读取与公开 query 接入留在 P3-04。
- 性能全矩阵、峰值 RSS、旧历史的后台完成时间留在 P3-06；AC-7 外部安装包验收仍未关闭。
