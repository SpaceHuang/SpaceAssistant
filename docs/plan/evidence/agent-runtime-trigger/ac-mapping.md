# AC / INV 实现证据索引

此表定位当前源码上的可执行证据；局部测试通过不替代 T21 对当前最终 SHA 的门禁和审查。

| AC | 可执行证据 | 核验范围 / 仍留边界 |
|---|---|---|
| AC-01 | `electron/triggers/protocol.test.ts`、`electron/triggers/service.test.ts`、`electron/capabilities/handlers/runtimeTrigger.test.ts`、`electron/capabilities/match.test.ts`、`electron/capabilities/toolkitTool.test.ts`、`src/shared/skillPrompt.test.ts` | 参数严格校验、owner 宿主注入、五种能力发现与调用入口。 |
| AC-02 | `electron/triggers/sources.test.ts`、`electron/triggers/recovery.test.ts`、`electron/runtime/hostedTurnHandoff.test.ts` | 精确 Turn 来源及持久 Turn 终态对账。 |
| AC-03 | `electron/triggers/sources.test.ts`、`electron/triggers/syncCheckpoint.test.ts`、`electron/triggers/capacity.test.ts` | settled step 事实、增量追加、阈值基线；容量夹具对比 5000 项重建与单步追加。 |
| AC-04 | `electron/triggers/processSource.test.ts`、`electron/tools/runShellExecutor.test.ts`、`electron/tools/runScriptExecLogging.test.ts` | 受管进程身份、退出事实、generation 边界；任意系统进程不在观察面。 |
| AC-05 | `electron/triggers/imSource.test.ts`、`electron/database/imInbox.test.ts`、`electron/triggers/migration.test.ts` | 双渠道 accepted facts 分页、>100 项后页命中、coverage 变化和旧行未知身份。 |
| AC-06 | `electron/triggers/sources.test.ts`、`electron/triggers/service.test.ts`、`electron/triggers/capacity.test.ts` | 绝对时间等值命中、离线且未过期补发、到期容量释放；性能样本记录在 T19.md。 |
| AC-07 | `packages/agent-sdk/test/turn.test.ts`、`electron/triggers/syncCheckpoint.test.ts`、`electron/triggers/recovery.test.ts` | 生命周期暂停、超时动作、SDK 接纳前不派发、准确 receiver 完成与在线取消。 |
| AC-08 | `electron/triggers/queueContract.test.ts`、`electron/database/imInbox.test.ts`、`electron/turnRuntime.test.ts`、`electron/triggers/receiverStarter.test.ts` | trigger receipt 与平台 inbox 消费者隔离、单一启动资格和普通 receiver starter。 |
| AC-09 | `electron/triggers/recovery.test.ts`、`electron/triggers/imSource.test.ts`、`electron/triggers/migration.test.ts`、`electron/triggers/syncCheckpoint.test.ts` | 固定 request receipt 恢复、IM 分页补扫、schema 升级/旧整库副本恢复；外部授权服务不在本地模拟范围。 |
| AC-10 | `electron/triggers/service.test.ts`、`electron/triggers/syncCheckpoint.test.ts`、`electron/triggers/invariants.test.ts`、`electron/triggers/recovery.test.ts` | cancel/match CAS、等待超时/取消、终态不复活、重试上限。 |
| AC-11 | `electron/triggers/hostService.test.ts`、`electron/triggers/hostAuthorization.test.ts`、`electron/triggers/processSource.test.ts`、`electron/capabilities/handlers/runtimeTrigger.test.ts` | 可见目标、宿主来源身份和 generation 校验。 |
| AC-12 | `electron/triggers/authorization.test.ts`、`electron/triggers/runtimeMaterials.test.ts`、`electron/sessionStorage/sessionStorage.test.ts`、`electron/runtime/hostedTurnHandoff.test.ts` | authorization/final-check、首次历史接纳原子性、失败 raw 拒绝、合法 admission 撤权后可复用；T15/T16 记录崩溃窗口证据。 |
| AC-13 | `electron/sessionStorage/sessionStorage.test.ts`、`electron/triggers/queueContract.test.ts`、`electron/triggers/migration.test.ts`、`electron/runtime/hostedTurnHandoff.test.ts` | 普通历史一致性、队列幂等与未派发取消、旧 schema 数据及整库副本恢复。 |
| AC-14 | `electron/triggers/invariants.test.ts`、`electron/triggers/capacity.test.ts`、`electron/triggers/recovery.test.ts`、`electron/triggers/syncCheckpoint.test.ts` | seed `0x51a7`、128/4096 容量、到期释放、重试上限和独立 SDK pause 生命周期。 |

## 全局不变量

| INV | 主要测试证据 |
|---|---|
| INV-01 | `service.test.ts`、`store.test.ts`、`invariants.test.ts` |
| INV-02 | `delivery.test.ts`、`queueContract.test.ts`、`receiverStarter.test.ts`、`recovery.test.ts` |
| INV-03 | `packages/agent-sdk/test/turn.test.ts`、`syncCheckpoint.test.ts` |
| INV-04 | `sources.test.ts`、`imSource.test.ts`、`processSource.test.ts` |
| INV-05 | `authorization.test.ts`、`runtimeMaterials.test.ts`、`queueContract.test.ts`、`sessionStorage.test.ts` |
| INV-06 | `recovery.test.ts`、`service.test.ts`、`invariants.test.ts`、`syncCheckpoint.test.ts` |

## 未验证的真实外部边界

真实飞书/微信账号投递、Electron 休眠/恢复与系统时间跳变、不同 macOS/Windows 发行构建、真实生产策略服务及用户数据库恢复操作不由本地测试替代。U-04 仍标记未实测；运行时恢复只能按 T20 中整库副本路径演练，不用删表或降 schema 版本作为回滚。
