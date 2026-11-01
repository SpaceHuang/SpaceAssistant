# 会话存储全链路性能改进：本机验收汇总

## 当前结论

本机P0至P3、P4-01至P4-04完成。最终源码指纹匹配的全场景30样本中，800事件/pending=16追加p95 185.947ms，spawn至first-paint代理p95 979.914ms，均低于方案阈值；后者仅约20ms余量，OS page cache未控制且窗口隐藏、不采集像素。冷History 10MiB source read/hydrate p95 40.433ms，最大连续主线程阻塞3.133ms；专门的无spill冷恢复1/4/10MiB最大阻塞10.2/14.6/42.6ms。真实LLM/IM/Windows设备和安装包仍独立列为外验。

最终阶段收尾全量`npm test`通过：1250文件通过、1跳过；12108项通过、140项跳过；用时1192.75秒。

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
| AC-12 | 当前样本通过 | 最终指纹完整30样本：800事件/pending=16追加p95 185.947ms，spawn至renderer FCP代理p95 979.914ms，低于1秒约20ms。renderer自身FCP p95约132ms；主要耗时落在主进程/Electron启动到renderer加载，未发现单一主导模块。窗口隐藏且OS page cache未控制，FCP未证明语义可读或跨机稳定。详见[P4-03](P4-03.md)与[candidate-current-final.json](candidate-current-final.json) |
| AC-13 | 通过 | P0-03、P1-08与P3-02热／冷规则、park及旧SDK逐消息对拍 |
| AC-14 | 通过 | P3-04、P3-06崩溃窗口与工具恢复；P4-03大工具结果测量 |
| AC-15 | 通过 | P1-08事务故障／receipt重试；P4-03无检查点重开读回 |
| AC-16 | 通过 | P2-04目标文件转换、P3-08目标操作不探测其他location |
| AC-17 | 通过 | P3-01目标恢复、active owner及继续handler；P3-03启动全局扫描移除；P4-03测量100／1000已完成会话启动屏障及首次目标准备 |
| AC-18 | 通过 | P3-08日常动作及合成渠道派生任务计数；P4-01自动导出任务退出 |
| AC-19 | 通过 | [P4-02](P4-02.md)函数／调用者核销、兼容保留理由与增删账 |

## 验证状态

- P4-01与P4-02证据见各自记录；P4-03最终source/Electron/renderer指纹一致全场景结果及故障矩阵见`candidate-current-final.json`和[P4-03](P4-03.md)。AC-12当前样本达标但裕量有限。
- 第六轮最终受影响六文件588 passed、6 skipped；hosted replay修复后定向子集67项通过。全量`npm test`最终1250文件通过、1跳过；12108 passed、140 skipped。
- session-storage、cleanup、message-fact-ownership边界门禁；shared/renderer/Agent SDK类型检查；Agent SDK边界与依赖检查；check:no-nul通过。
- `npm run build`通过；source/Electron/renderer指纹与最终30样本候选报告一致：`81f43b85988d32be82c73ca4cfda728b24714c81507edc6c6795092a47310e0b`、`84fe2b27f14502017b8a2c5f7a45c86698fb234a6bd0773e2c3fe99801e0524a`、`44a938f6ccf926ca86623e81aba2c861d6fe9292fc21d4fa8d333e754ee1e741`；不构建安装包。
- 全量`npm test`和完整`npm run build`在第六轮修复后最终复验通过；另通过shared/renderer/Agent SDK类型、Agent SDK边界、session-storage/cleanup/message ownership/system invariant边界、i18n、no-NUL及diff检查。旧账本首次baseline 30样本回归包含于最终候选报告。P4-04源码关闭完成；外部验收另列。

## 外部验收（独立于本机关闭）

真实LLM账号未配置，所有Provider/History验证使用确定性测试Provider或合成数据，不声称模型端到端、回答质量验收。没有真实IM账号／设备、Windows原设备复现及已签名安装包验收；这些保持外部验收，不影响代码测试结论。
