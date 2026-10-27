# P4-03 macOS 安装包验收记录

日期：2026-10-27  
状态：**部分完成；当前不具备发布验收结论。**

## 已完成的本机准备与可采信证据

- 所有运行验收均使用隔离数据库副本；未把用户原始数据库交给验收应用。
- 最新候选 build identity：`3817abb0-b0b3-4bd6-9b34-964550c2d40f`，版本 `0.2.9`，源码提交 `6570771d54ba667b00c4436e83c6c6c1c903715b`，构建时工作树干净。
- 最新 arm64 PKG SHA-256 为 `d21aa292afefcced83f2d49fbe78487a15ece142cebe80fe9138b4f24338ecc1`，PKG 内 `app.asar` SHA-256 为 `dbe16e0c955b0b143e34cc7283fff0db1f88c4d2e2256903ea2ea163be7e67c1`。`codesign --verify --deep --strict` 通过；无 Developer ID 身份，属于 ad-hoc 隔离候选，不是已签名公证的发布包。
- 前一候选包内分页代码在隔离真实库 APFS clone 上执行 `readChatPageAfterPreparation`：大/普通会话 cold-projection source-page 各 30 次，p95 为 3.71/4.96 ms。该共享主进程实现与当前 v7 相同；测量使用 Electron 44.1.1 / Node 24.19.0，不包含点击到首帧、React 渲染、跨进程等待或维护竞争。
- 前一候选包内 `readCanonicalCompactionReplay` 在同一真实库副本上，大/普通会话各 10 次 p50 为 13.65/8.19 ms。此前包 `410a14dd` 的 15 次 ledger 检查均为 proof reuse，没有重复 baseline；该包仍记录一次 845 ms event-loop delay，来源未确定。
- P4-02 的完整证据和限制见 [external-performance.md](external-performance.md)。视口回归修复的定向测试、类型检查、完整构建和新候选 PKG 校验均通过。
- 较早的点击测量使用隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v6`；该状态已由下方最新候选 v7 的复测更新。
- 前一候选启动后日志确认 build ID `c3d37a41-8a08-46e0-b327-52800a4d494d`。两次启动都自动请求初始会话页（各自 `requestOrdinal=1`），观测值分别为：main 9.94/3.86 ms、renderer page request 40.8/66.2 ms、render commit 21.9/6.4 ms、next paint 14.7/11 ms。启动期另观测到 ledger proof reuse 135 ms 与 41 ms，recovery completed 6 ms 与 5 ms。辅助功能看到进程可见但没有窗口，故两条 trace 都只是启动初始页，**不是会话切换样本**，不纳入 AC-7 的点击到首帧统计。日志位置：`/tmp/spaceassistant-p4-validation/copies/candidate-v6/workspaces/2/.agent/logs/Agent-20261027.log`。
- 较早启动期辅助功能不可见窗口的限制已由后续真实界面点击样本取代，历史启动 trace 保留作启动数据，不纳入切换统计。
- IM 验收经用户澄清后标为**不适用**：本项目没有专用私聊或群聊 sandbox 会话。此前授权仅限 sandbox 测试消息；不向任何真实会话发送测试消息，也不再把提供 sandbox 账号/会话作为继续条件。

## 尚未执行的安装包验收

设备现已解锁，桌面自动化可以操作候选窗口；候选单边真实切换已有样本。完整矩阵、可运行的基线二进制和包内故障场景仍待完成，因此本报告不把单边数据写成完整界面验收。

以下项目仍未完成：

1. 最新包在当前 macOS arm64 设备上的首次访问、热缓存、损坏缓存和维护开/关矩阵；已采集的 105 次 cold 页切换不能代替这些矩阵，按方案 §2 对每个适用格采集至少 30 次、失败率、p50/p95/max。
2. 已完成同一冻结备份来源的基线/候选真实窗口点击代理比较，细节见下方“同源基线与最大历史窗口点击补充”。因两版最大会话规模不同，且指标截止双帧而非正文首屏 ready，该证据不能关闭 AC-7；仍需按方案口径测量内容 ready 与缓存/维护场景。
3. 切换期间长任务的调用级归因、维护期间全进程峰值 RSS、维护完成耗时及后台维护对前台的竞争数据。已采集无维护时 4 个进程合计 RSS 的 30 秒样本，见 [external-performance.md](external-performance.md)；设置页响应已在大/普通上下文各测 20 次，但不覆盖维护竞争时的响应。
4. 安装包 AC-5 的取消等待者、后台维护与前台竞争、关闭/切库场景，以及 AC-6 的源编辑/追加/压缩/删除、投影块截断、发布边界故障。窗口 A→B→A 与重复切换已有样本；canonical source spill 缺失、截断、同长度摘要篡改、合法格式但不存在的 locator 时 fail-closed 均已用合成 canonical-backed 包内样本验证，详见 [external-performance.md](external-performance.md)。源码测试通过不能替代剩余安装包场景证据。
5. IM 并发项不适用：用户确认没有专用私聊或群聊 sandbox。当前不向真实 IM 会话发送测试消息。

## 继续验收步骤

1. 候选窗口保持唯一运行且指向隔离副本。基线二进制因 schema 不兼容已退出；先确认是否有计划基线可读的 schema 107 数据快照，再串行启动基线和候选，避免并行窗口与数据目录混淆。
2. 依照方案 §2 固定同一机器、库来源、页大小与系统缓存条件，完成首次访问、热缓存、损坏缓存、维护开/关适用矩阵；记录每格至少 30 个有效样本、失败率、p50/p95/max、主线程长任务、候选 RSS 与维护完成时间。若测量目标未达，返回源码任务修复后重建包并复测。
3. 安装包中复核 AC-5：A→B→A、重复读取、取消等待者、后台维护与前台竞争、关闭/切库；复核 AC-6：选页后源编辑/追加/压缩/删除、spill 损坏、块截断、发布边界故障。只接受完整有效页或既定错误，不把空页当成功。
4. IM 项保持不适用，不发送真实会话测试消息。
5. 更新本报告结论与证据链接。只有 AC-7 适用外验与 AC-5/AC-6 包内代表场景都有结果后，才能把 P4-03 标为完成；本报告不触发自动发布或替代生产 owner 门禁。

## 结论

P4-03 **未完成**。最新候选包已经在隔离真实库上完成大/普通会话窗口切换与设置响应采样，并观察确认视口索引修复生效；首次/热/损坏缓存和维护开关矩阵、正文首屏 ready 指标、维护竞争与维护期间内存峰值，以及 AC-5 的取消/维护/关闭切库和 AC-6 除 canonical spill 缺失/截断/摘要/定位损坏外的包内故障场景仍缺。无维护时的全进程 RSS 基线已采样。IM 并发因产品没有私聊、群聊或专用测试会话而不适用。当前结论不表示 AC-7 全面通过，也不构成发布许可。

## 解锁后补充（2026-10-27）

- 在候选包窗口实际观察到 94–104.6 ms 的 long animation frame 与 50–74 ms long task。它们足以说明仍存在可感知卡顿风险，但缺少脚本 attribution 和调用级关联；当前没有证据证明 20 条首屏页读取本身是长帧来源。候选单进程 RSS 采样峰值约 517.4 MiB。
- 已从计划基线 `109a9384` 构建 arm64 PKG；构建与签名校验成功。但该二进制支持的最高数据库版本为 107，其他可读取的同数据副本均为 schema 115/116，启动被安全拒绝；另有一份 baseline-v3 副本无法只读校验。因此同库基线 UI 对照仍不可执行，也没有尝试降低 schema 或修改用户数据。
- 截至该段旧测量记录，唯一运行实例是候选 PKG，进程命令行带有 `--user-data-dir=/tmp/spaceassistant-p4-validation/copies/candidate-v6`；基线实例已退出。该状态已由下方 v7 复测更新，期间没有并行启动基线/候选窗口。
- IM 项继续标记为不适用：项目没有专用私聊或群聊测试会话，未向任何真实会话发送消息。

更新后的结论仍是 **P4-03 未完成**。真实候选窗口测量已开始，但基线版本拒绝兼容、AC-7 全矩阵及 AC-5/AC-6 包内代表场景尚未完成；因此不能写“验收完成”或“允许发布”。

## 视口修复后的候选包复验（2026-10-27）

- 最新候选已更新为 build ID `3817abb0-b0b3-4bd6-9b34-964550c2d40f`，版本 `0.2.9`，提交 `6570771d54ba667b00c4436e83c6c6c1c903715b`。arm64 PKG SHA-256 为 `d21aa292afefcced83f2d49fbe78487a15ece142cebe80fe9138b4f24338ecc1`，app.asar SHA-256 为 `dbe16e0c955b0b143e34cc7283fff0db1f88c4d2e2256903ea2ea163be7e67c1`；`codesign --verify --deep --strict` 通过。源码定向回归、renderer 类型检查和完整构建均通过，细节见 [external-performance.md](external-performance.md)。
- 隔离真实库上的窗口点击样本：大历史 30/30 成功，点击到 renderer next-paint p50/p95/max 53.3/58.2/65.3 ms；普通历史 30/30 成功，41.7/46.7/47.0 ms。设置对话框在大历史上下文 20/20 成功，响应 p50/p95/max 33.4/47.6/49.0 ms；普通上下文 20/20 成功，26.2/28.1/29.6 ms。测试经 CDP 指针事件派发，表示实际 Electron 窗口交互路径，不等同于物理鼠标硬件端到端延迟。
- 新构建 10 次交替切换均将 Virtuoso `firstItemIndex` 保持在 100000；旧构建曾连续递减。此回归由 TDD 测试和 PKG 运行观察支持。新构建 60 次会话切换中未观察到 ≥50 ms Long Task/LoAF。串行旧/新候选测量不具备随机交叉设计，且旧二进制无法打开同 schema 数据库，故不据此宣称 AC-7 全面通过。
- 最新唯一运行进程是候选 PKG，隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v7`，未启用远程调试端口。没有向任何 IM 会话发消息；用户确认产品没有私聊、群聊或专用 IM 测试会话，因此 IM 并发验收不适用。
- 真实库上的早期 AC-6 探针因样本是 legacy 消息而不计验收。随后已在独立合成 canonical-backed fixture 上验证包内 source spill 缺失、截断、同长度摘要篡改及 locator 指向不存在文件均返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，证据见 [external-performance.md](external-performance.md)。

结论维持 **P4-03 未完成**。同源基线点击代理比较已有记录，但双帧指标不能替代正文首屏 ready；热/损坏缓存与维护开关矩阵、维护竞争和维护完成时间、维护期间全进程峰值 RSS，以及安装包内 AC-5 剩余并发场景和 AC-6 剩余故障场景仍待验收。无维护时的全进程 RSS 基线已有 30 秒样本；source spill 缺失、截断、摘要篡改与 locator 失效的 fail-closed 已在包内验证。当前候选测量不构成整体验收或发布许可。

## 空消息回填修复包的补充运行记录（2026-10-27）

最新隔离候选为源码提交 `76cb2b7812d2c7a00e4d997a3c37fa10751e7611`，build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`，PKG SHA-256 `90333659cac14e42d09729b4b3ee8c53580e3e5e5609939276ce5121f4c459c5`。该包在隔离真实库副本上完成 20 次大/普通会话交替点击，每组 10 次；点击至双帧 p50/p95 为 23.5/52.9 ms 与 34.4/38.8 ms。一次大历史点击与 110 ms Long Task、126.6 ms LoAF 重叠。指标不是正文首屏 ready，且副本有部分 legacy 历史错误，因此不纳入 AC-7 通过率。352 个空消息会话完成回填；32 个仅含 legacy 消息的会话仍为 backfilling，失败类别及限制见 [external-performance.md](external-performance.md)。候选测试后已退出。

本次仅为补充观测，不改变验收结论：P4-03 **未完成**。AC-7 的内容 ready 与缓存/维护矩阵、维护竞争，以及 AC-5/AC-6 的剩余安装包场景仍缺；IM 并发不适用，不向真实会话发送测试消息。

## 同源基线与最大历史窗口点击补充（2026-10-27）

为解决此前基线 schema 不兼容，重新从同一冻结数据库备份制作独立 APFS clone：旧基线 `109a9384` 在其 clone 上迁移至 schema 107，候选 build `3817abb0-b0b3-4bd6-9b34-964550c2d40f` 在另一 clone 上迁移至 schema 116；串行运行，未改原始库，IM 设置仅在副本关闭。

通过 CUA 在实际窗口各做 30 次可信点击。旧基线 64 条消息会话点击到双 `requestAnimationFrame` p50/p95/max 为 29.5/32.3/32.5 ms；候选 150 条最大会话为 51.3/59.1/59.2 ms。由于会话规模不同，该差异只能作为响应代理观察，不能归因于单个新增任务。基线点击窗口没有 Long Task，候选检测到一个最大 120 ms Long Task 和三个最大 133.1 ms LoAF，但它们没有落在记录的点击窗口。另一个候选 64 条会话样本 p95 为 53.2 ms，点击窗口内无 Long Task/LoAF。候选大历史切换后设置视图仍能打开，响应操作成功。

指标截止于双帧回调，并非消息正文首屏 ready；候选测试期间 source locator 后台回填仍在进行且未查明完成时间，因此不能用这些样本关闭 AC-7 或认定维护影响已排除。P4-03 继续未完成：仍需完成 AC-7 的首屏 ready/缓存/维护矩阵、维护竞争及维护耗时/RSS，并覆盖 AC-5/AC-6 剩余包内场景。IM 并发按用户澄清不适用，不向真实会话发消息。
