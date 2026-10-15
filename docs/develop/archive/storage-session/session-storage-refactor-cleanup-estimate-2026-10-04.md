# M4-5 清理空间估算基线（2026-10-04）

本报告使用 schema v48 的合成 SQLite profile，不含用户数据。先生成 M4-4 profile，再复制为清理估算样本，并在副本中加入两个 workspace roots、合成台账目录、spill 文件和一个独立、可认证的 canonical 会话及精确身份正文候选。估算器只读运行；运行前后 DB SHA-256 均为 `10766297a2ebc2391655a50c31b1dbefd46bc780c59607ee2476359c207c97fd`。

复现命令（在仓库根目录执行）：

```sh
node --import tsx scripts/create-session-storage-profile-fixture.ts /tmp/session-storage-profile-v48.db
node --import tsx scripts/create-session-storage-cleanup-fixture.ts /tmp/session-storage-profile-v48.db /tmp/session-storage-cleanup-v48.db
node --import tsx scripts/session-storage-cleanup-estimate.ts /tmp/session-storage-cleanup-v48.db
```

机器可读的完整估算结果见[JSON 报告](./session-storage-refactor-cleanup-estimate-2026-10-04.json)。

## 样本与估算结果

- SQLite schema 48；DB 201,408,512 B；WAL/SHM 为 0；page size 4,096 B，page count 49,172，freelist 0。
- 两个 workspace roots 均成功读取。共 105 个带索引目录；按每 root 最多保留 100 个，103 个在保留范围内、2 个为数量候选（195 B）。另有 1 个无索引目录（27 B），保守保留。目录字节为普通文件 `stat.size` 总和，不代表磁盘分配块。
- 1 条精确消息身份候选，正文原始字节 472,600 B。候选不获删除授权；`legacy_required` 排除在逐会话清理之外。
- 178 条 transcript snapshots 共 10,732,981 B，当前 turn/recovery 契约要求保留，等待独立 owner 决定。
- degradable spill 34 B，其中按配置保留期过期 34 B；source-of-truth spill 31 B 必须保留；unreferenced spill 28 B 只有通过完整引用扫描和持久 GC 协议后才可处理。缺失的已引用 spill 为 0。
- 85 个索引对象合计 667,648 B；canonical event payload 170,630,555 B，canonical History 表占 171,192,320 B。
- 只对 `messages` 表允许假设页面回收，得到数据库缩小区间 0–18,317,312 B，对应清理后文件区间 183,091,200–201,408,512 B。这个上限是保守的整表页面上界，并非预测值；原始候选正文字节、逻辑删除量都不能证明文件会缩小。只有后续 VACUUM 前后测量才能验收实际物理缩小。

估算器未删除数据库行、工作目录文件或 spill。样本用于验证计量分类、范围边界和报告完整性；不代表真实 profile 分布，也不授权生产清理。
