# Tools 机制需求方案

## 目录

1. [背景与动机](#1-背景与动机)
2. [目标与非目标](#2-目标与非目标)
3. [用户故事](#3-用户故事)
4. [内置工具定义](#4-内置工具定义)
5. [工具调用循环与 IPC 机制](#5-工具调用循环与-ipc-机制)
6. [安全机制](#6-安全机制)
7. [工具权限配置](#7-工具权限配置)
8. [渲染进程展示与组件设计](#8-渲染进程展示与组件设计)
9. [数据模型设计](#9-数据模型设计)
10. [IPC 接口设计](#10-ipc-接口设计)
11. [与现有功能的关系](#11-与现有功能的关系)
12. [非功能需求](#12-非功能需求)
13. [发布计划](#13-发布计划)
14. [待解决问题](#14-待解决问题)

---

## 1. 背景与动机

### 1.1 现状

SpaceAssistant 当前采用**委托式工具调用**模式：应用将用户消息发送给 Claude API，模型返回 `tool_use` 内容块后，仅通过 IPC 通知渲染进程展示工具调用信息，**应用本身并不执行工具操作**。工具定义和执行逻辑完全依赖模型侧的能力，应用侧缺少以下关键能力：

- 本地文件读写和搜索
- 脚本执行
- 工具执行前的用户确认
- 工具执行过程中的实时进度展示

### 1.2 问题

- **无法操作本地环境**：AI 只能"看"和"说"，无法读写文件、搜索代码、运行脚本，大幅限制了 Agent 的实用性
- **无安全确认机制**：缺少工具执行前的用户审批流程，存在安全隐患
- **无执行进度反馈**：工具调用仅展示开始和结束状态，缺少执行过程的实时反馈
- **工具能力不可配置**：无法控制哪些工具可用、哪些需要确认

### 1.3 机会

参考 Claude Code 的 Tools 机制（PRD 见 `docs/references/claude_code_tools_prd.md`），结合 SpaceAssistant 的 Electron 桌面应用架构，引入内置工具机制可以：

- 让 AI 在对话中直接操作本地文件系统、搜索代码、执行脚本
- 通过工作目录边界约束和用户确认保障安全
- 提供丰富的工具执行进度和结果展示

### 1.4 与 Claude Code Tools 的核心差异

| 维度 | Claude Code Tools（参考） | SpaceAssistant Tools（本方案） |
|------|--------------------------|-------------------------------|
| 宿主环境 | CLI 终端 | Electron 桌面应用（GUI） |
| 工具执行 | 主进程直接执行 | 主进程执行 + Renderer 确认/展示 |
| 安全确认 | 终端 Permission Prompt | 聊天窗口内嵌确认卡片 |
| 进度展示 | 终端文本输出 | 图形化卡片 + 实时进度 |
| 工具范围 | Read/Write/Edit/Bash/Web 等 | read_file/write_file/list_directory/grep/run_script |
| MCP 支持 | 完整 MCP 协议支持 | 本期不支持（后续迭代） |
| 配置方式 | CLI 参数 + 配置文件 | 设置界面图形化配置 |

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 |
|---|------|
| G1 | SpaceAssistant 能在发送聊天请求时将内置工具定义传给模型，模型可自主决定调用工具 |
| G2 | 主进程执行工具操作，渲染进程展示执行过程和结果 |
| G3 | 文件读写、搜索操作均不可超出工作目录，脚本执行需用户确认 |
| G4 | 工具执行进展在渲染进程实时展示 |
| G5 | 支持用户通过设置界面配置工具权限、确认模式和脚本执行参数 |
| G6 | 工具调用记录持久化到消息历史中 |

### 2.2 非目标

- 不实现 MCP 外部工具协议支持（属于后续迭代）
- 不实现工具的 SDK 自定义注册（属于后续迭代）
- 不实现 Hooks 机制（PreToolUse/PostToolUse 钩子，属于后续迭代）
- 不支持 Bash 工具（安全风险过高，本版本通过 run_script 工具仅支持 Python 脚本执行）
- 不支持 WebSearch/WebFetch 工具（属于后续迭代）
- 不实现企业级策略管控

---

## 3. 用户故事

### US-01：AI 读取项目文件

**作为一名开发者**，当我在聊天中让 AI 分析某个文件的代码时，我希望 AI 能直接读取该文件内容，而不是让我手动复制粘贴。

### US-02：AI 写入文件并确认

**作为一名开发者**，当 AI 建议修改某个配置文件时，我希望能在聊天窗口中看到变更差异（diff），确认后才写入磁盘。

### US-03：AI 搜索代码

**作为一名开发者**，当我在聊天中询问某个函数在项目中的使用情况时，我希望 AI 能自动搜索代码库并汇总结果。

### US-04：AI 执行脚本

**作为一名开发者**，当 AI 生成一段 Python 数据处理脚本时，我希望能在聊天窗口中看到完整脚本代码，确认后执行，并实时看到输出结果。

### US-05：配置工具权限

**作为一名开发者**，我希望能在设置中控制哪些工具可用、是否需要确认，以及 Python 解释器的路径。

### US-06：查看工具执行历史

**作为一名开发者**，在回顾历史会话时，我希望能看到每次工具调用的参数和结果，以便理解 AI 的操作过程。

---

## 4. 内置工具定义

### 4.1 工具清单

| 工具名 | 描述 | 需要确认 | 风险等级 |
|--------|------|---------|---------|
| `read_file` | 读取指定文件内容 | 否 | low |
| `write_file` | 写入/创建文件 | 是 | medium |
| `list_directory` | 列出目录内容 | 否 | low |
| `grep` | 在文件中搜索文本 | 否 | low |
| `run_script` | 执行脚本 | 是 | high |

### 4.2 工具定义（Anthropic Tool 格式）

#### read_file

```json
{
  "name": "read_file",
  "description": "读取指定文件的完整内容。路径相对于工作目录，不可超出工作目录范围。",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "相对于工作目录的文件路径"
      }
    },
    "required": ["path"]
  }
}
```

**执行逻辑**：
- 调用 `resolveSafePath(workDir, path)` 验证路径安全性
- 读取文件内容（限制 2MB，超出截断并标记）
- 二进制文件返回错误：`"文件为二进制格式，无法读取"`
- 返回文件内容和编码信息

#### write_file

```json
{
  "name": "write_file",
  "description": "将内容写入指定文件。如果文件不存在则创建（含中间目录），存在则覆盖。路径相对于工作目录，不可超出工作目录范围。",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "相对于工作目录的文件路径"
      },
      "content": {
        "type": "string",
        "description": "要写入的文件内容"
      }
    },
    "required": ["path", "content"]
  }
}
```

**执行逻辑**：
- 调用 `resolveSafePath(workDir, path)` 验证路径安全性
- 自动创建中间目录（`mkdir -p` 语义）
- 若文件已存在，先读取旧内容用于 diff 展示
- 写入新内容
- 返回写入结果和 diff 信息

#### list_directory

```json
{
  "name": "list_directory",
  "description": "列出指定目录下的文件和子目录。路径相对于工作目录，不可超出工作目录范围。",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "相对于工作目录的目录路径，默认为工作目录根"
      }
    }
  }
}
```

**执行逻辑**：
- 调用 `resolveSafePath(workDir, path)` 验证路径安全性
- 使用 `fs.readdir` + `fs.stat` 获取目录内容
- 返回文件/目录名、大小、修改时间等信息
- 不递归展开子目录

#### grep

```json
{
  "name": "grep",
  "description": "在工作目录下搜索匹配正则表达式的文件内容。返回匹配行及其上下文。",
  "input_schema": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "正则表达式模式"
      },
      "path": {
        "type": "string",
        "description": "搜索的目录路径（相对于工作目录），默认为工作目录根"
      },
      "include": {
        "type": "string",
        "description": "文件名 glob 模式，如 '*.ts'、'*.{js,jsx}'"
      }
    },
    "required": ["pattern"]
  }
}
```

**执行逻辑**：
- 调用 `resolveSafePath(workDir, path)` 验证路径安全性
- 递归搜索指定目录下的文本文件
- 跳过二进制文件和 `node_modules`、`.git` 等常见排除目录
- 返回匹配行、文件路径、行号和上下文
- 结果限制最多 100 条匹配，超出标记截断
- 单个文件读取限制 1MB

#### run_script

```json
{
  "name": "run_script",
  "description": "执行一段 Python 脚本代码。脚本在工作目录下执行，有超时限制。执行前需用户确认。",
  "input_schema": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "description": "要执行的脚本代码"
      },
      "timeout": {
        "type": "number",
        "description": "超时时间（秒），默认 300。对于长时间运行的任务（如下载、数据处理）可适当增大"
      }
    },
    "required": ["code"]
  }
}
```

**执行逻辑**：
- 当前版本固定使用 Python 解释器执行（通过 `interpreterPaths.python` 配置路径）
- 工作目录设为 workDir
- stdout/stderr 实时流式输出
- 超时或用户取消时 kill 子进程组
- 返回退出码、stdout、stderr

---

## 5. 工具调用循环与 IPC 机制

### 5.1 整体流程

采用**方案 B：主进程执行 + Renderer 确认**模式。工具调用循环在主进程中完成，渲染进程负责确认和展示。

```
Renderer                     Main Process                    Claude API
   │                              │                              │
   │ 1. 发送消息 + tools定义       │                              │
   │─────────────────────────────▶│                              │
   │                              │ 2. 创建流式请求(含tools)      │
   │                              │─────────────────────────────▶│
   │                              │                              │
   │                              │ 3. 流式返回(tool_use块)       │
   │                              │◀─────────────────────────────│
   │                              │                              │
   │ 4. tool:use事件(展示工具卡片) │                              │
   │◀─────────────────────────────│                              │
   │                              │                              │
   │     [需要确认的工具?]         │                              │
   │     ├─ 是:                   │                              │
   │ 5a. tool:confirm-request     │                              │
   │◀─────────────────────────────│                              │
   │ 6a. 用户确认/拒绝            │                              │
   │─────────────────────────────▶│                              │
   │     ├─ 拒绝: 返回拒绝结果    │                              │
   │     └─ 确认: 执行工具        │                              │
   │                              │                              │
   │     [不需要确认的工具?]       │                              │
   │     └─ 直接执行              │                              │
   │                              │                              │
   │ 7. tool:progress事件         │                              │
   │◀─────────────────────────────│                              │
   │                              │                              │
   │ 8. tool:result事件           │                              │
   │◀─────────────────────────────│                              │
   │                              │                              │
   │                              │ 9. 将tool_result加入消息     │
   │                              │ 10. 再次调用API(继续循环)     │
   │                              │─────────────────────────────▶│
   │                              │                              │
   │                              │ ... 直到模型返回text/stop    │
   │                              │                              │
   │ 11. claude-chat-delta        │                              │
   │◀─────────────────────────────│                              │
   │                              │                              │
   │ 12. claude-chat-done         │                              │
   │◀─────────────────────────────│                              │
```

### 5.2 工具调用循环详细步骤

1. **发送请求**：渲染进程通过 `claude-chat-create-with-tools` 发送消息和工具定义
2. **模型返回 tool_use**：主进程解析流式响应，收集 `tool_use` 内容块
3. **通知渲染进程**：发送 `tool:use` 事件，渲染进程展示工具调用卡片（状态：calling）
4. **判断是否需要确认**：
   - 不需要确认（low risk）：直接执行
   - 需要确认（medium/high risk）：发送 `tool:confirm-request`，等待渲染进程返回 `tool:confirm-response`
5. **执行工具**：调用对应 `ToolExecutor.execute()` 方法
6. **发送进度**：执行过程中通过 `tool:progress` 事件实时更新
7. **发送结果**：执行完成后通过 `tool:result` 事件通知
8. **构建 tool_result 消息**：将工具结果添加到消息列表中
9. **继续循环**：将包含 `tool_use` 和 `tool_result` 的消息再次发送给模型，直到模型返回纯文本或停止

### 5.3 新增 IPC 事件

| 事件名 | 方向 | 数据格式 | 说明 |
|--------|------|---------|------|
| `tool:use` | Main→Renderer | `{ requestId, toolUse: { id, name, input } }` | 通知渲染进程工具被模型调用 |
| `tool:confirm-request` | Main→Renderer | `{ requestId, toolUseId, toolName, input, riskLevel, diff? }` | 请求用户确认执行危险工具 |
| `tool:confirm-response` | Renderer→Main | `{ requestId, toolUseId, approved: boolean }` | 用户确认或拒绝执行 |
| `tool:progress` | Main→Renderer | `{ requestId, toolUseId, status: string, message?: string }` | 工具执行进度更新 |
| `tool:result` | Main→Renderer | `{ requestId, toolUseId, result: ToolResult }` | 工具执行完成，返回结果 |

### 5.4 确认机制详细设计

#### 确认请求超时

- 确认请求发出后，若 5 分钟内未收到 `tool:confirm-response`，主进程自动拒绝该工具调用
- 超时拒绝时，向模型返回 `tool_result` 内容为 `"用户确认超时，工具调用已取消"`

#### 多工具调用处理

模型可能在一次响应中返回多个 `tool_use` 块。处理策略：
- 按顺序逐个处理工具调用（前一个完成后再处理下一个）
- 每个需要确认的工具独立弹出确认卡片
- 不支持并行确认（避免用户混淆）

#### 确认请求中的 diff 信息

当 `write_file` 工具的目标文件已存在时，`tool:confirm-request` 事件中包含 `diff` 字段：

```typescript
interface ConfirmDiff {
  oldContent: string     // 旧文件内容（可能为空，表示新文件）
  newContent: string     // 新文件内容
  oldPath: string        // 文件路径
}
```

### 5.5 工具执行器注册表

主进程中维护工具执行器注册表，每个内置工具实现 `ToolExecutor` 接口：

```typescript
interface ToolExecutor {
  name: string
  needsConfirmation: boolean
  riskLevel: 'low' | 'medium' | 'high'
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>
}

interface ToolExecutionContext {
  workDir: string
  requestId: string
  toolUseId: string
  sendProgress: (status: string, message?: string) => void
}

interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  duration?: number  // 执行耗时（ms）
}
```

---

## 6. 安全机制

### 6.1 路径安全

所有文件操作工具（read_file, write_file, list_directory, grep）必须遵守工作目录边界约束：

| 安全措施 | 实现方式 |
|---------|---------|
| 路径穿越防护 | 调用 `resolveSafePath(workDir, path)` 验证解析后的绝对路径是否以 workDir 开头 |
| 绝对路径处理 | 若模型传入绝对路径，检查其是否落在工作目录下；若不在，返回错误 |
| 符号链接处理 | 解析符号链接后的实际路径也必须落在工作目录下 |
| 违规响应 | 返回 `"路径超出工作目录范围: <path>"` 错误，不泄露工作目录外的任何信息 |

### 6.2 脚本执行安全

`run_script` 工具的安全措施：

| 安全措施 | 实现方式 |
|---------|---------|
| 语言白名单 | 当前版本仅支持 Python，后续扩展时通过执行器注册表控制可用语言 |
| 超时控制 | `child_process.spawn` 设置 timeout，默认 300s，由模型通过 timeout 参数指定 |
| 工作目录 | 脚本仅在工作目录下执行（`cwd: workDir`） |
| 输出限制 | stdout/stderr 各限制 100KB，超出截断并标记 `[输出被截断]` |
| 环境隔离 | 不继承主进程的 API Key 等敏感环境变量，仅传递 `PATH` 和 `HOME`/`USERPROFILE` |
| 进程清理 | 超时或取消时强制 kill 子进程及其子进程组（`process.kill(-pid)`） |
| 用户确认 | 执行前必须在渲染进程中获得用户确认 |
| 代码审查 | 确认卡片中展示完整脚本代码，用户可审查后决定 |

### 6.3 与现有安全措施的衔接

| 现有安全措施 | 衔接方式 |
|-------------|---------|
| `pathSecurity.ts` | 工具执行器直接调用 `resolveSafePath`，复用现有路径安全逻辑 |
| `claudeRequestGuards.ts` | 继续用于请求验证，工具输入参数也需通过验证 |
| Electron context isolation | 不变，工具执行在主进程中，不暴露 Node.js API 给渲染进程 |
| `secureApiKey.ts` | 脚本执行环境不传递 API Key，防止密钥泄露 |
| 内容块验证 | `claudeStreamHandlers.ts` 中的验证逻辑继续生效，新增工具相关验证 |

---

## 7. 工具权限配置

### 7.1 配置结构

在 `AppConfig` 中新增 `tools` 配置项：

```typescript
interface ToolsConfig {
  enabled: boolean              // 是否启用工具功能，默认 true
  confirmMode: 'diff' | 'direct'  // 文件写入确认模式，默认 'diff'
  allowedTools: string[]        // 允许的工具列表，空数组=全部允许
  deniedTools: string[]         // 禁止的工具列表，优先级高于 allowedTools
  pythonPath: string            // Python 解释器路径，默认 'python'
  scriptTimeout: number         // 脚本执行默认超时（秒），默认 300
}
```

**`AppConfig` 更新**：

```typescript
interface AppConfig {
  // ... 现有字段保持不变 ...
  tools: ToolsConfig
}
```

**配置存储**：

- `tools` 配置存储在 `configs` 表中，键名为 `tools`
- 首次加载时若 `tools` 为空，使用默认值：
  ```json
  {
    "enabled": true,
    "confirmMode": "diff",
    "allowedTools": [],
    "deniedTools": [],
    "pythonPath": "python",
    "scriptTimeout": 300
  }
  ```

### 7.2 工具过滤逻辑

当 `tools.enabled` 为 `false` 时，不发送任何工具定义给模型（模型无法调用工具）。

工具可用性判断：

```
1. 如果 allowedTools 非空且工具不在列表中 → 禁用
2. 如果工具在 deniedTools 中 → 禁用
3. 否则 → 可用
```

### 7.3 配置界面

在设置弹窗中新增 **"工具" Tab 页**，与现有的"通用"、"大模型" Tab 并列。

#### 7.3.1 Tab 布局

| 区域 | 内容 |
|------|------|
| 顶部 | 启用工具 Switch 控件 |
| 确认模式 | Radio 组：diff 模式 / direct 模式 |
| Python 配置 | Python 路径输入框 + 测试按钮、超时时间 InputNumber |
| 工具列表 | 每个内置工具一行：名称 + 启用 Switch + 风险等级标签 |

#### 7.3.2 工具列表显示

| 列 | 说明 |
|----|------|
| 启用开关 | Switch 控件，控制工具是否加入 allowedTools/deniedTools |
| 工具名称 | 工具的 `name` 字段 |
| 风险等级 | 标签：low（绿色）/ medium（橙色）/ high（红色） |
| 确认要求 | 标签：需确认 / 免确认 |

#### 7.3.3 Python 路径测试

点击"测试"按钮后，使用配置的 Python 路径执行 `python --version`，验证解释器是否可用：
- 成功：显示版本号（绿色标签），如 `Python 3.12.4`
- 失败：显示错误信息（红色标签），如 "未找到 Python 解释器"

### 7.4 设置 Tab 布局更新

设置弹窗现有结构为"通用"和"大模型"两个 Tab，新增"工具" Tab 后：

| Tab | 名称 | 包含内容 |
|-----|------|---------|
| 通用 | 通用 | 工作目录 |
| 大模型 | 大模型 | API Key、Base URL、模型列表、Temperature、默认开启 Thinking |
| 工具 | 工具 | 启用开关、确认模式、Python 路径、超时配置、工具列表 |

---

## 8. 渲染进程展示与组件设计

### 8.1 工具调用卡片（ToolCallCard）

在聊天消息流中，当模型调用工具时，插入 `ToolCallCard` 组件。

**状态流转**：

```
calling → confirming → executing → completed
                   ↘ rejected
         ↘ failed
```

**各状态展示**：

| 状态 | 展示内容 | 用户可操作 |
|------|---------|-----------|
| `calling` | 工具图标 + 工具名称 + 参数摘要 + 加载动画 | 无 |
| `confirming` | 工具图标 + 工具名称 + 完整参数 + 确认/拒绝按钮 | 确认 / 拒绝 |
| `executing` | 工具图标 + 工具名称 + 执行中动画 + 进度消息 | 取消执行 |
| `completed` | 工具图标 + 工具名称 + 结果摘要（可展开查看详情） | 展开/折叠详情 |
| `failed` | 工具图标 + 工具名称 + 错误信息（红色） | 无 |
| `rejected` | 工具图标 + 工具名称 + "用户已拒绝"（灰色） | 无 |

### 8.2 确认模式展示

#### diff 模式（write_file 确认）

展示旧内容→新内容的 diff 视图：

```
┌─────────────────────────────────────────────┐
│ 📝 write_file              ⏳ confirming    │
│ ─────────────────────────────────────────── │
│ 📄 config.json                              │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ - "version": "1.0.0"                    │ │
│ │ + "version": "2.0.0"                    │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│    [✓ 确认写入]    [✗ 拒绝]                 │
└─────────────────────────────────────────────┘
```

#### direct 模式（write_file 确认）

展示目标路径和内容大小：

```
┌─────────────────────────────────────────────┐
│ 📝 write_file              ⏳ confirming    │
│ ─────────────────────────────────────────── │
│ 📄 config.json（1.2 KB）                    │
│                                             │
│    [✓ 确认写入]    [✗ 拒绝]                 │
└─────────────────────────────────────────────┘
```

#### 脚本执行确认

展示完整脚本代码块（带语法高亮），并标注语言类型：

```
┌─────────────────────────────────────────────┐
│ 🐍 run_script              ⏳ confirming    │
│ ─────────────────────────────────────────── │
│ ┌─────────────────────────────────────────┐ │
│ │ import json                             │ │
│ │ with open('data.json') as f:            │ │
│ │     data = json.load(f)                 │ │
│ │     print(data['count'])                │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│    [✓ 确认执行]    [✗ 拒绝]                 │
└─────────────────────────────────────────────┘
```

### 8.3 进度展示

工具执行期间，通过 `tool:progress` 事件实时更新卡片：

| 工具 | 进度消息示例 |
|------|-------------|
| `read_file` | `正在读取文件...` |
| `write_file` | `正在写入文件...` |
| `list_directory` | `正在读取目录...` |
| `grep` | `搜索中... 已扫描 42 个文件` |
| `run_script` | 实时流式输出 stdout/stderr（终端效果） |

### 8.4 结果展示

| 工具 | 结果展示方式 |
|------|-------------|
| `read_file` | 文件内容（代码块 + 语法高亮），可折叠 |
| `write_file` | 写入成功/失败状态 + 文件路径 |
| `list_directory` | 文件列表表格（名称、大小、类型、修改时间） |
| `grep` | 匹配结果列表（文件路径:行号 + 匹配行高亮） |
| `run_script` | stdout 输出（代码块）+ stderr 输出（红色）+ 退出码 |

### 8.5 与现有 ChatBubble 的关系

当前 `ChatBubble` 已有 `toolUse` 展示逻辑（简单的 Card + JSON 展示）。改造方式：

- 现有 `toolUse` 展示逻辑保持不变（兼容旧消息的历史回显）
- 新增 `ToolCallCard` 组件，作为独立消息块插入消息流
- `Message` 类型新增 `toolCalls: ToolCallRecord[]` 字段，支持一条助手消息内多次工具调用
- 渲染时，助手消息先展示文本内容，再依次展示 ToolCallCard 列表

---

## 9. 数据模型设计

### 9.1 运行时数据模型

```typescript
/** 工具调用记录（持久化到消息中） */
interface ToolCallRecord {
  id: string                    // 工具调用唯一标识（来自模型的 tool_use id）
  toolName: string              // 工具名称
  input: Record<string, unknown>  // 调用参数
  result?: ToolCallResult       // 调用结果
  status: ToolCallStatus        // 调用状态
  riskLevel: 'low' | 'medium' | 'high'
  confirmedAt?: number          // 用户确认时间戳
  startedAt?: number            // 执行开始时间戳
  completedAt?: number          // 执行完成时间戳
  duration?: number             // 执行耗时（ms）
}

type ToolCallStatus = 'calling' | 'confirming' | 'executing' | 'completed' | 'failed' | 'rejected'

interface ToolCallResult {
  success: boolean
  data?: unknown
  error?: string
}
```

### 9.2 Message 类型变更

```typescript
interface Message {
  // ... 现有字段保持不变 ...
  toolCalls?: ToolCallRecord[]   // 新增：工具调用记录列表
}
```

**兼容性**：
- `toolUse` 字段保留，用于兼容旧消息
- `toolCalls` 为新增可选字段，旧消息中不存在时默认为空数组
- 渲染逻辑：优先使用 `toolCalls`，若为空则回退到 `toolUse`

### 9.3 数据库变更

#### messages 表

`toolCalls` 字段以 JSON 字符串存储在 messages 表的现有结构中。具体方式：
- 在消息序列化时，将 `toolCalls` 数组序列化为 JSON 字符串
- 在消息反序列化时，解析 JSON 字符串还原为 `ToolCallRecord[]`
- 与现有 `toolUse` 字段的存储方式一致

#### configs 表新增键

| key | value 示例 | 说明 |
|-----|-----------|------|
| `tools` | `{"enabled":true,"confirmMode":"diff","allowedTools":[],"deniedTools":[],"pythonPath":"python","scriptTimeout":300}` | 工具全局配置 |

---

## 10. IPC 接口设计

### 10.1 新增 IPC 通道

| 通道名 | 方向 | 参数 | 返回值 | 功能 |
|--------|------|------|--------|------|
| `tool:confirm-response` | Renderer→Main | `{ requestId, toolUseId, approved: boolean }` | `void` | 用户确认/拒绝工具执行 |
| `tool:cancel` | Renderer→Main | `{ requestId, toolUseId }` | `void` | 取消正在执行的工具 |

### 10.2 新增 IPC 事件（Main→Renderer，通过 ipcRenderer.on 订阅）

| 事件名 | 数据格式 | 功能 |
|--------|---------|------|
| `tool:use` | `{ requestId, toolUse: { id, name, input } }` | 通知渲染进程工具被调用 |
| `tool:confirm-request` | `{ requestId, toolUseId, toolName, input, riskLevel, diff? }` | 请求用户确认 |
| `tool:progress` | `{ requestId, toolUseId, status, message? }` | 工具执行进度 |
| `tool:result` | `{ requestId, toolUseId, result: ToolCallResult }` | 工具执行结果 |

### 10.3 现有 IPC 通道变更

| 通道名 | 变更说明 |
|--------|---------|
| `claude-chat-create-with-tools` | 工具调用循环中增加确认/执行/结果处理逻辑 |
| `configGet` | 返回值 `AppConfig` 新增 `tools` 字段 |
| `configSet` | payload 新增 `tools` 字段支持 |

### 10.4 SpaceAssistantApi 类型变更

```typescript
export type SpaceAssistantApi = {
  // ... 现有方法保持不变 ...

  // 新增工具相关方法
  toolConfirmResponse: (payload: { requestId: string; toolUseId: string; approved: boolean }) => Promise<void>
  toolCancel: (payload: { requestId: string; toolUseId: string }) => Promise<void>
  toolOnUse: (cb: (data: { requestId: string; toolUse: { id: string; name: string; input: unknown } }) => void) => () => void
  toolOnConfirmRequest: (cb: (data: {
    requestId: string
    toolUseId: string
    toolName: string
    input: unknown
    riskLevel: 'low' | 'medium' | 'high'
    diff?: { oldContent: string; newContent: string; oldPath: string }
  }) => void) => () => void
  toolOnProgress: (cb: (data: { requestId: string; toolUseId: string; status: string; message?: string }) => void) => () => void
  toolOnResult: (cb: (data: { requestId: string; toolUseId: string; result: ToolCallResult }) => void) => () => void
  toolTestInterpreter: (payload: { path: string }) => Promise<{ ok: true; version: string } | { ok: false; error: string }>
}
```

---

## 11. 与现有功能的关系

| 现有功能 | Tools 的关系 |
|----------|---------------|
| 流式聊天 | 工具定义作为 `tools` 参数注入聊天请求，模型自主决定是否调用工具。工具调用循环与现有流式响应机制无缝衔接 |
| Tool Use 可视化 | 现有 `ChatBubble` 的 `toolUse` 展示保持不变，新增 `ToolCallCard` 组件提供更丰富的展示 |
| Thinking 过程展示 | 不受影响，工具调用和思考过程可并行存在 |
| 文件浏览 | 工具中的 `list_directory` 和 `read_file` 与左侧栏文件浏览器功能重叠，但用途不同：文件浏览器供用户手动浏览，工具供 AI 自动操作 |
| 搜索功能 | 工具中的 `grep` 与左侧栏搜索功能重叠，但用途不同：搜索功能供用户手动搜索，工具供 AI 自动搜索 |
| Skills 机制 | 互补：Skills 提供操作知识和规范指导（怎么做），Tools 提供工具调用能力（做什么） |
| 配置管理 | 工具配置存储在 `AppConfig` 中，通过设置界面管理 |
| 路径安全 | 工具执行器复用 `pathSecurity.ts` 的 `resolveSafePath` 函数 |

### 11.1 工具定义注入方式

工具定义在渲染进程发送 `claude-chat-create-with-tools` 请求时，根据 `ToolsConfig` 动态构建：

1. 读取 `ToolsConfig.enabled`，若为 `false` 则不注入任何工具定义
2. 获取所有内置工具定义
3. 根据 `allowedTools` / `deniedTools` 过滤
4. 将过滤后的工具定义作为 `tools` 参数传给模型

---

## 12. 非功能需求

### 12.1 性能

| 指标 | 要求 |
|------|------|
| 工具定义注入延迟 | < 10ms（本地计算，无 IO） |
| 文件读取延迟 | < 100ms（10MB 以内文件） |
| 文件写入延迟 | < 100ms（10MB 以内文件） |
| 目录列表延迟 | < 200ms（1000 个文件以内） |
| grep 搜索延迟 | < 2s（1000 个文件以内） |
| 脚本启动延迟 | < 500ms（解释器启动） |
| 确认交互 IPC 往返 | < 100ms（不含用户思考时间） |
| 对现有聊天响应时间的影响 | 工具未启用时无额外开销；工具启用时仅增加工具定义的 Token 开销 |

### 12.2 安全性

- 文件操作严格限定在工作目录内，路径穿越防护覆盖绝对路径、相对路径和符号链接
- 脚本执行环境不传递敏感环境变量（API Key 等）
- 脚本执行有超时限制，防止长时间挂起
- 用户确认机制确保危险操作不会被自动执行
- 工具执行结果不包含工作目录外的文件信息

### 12.3 可用性

- 工具调用卡片的设计与现有消息气泡视觉风格一致
- 确认操作不使用模态弹窗（避免打断用户流程），而是嵌入聊天流中
- 工具执行进度实时可见，用户随时可取消
- 工具调用记录持久化到消息历史，历史会话中可查看

### 12.4 兼容性

- 与现有 `AppConfig` 兼容：新增 `tools` 字段有默认值，旧版配置自动补充默认值
- 与现有 `Message` 模型兼容：`toolCalls` 为可选字段，旧消息中不存在时不影响展示
- 与现有流式聊天 API 兼容：工具定义和工具调用循环是增量添加，不修改现有消息格式
- 跨平台：脚本执行通过 `child_process.spawn` 调用系统解释器，路径处理使用 `path.resolve` 适配各平台

---

## 13. 发布计划

### Phase 1 — 基础工具支持（里程碑 1）

- [ ] 内置工具定义（5 个工具的 name/description/input_schema，Phase 1 仅注入 read_file 和 list_directory 的定义，其余工具在对应 Phase 实现执行器后再注入）
- [ ] 主进程工具执行器注册表和执行框架
- [ ] 工具调用循环（确认→执行→结果→继续）
- [ ] IPC 事件：tool:use, tool:confirm-request, tool:confirm-response, tool:progress, tool:result
- [ ] read_file 和 list_directory 执行器（复用 pathSecurity）
- [ ] 渲染进程 ToolCallCard 组件（calling → completed 状态）
- [ ] AppConfig 新增 tools 配置项

### Phase 2 — 写入与搜索工具（里程碑 2）

- [ ] write_file 执行器（含 diff 计算）
- [ ] grep 执行器
- [ ] 确认卡片 UI（confirming 状态 + 确认/拒绝按钮）
- [ ] diff 模式 / direct 模式切换
- [ ] 工具执行进度实时展示
- [ ] Message 新增 toolCalls 字段，消息持久化
- [ ] 历史会话中工具调用记录的回显

### Phase 3 — 脚本执行与配置界面（里程碑 3）

- [ ] run_script 执行器（child_process.spawn + 语言路由 + 超时 + 输出限制）
- [ ] 脚本执行确认卡片（代码展示 + 语法高亮）
- [ ] 脚本执行实时输出流式展示
- [ ] 设置弹窗新增"工具"Tab 页
- [ ] 工具启用/禁用、确认模式、Python 路径、超时配置
- [ ] Python 路径测试功能
- [ ] 工具取消执行功能

---

## 14. 待解决问题

| # | 问题 | 优先级 | 备注 |
|---|------|--------|------|
| OQ-1 | 工具定义占用 Token 较多（5 个工具约 500-800 Token），是否需要支持按需注入？ | 中 | 可考虑根据用户消息内容选择性注入相关工具 |
| OQ-2 | grep 工具的性能在大仓库中可能较慢，是否需要引入缓存或索引？ | 低 | MVP 阶段使用简单递归搜索，后续优化 |
| OQ-3 | run_script 支持新语言时的扩展方式？ | 低 | 首版仅支持 Python（无 language 参数，硬编码），后续扩展时引入 language 参数 + `interpreterPaths` 配置 + 执行器注册表 |
| OQ-4 | write_file 的 diff 展示在大文件时性能如何？ | 中 | 可考虑对超过 1000 行的文件仅展示变更区域摘要 |
| OQ-5 | 工具调用循环的最大迭代次数限制？ | 高 | 需设置上限（如 10 次），防止无限循环消耗 Token |

---

**文档版本**: v1.0
**创建日期**: 2026年5月15日
**适用范围**: SpaceAssistant 桌面应用 Tools 机制
