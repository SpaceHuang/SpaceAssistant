# P4-03 macOS 安装包验收记录

日期：2026-10-27  
状态：**部分完成；当前不具备发布验收结论。**

## 已完成的本机准备与可采信证据

- 基线与候选都使用同一冻结备份的隔离副本；没有打开或修改原始数据库。最新候选 PKG 已构建、解包并启动一次，采集启动日志后已停止；基线与候选 app 目前都未运行。
- 最新候选 build identity：`c3d37a41-8a08-46e0-b327-52800a4d494d`，版本 `0.2.9`，源码提交 `d117424ece9555f565d29af2a187012aa67d947d`，构建时工作树干净。
- 最新 arm64 PKG：`release/SpaceAssistant-0.2.9-arm64.pkg`，SHA-256 `868e130b26943bf1cd0902222551c4be455263e1c4c5312670870ef4255f456c`。PKG 内 `app.asar` SHA-256 `d11b3528f82bfc2627773bd54ba6c1a6b262b9250d283492a5c9020335a9c529`；PKG 展开后的文件哈希与打包目录一致。`codesign --verify --deep --strict` 通过；没有 Developer ID 身份，故这是 ad-hoc 隔离候选，不代表已签名公证的发布包。
- 最新包内分页代码在隔离真实库 APFS clone 上执行 `readChatPageAfterPreparation`：大/普通会话 cold-projection source-page 各 30 次，p95 为 3.71/4.96 ms。这是 Electron 44.1.1 / Node 24.19.0 中的共享主进程读函数数据，不包含点击到首帧、React 渲染、跨进程等待或维护竞争。
- 最新包内 `readCanonicalCompactionReplay` 在同一真实库副本上，大/普通会话各 10 次 p50 为 13.65/8.19 ms。此前包 `410a14dd` 的 15 次 ledger 检查均为 proof reuse，没有重复 baseline；该包仍记录一次 845 ms event-loop delay，来源未确定。
- P4-02 的完整证据和限制见 [external-performance.md](external-performance.md)。本地定向回归、完整构建、边界门禁与 PKG 校验结果分别记于该报告与提交 `d117424e`。
- 用户确认已解锁 Mac；但桌面自动化服务仍返回“Mac 已锁定”，无法向窗口发送点击或采集真实交互。通过 `open -n` 启动最新候选解包应用，PID `36040`，仅使用隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v6`；基线使用独立目录 `/tmp/spaceassistant-p4-validation/copies/baseline-v4`。完成日志采集后已向两个由本任务启动的实例发送 TERM 并确认进程退出。
- 最新候选启动后日志确认 build ID `c3d37a41-8a08-46e0-b327-52800a4d494d`。单次**启动初始页** trace：main `durationMs=9.94`（page-select 9.35、source-page-read 9.54、main-ipc 9.86）；renderer page request 40.8 ms；store commit 0.4 ms、render commit 21.9 ms、next paint 14.7 ms。另有启动期 ledger proof reuse 135 ms、recovery completed 6 ms。此为启动观测，**不是会话切换样本**，不纳入 AC-7 的点击到首帧统计。日志位置：`/tmp/spaceassistant-p4-validation/copies/candidate-v6/workspaces/2/.agent/logs/Agent-20261027.log`。
- 当前桌面控制接口多次报锁屏，因此未做点击切换、设置响应、热/损坏缓存矩阵、主线程长任务或前台/维护竞争测量。候选启动日志已采集，进程现已停止；这不能替代 GUI 验收。
- IM 验收经用户澄清后标为**不适用**：本项目没有专用私聊或群聊 sandbox 会话。此前授权仅限 sandbox 测试消息；不向任何真实会话发送测试消息，也不再把提供 sandbox 账号/会话作为继续条件。

## 尚未执行的安装包验收

虽然用户确认 Mac 已解锁，桌面自动化服务仍返回“Mac 已锁定”。在该状态下无法操作窗口、采集首帧或验证设置响应，因此本报告不把启动页日志或函数级计时写成界面验收。

以下项目仍未完成：

1. 最新包在当前 macOS arm64 设备上的实际窗口切换、首次访问、热缓存、损坏缓存和维护开/关矩阵；按方案 §2 对每个适用矩阵格采集至少 30 次、失败率、p50/p95/max。
2. 同设备、同冻结库来源、同场景的基线/候选点击到首帧比较。当前基线二进制没有同口径 `session.switch.trace`；先前 CUA AX / screenshot 计时包含自动化等待和可访问性树读取，不可作为首帧证据。
3. 切换期间主线程同步长任务（AC-7 暂定上限 50 ms）、设置响应、候选进程峰值 RSS、维护完成耗时及后台维护对前台的竞争数据。
4. 最新安装包中的 AC-5/AC-6 代表性故障与并发场景复核。源码测试通过不能替代安装包真实运行证据。
5. IM 并发项不适用：用户确认没有专用私聊或群聊 sandbox。当前不向真实 IM 会话发送测试消息。

## 继续验收步骤

1. 桌面自动化恢复后，分别启动基线与唯一最新候选；确认两个实例的 user-data 目录仍隔离，记录包 build ID 与数据库 schema。当前两个实例均已停止。
2. 依照方案 §2 固定同一机器、库来源、页大小与系统缓存条件，完成首次访问、热缓存、损坏缓存、维护开/关适用矩阵；记录每格至少 30 个有效样本、失败率、p50/p95/max、主线程长任务、候选 RSS 与维护完成时间。若测量目标未达，返回源码任务修复后重建包并复测。
3. 安装包中复核 AC-5：A→B→A、重复读取、取消等待者、后台维护与前台竞争、关闭/切库；复核 AC-6：选页后源编辑/追加/压缩/删除、spill 损坏、块截断、发布边界故障。只接受完整有效页或既定错误，不把空页当成功。
4. IM 项保持不适用，不发送真实会话测试消息。
5. 更新本报告结论与证据链接。只有 AC-7 适用外验与 AC-5/AC-6 包内代表场景都有结果后，才能把 P4-03 标为完成；本报告不触发自动发布或替代生产 owner 门禁。

## 结论

P4-03 **未完成**。已具备最新候选包、隔离真实库、一次启动初始页 trace 与源码/包内函数级数据；真实会话切换 UI、完整 AC-7 矩阵、包内 AC-5/AC-6 场景仍缺。IM sandbox 并发因项目没有专用测试会话而不适用。当前结论不得解读为性能验收通过或允许发布。
