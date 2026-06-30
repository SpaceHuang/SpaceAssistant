# V7 — Git 远端同步

> **版本**：V7  
> **发布**：M2 **第二期**（依赖 V6 本地闭环，可独立发布）  
> **状态**：需求定稿  
> **依赖**：[v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md)  
> **后续**：[v8-git-advanced-requirement.md](./v8-git-advanced-requirement.md)（可选）  
> **原文**：§7.4、§6.5.10、§4.10.7、§10.3、附录 C

---

## 1. 概述

V7 在 V6 之上交付 **远端能力**：**同步**（pull → push）、**clone**、HTTPS **凭据**，以及 Agent 远端 `git_*`。UI 与 Agent **同期注册**。

### 1.1 非目标

- push --force（禁止）
- SSH 原生（HTTPS + Token；或 shell 回退）
- 改变 V6 单仓库模型与写作极简 UI

---

## 2. 功能范围

| 功能 | UI | Agent | IPC |
|------|-----|-------|-----|
| 同步 | **同步** 按钮 | `git_pull`, `git_push` | `git:fetch`, `git:pull`, `git:push` |
| clone | 设置 / onboarding | `git_clone` | `git:clone` |
| 凭据 | 设置页 Git 区块 | 同 UI | `onAuth` + safeStorage |

---

## 3. UI：同步（§6.5.10）

- 文案：**同步**；默认 pull 再 push
- 有未提交变更：pull 前提醒 **保存版本**
- `syncing` 时禁用保存与同步

---

## 4. Clone 与凭据

- Clone：推荐新建 Profile，目标 workDir **根**；HTTPS；`resolveSafePath`
- 凭据：按 host、`safeStorage`；不落 workDir

---

## 5. Agent 工具（附录 C）

V7 起注册：`git_clone`、`git_pull`、`git_push`（V6 不注册）。

---

## 6. 验收标准

- [ ] 有效 HTTPS 凭据下同步可用
- [ ] clone 路径安全；凭据加密
- [ ] Agent 远端工具与 UI 同期上线
- [ ] push --force 被拒绝

---

## 7. 工作量参考

约 **5–8 人日**。

---

## 8. 关联文档

- [v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md)
- [v8-git-advanced-requirement.md](./v8-git-advanced-requirement.md)
- [isomorphic-git-workdir-version-control-requirement.md](./isomorphic-git-workdir-version-control-requirement.md)
