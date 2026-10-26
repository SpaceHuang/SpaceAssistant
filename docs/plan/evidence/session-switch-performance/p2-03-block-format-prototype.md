# P2-03 正文块与目录候选格式

日期：2026-10-27  
范围：测试原型与既有性能证据；不创建生产文件格式、数据库表或迁移。

## 候选正文块

正文按消息顺序落到独立不可变 blob。每条记录含 message ID、role、timestamp、sequence 与 `chatBodyV1` 正文；块使用 UTF-8 JSON 字节数计算预算。

| 项目 | 候选值/行为 | 依据与状态 |
| --- | --- | --- |
| 普通块最大消息数 | 8 | 原型设定；固定页 20 通常需读 3 个块，未对齐时可能为 4 个，减少过度分片 |
| 普通块最大序列化字节 | 256 KiB | 与现 inline cache 上限同量级；尚未以磁盘随机读基准确认最优值 |
| 单条正文超过字节预算 | 单独放入一个块，不拆消息 | 与方案“巨型正文保持完整语义”一致；原型覆盖 300 KiB |
| 块校验 | 每块独立 SHA-256 + byteLength；读到某块先校验完整块，再解码所需消息 | 原型已验证块摘要损坏 fail closed；不同于对全会话单 blob 做整份 SHA-256 |
| 块内容 | 只含稳定正文字段与有序消息记录，不放 History payload、tool state 或展示错误信息 | 对齐现有 `chatBodyV1` 输出字段 |

## 候选定位目录

- 使用有序范围树，以消息 `sequence` 为页读取入口；内部节点记录子节点 sequence 范围、blob locator、byteLength 与摘要。候选 fanout 为 8。根摘要由 manifest 固定，读页只遍历与页范围相交的节点。
- 另需 message ID → 可单独读取的正文片段 + 精确 History 来源坐标/摘要记录，供未发布/失效正文缓存后的冷页读取；仅保存整 event ID 不够，因为大 context event 可包含整段会话，读一条仍可能解析所有消息。这是 D-3 的持久定位记录决策，不能与顺序块目录混为一份全量 JSON 清单。
- 构建时扫描完整输出并验证稳定 ID 唯一、sequence 唯一/递增、消息正文与源事实一致；运行时页读取不重做全量覆盖扫描，只依赖完整发布的 manifest 和本页块。
- 每个目录节点与正文块独立校验。根 manifest 绑定 session generation、chatBody 规格版本、source identity/fence、消息范围、message count、目录根引用与摘要。未知版本、缺块、错摘要、越界序列或重复 ID 使整个该代产物不可用，不返回部分页。

## P0 现有数据对预算的约束

既有性能基线 `p0-attribution.md` / `source-identity-scale.md` 的合成数据表明：

- 100,000 条缓存消息的单 JSON 约 6.43 MiB；固定读取 20 条的 worker 选择 p95 约 3.57 ms，仍遍历全缓存数组。新目录需避免这个全量遍历。
- 页正文本身可以达到 20 KiB、640 KiB、5 MiB；5 MiB 页中 Worker 内筛选 p95 约 0.04 ms，进程传输 p95 约 3.94 ms。页块读取不能虚称省掉用户实际需要的正文 bytes，优化目标是剔除无关历史与整 blob 校验扫描。
- 单条 8 MiB 正文的 p95 约 7.12 ms（30 次合成、含返回正文），支持“巨型消息可独立成块、不对其承诺固定时间”。
- 当前 blob stream 会从头读取文件并校验整文件长度和 SHA-256，再由 JSON stream parser 选择 ID；即使 parser 只物化目标项，磁盘/摘要读取仍随整 blob bytes 增长。因此必须改成每块独立 blob+digest，不能只在原 monolithic blob 外加一个 ID 表。
- 当前 cache inline 上限 256 KiB，stream metadata scalar 上限 64 KiB；History 源正文 >64 KiB 会 spill。它们是已有实现边界，不是最终分页块尺寸的基准结论。

## 发布与恢复候选协议

1. worker 根据一份稳定 source revision 构建正文块、顺序目录和逐消息来源记录；逐项把产物写到 staging，完整 fsync/摘要校验后 promote 成不可变最终 blob。大 History 事件必须能为目标消息定位到独立片段，不能每次把整个大事件当作单条消息依赖。
2. 在一个 SQLite 事务中核对 source revision、session generation、message revision 与 History watermark，再发布 manifest 与索引完成标记。任何 fence 不匹配都丢弃本轮产物并重排维护。
3. 崩溃发生在 manifest 发布前：blob 是孤块，不可读；重启孤块清理由现有 blob reference reconciliation 纳入新 manifest 引用类型后执行。发布后块缺失/损坏：该代无效、清除 ready 资格、保留 History/spill，进入现有 rebuild supervisor。
4. 目录/来源映射引用与 canonical event append 必须同事务。编辑、History event UPDATE/DELETE、owner/schema 变更与 session 删除由触发器递增 source revision 或撤销索引完成状态。正文片段是可校验派生数据，需保留 History 来源 event ID/sequence/schema version 与 source digest，不得成为独立权威。
5. 老会话来源映射回填分段提交 progress，但全量尾部校验前不发布 complete；期间按 D-3 批准的行为处理页面。source revision 变化要使本次回填 checkpoint 失效或从安全游标续跑，并且不能把部分映射当完整覆盖。

## 原型验证

`pageBodyReadPrototype.test.ts` 目前 9 项通过：完整 History reducer 对拍、compaction 覆盖旧 ID、assistant chunk/mixed authority、页范围和 message ID 二级目录各放大 10 倍、正文块/目录/来源片段/来源事件/依赖摘要损坏或变化拒绝、普通块 byte/message 上限及 300 KiB 单条隔离。逐消息来源记录绑定 event ID、invocation 内序号、session 序号、schema version、event kind、source digest 和完整 reducer dependency digests。测试先用不完整定位记录断言出 RED，再补来源坐标、摘要和 source revision fence；按页读取经 sequence directory 选中范围后，只验证目标片段，不遍历全体来源事件。

```text
npm exec -- vitest run electron/sessionStorage/pageBodyReadPrototype.test.ts --reporter=dot
1 file passed; 9 passed; 0 failed; 0.59s
```

这仍是内存数据结构原型，未接 SQLite、真实文件系统发布、GC、并发 History 写入或 source locator table；C4a 的来源定位全格式矩阵尚未通过。256 KiB/8 条和 fanout 8 必须在生产 block store 性能测试后冻结，不能由本原型直接带入生产常量。D-3 未获批准前，以上发布/迁移契约仅作候选方案。
