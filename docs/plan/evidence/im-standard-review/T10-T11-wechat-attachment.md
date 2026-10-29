# T10–T11 微信目录外附件审核与上传证据

- 基线：Phase C 提交 `777cade8`；本阶段改动在 `codex/im-standard-review-execution` 隔离 worktree，未激活生产 `im-standard-v3`。
- 规格：技术方案 D-04、INV-05、AC-05/08。证据只覆盖本机模拟链路；真实微信账号和渠道上传仍需后续外部验收。

## T10 完整事实与拒绝优先

- RED：普通目录外附件最初只有路径范围事实，缺少完整内容摘要、授权绑定和可供 Agent 审核的隔离规则；新增事实/决策测试在实现前失败。
- GREEN：gate 采集普通文件的设备/ inode/模式/大小/修改时间身份，使用 `O_NOFOLLOW` 打开并在读取前后对拍身份，生成 SHA-256、大小、UTF-8 检查覆盖与脱敏展示名；绑定收件人、文件身份、IM owner、授权代次、message/request/tool id。外部普通回复只有在注册执行器准备摘要与 gate 实际读取摘要相同时才保留候选。
- 拒绝边界：仅标准档的 `wechat_reply` 目录外普通文本可进入 Agent 审核；缺事实或摘要不匹配由 locked deny 阻断。`wechat_send` 仍命中 `remote-wechat-media-outside-deny`；其他档位仍拒绝；含凭证证据触发真人确认，未降低敏感出站审核要求。
- TDD/定向结果：`npm exec -- vitest run electron/confirmation/toolCallGate.test.ts electron/tools/weChatToolExecutor.test.ts electron/tools/wechatOutboundRegisteredTools.test.ts` 退出码 0，3 files / 244 tests passed。覆盖文件身份、完整绑定、缺 owner/授权代次、摘要不匹配、敏感内容真人确认、非标准档拒绝及主动发送拒绝。

## T11 实际上传与许可

- RED：新增长测先因现有执行器只允许工作目录内路径而失败，未调用上传；GREEN 后只在已准备的普通文本目录外回复许可、用户/owner/收件人绑定一致、p2p 上下文有效且 Agent 回执存在时，执行器才按审批绝对路径打开文件并核验最终字节 SHA-256。
- 变更失效：prepared fingerprint 在确认前、dispatch 后各核对一次，覆盖路径摘要、收件人、授权代次及远程上下文；打开文件后再次核对 descriptor identity 和摘要。批准后替换、dispatch 前授权代次撤销、接收者变化均在上传前拒绝；绕过注册许可直接调用执行器、缺许可事实或最终 SHA-256 不同均不上传。最终字节漂移使用稳定 case ID `wechat-media-approved-material-changed`。
- TDD/定向结果：`npm exec -- vitest run electron/tools/weChatToolExecutor.test.ts electron/tools/wechatOutboundRegisteredTools.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts` 退出码 0，3 files / 99 tests passed。注册执行器模拟验证上传收到的字节等于摘要绑定字节；另覆盖确认后替换、dispatch 后撤权/换收件人、缺许可、final-check 摘要漂移及 task-reply 许可不能转用于主动发送。

## Phase D 收尾

- `npm run typecheck:shared`：退出码 0。
- `npm run build:electron:incremental`：退出码 0；pi-ai runtime closure、session-storage cleanup/module graph 门禁通过。
- `npm run check:system-invariant-registry`：退出码 0；12 registrations、42 references，正反向 fixtures 通过；本阶段未新增系统 invariant。
- `git diff --check`：退出码 0。
- `npx tsc -p tsconfig.electron.json --noEmit --incremental false`：退出码 0，无诊断。
- `npm test`：退出码 0；1228 files passed、1 skipped；11871 tests passed、140 skipped；Vitest duration 1247.86s。
- 未运行真实微信渠道或真实上传；按计划 AC-05 本机部分完成，不代表完整 AC 或发布验收。
