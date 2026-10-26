# P2-02 正文分页原型证据

日期：2026-10-27  
工作树：`codex/session-storage-boundary-refactor`  
范围：仅测试原型；未接生产 IPC、生产读取器或生产工厂。

## 结论

测试原型证明：完整权威归约后生成按消息顺序排列的不可变正文块，配合多层范围目录，可以只读固定页及相邻块；另有按 message ID 查找来源片段的二级范围目录。正文块与目录摘要不匹配会拒绝读取。普通块最多 8 条、JSON 字节不超过 256 KiB；单条超过字节预算时独立成块，不拆分消息。10 倍合成历史下，末页触及 24 条正文记录与 23 个序列目录节点；按 ID 查找最多读取 5 个目录节点与 8 条候选记录。

这**没有通过 AC-3/AC-4 的冷读来源定位门禁**。现有 turn/request 索引不能定位完整正文依赖：后续 invocation 的 `transcript-compacted` 可以用同一 message ID 更新此前的正文，完整归约结果取决于该后续事件。现在只有全历史 reducer 会发现这个更新。`readProjectionSourceIdentity` 还会枚举并序列化该 session 的全部 stream IDs。因此本原型不能证明无索引冷页不需要全会话工作，不能进入 P3。

## 复现与差分

新增 [pageBodyReadPrototype.test.ts](../../../electron/sessionStorage/pageBodyReadPrototype.test.ts)，复用 `createProjectionChatBodyReducer`，验证：

- 完整 reducer 与正文块分页结果一致，样本包含 dual-write/ canonical-only、assistant response、`tool_use` 文本提取，以及后来压缩快照改写既有 user/assistant message ID。
- 按 turn 分组归约的来源片段样本，将旧消息映射到后来 compaction 所属 invocation、保留完整 invocation 依赖 event IDs，并与全 session reducer 页结果相同；该片段生成仍由内存全量原型完成。
- 10,000 条 message ID 二级目录查询只走根到叶路径；1,000→10,000 条规模增长时，返回页正文数据项保持不超过 8 条。
- 正文块摘要损坏时返回明确失败，不产出页面。
- 1,000 与 10,000 条正文数据读取末 20 条：大样本触及 24 条正文记录、23 个目录节点，目录没有全量加载。
- 单独反例确认 `turns` 中只列当前 turn 的消息 ID，而后续压缩事件可再次包含旧消息 ID；只按 turn ID 查找会漏掉更新。

定向验证：

```text
npm exec -- vitest run electron/sessionStorage/pageBodyReadPrototype.test.ts --reporter=dot
1 file passed; 7 passed; 0 failed; 0.59s
```

## 尚未证明的要求

- 本测试的页目录由完整 reducer 结果构建；没有证明冷会话如何在不先扫描/归约完整旧 History 的情况下找到页正文依赖。
- 尚未覆盖 P2-01 矩阵中的所有旧 ledger、匿名 replay、缺 owner/order、spill 缺失/损坏与 stream schema/version 错误样本。
- 256 KiB/8 条是测试候选上限，不是经生产磁盘基准选定的最终常量；正文块读取计数只是内存原型统计，不是 SQLite 查询计划、worker 冷路径或实际磁盘 IO 证据。
- 全量 stream ID 的 source identity 仍是与历史规模线性相关的读取工作。

## 方案门禁建议

按原方案 §4.2，缺少可靠来源映射时不能把“后台全量建索引”说成冷首屏已满足 INV-3。要继续实现冷会话首屏，需要在 P2-03 明确一种可接受的冷会话契约：为新写入持续维护可寻址事实，并接受旧会话一次性后台全量回填期间的首屏等待/旧路径行为；同时规定如何以有界成本读取身份 fence。若要求所有未经索引的旧会话也必须在不等待全量扫描的情况下立刻返回正确页面，则当前事件格式没有足够的反向映射事实，方案需要增加/批准持久化映射或放宽该验收条件。P2-03 规格门禁未关闭前不进入生产读路径实现。
