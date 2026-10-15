# M4-8 清理后体积与启动复测（2026-10-05）

本次沿用 M4-5 的无用户数据合成负载，以当前 schema v50 重建 144 sessions、335 messages、177 transcript snapshots、182 canonical streams/546 events 的数据库。测试将数据库分别制成 before 与 after：两侧执行相同认证/停写准备，after 另清理一条精确身份正文、重开验收并执行 `VACUUM`。每次 Electron 启动均复制相同 workspace roots 与 spill 到独立 userData。

复现命令：

```sh
node --import tsx scripts/create-session-storage-profile-fixture.ts /tmp/session-storage-profile-v50.db
node --import tsx scripts/create-session-storage-cleanup-fixture.ts /tmp/session-storage-profile-v50.db /tmp/session-storage-cleanup-v50.db
node --import tsx scripts/session-storage-maintenance-profile.ts /tmp/session-storage-cleanup-v50.db docs/develop/session-storage-refactor-maintenance-profile-2026-10-05.json 5
```

启动测量为 5 组配对新进程；组内 before/after 次序交替。p50/p95 使用线性插值分位数；每对原始耗时、先后次序和差值保存在 [机器可读报告](./session-storage-refactor-maintenance-profile-2026-10-05.json)。OS/文件缓存未受控，五组样本只作本机工程参考。

## 体积与归因

- 合成输入 DB 的 SHA-256 前后均为 `e0a47708727c087bc6311942a3429e1c141d7857c2a9fb1bf7377c8d9e1cfbd8`。生成和测量均未触碰真实 profile。
- 认证及清理账本准备使 DB 从 201,437,184 B 增至 202,379,264 B（+942,080 B）。清理一条 472,600 B 正文并 VACUUM 后为 201,670,656 B，较清理前减少 708,608 B、173 页；`freelist_count` 从 230 降至 0。archive 为 202,379,357 B，VACUUM 用时约 837 ms，峰值空间 607,170,653 B 是保守估算而非瞬时采样。
- `messages` dbstat 从 18,317,312 B 降至 17,842,176 B。canonical event payload（170,630,555 B）、transcript snapshot（10,732,981 B）与 spill（93 B）保持不变。清理后文件仍比未经认证的输入大 233,472 B；认证账本和 cache 成本单独保留在归因中。

## 启动测量

| 指标 | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| 新进程至 renderer load | 905 / 1,770.8 ms | 866 / 941.6 ms |
| database open + migrations | 2 / 6 ms | 2 / 2 ms |
| canonical History classification | 33 / 38.6 ms | 32 / 32.8 ms |
| canonical History recovery | 5 / 8.2 ms | 5 / 5.8 ms |
| session ledger reconcile | 6 / 9.2 ms | 6 / 6 ms |
| renderer load 阶段 | 517 / 733 ms | 501 / 535.8 ms |

五组配对的总启动差值（after−before）中位数为 **−2 ms**；before 首次样本 1,983 ms 显示启动噪声显著。总耗时各组差值为 −1,117、−55、+32、−2、+38 ms，不能将组间 p50 差异归因于正文清理。数据库分类 p50 差约 1 ms、恢复相同，远小于整体启动波动。本次确认逻辑清理与 VACUUM 可以实降数据库文件；**没有证明启动耗时改善**。不外推至冷 OS 缓存、慢设备或真实生产分布。

## 解释边界

- 只清理一个合成消息；事件数 546，低于历史画像的 3,895。
- 启动时每份 DB 都复制到新 userData 并启动新 Electron 进程，但操作系统文件缓存没有清理或控制；“新进程”不等于“冷 OS 缓存”。
- 五组样本中 p95 对单次高噪声敏感；此处用于描述样本，不作为性能门禁通过证据。项目不得据此宣称启动更快。
- M4-8 的工程测量和体积归因已完成；性能目标结果为未证明通过。生产规模/慢设备观察属于发布后观测，不阻断本地功能开发。
