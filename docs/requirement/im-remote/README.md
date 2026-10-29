# im-remote（需求侧）—— 飞书 / 微信集成、远程安全与意图 Track

> 定位：远程与 IM 的需求口径入口。实现侧见 [`../../develop/im-remote/`](../../develop/im-remote/)。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 当前生效口径（飞书集成与状态栏、CLI 日志、微信 iLink Bot、私聊安全、异步审批、远程模型与思考档位、进度同步、会话上下文感知、远程工作目录、产物决策）。
- [im-security-agent-agency-principles-requirement.md](./im-security-agent-agency-principles-requirement.md) —— IM 安全审核 Agent 协作原则（A 类，讨论共识；**尚未拆分为实现方案**）。

## 在途（in-flight）

- [2026-10-11-im-security-review-improvement-requirement.md](./in-flight/2026-10-11-im-security-review-improvement-requirement.md) —— **真在途**：统一 IM 策略域（少问人）的方案草案；开发侧方案见 [`../../develop/im-remote/in-flight/`](../../develop/im-remote/in-flight/)。

## 归档

- 需求原件 → [`../archive/im-remote/`](../archive/im-remote/)（14 件：飞书 / 微信集成、远程工作目录、进度同步、异步审批、产物决策等）。
- 旧路径 → 新路径：见 [`../archive/INDEX.md`](../archive/INDEX.md)。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/feishu electron/wechat electron/remote electron/outbound
rg -n 'remotePolicy|intentTrack|asyncApproval' electron/remote electron/feishu electron/wechat
```
