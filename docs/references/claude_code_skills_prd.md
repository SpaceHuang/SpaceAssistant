# 产品需求说明书：Claude Code Skills 功能支持

**文档版本：** v1.0  
**状态：** 草稿  
**作者：** 产品团队  
**最后更新：** 2026-03-20

---

## 1. 背景与动机

### 1.1 现状

Claude Code 是 Anthropic 提供的命令行智能编程助手，支持 agentic 工作流、文件操作、代码生成与调试等核心能力。目前，Claude Code 的能力边界固定在其训练知识与内置工具集之内，缺乏一种结构化的机制让团队或个人将**领域专属的最佳实践、脚本模板和操作规范**注入 Claude 的工作流中。

### 1.2 问题陈述

- 不同团队、不同项目对 Claude Code 有差异化的操作规范（例如：特定的文档生成格式、代码审查 checklist、特定库的使用约定）。
- 这些规范目前只能通过冗长的 prompt 重复告知 Claude，缺乏可复用性和版本管理。
- Claude.ai Web 环境中已有 Skills 功能（`/mnt/skills/` 目录下的 `SKILL.md` 文件），但 Claude Code CLI 环境尚未原生支持该机制。
- 开发者无法在 Claude Code 会话中按需激活特定领域 Skill，导致高频场景（如：生成 `.docx`、操作 `.pptx`、处理 PDF）需反复提供上下文。

### 1.3 机会

通过将 Skills 机制引入 Claude Code，可以：

- 让 Claude Code 在执行任务前自动发现并加载相关 Skill 文档；
- 支持团队共享和个人自定义 Skill 库；
- 显著提升复杂任务的一致性、准确率与执行效率。

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 |
|---|------|
| G1 | Claude Code 能够识别项目或用户级别的 Skill 定义文件 |
| G2 | Claude Code 在处理任务时，能根据任务类型自动匹配并加载相关 Skill |
| G3 | 支持 Skill 的手动显式调用（`/skill <name>` 命令） |
| G4 | 提供 Skill 的增删改查管理命令 |
| G5 | 支持团队级（共享）和用户级（个人）两层 Skill 作用域 |
| G6 | Skill 加载过程对用户透明，可审计 |

### 2.2 非目标

- 不构建 Skill 的图形化管理界面（UI 界面留给 Claude.ai Web 端）
- 不支持跨用户的 Skill 市场/发布平台（属于后续迭代范围）
- 不修改 Claude 模型本身的训练权重
- 不替代 MCP Server 机制（Skills 与 MCP 互补，不竞争）

---

## 3. 用户故事

### 3.1 主要用户群体

- **个人开发者**：希望在 Claude Code 中复用自己积累的最佳实践文档
- **技术团队负责人**：希望为团队统一注入编码规范、架构决策和领域知识
- **企业 IT/平台工程团队**：希望在企业内部标准化 Claude Code 的输出格式与操作流程

### 3.2 用户故事列表

**US-01（自动激活）**  
作为一名开发者，当我让 Claude Code 生成 Word 文档时，我希望它能自动加载 `docx` Skill，而无需我手动告知任何格式规范。

**US-02（手动调用）**  
作为一名开发者，我希望能通过 `/skill use pdf` 显式告知 Claude Code 当前任务需要使用 PDF Skill，以确保它遵循正确的操作规范。

**US-03（团队 Skill）**  
作为团队负责人，我希望将团队的代码审查规范写成一个 Skill，放在项目 `.claude/skills/` 目录下，让所有团队成员的 Claude Code 都能自动加载它。

**US-04（个人 Skill）**  
作为个人用户，我希望能在 `~/.claude/skills/` 目录下维护自己的私有 Skill，这些 Skill 不会被提交到代码仓库。

**US-05（查看已加载 Skill）**  
作为一名开发者，当 Claude Code 执行任务时，我希望能看到它当前加载了哪些 Skill，以便排查问题。

**US-06（禁用 Skill）**  
作为开发者，我希望能在某次会话中临时禁用特定 Skill（`/skill disable <name>`），以避免其干扰当前任务。

---

## 4. 功能需求

### 4.1 Skill 定义规范

#### 4.1.1 Skill 文件结构

每个 Skill 由一个目录表示，目录下必须包含 `SKILL.md` 文件：

```
<skill-name>/
├── SKILL.md          # 必须：Skill 的核心说明文档（Claude 读取的主文件）
├── scripts/          # 可选：辅助脚本
├── REFERENCE.md      # 可选：参考资料
└── LICENSE.txt       # 可选：许可证
```

#### 4.1.2 SKILL.md 文件格式

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

- `name`：Skill 唯一标识符，字母小写加连字符
- `description`：自然语言描述，Claude 据此判断是否激活该 Skill
- `triggers`：关键词列表，用于辅助匹配
- `version`：语义化版本号
- `author`：可选，便于团队追踪

#### 4.1.3 Skill 大小限制

| 指标 | 限制 |
|------|------|
| 单个 `SKILL.md` 最大体积 | 100 KB |
| 单次会话最大并发加载 Skill 数 | 10 个 |
| 单个 Skill 目录总体积 | 10 MB |

### 4.2 Skill 目录结构与作用域

Claude Code 按以下优先级顺序查找 Skill（高优先级覆盖低优先级同名 Skill）：

```
优先级（高 → 低）
┌─────────────────────────────────────┐
│ 1. 项目级：<project-root>/.claude/skills/   │  ← 团队共享，提交到 git
│ 2. 用户级：~/.claude/skills/               │  ← 个人私有，不提交
│ 3. 系统级：/usr/local/share/claude/skills/ │  ← 企业部署，管理员管理
└─────────────────────────────────────┘
```

### 4.3 自动激活机制

Claude Code 在接收到用户指令后、开始执行前，执行以下匹配流程：

```
用户输入
   ↓
扫描所有可用 Skill 的 description 和 triggers
   ↓
Claude 内部推理：该任务是否与某个 Skill 高度相关？
   ↓
   ├── 是 → 自动读取 SKILL.md → 将内容注入上下文 → 执行任务
   └── 否 → 直接执行任务
```

**自动激活的输出示例：**

```
> 请帮我把这份报告生成为 Word 文档

[Skill] 检测到任务匹配 Skill: docx（项目级）
[Skill] 正在加载 .claude/skills/docx/SKILL.md...
✓ Skill 已就绪，开始执行任务
```

自动激活行为可通过配置文件控制（详见第 4.5 节）。

### 4.4 CLI 命令接口

#### `/skill list` — 列出所有可用 Skill

```
> /skill list

可用 Skills（共 4 个）：
┌──────────────────┬────────┬──────────────────────┬────────────────┐
│ 名称             │ 作用域 │ 描述                 │ 状态           │
├──────────────────┼────────┼──────────────────────┼────────────────┤
│ docx             │ 系统级 │ Word 文档生成规范     │ ✓ 可用         │
│ pdf              │ 系统级 │ PDF 操作规范          │ ✓ 可用         │
│ code-review      │ 项目级 │ 团队代码审查规范      │ ✓ 可用         │
│ api-design       │ 用户级 │ RESTful API 设计规范  │ ✓ 可用         │
└──────────────────┴────────┴──────────────────────┴────────────────┘
```

#### `/skill use <name>` — 手动激活 Skill

```
> /skill use pdf

[Skill] 手动加载: pdf（系统级）
✓ PDF Skill 已就绪
```

#### `/skill show <name>` — 查看 Skill 详情

显示 `SKILL.md` 的 Front Matter 元信息，不输出全文。

#### `/skill disable <name>` — 本次会话禁用 Skill

```
> /skill disable code-review

[Skill] 已在本次会话中禁用: code-review
```

#### `/skill add <path>` — 添加本地 Skill 到用户级目录

```
> /skill add ~/my-skills/react-conventions

[Skill] 正在安装到 ~/.claude/skills/react-conventions...
✓ Skill 安装成功
```

#### `/skill remove <name>` — 删除用户级 Skill

仅可删除用户级 Skill，不可删除项目级和系统级 Skill。

### 4.5 配置文件支持

在 `.claude/config.json`（项目级）或 `~/.claude/config.json`（用户级）中支持以下配置项：

```json
{
  "skills": {
    "auto_detect": true,
    "max_concurrent": 5,
    "disabled": ["code-review"],
    "always_load": ["api-design"]
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `auto_detect` | boolean | `true` | 是否启用自动 Skill 匹配 |
| `max_concurrent` | integer | `10` | 单次会话最大并发 Skill 数 |
| `disabled` | string[] | `[]` | 永久禁用的 Skill 列表 |
| `always_load` | string[] | `[]` | 每次会话始终加载的 Skill |

### 4.6 审计与透明度

- 每次 Skill 加载事件记录到 `~/.claude/logs/skill_activity.log`
- 日志格式：`[timestamp] [action] [skill_name] [scope] [trigger: auto|manual]`
- 支持 `--verbose` 标志显示详细 Skill 加载过程

---

## 5. 非功能需求

### 5.1 性能

| 指标 | 要求 |
|------|------|
| Skill 扫描延迟 | < 50ms（本地文件系统） |
| 单个 SKILL.md 加载时间 | < 100ms |
| 对现有任务响应时间的影响 | < 200ms 额外开销 |

### 5.2 安全性

- Skill 文件内容**不得**包含可执行代码直接运行（脚本需用户确认后才能执行，与现有 Claude Code 的代码执行权限模型一致）
- 系统级 Skill 目录需要管理员权限才能写入
- Skill 加载不得突破现有的 Claude Code 沙箱限制
- 对 Skill 文件路径进行路径穿越攻击（path traversal）防护

### 5.3 兼容性

- 与现有 `CLAUDE.md`（项目自定义指令文件）共存，不冲突
- 与 MCP Server 配置（`.mcp.json`）共存，不冲突
- 跨平台支持：macOS、Linux、Windows（WSL）

### 5.4 可维护性

- Skill 文件为纯文本 Markdown，无二进制依赖，便于 Git 版本管理
- Skill 格式向后兼容：新增字段不影响旧版 Skill 的加载

---

## 6. 与现有功能的关系

| 现有功能 | Skills 的关系 |
|----------|---------------|
| `CLAUDE.md`（项目自定义指令） | 互补：`CLAUDE.md` 定义项目级全局行为，Skills 定义可按需激活的领域规范 |
| MCP Server | 互补：MCP 提供外部工具调用能力，Skills 提供操作知识和规范指导 |
| System Prompt | Skills 内容在运行时动态注入上下文，类似动态 system prompt 片段 |
| `--permission` 模式 | Skills 的脚本执行遵循现有权限控制机制 |

---

## 7. 用户体验设计原则

1. **零配置即可用**：将 `SKILL.md` 放入指定目录，立即生效，无需额外注册
2. **渐进式可见**：默认静默加载，`--verbose` 模式下显示详情，不干扰主工作流
3. **显式优于隐式**：自动激活可关闭，用户始终保有手动控制权
4. **失败静默降级**：Skill 文件解析失败时，Claude Code 继续执行任务并给出警告，不阻断流程
5. **与 git 友好**：项目级 Skills 自然纳入代码仓库管理，团队协作零成本

---

## 8. 成功指标（KPI）

| 指标 | 目标值（上线后 90 天） |
|------|----------------------|
| Skills 功能使用率（使用过 Skill 的用户占比） | ≥ 30% |
| 自动激活准确率（正确匹配任务类型） | ≥ 85% |
| 用户自建 Skill 数量（用户级 + 项目级） | ≥ 5,000 个 |
| 因 Skills 减少的重复上下文输入（用户调研） | 减少 ≥ 40% |
| Skill 加载相关报错率 | ≤ 0.5% |

---

## 9. 发布计划

### Phase 1 — MVP（里程碑 1）

- [ ] 支持用户级和项目级 Skill 目录扫描
- [ ] 手动 `/skill use <name>` 命令
- [ ] `/skill list` 命令
- [ ] 基础日志记录

### Phase 2 — 自动激活（里程碑 2）

- [ ] 基于 description/triggers 的自动匹配机制
- [ ] `auto_detect` 配置项
- [ ] `--verbose` Skill 加载输出

### Phase 3 — 完整管理（里程碑 3）

- [ ] `/skill add / remove / disable / show` 完整命令集
- [ ] 系统级 Skill 目录支持
- [ ] `always_load` / `disabled` 配置项
- [ ] 与 Claude.ai Web 端 Skills 的格式统一验证

---

## 10. 待解决问题（Open Questions）

| # | 问题 | 负责人 | 优先级 |
|---|------|--------|--------|
| OQ-1 | 自动激活的匹配算法：纯关键词匹配 vs. 语义向量检索？ | 工程团队 | 高 |
| OQ-2 | 当多个 Skill 同时匹配时，是否全部加载还是排序选 Top-N？ | 产品团队 | 高 |
| OQ-3 | 是否支持 Skill 之间的依赖声明（`depends_on`）？ | 产品团队 | 中 |
| OQ-4 | 企业版是否需要 Skill 的集中管理 API？ | 企业产品 | 中 |
| OQ-5 | Skills 与未来可能的 Claude Code 插件生态如何边界划分？ | 平台团队 | 低 |

---

## 附录 A：参考资料

- Claude.ai Web 端 Skills 现有实现（`/mnt/skills/public/`）
- [Claude Code 官方文档](https://docs.claude.com/en/docs/claude-code/overview)
- [MCP 协议规范](https://modelcontextprotocol.io)
- CLAUDE.md 项目自定义指令文档

---

*本文档为内部产品草稿，尚未最终确定，欢迎各团队评审反馈。*
