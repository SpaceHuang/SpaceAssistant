# 会话存储体积与启动基线（合成工程样本）

| 字段 | 内容 |
| --- | --- |
| 采样日期 | 2026-10-04 |
| 样本类型 | 合成 SQLite 数据库；不含用户数据 |
| Schema | v48 |
| 数据集生成器 | [`scripts/create-session-storage-profile-fixture.ts`](../../scripts/create-session-storage-profile-fixture.ts) |
| 画像命令 | `npx tsx scripts/session-storage-profile.ts <fixture-db-path>` |
| 启动命令 | `npx tsx scripts/session-storage-cold-start-profile.ts <fixture-db-path>` |
| 冷启动范围 | 新 Electron 进程创建至 renderer `loadURL` 完成；OS/文件缓存不受控，单次观测 |

## 样本规模与文件体积

样本生成器按已有画像中的消息、transcript 和 canonical 体积量级填入合成正文，使用当前 schema 和真实启动恢复代码。它适合重复验证采集器、观察接近 200 MB 的数据库启动分段；canonical event 行数少于历史画像，正文内容也不代表真实会话语义，因此本结果不代表生产工作负载、缓存冷态或 p95。

| 指标 | 结果 |
| --- | ---: |
| Sessions | 144 |
| Messages | 335 |
| Transcript snapshots | 177 |
| Canonical streams / events | 182 / 546 |
| DB 文件 | 200,458,240 B |
| WAL / SHM | 0 B / 32,768 B |
| DB + WAL + SHM | 200,491,008 B |
| dbstat 表/索引对象 | 131 |
| `page_size` / `page_count` / `freelist_count` | 4,096 B / 48,940 / 0 |
| `auto_vacuum` | `NONE` (0) |
| `agent_history_events` dbstat | 170,717,184 B，41,679 pages |
| `messages` dbstat | 17,842,176 B，4,356 pages |
| `session_transcript_entries` dbstat | 10,878,976 B，2,656 pages |
| Canonical event payload bytes | 170,157,844 B |
| Message text columns | 17,413,300 B |
| Transcript snapshot JSON | 10,732,395 B |
| Spill | 0 B |

## 单次启动样本

| 阶段 | 耗时 |
| --- | ---: |
| `database.open-and-migrations` | 2 ms |
| `canonical-history.classification` | 34 ms |
| `canonical-history.recovery` | 258 ms |
| `session-ledger.reconcile` | 2 ms |
| `app.start-to-renderer-loaded` | 825 ms |
| 进程启动至 renderer load 总耗时 | 1,226 ms |

Renderer 加载结果为 `ok`。采样时间为 2026-10-04 13:20 UTC。应用版本 `0.2.4`，Electron `44.1.1`，Electron Node `24.19.0`，Electron SQLite `3.53.3`。采集器运行环境为 macOS `25.5.0` arm64、Node `26.4.0`、SQLite `3.53.3`。

## 解释边界

- 这是一次本机新进程启动观测，不是多次运行统计，也不是 OS/文件缓存冷启动。
- 样本是容量近似合成数据；事件数为 546，低于历史样本的 3,895，因此阶段耗时只用于本机工程回归参考。
- `messageBodyCoverage` 不用于该合成样本的迁移资格判断；样本消息与 canonical 内容刻意独立生成。
- 该基线满足 M4-4 的工具与同库采样交付。慢设备、真实生产分布及发布后样本属于后续观察，不阻断独立功能开发。
- 可在相同代码、同一生成器和命令下重建样本；M4-8 复测应沿用该数据集与缓存条件，并单独说明代码变更。
