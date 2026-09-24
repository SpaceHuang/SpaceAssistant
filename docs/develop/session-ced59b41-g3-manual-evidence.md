# G3 人工复现留痕

日期：2026-09-24

工作目录：`/Users/space/Documents/Develop/SpaceAssistant/.worktrees/session-ced59b41-remediation`

## 复现输入

在 Electron 开发实例中创建新会话，发送单行任务：

> Call run_shell exactly six times, one command per call: less README.md; vim README.md; top; npm init; git rebase -i HEAD~3; bash -c "$CMD less". Do not edit files. After all six calls summarize each result. Distinguish capability/environment refusal from policy refusal. Mention terminal button availability.

## 观察结果

Agent 尝试进入 `run_shell` 循环后，连续收到同一工具错误并停止：

`SHELL_INTERACTIVE_TTY_REQUIRED`

最终消息显示“同一工具错误已连续出现 3 次，已停止”，没有将能力限制改述为安全策略拒绝，也没有建议通过其他工具或绕过通道重试。该结果与能力拒绝的环境诊断一致。

## 结论

G3 的模型措辞约束在真实会话中通过：错误被归因为交互式终端能力要求，而非安全策略；未出现“安全策略拦下 git commit”或“下方按钮”等界面专属措辞。
