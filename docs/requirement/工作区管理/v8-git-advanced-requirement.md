# V8 — Git 进阶能力（可选）

> **版本**：V8  
> **发布**：M2+（**可选**，不阻塞 V6/V7）  
> **状态**：范围占位  
> **依赖**：[v7-git-remote-sync-requirement.md](./v7-git-remote-sync-requirement.md)  
> **原文**：§7.5、§12

---

## 1. 概述

V8 为可选增强：merge / stash、子模块识别、系统 Git 回退、status 性能优化等。立项时再细化，不改变 V6 双暴露面原则。

---

## 2. 范围（§7.5）

| 能力 | 暴露面 |
|------|--------|
| merge / stash / cherry-pick | primarily Agent |
| 子模块 linked gitdir | Agent + 文档 |
| 系统 Git 回退 | 设置开关 |
| status 性能优化 | 主进程 |

---

## 3. 验收原则

- [ ] 不 reintroduce 多仓库选择器
- [ ] 不阻塞 V6/V7 发布

---

## 4. 关联文档

- [v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md)
- [isomorphic-git-workdir-version-control-requirement.md](./isomorphic-git-workdir-version-control-requirement.md) §7.5
