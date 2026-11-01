# 会话存储全链路性能改进：本机验收汇总

## 当前结论

第七轮系统重审的冷恢复性能阻断已修复并完成P4-04本机验收。指纹匹配的最终30样本中，800事件/pending=16追加p95 171.042ms；冷启动spawn至first-paint代理p95 900.398ms，低于1秒约99.6ms。冷History 10MiB source read/hydrate p95 37.102ms、最大连续主线程阻塞3.016ms；100MiB p95 427.494ms、最大阻塞3.211ms。真实SDK必写事件及工具／压缩／失败混合的SQLite冷恢复30次读取p95 41.5ms、最大连续阻塞46.5ms，低于50ms预算。所有数据为本机样本；OS page cache未控制，冷启动窗口隐藏且不采集像素。真实LLM/IM/Windows设备和安装包仍独立列为外验。

最终阶段收尾全量`npm test`通过：1250文件通过、1跳过；12108项通过、140项跳过；用时1073.72秒。

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
| AC-12 | 当前本机样本通过 | 最终源码fingerprint匹配的全场景30样本：800事件/pending=16追加p95 171.042ms；冷启动进程spawn至first-paint代理p95 900.398ms；cold-history 10MiB source read/hydrate p95 37.102ms、最大阻塞3.016ms，100MiB p95 427.494ms、最大阻塞3.211ms。另有真实SDK事件组成的混合恢复检查点脚本30次读取：10MiB p95 41.5ms、最大连续阻塞46.5ms。窗口隐藏、OS page cache未控制，FCP未证明语义可读或跨机稳定。详见[P4-03](P4-03.md)、[P4-04](P4-04.md)和[candidate-current-final.json](candidate-current-final.json) |
| AC-13 | 通过 | P0-03、P1-08与P3-02热／冷规则、park及旧SDK逐消息对拍 |
| AC-14 | 通过 | P3-04、P3-06崩溃窗口与工具恢复；P4-03大工具结果测量 |
| AC-15 | 通过 | P1-08事务故障／receipt重试；P4-03无检查点重开读回 |
| AC-16 | 通过 | P2-04目标文件转换、P3-08目标操作不探测其他location |
| AC-17 | 通过 | P3-01目标恢复、active owner及继续handler；P3-03启动全局扫描移除；P4-03测量100／1000已完成会话启动屏障及首次目标准备 |
| AC-18 | 通过 | P3-08日常动作及合成渠道派生任务计数；P4-01自动导出任务退出 |
| AC-19 | 通过 | [P4-02](P4-02.md)函数／调用者核销、兼容保留理由与增删账 |

## 验证状态

- P4-01至P4-03证据见各自记录；最终source/Electron/renderer指纹匹配候选报告与故障矩阵见`candidate-current-final.json`和[P4-03](P4-03.md)。第七轮冷恢复P1的复现、修复和验证见[P4-04](P4-04.md)。
- 第七轮最终受影响四文件190 passed、6 skipped；全量`npm test`最终1250文件通过、1跳过；12108 passed、140 skipped。
- session-storage、cleanup、message-fact-ownership边界门禁；shared/renderer/Agent SDK类型检查；Agent SDK边界与依赖检查；check:no-nul通过。
- `npm run build`通过；source/Electron/renderer fingerprint与最终30样本候选报告一致：`596de3b20991f0b7c70f73ca8c08d517eaed7b4deec6f2594b204719d12c7326`、`3a23bffa6e0d02ede752cc109990f4fc434ceaac969731ebc3d5bbae226ca7a1`、`44a938f6ccf926ca86623e81aba2c861d6fe9292fc21d4fa8d333e754ee1e741`；不构建安装包。
- 全量`npm test`及完整`npm run build`在第七轮修复后最终复验通过；另通过shared/renderer/Agent SDK类型、Agent SDK依赖与闭包、session-storage/cleanup/message ownership/system invariant边界、i18n、no-NUL、fingerprint及diff检查。P4-04本机源码计划已关闭，外部验收另列。

## 外部验收（独立于本机关闭）

真实LLM账号未配置，所有Provider/History验证使用确定性测试Provider或合成数据，不声称模型端到端、回答质量验收。没有真实IM账号／设备、Windows原设备复现及已签名安装包验收；这些保持外部验收，不影响代码测试结论。
