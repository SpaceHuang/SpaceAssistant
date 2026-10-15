# M4-8 清理后体积与启动复测（2026-10-04）

报告使用 M4-5 的 schema v48 合成 profile，不含用户数据。将样本复制成两份；两份都执行相同的 canonical identity 认证、write-authority 建立和 write-stopped/pending 准备。基线副本保留消息正文，处理副本用现有有界清理 API 清理一条精确身份正文，关闭/重开并完成终验，然后执行已归档的 `VACUUM`。每次 Electron 启动都复制相同的 2 个 synthetic workspace roots 和 93 B spill 到隔离 userData。

复现命令：

```sh
npm run build:renderer
npm run build:electron:incremental
node --import tsx scripts/create-session-storage-profile-fixture.ts /tmp/session-storage-profile-v48.db
node --import tsx scripts/create-session-storage-cleanup-fixture.ts /tmp/session-storage-profile-v48.db /tmp/session-storage-cleanup-v48.db
node --import tsx scripts/session-storage-maintenance-profile.ts /tmp/session-storage-cleanup-v48.db docs/develop/session-storage-refactor-maintenance-profile-2026-10-04.json 3
```

完整 profile、启动阶段样本及 VACUUM manifest 见[机器可读报告](./session-storage-refactor-maintenance-profile-2026-10-04.json)。输入 DB 运行前后 SHA-256 相同：`10766297a2ebc2391655a50c31b1dbefd46bc780c59607ee2476359c207c97fd`。

## 体积与归因

- M4-5 原始样本 DB 为 201,408,512 B。为该会话建立已认证 transcript projection/cache 与清理账本后，清理前 DB 为 202,350,592 B；其中 `canonical_session_projection_cache` 从 32,768 B 增至 503,808 B。比较这两个状态可以把清理收益与前置认证成本分开。
- 清理 1 条正文（472,600 raw bytes）并 VACUUM 后 DB 为 201,641,984 B；相对清理前状态实降 708,608 B，`page_count` 49,402→49,229，`freelist_count` 230→0。VACUUM 用时约 892 ms；报告同时记录 DB/WAL/SHM、85 个索引对象、归档字节、执行前可用空间和约 607 MB 的保守峰值空间上界。上界不是瞬时峰值观测。
- `messages` dbstat 从 18,317,312 B 降到 17,842,176 B（少 475,136 B）；4 个 History 索引及消息索引各减少一个 4 KiB 页，`PRAGMA optimize` 新增 `sqlite_stat1`/`sqlite_stat4` 合计 8 KiB。canonical event payload（170,630,555 B）、transcript snapshot（10,732,981 B）和 spill（93 B）前后不变。
- 清理后文件仍比未认证的 M4-5 原始样本大 233,472 B，因为样本原先没有该会话的投影 cache/清理账本。故本次证明的是已认证状态到清理/VACUUM 的净缩小；不会把认证准备成本隐藏掉，也不据此推断真实 profile 一定缩小。

## 启动复测

| 分段 | 清理前 p50 / p95 | 清理后 p50 / p95 |
| --- | ---: | ---: |
| 新进程至 renderer load 总耗时 | 997 / 1,049 ms | 1,001 / 1,010 ms |
| database open + migrations | 2 / 2 ms | 2 / 2 ms |
| canonical History classification | 34 / 36 ms | 35 / 36 ms |
| canonical History recovery | 5 / 5 ms | 5 / 5 ms |
| session ledger reconcile | 6 / 7 ms | 6 / 8 ms |
| renderer load 阶段 | 582 / 645 ms | 592 / 605 ms |

每侧 3 次启动；总耗时和各分段没有显示可归因的启动改善。每次都是新 Electron 进程，但 OS/文件缓存未受控；样本也只有 1 条可清理消息。不能把这些数值宣称为冷缓存、p95 门禁或生产收益。对这份样本可得出的结论是：VACUUM 确实回收了 173 页，但一次正文清理没有可测出的启动加速。
