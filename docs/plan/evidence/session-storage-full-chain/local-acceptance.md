# 会话存储全链路性能改进：本机验收汇总

## 当前结论

本机P0至P3、P4-01/02/03完成；P4-04本机源码验收完成。最新指纹匹配的全场景30样本中，800事件/pending=16累计追加p95 184.798ms，spawn至renderer FCP p95 971.473ms，当前样本满足主方案200ms与1秒预算；首次旧账本baseline＋投影p95 7.097ms。前次完整启动样本为1030.331ms，当前余量有限且OS page cache未控制。真实LLM/IM/Windows设备独立列为外验。

阶段收尾全量`npm test`通过：1249文件通过、1跳过；12085项通过、140项跳过；用时1178.41秒。

## AC逐项证据

| AC | 本机结论 | 证据 |
|---|---|---|
| AC-01 | 通过 | P1-08生产SDK→SQLite提交与重开；P4-03追加规模与当前History实现 |
| AC-02 | 通过 | P1-03差分／随机状态不变量；P1-08事件归约及重开 |
| AC-03 | 通过 | P3-05局部状态／preview读取；P3-08范围与跨会话日常动作 |
| AC-04 | 通过 | P3-06、P3-08普通入口计数；P4-01移除自动备份触发；P3-07页面trace |
| AC-05 | 通过 | P3-06/07 renderer live、迟到结果、分页绘制与读取边界；P3-08合并回归 |
| AC-06 | 通过 | P2-04旧文件转换与失败续跑；P3-08合成IM/track入口 |
| AC-07 | 通过 | P4-01显式分页写出、失败保留旧文件、自动调度与退出flush退出 |
| AC-08 | 通过 | P3-04有界摘要与可靠History结果恢复；P4-03大工具spill计量 |
| AC-09 | 通过 | P1-08确认丢失、receipt重开和事务失败；P4-03检查点关闭冷读 |
| AC-10 | 通过 | P3-05 SQL profile筛选、全量列表契约及规模；P3-08日常入口边界 |
| AC-11 | 通过 | P3-06 renderer历史/live职责；P3-07真实page dispatch到next-paint trace |
| AC-12 | 当前样本通过 | 当前指纹完整30样本：800事件/pending=16追加p95 184.798ms，spawn至renderer FCP p95 971.473ms；前次完整样本为1030.331ms，当前约28.5ms裕量。renderer自身FCP p95约132ms；主要耗时落在主进程/Electron启动到renderer加载，未发现单一主导模块。窗口隐藏且OS page cache未控制，FCP未证明语义可读或跨机稳定。详见[P4-03](P4-03.md)与[candidate-current-final.json](candidate-current-final.json) |
| AC-13 | 通过 | P0-03、P1-08与P3-02热／冷规则、park及旧SDK逐消息对拍 |
| AC-14 | 通过 | P3-04、P3-06崩溃窗口与工具恢复；P4-03大工具结果测量 |
| AC-15 | 通过 | P1-08事务故障／receipt重试；P4-03无检查点重开读回 |
| AC-16 | 通过 | P2-04目标文件转换、P3-08目标操作不探测其他location |
| AC-17 | 通过 | P3-01目标恢复、active owner及继续handler；P3-03启动全局扫描移除；P4-03测量100／1000已完成会话启动屏障及首次目标准备 |
| AC-18 | 通过 | P3-08日常动作及合成渠道派生任务计数；P4-01自动导出任务退出 |
| AC-19 | 通过 | [P4-02](P4-02.md)函数／调用者核销、兼容保留理由与增删账 |

## 验证状态

- P4-01与P4-02证据见各自记录；P4-03的source/Electron/renderer指纹一致全场景结果及故障矩阵见`candidate-current-final.json`和[P4-03](P4-03.md)。AC-12当前样本达标但裕量有限。
- 15文件605 passed、31 skipped的阶段相关定向回归通过；最终受影响历史/spill测试249/249通过。
- session-storage、cleanup、message-fact-ownership边界门禁；shared/renderer/Agent SDK类型检查；Agent SDK边界与依赖检查；check:no-nul通过。
- `npm run build`通过。Electron、renderer及源码指纹与候选记录一致；不构建安装包。
- 全量`npm test`阶段收尾复跑通过：1249文件通过、1跳过；12085项通过、140项跳过。该轮只验证确定性本机逻辑，不调用真实LLM。启动task barrier定向回归2文件7项通过，新增旧账本首次baseline全场景30样本通过；`npm run build`与类型、边界、i18n、no-NUL及diff检查通过。P4-04阶段最终记录待完成职责退出/代码量汇总和关闭清单。

## 外部验收（独立于本机关闭）

真实LLM账号未配置，所有Provider/History验证使用确定性测试Provider或合成数据，不声称模型端到端、回答质量验收。没有真实IM账号／设备、Windows原设备复现及已签名安装包验收；这些保持外部验收，不影响代码测试结论。
