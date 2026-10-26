# P1 兼容优化证据

日期：2026-10-27  
工作树：`.worktrees/session-storage-boundary-refactor`  
阶段提交：`887bfbc6`（`perf(session): bound projection work and reuse manifest snapshot`）  
计划：`会话切换性能优化执行计划.md` P1-01–P1-03  
方案：`会话切换性能优化方案.md` §4.3–4.4、AC-2、AC-5、AC-7

## P1-01：同步 manifest 快照去重

`readProjectionChatBodyCacheManifest` 是完全同步路径。原实现连续调用两次 `readSnapshot`，且两次之间没有 `await`。单次 SQLite `readSnapshot` 在一个事务里执行 8 条 SELECT：session、projection state、cache publication，以及 source identity 所需的 session、cutover、latest History watermark、event cursor、History streams 列表。于是 ready manifest 检查从 16 条 SELECT 和两次完整 stream identity 扫描降为 8 条 SELECT 和一次扫描。

RED/GREEN：先新增“ready manifest 只读一次 snapshot”断言；修改前测试失败（mock 收到 2 次调用，预期 1 次），修改后通过。异步 `readProjectionChatBodyCache` 路径仍保留 blob 读取前后两份独立快照；既有“blob 读取期间 source 移动则拒绝”测试仍断言 2 次 snapshot，并通过。读取页面在 Worker 前与 Worker 后的 source fence 未删改；source drift 与 in-flight mutation 探针保持 stale 页拒绝并回退到权威 reader。

P0 同规模 identity 基准中，100,000 streams 的一次 source identity 扫描约 44.5ms p95、输出约 2MB JSON。P1 删除的是 ready-manifest 路径中的一次扫描；未重新运行全性能矩阵，因此约 44.5ms 是该规模下单次扫描的历史基准，不代表已测得的请求级 p95 改善，也不代表真实 PKG 加速幅度。

## P1-02：前台优先、等待年龄与 Worker 预算

Supervisor 现在每轮只调度一个 work item，并在每轮重新检查前台请求；等待中的新前台请求可以插到尚未开始的后台 work 前。后台 work 连续等待达到 250ms 后按最老等待项提升一次。250ms 是低于 P0 的 ready 首屏候选预算 300ms 的调度阈值，不是从 PKG 性能样本推导出的体验承诺。生产宿主配置显式传入 250ms。

slice 计时现在覆盖从一次取得 lease 到让出执行权之间的连续 coordinator 调用；每片 8ms、每次最多 4 个 chunk、每个 chunk 最多 200 行/256KiB。测试用每个 chunk 5ms 的确定性时钟复现旧实现连续跑过多个 chunk 才让出的情况：修改前前台请求排在第三个后台 chunk 之后；修改后累计 10ms 后让出，前台请求先运行。单个同步 chunk 无法抢占；若单个 chunk 本身超预算，只能在该 chunk 结束后让出。

固定种子请求/停止/恢复序列覆盖 5 个 scope 与重复 waiter；取消时等待 Worker 退出，再恢复处理。断言同时活动的 Worker 最大值为 1、已取消 waiter 全部 settle，恢复后全部 scope 发布为 valid。现有单 owner 和进程内请求合并行为保留。

## 验证

- P1 相关整合回归：8 个文件，237 passed、6 个显式 skip；包含 C1 四个基线文件及新增 supervisor/coordinator/worker/lifecycle 覆盖。
- 按计划单独运行 C3：4 个文件，54 passed。
- C6 `npm run build:electron:incremental`：退出码 0；pi-ai runtime closure、cleanup boundary 与 session-storage module graph 门禁通过，31 个非法边探针均被拒绝，主进程与 agent-provider 编译通过。
- `git diff --check`：通过。

## 仍未完成的性能范围

本阶段没有改变缓存格式、History 权威或外部读取契约。大型 canonical-only 会话仍要等待冷投影准备；P0 合成 300KiB 冷读 p95 约 2.89s，AC-7 暂定 1s 目标未达。source identity 仍随 History streams 数量线性扫描和序列化；latest watermark 仍可能排序全会话事件；ready-cache Worker 仍扫描全缓存消息；冷路径仍需完整重放/物化投影。后续 P2/P3 必须继续解决按页依赖定位与冷页工作量，P4 仍需隔离真实库和 PKG 对照验收。

本提交是 P1 独立代码回退点：回退 `887bfbc6` 可恢复双 snapshot manifest 检查及原 supervisor 调度，不涉及数据库 schema 或缓存格式迁移。
