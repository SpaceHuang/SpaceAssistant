# Skills 机制需求方案

## 目录

1. [背景与动机](#1-背景与动机)
2. [目标与非目标](#2-目标与非目标)
3. [用户故事](#3-用户故事)
4. [Skill 定义规范](#4-skill-定义规范)
5. [Skill 目录与作用域](#5-skill-目录与作用域)
6. [Skill 加载与注入机制](#6-skill-加载与注入机制)
7. [Skill 管理界面](#7-skill-管理界面)
8. [配置支持](#8-配置支持)
9. [与现有功能的关系](#9-与现有功能的关系)
10. [非功能需求](#10-非功能需求)
11. [数据模型设计](#11-数据模型设计)
12. [IPC 接口设计](#12-ipc-接口设计)
13. [发布计划](#13-发布计划)
14. [待解决问题](#14-待解决问题)

---

## 1. 背景与动机

### 1.1 现状

SpaceAssistant 是一款基于 Electron + React + TypeScript 的桌面 AI 助手，当前已支持流式聊天、大模型配置、会话管理、Tool Use 可视化、Thinking 过程展示等核心功能。用户通过聊天界面与 AI 交互时，所有上下文和操作规范只能通过对话消息逐次传递，缺乏一种结构化机制将**领域专属的最佳实践、操作规范和知识模板**注入到 AI 的工作流中。

### 1.2 问题

- **重复输入上下文**：对于文档生成（Word/PDF）、代码审查、API 设计等高频场景，用户需每次手动描述格式规范与操作约束，效率低下。
- **团队规范难以对齐**：不同成员的 AI 输出风格和格式不一致，缺乏统一的团队级规范注入手段。
- **对话上下文浪费**：将大量规范文本写进每条消息中，占用 Token 额度，降低对话的有效信息密度。
- **个人知识难以复用**：用户积累的最佳实践无法结构化保存，无法在会话间自动复用。

### 1.3 机会

参考 Claude Code 的 Skills 机制（PRD 见 `docs/references/claude_code_skills_prd.md`），结合 SpaceAssistant 桌面应用的实际架构，引入 Skills 机制可以：

- 让 AI 在执行任务前自动发现并加载相关 Skill 文档，作为动态 System Prompt 片段注入上下文。
- 支持团队共享（项目级）和个人自定义（用户级）两层 Skill 作用域。
- 显著提升复杂任务的一致性、准确率与执行效率，减少重复上下文输入。

### 1.4 与 Claude Code Skills 的核心差异

| 维度 | Claude Code Skills（参考） | SpaceAssistant Skills（本方案） |
|------|--------------------------|-------------------------------|
| 宿主环境 | CLI 终端 | Electron 桌面应用（GUI） |
| 交互方式 | `/skill <subcommand>` 斜杠命令 | 图形化管理界面 + 聊天内斜杠命令 |
| Skill 管理 | 纯命令行操作 | 界面化管理（查看、添加、启用/禁用） |
| 上下文注入 | 运行时动态注入 system prompt | 通过聊天流式 API 的 system 字段注入 |
| 存储路径 | `.claude/skills/`（Unix 风格） | 适配 Windows/macOS/Linux 三平台的用户数据目录 |
| 作用域层级 | 项目级 / 用户级 / 系统级 | 项目级（工作目录下）/ 用户级（应用数据目录下） |

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 |
|---|------|
| G1 | SpaceAssistant 能够识别项目级和用户级两层 Skill 定义文件 |
| G2 | 发送聊天消息时，根据用户输入自动匹配并加载相关 Skill 到上下文 |
| G3 | 支持通过聊天输入框的斜杠命令 `/skill use <name>` 手动激活 Skill |
| G4 | 提供图形化的 Skill 管理界面，支持查看、启用/禁用、删除操作 |
| G5 | 支持 Skill 的自动激活与手动激活两种模式，用户可配置偏好 |
| G6 | Skill 加载过程对用户透明，在聊天界面中可见 |

### 2.2 非目标

- 不构建 Skill 市场/发布平台（属于后续迭代范围）
- 不修改 AI 模型本身的训练权重或行为
- 不替代 MCP Server 机制（Skills 提供知识指导，MCP 提供工具调用能力，二者互补）
- 不支持 Skill 之间的依赖声明（`depends_on`），本版本不做
- 不支持系统级（企业管理员）Skill 目录

---

## 3. 用户故事

### US-01：自动激活 Skill

**作为一名开发者**，当我在聊天中让 AI 生成 Word 文档时，我希望它能自动加载 `docx` Skill，而无需我手动告知格式规范。

### US-02：手动调用 Skill

**作为一名开发者**，我希望能通过 `/skill use pdf` 显式告知 AI 当前任务需要使用 PDF Skill，以确保它遵循正确的操作规范。

### US-03：团队共享 Skill

**作为团队负责人**，我希望将团队的代码审查规范写成一个 Skill，放在项目工作目录的 `.space-skills/` 下，让所有团队成员的 SpaceAssistant 都能自动加载它。

### US-04：个人私有 Skill

**作为个人用户**，我希望能在用户数据目录下维护自己的私有 Skill，这些 Skill 不会被提交到代码仓库。

### US-05：查看已激活 Skill

**作为一名开发者**，在 AI 执行任务时，我希望能看到它当前加载了哪些 Skill，以便排查输出不符合预期的问题。

### US-06：禁用 Skill

**作为开发者**，我希望能在某次会话中临时禁用特定 Skill，以避免其干扰当前任务。

---

## 4. Skill 定义规范

### 4.1 Skill 文件结构

每个 Skill 由一个目录表示，目录下必须包含 `SKILL.md` 文件：

```
<skill-name>/
├── SKILL.md          # 必须：Skill 核心说明文档（AI 读取的主文件）
├── scripts/          # 可选：辅助脚本（本版本不执行，仅作参考）
├── REFERENCE.md      # 可选：补充参考资料
└── LICENSE.txt       # 可选：许可证
```

### 4.2 SKILL.md 文件格式

```markdown
---
name: <skill-name>
description: "<触发描述，用于自动匹配判断>"
triggers:
  - keyword1
  - keyword2
version: "1.0.0"
author: "<作者或团队>"
---

# Skill 正文内容

...（具体的操作规范、最佳实践、脚本引用等）
```

**Front Matter 字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Skill 唯一标识符，字母小写加连字符，如 `docx-generation` |
| `description` | string | 是 | 自然语言描述，AI 据此判断是否激活该 Skill |
| `triggers` | string[] | 是 | 关键词列表，用于辅助匹配，至少包含一个关键词 |
| `version` | string | 否 | 语义化版本号，默认 `"1.0.0"` |
| `author` | string | 否 | 作者或团队名称 |

### 4.3 Skill 大小限制

| 指标 | 限制 |
|------|------|
| 单个 `SKILL.md` 最大体积 | 100 KB |
| 单次会话最大并发加载 Skill 数 | 5 个 |
| 单个 Skill 目录总体积 | 10 MB |

---

## 5. Skill 目录与作用域

SpaceAssistant 按以下优先级顺序查找 Skill（高优先级覆盖低优先级同名 Skill）：

```
优先级（高 → 低）
┌─────────────────────────────────────────────────────────────┐
│ 1. 项目级：<workDir>/.space-skills/                          │  ← 团队共享，可提交到 git
│ 2. 用户级：<userData>/skills/                                │  ← 个人私有，不提交
└─────────────────────────────────────────────────────────────┘
```

**目录说明：**

| 作用域 | 路径 | 说明 | 跨平台路径示例 |
|--------|------|------|---------------|
| 项目级 | `<workDir>/.space-skills/` | 与工作目录绑定，团队可共享 | Windows: `C:\Projects\MyApp\.space-skills\` |
| 用户级 | `<userData>/skills/` | 与用户数据目录绑定，全局生效 | Windows: `%APPDATA%\SpaceAssistant\skills\` |
| | | | macOS: `~/Library/Application Support/SpaceAssistant/skills/` |
| | | | Linux: `~/.config/SpaceAssistant/skills/` |

**扫描规则：**

- 项目级目录：仅在 `workDir` 已配置时扫描，路径为 `<workDir>/.space-skills/`
- 用户级目录：始终扫描
- 扫描深度：仅扫描一层子目录，每个子目录包含 `SKILL.md` 即识别为有效 Skill
- 同名 Skill：项目级覆盖用户级（项目级优先）

---

## 6. Skill 加载与注入机制

### 6.1 整体流程

```
用户输入消息
   ↓
┌────────────────────────────────────────┐
│ 1. 解析用户输入，检测斜杠命令           │
│    - 若为 /skill 命令 → 走管理流程      │
│    - 若为普通消息 → 继续                │
└──────────────────┬─────────────────────┘
                   ↓
┌────────────────────────────────────────┐
│ 2. Skill 匹配引擎                      │
│    a. 检查 always_load 列表 → 加载      │
│    b. 检查 disabled 列表 → 排除         │
│    c. 对剩余 Skill 执行自动匹配         │
│       - 关键词匹配（triggers 字段）      │
│       - 描述语义匹配（description 字段）  │
│    d. 已手动 /skill use 的 Skill → 加载  │
└──────────────────┬─────────────────────┘
                   ↓
┌────────────────────────────────────────┐
│ 3. 组装 system prompt 片段              │
│    - 读取所有命中 Skill 的 SKILL.md     │
│    - 按优先级排序拼接为文本              │
│    - 注入到聊天请求的 system 字段        │
└──────────────────┬─────────────────────┘
                   ↓
┌────────────────────────────────────────┐
│ 4. 发送聊天请求                         │
│    - 在聊天界面提示用户已加载的 Skill    │
└────────────────────────────────────────┘
```

### 6.2 自动匹配策略

> **演进说明（2026-05-27）：** 本节描述的本地关键词 + 描述相似度匹配，将由 [skill-llm-routing-requirement.md](./skill-llm-routing-requirement.md) 定义的 **大模型基于 `description` 路由** 替代。下文保留作 Phase 3 已实现基线与 legacy 回滚参考。

采用**关键词匹配 + 描述匹配**的混合策略：

1. **关键词匹配**：用户输入包含 Skill 的 `triggers` 中的任一关键词（不区分大小写），则该 Skill 被候选。
2. **描述匹配**：将用户输入与 Skill 的 `description` 进行文本相似度计算（TF-IDF 或简单词频交集），相似度超过阈值（默认 0.4）则被候选。
3. **合并去重**：将两种方式命中的 Skill 合并去重，按优先级排序（项目级 > 用户级），取 Top-N（N = `max_concurrent` 配置值）。
4. **过滤排除**：移除 `disabled` 列表中的 Skill。

### 6.3 上下文注入方式

Skill 内容通过 `claudeChatSendStream` 调用时的 `messages` 参数外，增加 `system` 字段注入：

```typescript
// 现有调用方式
claudeChatSendStream({
  requestId,
  model,
  baseUrl,
  messages: [...]
})

// 注入 Skill 后的调用方式
claudeChatSendStream({
  requestId,
  model,
  baseUrl,
  messages: [...],
  system: buildSystemPromptFromSkills(activeSkills)  // 新增
})
```

**`buildSystemPromptFromSkills` 的拼接格式：**

```
以下是由用户激活的 Skill 规范，请在生成回复时严格遵循：

--- Skill: <skill-name-1> (v<version>) ---
<SKILL.md 正文内容>

--- Skill: <skill-name-2> (v<version>) ---
<SKILL.md 正文内容>

---
```

### 6.4 自动激活的用户提示

当 Skill 被自动激活时，在聊天界面中插入一条系统提示消息（不可编辑，不存储到消息历史）：

```
[Skill] 已自动加载: docx-generation（项目级）、pdf-handling（用户级）
```

---

## 7. Skill 管理界面

### 7.1 聊天内斜杠命令

在消息输入框中支持以 `/skill` 开头的斜杠命令：

| 命令 | 功能 | 示例 |
|------|------|------|
| `/skill list` | 列出所有可用 Skill | `/skill list` |
| `/skill use <name>` | 手动激活指定 Skill | `/skill use pdf-handling` |
| `/skill disable <name>` | 本次会话禁用指定 Skill | `/skill disable code-review` |
| `/skill status` | 查看当前会话已激活/已禁用的 Skill | `/skill status` |

**命令反馈格式：**

命令执行后在聊天界面中插入系统提示消息（类似自动激活提示），不作为用户/助手消息存储。

### 7.2 图形化管理界面

在设置弹窗中新增 **"Skill" Tab 页**，与现有的"通用"、"大模型" Tab 并列。

#### 7.2.1 Skill 列表

| 列 | 说明 |
|----|------|
| 启用开关 | Switch 控件，控制 Skill 是否参与自动匹配（不删除文件，仅标记 disabled） |
| 名称 | Skill 的 `name` 字段 |
| 作用域标签 | "项目级"（蓝色）/ "用户级"（绿色） |
| 描述 | Skill 的 `description` 字段，单行截断显示 |
| 版本 | Skill 的 `version` 字段 |
| 操作 | 删除按钮（仅用户级 Skill 可删除；项目级 Skill 显示为禁用态） |

#### 7.2.2 操作按钮

位于"Skill 管理"标题行右侧：

| 按钮 | 图标 | 行为 |
|------|------|------|
| 扫描 Skill | mingcute refresh_2_line | 重新扫描 Skill 目录并刷新列表 |
| 安装 Skill | mingcute download_2_line | 弹出系统目录选择器，用户选择 Skill 源目录后执行安装（详见 7.2.3） |
| 打开目录 | mingcute folder_open_line | 在系统文件管理器中打开用户级 Skill 目录 |

#### 7.2.3 安装 Skill 流程

用户点击"安装 Skill"按钮后，进入以下安装流程：

**第一步：选择源目录**

弹出系统原生目录选择器（与"通用"Tab 中选择工作目录的交互一致），用户选择包含 Skill 的源目录。

**第二步：合法性校验**

选择目录后，系统自动执行以下校验：

| 校验项 | 规则 | 失败提示 |
|--------|------|---------|
| SKILL.md 存在性 | 源目录根下必须存在 `SKILL.md` 文件 | "所选目录中未找到 SKILL.md 文件，请选择一个合法的 Skill 目录" |
| SKILL.md 可读性 | 文件可正常读取，非二进制文件 | "SKILL.md 文件无法读取，请检查文件是否损坏" |
| Front Matter 完整性 | 必须包含 `name`、`description`、`triggers` 三个必填字段 | "SKILL.md 缺少必填字段：<缺失字段列表>" |
| name 格式合法性 | `name` 仅允许小写字母、数字和连字符，且以字母开头 | "Skill 名称格式不合法：仅允许小写字母、数字和连字符，且以字母开头" |
| name 长度 | 1 ~ 64 个字符 | "Skill 名称长度不合法：需为 1~64 个字符" |
| description 非空 | `description` 不为空字符串 | "Skill 描述不能为空" |
| triggers 非空 | `triggers` 数组至少包含一个关键词 | "Skill 触发关键词不能为空" |
| SKILL.md 体积 | 不超过 100 KB | "SKILL.md 文件体积超过 100 KB 限制" |
| 目录总体积 | 不超过 10 MB | "Skill 目录总体积超过 10 MB 限制" |

校验失败时，在 Skill 列表上方显示红色错误提示条（Ant Design Alert 组件），包含具体失败原因，用户可重新选择目录。

**第三步：冲突检测**

校验通过后，检查目标作用域中是否已存在同名 Skill：

| 冲突情况 | 处理方式 |
|----------|---------|
| 用户级目录下已存在同名 Skill | 弹出确认对话框："用户级目录下已存在 Skill「{name}」（v{旧版本}），是否用新版本（v{新版本}覆盖？"，用户确认后继续，取消则中止 |
| 项目级目录下已存在同名 Skill | 安装到用户级目录，项目级 Skill 优先级更高，安装后用户级 Skill 会被项目级覆盖。在确认对话框中提示："项目级目录下已存在同名 Skill「{name}」，安装到用户级后将被项目级版本覆盖，是否继续？" |
| 无冲突 | 直接进入安装步骤 |

**第四步：安装（文件复制）**

确认安装后，系统将源目录中的全部文件和子目录递归复制到目标目录：

```
源目录（用户选择的目录）         目标目录（用户级）
┌──────────────────────┐      ┌──────────────────────────────────────┐
│ C:\my-skills\docx/   │  →   │ <userData>/skills/docx/              │
│ ├── SKILL.md         │      │ ├── SKILL.md                         │
│ ├── REFERENCE.md     │      │ ├── REFERENCE.md                     │
│ ├── scripts/         │      │ ├── scripts/                         │
│ │   └── gen.py       │      │ │   └── gen.py                       │
│ └── LICENSE.txt      │      │ └── LICENSE.txt                      │
└──────────────────────┘      └──────────────────────────────────────┘
```

**安装规则：**

| 规则 | 说明 |
|------|------|
| 目标目录名 | 使用 SKILL.md 中 `name` 字段的值作为目录名（而非源目录的文件夹名） |
| 递归复制 | 复制源目录下的所有文件和子目录，保持原有目录结构 |
| 符号链接处理 | 遇到符号链接时，复制链接指向的实际文件内容，不保留符号链接 |
| 文件权限 | 保持源文件的读权限，确保安装后的文件可被 SpaceAssistant 读取 |
| 原子性 | 先复制到临时目录，全部成功后再移动到目标位置。若中途失败，回滚临时目录，不影响已有 Skill |
| 覆盖行为 | 若目标目录已存在（冲突确认后），先删除旧目录，再执行完整复制 |

**第五步：安装结果反馈**

| 结果 | 反馈 |
|------|------|
| 安装成功 | Skill 列表自动刷新，新安装的 Skill 高亮显示 2 秒；列表上方显示绿色成功提示："Skill「{name}」安装成功" |
| 安装失败 | 列表上方显示红色错误提示："Skill 安装失败：{具体原因}"，已复制的临时文件自动清理 |

**安装流程图：**

```
点击"安装 Skill"按钮
       │
       ▼
弹出系统目录选择器
       │
       ├── 用户取消 → 流程结束
       │
       ▼
合法性校验（SKILL.md 存在性、格式、体积等）
       │
       ├── 校验失败 → 显示错误提示，用户可重新选择
       │
       ▼
冲突检测（目标作用域是否存在同名 Skill）
       │
       ├── 有冲突 → 弹出确认对话框
       │              ├── 用户取消 → 流程结束
       │              └── 用户确认 → 继续
       │
       ▼
递归复制源目录到临时目录
       │
       ├── 复制失败 → 清理临时目录，显示错误提示
       │
       ▼
将临时目录移动到目标位置
       │
       ├── 移动失败 → 清理临时目录，显示错误提示
       │
       ▼
刷新 Skill 列表，显示成功提示
```

### 7.3 设置 Tab 布局更新

设置弹窗现有结构为"通用"和"大模型"两个 Tab，新增"Skill" Tab 后：

| Tab | 名称 | 包含内容 |
|-----|------|---------|
| 通用 | 通用 | 工作目录 |
| 大模型 | 大模型 | API Key、Base URL、模型列表、Temperature、默认开启 Thinking |
| Skill | Skill | Skill 列表、操作按钮 |

---

## 8. 配置支持

在现有 `AppConfig` 中新增 `skills` 配置项：

```typescript
interface SkillsConfig {
  autoDetect: boolean       // 是否启用自动 Skill 匹配，默认 true
  maxConcurrent: number     // 单次会话最大并发 Skill 数，默认 5
  disabled: string[]        // 永久禁用的 Skill name 列表，默认 []
  alwaysLoad: string[]      // 每次会话始终加载的 Skill name 列表，默认 []
}
```

**`AppConfig` 更新：**

```typescript
interface AppConfig {
  // ... 现有字段保持不变 ...
  skills: SkillsConfig
}
```

**配置存储：**

- `skills` 配置存储在现有 `config` 表中，键名为 `skills`
- 首次加载时若 `skills` 为空，使用默认值

**配置界面：**

Skill Tab 页顶部放置"自动检测"Switch 控件，绑定 `skills.autoDetect` 字段。其余配置项（`maxConcurrent`、`disabled`、`alwaysLoad`）暂不在 UI 暴露，通过配置文件直接编辑。

---

## 9. 与现有功能的关系

| 现有功能 | Skills 的关系 |
|----------|---------------|
| `CLAUDE.md` / System Prompt | 互补：System Prompt 定义全局行为，Skills 定义可按需激活的领域规范。Skill 内容在运行时作为 system prompt 片段动态注入 |
| MCP Server / Tool Use | 互补：MCP/Tool Use 提供工具调用能力（做什么），Skills 提供操作知识和规范指导（怎么做） |
| 会话管理 | Skill 激活状态与会话绑定：每个会话记录其手动激活/禁用的 Skill 列表 |
| 配置管理 | Skills 的全局配置（`autoDetect`、`disabled` 等）存储在 `AppConfig` 中 |
| 流式聊天 | Skill 内容作为 `system` 字段注入到聊天请求，不影响现有流式响应机制 |
| 文件浏览 | 用户可通过文件浏览查看 `.space-skills/` 目录内容 |

### 9.1 会话级 Skill 状态

每个会话需要记录其 Skill 激活状态，以便会话恢复时还原：

```typescript
interface Session {
  // ... 现有字段保持不变 ...
  skillsState: SessionSkillsState
}

interface SessionSkillsState {
  manualActivated: string[]   // 手动激活的 Skill name 列表
  manualDisabled: string[]    // 手动禁用的 Skill name 列表
}
```

**数据库更新：**

`sessions` 表新增 `skillsState` 字段（TEXT 类型，存储 JSON）。

---

## 10. 非功能需求

### 10.1 性能

| 指标 | 要求 |
|------|------|
| Skill 目录扫描延迟 | < 100ms（本地文件系统） |
| 单个 SKILL.md 加载时间 | < 50ms |
| 对现有聊天响应时间的影响 | < 200ms 额外开销（含匹配 + 读取 + 注入） |
| 自动匹配算法执行时间 | < 50ms |

### 10.2 安全性

- Skill 文件为纯 Markdown，**不直接执行任何代码**。`scripts/` 目录中的脚本仅作为参考文本，不会被 SpaceAssistant 自动执行。
- 对 Skill 文件路径进行路径穿越（path traversal）防护，确保不会读取 Skill 目录之外的文件。
- Skill 内容作为 system prompt 注入时，须进行大小限制（单文件 100KB），防止恶意超大文件占用上下文窗口。
- 项目级 Skill 目录中的内容可被 git 管理，用户级 Skill 目录下的内容不包含敏感信息存储。

### 10.3 兼容性

- 与现有 `AppConfig` 兼容：新增 `skills` 字段有默认值，旧版配置自动补充默认值。
- 与现有 `Session` 模型兼容：新增 `skillsState` 字段有默认值，旧版会话自动补充空状态。
- 与现有聊天流式 API 兼容：`system` 字段为新增可选字段，不影响现有 `messages` 参数。
- 跨平台：项目级路径使用 `<workDir>/.space-skills/`，用户级路径使用 Electron 的 `app.getPath('userData')/skills/`，自动适配 Windows/macOS/Linux。

### 10.4 可维护性

- Skill 文件为纯文本 Markdown，无二进制依赖，便于 Git 版本管理。
- Skill 格式向后兼容：新增 Front Matter 字段不影响旧版 Skill 的加载。
- Skill 扫描结果有缓存机制，避免每次发送消息都重新扫描磁盘。

---

## 11. 数据模型设计

### 11.1 运行时数据模型

```typescript
/** Skill 元信息（从 SKILL.md Front Matter 解析） */
interface SkillMeta {
  name: string
  description: string
  triggers: string[]
  version: string
  author: string
}

/** Skill 完整定义（包含正文内容） */
interface SkillDefinition {
  meta: SkillMeta
  content: string          // SKILL.md 去除 Front Matter 后的正文内容
  scope: 'project' | 'user'
  directoryPath: string    // Skill 目录的绝对路径
  filePath: string         // SKILL.md 的绝对路径
  lastModified: number     // 文件最后修改时间戳
}

/** 会话内的 Skill 激活状态 */
interface SessionSkillsState {
  manualActivated: string[]
  manualDisabled: string[]
}

/** Skill 扫描结果缓存 */
interface SkillsCache {
  skills: SkillDefinition[]
  scannedAt: number        // 上次扫描时间戳
  workDir: string          // 扫描时的工作目录
}
```

### 11.2 数据库变更

#### sessions 表新增字段

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| skillsState | TEXT | | 会话 Skill 状态（JSON），默认 `{"manualActivated":[],"manualDisabled":[]}` |

#### configs 表新增键

| key | value 示例 | 说明 |
|-----|-----------|------|
| `skills` | `{"autoDetect":true,"maxConcurrent":5,"disabled":[],"alwaysLoad":[]}` | Skills 全局配置 |

---

## 12. IPC 接口设计

### 12.1 新增 IPC 通道

| 通道名 | 参数 | 返回值 | 功能 |
|--------|------|--------|------|
| `skill:list` | `{}` | `SkillDefinition[]` | 扫描并返回所有可用 Skill |
| `skill:get` | `{ name: string }` | `SkillDefinition \| null` | 获取指定 Skill 的完整定义 |
| `skill:install` | `{ sourcePath: string }` | `{ ok: true; skill: SkillDefinition } \| { ok: false; error: string }` | 从指定源目录安装 Skill 到用户级目录（含校验、冲突检测、文件复制） |
| `skill:delete` | `{ name: string }` | `void` | 删除用户级 Skill（不可删除项目级） |
| `skill:toggleDisable` | `{ name: string; disabled: boolean }` | `void` | 在全局配置中启用/禁用指定 Skill |
| `skill:openDirectory` | `{ scope: 'user' \| 'project' }` | `void` | 在系统文件管理器中打开 Skill 目录 |
| `skill:match` | `{ userInput: string; sessionSkillsState: SessionSkillsState }` | `SkillDefinition[]` | 根据用户输入和会话状态匹配 Skill |

### 12.2 现有 IPC 通道变更

| 通道名 | 变更说明 |
|--------|---------|
| `claudeChatSendStream` | payload 新增可选字段 `system?: string`，用于注入 Skill 组装的 system prompt |
| `configGet` | 返回值 `AppConfig` 新增 `skills` 字段 |
| `configSet` | payload 新增 `skills` 字段支持 |
| `sessionCreate` | 初始化时自动填充 `skillsState` 默认值 |
| `sessionGet` | 返回值包含 `skillsState` |

### 12.3 SpaceAssistantApi 类型变更

```typescript
export type SpaceAssistantApi = {
  // ... 现有方法保持不变 ...

  // 新增 Skill 相关方法
  skillList: () => Promise<SkillDefinition[]>
  skillGet: (payload: { name: string }) => Promise<SkillDefinition | null>
  skillInstall: (payload: { sourcePath: string }) => Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }>
  skillDelete: (payload: { name: string }) => Promise<void>
  skillToggleDisable: (payload: { name: string; disabled: boolean }) => Promise<void>
  skillOpenDirectory: (payload: { scope: 'user' | 'project' }) => Promise<void>
  skillMatch: (payload: { userInput: string; sessionSkillsState: SessionSkillsState }) => Promise<SkillDefinition[]>
}
```

---

## 13. 发布计划

### Phase 1 — 基础支持（里程碑 1）

- [ ] Skill 目录扫描（项目级 + 用户级）
- [ ] SKILL.md 文件解析（Front Matter + 正文）
- [ ] 聊天内 `/skill list` 和 `/skill use <name>` 斜杠命令
- [ ] Skill 内容注入到聊天请求的 `system` 字段
- [ ] `AppConfig` 新增 `skills` 配置项
- [ ] 自动关键词匹配（triggers 字段）

### Phase 2 — 图形化管理（里程碑 2）

- [ ] 设置弹窗新增 "Skill" Tab 页
- [ ] Skill 列表展示（启用开关、作用域标签、描述）
- [ ] 安装 Skill（目录选择、合法性校验、冲突检测、递归文件复制、结果反馈）
- [ ] 删除 Skill / 打开目录操作
- [ ] `/skill disable <name>` 和 `/skill status` 命令
- [ ] 会话级 Skill 状态持久化

### Phase 3 — 增强匹配（里程碑 3）

- [ ] 描述语义匹配（description 字段的文本相似度计算）
- [ ] `alwaysLoad` / `disabled` 配置项 UI 暴露
- [ ] Skill 扫描缓存机制
- [ ] Skill 激活时的加载日志与审计
- [ ] Skill 导入/导出功能

---

## 14. 待解决问题

| # | 问题 | 优先级 | 备注 |
|---|------|--------|------|
| OQ-1 | 自动匹配算法：纯关键词匹配已满足 MVP，是否需要引入语义向量检索？ | 低 | **已决议：** 见 [skill-llm-routing-requirement.md](./skill-llm-routing-requirement.md)（LLM 路由，非向量检索） |
| OQ-2 | 多 Skill 同时匹配时，按什么策略排序和筛选？ | 中 | 当前方案：项目级优先 + 匹配度排序 + Top-N 截断 |
| OQ-3 | Skill 注入的 system prompt 过长时如何处理？是否截断或摘要？ | 高 | 需根据模型上下文窗口动态计算 |
| OQ-4 | 项目级 `.space-skills/` 目录命名是否合适？是否使用 `.sa-skills/` 等更短名称？ | 低 | 待用户反馈 |
| OQ-5 | 是否需要支持 Skill 的版本升级提示（当项目级 Skill 与用户级同名但版本不同时）？ | 低 | Phase 3 评估 |

---

**文档版本**: v1.0
**创建日期**: 2026年5月15日
**适用范围**: SpaceAssistant 桌面应用 Skills 机制
