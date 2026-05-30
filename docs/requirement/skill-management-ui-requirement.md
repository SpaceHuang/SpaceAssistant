# Skill 管理界面优化与推荐安装 — 需求规格

**版本：** 1.0  
**日期：** 2026-05-30  
**状态：** 已实现  
**关联文档：** [skills-requirement.md](./skills-requirement.md)、[settings-ui-refinement-requirement.md](./settings-ui-refinement-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05-30 | Skill Tab 双列表、推荐 Skill 一键安装、表格样式精简、GitHub 安装后端、外部 Skill 校验放宽 |

---

## 目录

1. [概述](#1-概述)
2. [Skill 管理双 Tab](#2-skill-管理双-tab)
3. [推荐 Skill 列表](#3-推荐-skill-列表)
4. [GitHub 一键安装](#4-github-一键安装)
5. [已安装列表 UI](#5-已安装列表-ui)
6. [Skill 校验规则调整](#6-skill-校验规则调整)
7. [作用域相关说明](#7-作用域相关说明)
8. [IPC 与 API](#8-ipc-与-api)
9. [验收标准](#9-验收标准)
10. [相关文件](#10-相关文件)
11. [待解决问题](#11-待解决问题)

---

## 1. 概述

### 1.1 背景

设置页 Skill Tab 原有「Skill 管理」为单一表格，用户只能：

- 查看已安装 Skill 并启用/禁用、导出、删除
- 通过「安装 Skill」从本地目录手动安装

存在以下问题：

- 缺少官方/社区优质 Skill 的发现与引导入口
- 从 GitHub 获取 Skill 需用户自行 clone/下载后再选目录，路径长
- 表格列（名称、描述、作用域、版本）信息密度低，与推荐列表视觉不一致
- 部分外部 Skill（如 Superpowers、MiniMax）的 `SKILL.md` 不含 `triggers` 字段，无法通过现有校验安装

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | Skill 管理区拆分为 **「已安装」** 与 **「推荐」** 两个 Tab |
| G2 | 推荐 Tab 展示首批精选 Skill，支持 **GitHub 一键安装** |
| G3 | 已安装 / 推荐列表统一采用 **标题 + 描述** 双行单元格布局 |
| G4 | 精简已安装列表：移除 **版本**、**作用域** 列 |
| G5 | 放宽 Skill 元数据校验，兼容主流外部 Skill 仓库格式 |
| G6 | 提供可扩展的推荐 Skill 配置源（`RECOMMENDED_SKILLS`） |

### 1.3 非目标

- 不实现 Skill 市场、评分、搜索、分页
- 不在本需求中实现安装时选择作用域（用户级 / 项目级）
- 不改变 Skill 匹配、路由、斜杠命令等运行时逻辑（除校验放宽外）
- 推荐列表内容不由服务端动态下发（首批为应用内静态配置）

---

## 2. Skill 管理双 Tab

### 2.1 布局

「Skill 管理」区块标题与工具按钮保持不变，其下使用 Ant Design `Tabs`（`size="small"`）：

| Tab key | 标签 | 内容 |
|---------|------|------|
| `installed` | 已安装 | 当前用户可见的 Skill 列表（同原列表能力） |
| `recommended` | 推荐 | 静态推荐 Skill 列表 + 安装按钮 |

默认激活 Tab：**已安装**。

### 2.2 工具按钮

| 按钮 | 可见 Tab | 行为 |
|------|----------|------|
| 安装 Skill | 仅 **已安装** | 弹出系统目录选择器，从本地目录安装（行为不变） |
| 打开目录 | 两个 Tab 均可见 | 打开用户级 Skill 目录 `<userData>/skills/` |

推荐 Tab **不显示**「安装 Skill」按钮（安装入口为各行「安装」按钮）。

### 2.3 区块上方配置（不变）

Tab 上方仍保留：

- 「由 AI 根据 Skill 描述自动选择要加载的 Skill」Switch（`skills.autoDetect`）
- 「始终加载」多选（隐藏产品内置 Skill，见 [settings-ui-refinement-requirement.md](./settings-ui-refinement-requirement.md) §4.1）

---

## 3. 推荐 Skill 列表

### 3.1 数据来源

推荐项定义于 `src/shared/recommendedSkills.ts` 的 `RECOMMENDED_SKILLS` 常量。

每条推荐项结构：

```typescript
interface RecommendedSkillEntry {
  id: string
  name: string
  description: string
  sourceUrl: string
  subPath?: string           // 仓库内 Skill 目录（相对解压根）
  installAll?: boolean       // true 时安装 subPath 下所有含 SKILL.md 的子目录
  expectedSkillNames: string[] // 用于判断「已安装」状态
}
```

### 3.2 首批推荐列表

| id | 展示名称 | sourceUrl | 安装说明 |
|----|----------|-----------|----------|
| `superpowers` | Superpowers | `https://github.com/obra/superpowers` | `subPath: skills`，`installAll: true`，批量安装 14 个子 Skill |
| `guizang-social-card` | 归藏社交卡片 | `https://github.com/op7418/guizang-social-card-skill` | 单 Skill 仓库根目录 |
| `pptx-generator` | PPTX Generator | `https://github.com/MiniMax-AI/skills/tree/main/skills/pptx-generator` | 单子目录 |
| `minimax-xlsx` | MiniMax XLSX | `https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-xlsx` | 单子目录 |
| `minimax-docx` | MiniMax DOCX | `https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-docx` | 单子目录 |

后续新增推荐项：在 `RECOMMENDED_SKILLS` 数组末尾追加条目即可，无需改 UI 代码。

### 3.3 表格列

| 列 | 布局 | 说明 |
|----|------|------|
| Skill | 双行 | 第一行：**标题**（`name`，加粗 13px）；第二行：**描述**（`description`，次要色 12px） |
| 来源 | 双行 | 第一行：**作者昵称**（从 `sourceUrl` 解析 GitHub owner，如 `obra`、`MiniMax-AI`）；第二行：**GitHub** 外链 |
| 操作 | 单行 | 见 §3.4 |

列宽支持拖拽调整（与已安装列表共用 `useResizableColumns` 模式）。

### 3.4 操作列

| 状态 | 展示 |
|------|------|
| 未安装 | 主色「安装」按钮（带下载图标）；安装中显示 loading |
| 已安装 | 绿色 Tag「已安装」 |

**已安装判定：** `expectedSkillNames` 中每个名称均出现在当前已安装 Skill 列表（不含产品内置 Skill）中。

作者昵称解析：`getRecommendedSkillAuthor(entry)`，正则匹配 `github.com/<owner>/`。

### 3.5 安装成功反馈

| 场景 | 行为 |
|------|------|
| 安装 1 个 Skill | 顶部绿色 Alert：`Skill「{name}」安装成功`；自动切到 **已安装** Tab；高亮对应行 2 秒 |
| 批量安装（如 Superpowers） | Alert：`已成功安装 {n} 个 Skill`；切 Tab + 高亮首个 Skill |
| 同名已存在 | 确认对话框询问是否覆盖；确认后 `overwrite: true` 重试 |
| 失败 | 顶部红色 Alert 展示错误信息 |

---

## 4. GitHub 一键安装

### 4.1 流程

```
用户点击「安装」
    → 解析 sourceUrl（owner / repo / branch / subPath）
    → 从 codeload.github.com 下载 tar.gz
    → tar 解压到临时目录
    → 解析 Skill 源目录（单目录或 installAll 批量）
    → 逐个调用 installSkillToUserDir 复制到 <userData>/skills/
    → 清理临时目录，刷新列表
```

### 4.2 URL 解析规则

支持格式：

- `https://github.com/{owner}/{repo}`
- `https://github.com/{owner}/{repo}/tree/{branch}/{subPath}`

默认分支：`main`；若 `main` 下载失败则尝试 `master`。

### 4.3 Skill 源目录解析

| 条件 | 行为 |
|------|------|
| `subPath`（或 URL 内 path）指向的目录根含 `SKILL.md` | 安装该目录 |
| `installAll === true` | 安装 `subPath` 下每个含 `SKILL.md` 的子目录 |
| 均不满足 | 报错「未找到有效的 Skill 目录」 |

### 4.4 安装目标作用域

GitHub 安装与本地目录安装相同：**固定安装到用户级** `<userData>/skills/`，不可选择项目级。

### 4.5 依赖与环境

| 依赖 | 说明 |
|------|------|
| 网络 | 需访问 `codeload.github.com` |
| 系统 `tar` | 解压 tar.gz（Windows 10+ / macOS / Linux 均可用） |

---

## 5. 已安装列表 UI

### 5.1 表格列（最终实现）

| 列 | 布局 | 说明 |
|----|------|------|
| 启用 | 单行，垂直居中 | Switch，控制 `skills.disabled` |
| Skill | 双行 | 第一行：**Skill 名称**（加粗）；第二行：**描述**（次要色） |
| 操作 | 单行，垂直居中 | 导出、删除；表头 **「操作」水平居中** |

### 5.2 移除的列

| 列 | 变更 |
|----|------|
| 名称 / 描述（分列） | 合并为 Skill 双行单元格 |
| 作用域 | **移除**（运行时仍区分 project/user，列表不再展示） |
| 版本 | **移除** |

### 5.3 保留的后端行为

| 行为 | 说明 |
|------|------|
| 项目级 Skill 不可删除 | 删除按钮对 `scope === 'project'` 仍 disabled |
| 产品内置 Skill 不展示 | `llm-wiki` 等仍不出现在列表 |
| Tab 激活时自动刷新 | 进入 Skill Tab 时 `skillInvalidateCache` + `skillList` |

---

## 6. Skill 校验规则调整

### 6.1 `triggers` 字段

| 原规则 | 新规则 |
|--------|--------|
| `SKILL.md` front matter **必须**含 `triggers`，且非空 | `triggers` **可选**；缺失时默认为 `[]` |
| 缺失则安装/扫描失败 | 兼容 Superpowers、MiniMax 等外部仓库 |

仍必填：`name`、`description`（格式与长度规则不变）。

### 6.2 路由影响

`triggers` 为空时：

- 关键词匹配（`keywordMatch`）不命中
- 仍可通过 **描述相似度**、**LLM 路由**、**始终加载**、**手动激活** 加载 Skill

---

## 7. 作用域相关说明

### 7.1 支持的作用域（运行时，未改）

| 作用域 | 目录 | 说明 |
|--------|------|------|
| 用户级 `user` | `<userData>/skills/` | 本地安装、GitHub 安装的目标 |
| 项目级 `project` | `<workDir>/.space-skills/` | 手动放置或由产品逻辑安装（如 Wiki 初始化 `llm-wiki`） |

同名冲突时项目级优先（扫描合并逻辑不变）。

### 7.2 安装入口与作用域

| 安装方式 | 是否可选作用域 | 实际目标 |
|----------|----------------|----------|
| 本地目录「安装 Skill」 | **否** | 用户级 |
| 推荐 Tab GitHub 一键安装 | **否** | 用户级 |
| 手动复制到 `.space-skills/` | — | 项目级 |

本需求 **未实现** 安装前选择作用域；若未来支持，需扩展 UI 与 `skill:install` / `skill:install-from-url` 参数。

---

## 8. IPC 与 API

### 8.1 新增 IPC

| 通道 | 入参 | 返回 |
|------|------|------|
| `skill:install-from-url` | `{ sourceUrl, subPath?, installAll?, overwrite? }` | `{ ok: true, skills }` 或 `{ ok: false, error }` |

### 8.2 渲染进程 API

```typescript
skillInstallFromUrl: (payload: {
  sourceUrl: string
  subPath?: string
  installAll?: boolean
  overwrite?: boolean
}) => Promise<{ ok: true; skills: SkillDefinition[] } | { ok: false; error: string }>
```

### 8.3 共享工具

| 符号 | 文件 | 用途 |
|------|------|------|
| `RECOMMENDED_SKILLS` | `src/shared/recommendedSkills.ts` | 推荐列表配置 |
| `getRecommendedSkillAuthor` | 同上 | 解析 GitHub owner 作为作者昵称 |
| `isRecommendedSkillInstalled` | 同上 | 判断推荐项是否已全部安装 |

### 8.4 主进程模块

| 模块 | 职责 |
|------|------|
| `electron/skills/skillGithubInstall.ts` | URL 解析、下载、解压、目录解析、批量安装 |
| `electron/skills/skillManager.ts` | 新增 `installFromUrl()` |
| `electron/skills/skillParser.ts` | `triggers` 可选 |

---

## 9. 验收标准

### 9.1 Tab 与导航

- [ ] Skill 管理区有「已安装」「推荐」两个 Tab，默认「已安装」
- [ ] 「安装 Skill」仅在已安装 Tab 显示；「打开目录」两 Tab 均可见

### 9.2 推荐 Tab

- [ ] 展示 5 条首批推荐 Skill，Skill / 来源均为双行布局
- [ ] 来源第一行显示 GitHub owner，第二行为 GitHub 链接
- [ ] 未安装项可一键安装；已安装项显示「已安装」Tag
- [ ] Superpowers 安装后已安装列表增加 14 个 Skill
- [ ] 安装成功自动切换到已安装 Tab 并提示

### 9.3 已安装 Tab

- [ ] 列为：启用 | Skill（双行）| 操作
- [ ] 无作用域列、无版本列
- [ ] 「操作」表头水平居中
- [ ] 项目级 Skill 删除按钮仍禁用

### 9.4 安装与校验

- [ ] 本地目录安装仍可用，目标为用户级目录
- [ ] 不含 `triggers` 的外部 Skill 可成功安装
- [ ] 同名 Skill 覆盖确认流程正常

### 9.5 测试

- [ ] `electron/skills/skillGithubInstall.test.ts` — URL 解析与目录解析
- [ ] `src/shared/recommendedSkills.test.ts` — 推荐列表与安装状态
- [ ] `electron/skills/skillParser.test.ts` — triggers 可选

---

## 10. 相关文件

| 文件 | 变更摘要 |
|------|----------|
| `src/renderer/components/Config/SkillsTab.tsx` | 双 Tab、推荐/已安装表格布局、GitHub 安装交互 |
| `src/shared/recommendedSkills.ts` | 推荐 Skill 配置与工具函数 |
| `src/shared/recommendedSkills.test.ts` | 推荐配置单元测试 |
| `src/shared/api.ts` | `skillInstallFromUrl` 类型 |
| `electron/preload.ts` | 暴露 `skillInstallFromUrl` |
| `electron/appIpc.ts` | `skill:install-from-url` 处理器 |
| `electron/skills/skillGithubInstall.ts` | GitHub 下载与安装 |
| `electron/skills/skillGithubInstall.test.ts` | GitHub 安装单元测试 |
| `electron/skills/skillManager.ts` | `installFromUrl` |
| `electron/skills/skillParser.ts` | `triggers` 可选 |
| `electron/skills/skillParser.test.ts` | 校验规则测试更新 |

---

## 11. 待解决问题

| # | 问题 | 说明 |
|---|------|------|
| O1 | 安装时不可选作用域 | 本地 / GitHub 安装均固定用户级；项目级需手动放入 `.space-skills/` |
| O2 | 推荐列表静态配置 | 更新推荐内容需发版；后续可考虑远程配置或 Skill 市场 |
| O3 | GitHub 安装依赖系统 `tar` | 极端环境下 tar 不可用会导致安装失败，需错误提示友好 |
| O4 | `skills-requirement.md` §7.2 表格列定义过时 | 原需求含作用域、版本列；以本文及当前 UI 为准 |

---

*本文档汇总 2026-05-30 Skill Tab 管理优化与推荐安装的实现规格；与 [skills-requirement.md](./skills-requirement.md) 冲突时，以本文及当前代码为准。*
