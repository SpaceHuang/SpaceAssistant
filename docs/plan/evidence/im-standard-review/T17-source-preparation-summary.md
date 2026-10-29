# T17 本机源码准备汇总

- 日期：2026-10-30（Asia/Shanghai）
- worktree：`.worktrees/im-standard-review-execution`
- 分支：`codex/im-standard-review-execution`
- 汇总基线：T14–T16 提交 `8c2b80e5`；工作区在最终验证前干净。
- 规格基线：技术方案 `docs/develop/im-remote/in-flight/IM标准模式安全审核替代一刀切技术方案.md`；格式/内部契约批准记录 `docs/plan/evidence/im-standard-review/AP-format-approval.md`。

## 计划任务与本机 AC 覆盖

| 范围 | 完成任务 | 本机证据 | 可声明范围 |
|---|---|---|---|
| A 版本与迁移 | T00–T03、T14–T16 | `T00-baseline.md`、`T01-legacy-contract.md`、`T02-runtime-and-binding.md`、`T14-T16-policy-migration-recovery.md` | AC-07a/07b、08 的隔离库、版本、回退与恢复部分；v3 未由正常生产启动激活 |
| B 普通文件及命令 | T04–T07 | `T04-read-scope.md` | AC-01～03、08、09 的本机模拟、事实与执行边界 |
| C 浏览器 | T08–T09 | `T04-read-scope.md`（含 T08/T09 和 Phase C 收尾） | AC-04/08 的本机请求、审批失效与拒绝边界；UI/配置审批与真实登录浏览器未覆盖 |
| D 微信附件 | T10–T11 | `T10-T11-wechat-attachment.md` | AC-05/08 的审核材料、字节绑定与上传边界测试；真实微信发送未覆盖 |
| E 联网脚本 | T12–T13 | `T12-T13-script-network-review.md` | AC-06/08 的静态候选、执行材料绑定和 Hosted 回归；未执行真实网络请求 |
| 跨入口汇总 | T17 | 本文和下列最终命令 | 上述 AC 的本机测试范围；不代表外部验收或发布关闭 |

## T17 最终验证

- `npm exec vitest run electron/confirmation/imAsyncApproval.integration.test.ts electron/remote/imEndToEndRecovery.test.ts electron/confirmation/securityTaskSetGate.integration.test.ts`：退出码 0；3 files / 25 tests passed。
- `npm test`：退出码 0；1229 files passed、1 skipped；11894 tests passed、140 skipped；Vitest duration 1148.97 秒。进程输出了 Node `MaxListenersExceededWarning`，未导致失败。
- `npm run build`：退出码 0；托盘图标、renderer 和 Electron 主进程构建完成。构建日志有现存的 ineffective dynamic import 与大 chunk 警告；无构建错误。
- `npm run check:system-invariant-registry`：退出码 0；12 registrations、42 references，正反向 fixtures 通过。
- `npm run typecheck:shared`：退出码 0。
- `git diff --check`：退出码 0。

## 未覆盖与发布边界

- 未连接真实微信/飞书账号、手机、登录浏览器或外部网络服务；真实附件发送、浏览器重定向与联网脚本仍待后续外部验收。
- 未用旧版二进制执行降级/重新启动以验证字段保留。按已批准契约，兼容性证明完成前不得降级到可能丢弃 `automaticMigrationSuppressedVersions` 的旧版本。
- 回退与重新启用 UI/IPC 尚未审批或实现；本计划只实现并测试内部存储契约。浏览器启用选择 UI/配置也未审批。
- 正常应用启动不传入 v3 release gate，IPC/runtime 生产白名单仍未包含 v3；本阶段不迁移生产用户数据、不激活 v3、不生成发布安装包，也不声称最终源码关闭或可发布。后续发布阶段 F 需按计划 §5 补充和评审新执行计划，并满足真实环境验收。

T17 只关闭本计划的本机源码准备汇总任务。外部验收和发布仍保持未完成。
