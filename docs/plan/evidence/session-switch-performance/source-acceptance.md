# P3-07 源码阶段验收

日期：2026-10-27  
基线：P3-06 `c01e0bb8`  
范围：关闭源码阶段；不执行真实库迁移、旧缓存清理、安装包用户体验验收或生产 owner 切换。

## 验收结论

P3-07 源码阶段通过。AC-1–6/8 有本机源码、定向回归或规模测试证据；AC-7 的真实库与安装包体验仍待 P4 外验，不能据本报告宣称通过。P4-01–03 仍未完成。

## 证据索引

| 项目 | 证据 | 本阶段核对结果 |
|---|---|---|
| P0 基线与归因 | [baseline.md](baseline.md)、[p0-attribution.md](p0-attribution.md) | 提供旧路径成本和阶段比较口径 |
| P1 兼容读取/写入 | [p1-compatibility.md](p1-compatibility.md)、[p1r-display.md](p1r-display.md) | 旧 reader、回退及展示边界仍保留 |
| R-03 来源格式与覆盖 | [source-coverage.md](source-coverage.md)、[trace-correlation.md](trace-correlation.md) | 正文块种类、History 事件、source drift 和失败边界有覆盖材料 |
| P3-01–03 | [p3-01-block-store.md](p3-01-block-store.md)、[p3-02-publication-recovery.md](p3-02-publication-recovery.md)、[p3-03-source-dependency.md](p3-03-source-dependency.md) | 分块存储、发布恢复与 canonical 来源依赖 |
| P3-04–05 | [p3-04-paged-query.md](p3-04-paged-query.md)、[p3-05-concurrency.md](p3-05-concurrency.md) | 有界分页读取与并发/取消/漂移边界 |
| P3-06 | [p3-performance.md](p3-performance.md)、[source-identity-scale.md](source-identity-scale.md) | 规模、读放大、回填和合成冷读限制 |
| P3-07 最终回归 | 本报告下方 C1–C9 记录 | 全量 Vitest 和 Electron 增量构建通过 |

## 验证结果

- **C1–C4：** 27 个定向测试文件，387 项通过、6 项显式跳过；涵盖分页/来源、缓存与回退、取消和并发失效。
- **C5：** [p3-performance.md](p3-performance.md) 报告的 32 项规模测试通过。100k streams 的 source identity p95 为 0.052ms；100k events 的水位查询 p95 为 0.068ms。1000 条历史 locator 后台回填合成耗时约 10.46s，Vitest 进程采样 RSS 峰值约 774MB。canonical-only 合成冷读 p95 约 753ms；这不是 PKG/真实库 AC-7 验收。
- **C6：** `npm run build:electron:incremental` 通过；pi-ai runtime closure、cleanup boundary、session-storage graph 三项门禁通过（31 个非法边探针被拒绝，768 个分类文件，0 个待处理跨目录例外），主进程及 provider TypeScript 编译通过。
- **C7：** `npm run typecheck:renderer` 通过；本阶段没有 renderer 源码变更。
- **C9：** `npm test` 通过：1214 个测试文件通过、1 个跳过；11631 项测试通过、140 项跳过；耗时 1064.30s。
- **定向迁移回归：** 5 个文件、21 项通过，覆盖 v116 locator、完整 schema、稀疏兼容库以及旧迁移 fixture。
- **差异卫生：** `git diff --check` 通过。

## TDD 与修复记录

1. **大 History 事件预算。** canonical-only 事件在分段读取器中因为 32MiB 的误用上限被拒绝，尽管格式允许 128MiB segmented event。将 raw payload 校验上限对齐到格式预算；单事件、大正文和编译路径回归通过。
2. **大正文摘要避免复制。** 先加 256KiB+ payload 探针，比对既有 SHA-256 字节结果，并 spy 检查完整 payload 不会再交给一次性 `JSON.stringify`。RED 可复现额外大字符串分配；随后改为按 16KiB 字符片段转义并流入 hash。引号、反斜线、换行、Unicode、代理对和控制字符的 digest 与原算法一致。
3. **Worker 堆上限。** 850 条 canonical History 的最终视图在 128MiB worker old-space 下 OOM；将该 final-view worker 的有界 old-space 提高到 256MiB，保留 worker 隔离和有界输入。大正文完整读回与全量回归通过。实际 Electron/PKG RSS 仍须由 P4 测量。
4. **稀疏 v115 兼容迁移。** 评审发现“跳过 v116 DDL 却写入版本 116”会产生虚假 schema fence。将 locator 表 DDL 与源表触发器分开；迁移创建核心 locator 表，且只对存在并具备必要列的 sessions、History、stream、cutover 表安装触发器。新增缺失源表的稀疏迁移回归；迁移测试通过。
5. **压力夹具修正。** 1000 条 locator 回填、spill 分段、取消/重试、vacuum 与 IPC 生命周期夹具此前各有材料或等待屏障缺失；补齐真实源材料/屏障并修正各自超时范围。全量 C9 复跑通过。

## 代码质量审查记录

按 `code-review-and-quality` 五个维度完成本阶段审查：

- **正确性：** source digest 保持原 JSON 序列化字节语义；128MiB 事件预算来自既定分段上限；v116 只有在事务中 DDL 和 schema version 一起成功后才推进。完整迁移、稀疏迁移、源写失效和大正文路径均有回归。
- **可读性：** 大 payload digest 的阈值、片段大小与代理对边界处理集中在命名常量/小函数；迁移按来源表职责分组触发器。
- **架构：** 大事件摘要只降低额外峰值字符串副本；History reducer 与最终视图仍在隔离 Worker；locator 与 blob reference 仍在 SQLite session-storage 边界内。
- **安全性：** SQL 仍为固定迁移常量，表/列检测只用于兼容分支；没有开放 renderer IPC、文件路径或动态 SQL 输入。session-storage/module graph 与 cleanup 边界门禁通过。
- **性能：** source hash 的额外分配被限制到固定片段；final-view worker 上限由 128MiB 提至 256MiB，是明确的内存预算变化。合成 RSS 不能替代编译产物/真实库峰值验收。

审查中发现并关闭：稀疏库错误标记 v116、超大 History payload 误拒绝、digest 额外整串转义副本、最终视图 worker OOM。未遗留已知源码阶段 P1/P2 阻断。AC-7、真实设备 RSS、PKG/真实库迁移和真实 IM 并发仍是 P4 未验项目。

## 回退锚点与未关闭项

- 本阶段源代码变更可整体回退到阶段前提交 `c01e0bb8`；P3-01–06 的既有阶段提交保持在其后，不应单独回退其中的 locator 或分页依赖。
- P3-07 代码阶段提交：`830047e4`（本报告中的提交号不包含本次证据号修正）。
- 未关闭：AC-7 真实库/PKG 性能阈值和真实设备交互；P4-01 隔离回退演练/候选包；P4-02 授权隔离真实库副本测量；P4-03 当前 macOS 与真实 IM 并发验收。

