# T00 基线记录

- 日期：2026-10-29（Asia/Shanghai）
- worktree：`.worktrees/im-standard-review-execution`
- 分支：`codex/im-standard-review-execution`
- 初始提交：`30ebf315035375e02f8067e4482ec25e85be4014`
- 技术方案：`docs/develop/im-remote/in-flight/IM标准模式安全审核替代一刀切技术方案.md`
- 技术方案 SHA-256：`26da47f648d36d2dada9a4afad508a7680019291473cb23e74377346c6b44dd3`
- 当前 worktree `git status --short --untracked-files=all`：初始干净；T00 记录新增后仅含本任务计划/证据改动。
- 主工作区状态：仅有未跟踪 `llm-wiki.migrated-20261015-135757/`（4 个文件）；未触碰。
- 方案评审：原工作区可读到 2026-10-29 第四轮评审，B-01/B-02/B-03 规格层关闭；该评审文档未跟踪，不属于方案内容基线，当前 worktree 无此文件。
- AP-格式：计划、方案、评审文本均未提供负责人批准记录；T14 保持阻塞。
- 界面/接口：浏览器选择及回退入口的批准记录未发现；不纳入本计划当前实施。
- 外部验收资源：未声明微信/飞书测试账号、登录态浏览器或网络测试服务可用；属于后续真实环境验收，不阻塞本机源码准备。
- 依赖：`test -d node_modules` 退出码 1；尚未安装。Node `v26.4.0`，npm `11.17.0`。
- 方案静态核对：第四轮结论为规格层无新增阻断；持久化字段审批和实现验证仍未完成。
- 取证命令（worktree 根目录）：`git rev-parse HEAD`、`git status --short --untracked-files=all`、`shasum -a 256 'docs/develop/im-remote/in-flight/IM标准模式安全审核替代一刀切技术方案.md'`、`rg -n 'AP-格式|格式审批|浏览器开启选择|界面归属卡|待批准|尚未批准' ...`。
