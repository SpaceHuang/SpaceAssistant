# T23 交付后实现评审修复

## 范围与修复

针对 2026-11-02 执行实现评审报告中的 5 项阻断，按 TDD 增加回归断言并修正实现。修复代码提交：`3668a8f0`（基于原交付文档提交 `2b1e84a3`）。

| 评审项 | 修复 | 主要回归证据 |
|---|---|---|
| R1 运行进程误报来源丢失 | 进程事实使用 running / terminal / source-gap 判别；running 保持 waiting，退出后才形成候选 | `processSource.test.ts`、`sources.test.ts`、`recovery.test.ts`：真实受管进程跨多轮恢复扫描后退出，只发生一次 waiting→matched |
| R2 活跃 Turn 首扫失败 | 宿主保留 pending 与 missing/source-gap 的区别；pending 继续等待，只有 terminal 才匹配 | `sources.test.ts`：pending 多次求值后转 terminal 才得到 candidate；已知 Turn 状态白名单，未知状态报 source-gap |
| R3 同步计数范围错配 | 登记基线保存 session 累计 settledCount 及逐 invocation 计数；在线阈值按 session baseline + 当前 invocation 相对登记基线的 delta 计算，checkpoint version 仍绑定当前 invocation | `hostService.test.ts`、`syncCheckpoint.test.ts`：两个旧 invocation 共 5 步，新 invocation 完成第 1 步后累计值为 6 并命中 |
| R4 同步触发器过期仍暂停/投递 | recovery 与 postStep 都收敛过期记录；暂停接受和投递前核验 expiresAt；delivery 拒绝已过期记录；SQLite matched CAS 同时校验事件发生时间，并对 sync checkpoint 校验匹配时间 | `sources.test.ts`、`syncCheckpoint.test.ts`、`delivery.test.ts`、`store.test.ts`：过期时不接受 pause、不 enqueue；跨过期的并发 matched CAS 失败 |
| R5 IM 无匹配记录不结束 | 完成 accepted facts 截止窗口补扫后，无匹配且已过期即转 expired；过期前接纳的消息仍可离线补命中，过期后消息不会复活 | `imSource.test.ts`、`recovery.test.ts`：空窗口到期清理、截止前事实补投、截止后事实过期；已过期行退出有界 waiting 集合 |

评审原报告文件 `docs/review/2026-11-02-agent-runtime-trigger-execution-review.md` 由仓库忽略规则排除在版本控制之外；本表记录五项结论和修复证据，不修改原报告。

## TDD 与验证

- RED：评审复现了五条生产路径。新增的最初测试矩阵暴露进程状态、Turn pending、跨 invocation 计数、sync 过期和 IM 到期缺口；之后将 IM 夹具改为真实 `imAcceptedFacts` 公共读口，避免用不匹配的 mock 误报。
- GREEN 定向回归：`npm exec vitest run electron/triggers/sources.test.ts electron/triggers/processSource.test.ts electron/triggers/syncCheckpoint.test.ts electron/triggers/imSource.test.ts electron/triggers/hostService.test.ts electron/triggers/store.test.ts electron/triggers/service.test.ts electron/triggers/delivery.test.ts electron/triggers/recovery.test.ts electron/triggers/invariants.test.ts electron/triggers/capacity.test.ts electron/sessionStorage/sessionStorage.test.ts` —— 12 files、180 tests passed。
- `npm exec tsc -- -p tsconfig.electron.json --noEmit`：通过。
- 最终 `npm test`：1272 files passed、1 skipped；12265 tests passed、140 skipped；exit 0，1426.97 秒。
- `npm run build`：tray、renderer production、Electron build 及 provider closure、session-storage cleanup/module graph gates 均通过。Vite 报告既有动态导入及 chunk size 警告。
- `npm run check:agent-sdk`、`npm run typecheck:shared`、`npm run check:system-invariant-registry`（12 registrations / 42 references）、`npm run check:message-fact-ownership`、`git diff --check`：通过；session-storage 两项边界门禁由完整构建运行并通过。

五轴复核未发现新增阻断。真实 IM/平台回调、远端生产策略、OS 休眠恢复和跨平台打包仍未实测，边界见 [T21](./T21.md) 与 [P3](./P3.md)。
