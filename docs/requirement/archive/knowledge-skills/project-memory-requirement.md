# 项目记忆文件机制需求方案

## 目录

1. [背景与动机](#1-背景与动机)
2. [目标与非目标](#2-目标与非目标)
3. [用户故事](#3-用户故事)
4. [记忆文件规范](#4-记忆文件规范)
5. [加载与注入机制](#5-加载与注入机制)
6. [热重载](#6-热重载)
7. [会话级开关](#7-会话级开关)
8. [自动生成](#8-自动生成)
9. [UI 管理界面](#9-ui-管理界面)
10. [错误处理](#10-错误处理)
11. [大小限制](#11-大小限制)
12. [数据模型设计](#12-数据模型设计)
13. [IPC 接口设计](#13-ipc-接口设计)
14. [发布计划](#14-发布计划)

---

## 1. 背景与动机

### 1.1 现状

SpaceAssistant 当前通过会话管理、Skills 机制、系统提示词等方式向 LLM 注入上下文。但这些机制集中在**应用级**和**会话级**——应用级（Skills、系统提示词）对所有项目通用，会话级（对话历史）随会话生命周期结束而丢失。缺少一种**项目级**的持久化上下文，让用户能为特定工作目录配置专属的元信息（项目目标、规范、交流偏好等）。

### 1.2 问题

- **重复输入项目背景**：切换项目后，用户需在对话中反复描述项目技术栈、规范、偏好
- **团队一致性缺失**：团队成员各自口头描述项目规范，LLM 收到不一致的指令
- **项目切换无感知**：应用不知道当前工作目录的项目特性，无法自动调整行为
- **无标准化入口**：没有机制将项目级 AI 协作偏好以文件形式记录下来

### 1.3 价值

- **一次配置，持续生效**：项目记忆文件写入工作目录后，每次 LLM 调用自动加载
- **项目即文档**：SPACEASSISTANT.md 可以提交到 Git，团队成员共享同一份 AI 协作规范
- **降低上下文成本**：用户无需在每条消息中重复描述项目背景，节省 token 和心智负担

---

## 2. 目标与非目标

### 2.1 目标

| 目标 | 描述 |
|------|------|
| 自动加载 | 检测 workDir 下的 `SPACEASSISTANT.md`，存在则自动加载到上下文 |
| System Prompt 注入 | 记忆内容以 `<project_memory>` 标签包裹，拼接到 system prompt 末尾 |
| 热重载 | 监听文件变更，自动重新加载，用户无需重启 |
| 会话级开关 | 支持在当前会话中临时关闭/开启项目记忆注入 |
| 自动生成 | 在用户指令下，调用 LLM 分析项目结构，自动生成 SPACEASSISTANT.md |
| 大小限制 | 文件硬限制 40KB，超出截断 |
| 查看与编辑 | UI 面板可查看记忆内容，支持编辑保存 |

### 2.2 非目标（第一期）

| 非目标 | 说明 |
|--------|------|
| 多文件/层级继承 | 不支持子目录各自配置记忆文件并合并，仅 workDir 根目录单文件 |
| 自动生成带预览的交互式编辑 | 自动生成直接输出草稿，不做多轮修订 |
| 多人协作感知 | 不做文件锁定、冲突检测等协作功能 |
| 远程同步 | 记忆文件仅存在于本地文件系统，不做云端同步 |

---

## 3. 用户故事

### US1：自动加载项目记忆

> **作为** 开发者，我打开 SpaceAssistant 并配置好 workDir 后，**我希望** 系统自动检测并加载项目记忆文件，**以便** 我在与该项目的对话中无需每次手动描述项目背景。

验收标准：
- 当 `{workDir}/SPACEASSISTANT.md` 存在时，应用启动后自动读取并缓存
- 每次 LLM 调用时，记忆内容被拼接在 system prompt 末尾
- 当文件不存在时，静默跳过，不影响正常聊天

### US2：自动生成记忆文件

> **作为** 开发者，我进入一个尚未配置记忆文件的项目时，**我希望** 能一键让 AI 分析项目结构并生成 SPACEASSISTANT.md 草稿，**以便** 快速建立项目记忆而不必从头手动编写。

验收标准：
- UI 面板提供"自动生成"按钮
- 点击后系统扫描项目目录结构和关键配置文件
- 调用 LLM 生成结构化的 SPACEASSISTANT.md 内容
- 生成的草稿写入文件，用户可后续编辑

### US3：会话级控制

> **作为** 开发者，在某个特定会话中我希望临时关闭项目记忆的注入，**以便** 进行与项目无关的通用问答，不受项目上下文影响。

验收标准：
- 聊天界面提供开关，默认开启
- 关闭后当前会话不再注入项目记忆，其他会话不受影响
- 重新开启后立即恢复注入

### US4：热重载

> **作为** 开发者，我在外部编辑器中修改了 SPACEASSISTANT.md 后，**我希望** 应用能自动检测变更并重新加载，**以便** 随时调整项目记忆而无需重启应用。

验收标准：
- 文件变更 500ms 内自动重载
- 重载后新的 LLM 调用使用最新内容
- 文件被删除后取消监听，UI 显示"无记忆文件"

### US5：查看与编辑

> **作为** 开发者，我想在应用内查看当前加载的项目记忆内容，**以便** 确认 AI 接收到了正确的项目上下文。

验收标准：
- UI 面板显示当前记忆内容（只读预览）
- 提供"编辑"入口，可修改并保存
- 显示文件大小（字符数），超过限制时红色警告

---

## 4. 记忆文件规范

### 4.1 命名与位置

- **文件名**：`SPACEASSISTANT.md`
- **位置**：workDir 根目录（即 `{workDir}/SPACEASSISTANT.md`）
- **格式**：Markdown

### 4.2 推荐内容结构

文件为自由格式 Markdown，以下为推荐章节：

```markdown
# 项目记忆 — {项目名称}

## 项目概述
{一句话描述项目用途与目标}

## 技术栈
{编程语言、框架、构建工具、数据库等}

## 代码规范
{命名约定、文件组织、注释风格、测试策略等}

## 交流偏好
{LLM 应使用的语言、回答风格（简洁/详细）、格式化偏好等}

## 特别说明
{注意事项、已知约束、敏感操作提醒等}
```

用户可自由增删章节，不受此模板约束。

---

## 5. 加载与注入机制

### 5.1 加载流程

```
应用启动 / 切换 workDir
  ├─ 检查 {workDir}/SPACEASSISTANT.md 是否存在
  │   ├─ 存在 → 通过 resolveSafePath 安全读取
  │   │         → 校验大小 ≤ 40KB
  │   │         → 缓存到内存（projectMemoryCache）
  │   │         → 通知渲染进程状态变更
  │   │         → 启动文件监听（热重载）
  │   └─ 不存在 → 缓存置空，通知渲染进程"无记忆文件"
```

### 5.2 注入位置

在 `claudeStreamHandlers.ts` 和 `toolChatLoop.ts` 的 API 调用前：

```typescript
// 原始 systemPrompt（用户配置 + Skills 注入）
const finalSystemPrompt = projectMemoryCache
  ? `${systemPrompt}\n\n<project_memory>\n${projectMemoryCache}\n</project_memory>`
  : systemPrompt;
```

注入在用户 system prompt 和 Skills 注入**之后**，确保项目记忆不会覆盖应用级配置。

### 5.3 生命周期

| 事件 | 行为 |
|------|------|
| 应用启动 | 读取配置中的 workDir，尝试加载记忆文件 |
| 切换 workDir | 清除旧缓存，尝试加载新 workDir 的记忆文件 |
| 文件变更（热重载） | 重新读取并更新缓存 |
| 文件删除（热重载） | 清空缓存 |
| 会话级开关关闭 | 缓存保留，注入逻辑跳过 |
| 应用退出 | 缓存自然释放 |

### 5.4 内存缓存

- `electron/projectMemory.ts` 维护模块级变量 `projectMemoryCache: string | null`
- 仅缓存原始文本内容，不做解析
- 注入时直接拼接，无额外计算开销

---

## 6. 热重载

### 6.1 机制

使用 `fs.watch` 监听 `{workDir}/SPACEASSISTANT.md`：

```
fs.watch 检测到变更
  → 防抖 500ms（防止编辑器保存触发多次）
  → 重新读取文件
  → 校验大小
  → 更新缓存
  → 通知渲染进程刷新 UI
```

### 6.2 边界情况

| 场景 | 行为 |
|------|------|
| 文件被删除 | 清空缓存，取消监听，UI 恢复"无记忆文件"状态 |
| 文件被创建（之前不存在时新建） | 需要手动触发"重新检测"（避免持续轮询） |
| 编辑器多次保存（连续写入） | 500ms 防抖确保只加载最终版本 |
| 监听出错 | 静默失败，日志记录，不影响已有缓存 |

---

## 7. 会话级开关

### 7.1 实现

- Redux `chatSlice` 中新增 `projectMemoryEnabled: boolean`，默认 `true`
- 注入逻辑检查 `projectMemoryEnabled`：
  ```typescript
  const finalSystemPrompt = (projectMemoryCache && projectMemoryEnabled)
    ? `${systemPrompt}\n\n<project_memory>\n${projectMemoryCache}\n</project_memory>`
    : systemPrompt;
  ```
- 开关状态仅在当前会话生命周期有效，不持久化

### 7.2 UI

- 位置：`MessageInput` 区域或会话顶部工具栏
- 样式：小型 toggle 开关，hover 显示"项目记忆"
- 状态反馈：
  - 开启 + 已加载：开关亮起，提示"项目记忆已加载"
  - 开启 + 未找到：开关灰色，提示"未找到 SPACEASSISTANT.md"
  - 关闭：开关暗灭，提示"项目记忆已关闭"

---

## 8. 自动生成

### 8.1 触发方式

- UI 面板"自动生成"按钮
- 仅在记忆文件**不存在**时可用

### 8.2 生成流程

```
用户点击"自动生成"
  → 主进程扫描 workDir：
      - 目录树（最多 3 层深度，最多 200 个条目）
      - package.json（名称、依赖、脚本）
      - tsconfig.json / vite.config.ts 等关键配置文件
      - .gitignore 存在性
  → 构造生成 prompt：
      "请为以下项目生成 SPACEASSISTANT.md 记忆文件..."
      + 项目扫描结果
  → 调用 LLM（使用当前配置的默认模型）
  → 流式返回生成内容（可选：UI 显示进度）
  → 写入 {workDir}/SPACEASSISTANT.md
  → 更新缓存，通知渲染进程刷新
```

### 8.3 扫描范围限制

| 项目 | 限制 |
|------|------|
| 目录树深度 | ≤ 3 层 |
| 目录树条目 | ≤ 200 个（超过则截断标注 "..."） |
| 文件读取 | 仅读取已知配置文件（package.json, tsconfig.json, .gitignore 等），不读取源码 |
| 扫描超时 | 5 秒 |

---

## 9. UI 管理界面

### 9.1 入口

左侧活动栏新增"项目记忆"图标（或整合到现有面板中）。

### 9.2 面板内容

**已加载状态**：
- 顶部：文件名 + 大小（如 "SPACEASSISTANT.md · 3.2 KB"）
- 中间：Markdown 预览（只读，支持代码高亮）
- 底部：编辑按钮、刷新按钮

**未找到状态**：
- 居中提示："当前项目尚未配置记忆文件"
- 说明文字："SPACEASSISTANT.md 放置在项目根目录，用于告诉 AI 项目目标、规范和偏好"
- 按钮："自动生成"

**超出大小限制**：
- 警告横幅："文件过大（> 40KB），已截断加载，请精简内容"
- 截断后的内容仍可预览
- 编辑按钮可用

---

## 10. 错误处理

| 场景 | 行为 |
|------|------|
| 文件不存在 | 静默跳过，缓存置空 |
| 文件超过 40KB | 截断前 40KB 内容，UI 显示截断警告 |
| 文件读取失败（权限、IO 错误） | 日志记录警告，静默跳过，不打断用户工作流 |
| 自动生成时 LLM 调用失败 | 返回错误提示给 UI，保留已有文件不变 |
| 自动生成时文件写入失败 | 返回错误提示，不覆盖已有文件 |
| 热重载监听失败 | 日志记录，保留当前缓存不变 |

---

## 11. 大小限制

| 参数 | 值 |
|------|------|
| 硬限制 | 40 KB（40960 字节） |
| 超出处理 | 截断前 40KB，丢弃超出部分 |
| UI 提醒阈值 | > 35KB 时在面板中黄色提示"文件较大" |
| 生成建议大小 | LLM 生成时要求输出不超过 30KB |

---

## 12. 数据模型设计

### 12.1 TypeScript 类型

```typescript
// src/shared/domainTypes.ts

/** 项目记忆加载状态 */
export interface ProjectMemoryState {
  /** 原始内容（已校验大小） */
  content: string | null;
  /** 文件路径（相对于 workDir） */
  filePath: string;
  /** 文件大小（字节），用于 UI 展示 */
  fileSize: number;
  /** 是否被截断 */
  truncated: boolean;
  /** 最后加载时间 */
  loadedAt: number | null;
}

/** AppConfig 新增字段 */
export interface AppConfig {
  // ... 现有字段 ...
  /** 项目记忆文件名（固定为 SPACEASSISTANT.md） */
  projectMemoryFile?: string; // 预留扩展，默认 'SPACEASSISTANT.md'
}
```

### 12.2 Redux State

```typescript
// chatSlice 中
projectMemoryEnabled: boolean; // 默认 true，会话级
```

---

## 13. IPC 接口设计

| 通道 | 方向 | 参数 | 返回值 | 描述 |
|------|------|------|--------|------|
| `project-memory:get-state` | 渲染→主 | 无 | `ProjectMemoryState` | 获取当前记忆文件状态 |
| `project-memory:generate` | 渲染→主 | 无 | `{ success, content?, error? }` | 触发 LLM 自动生成 |
| `project-memory:write` | 渲染→主 | `{ content: string }` | `{ success, error? }` | 保存记忆文件（用户编辑） |
| `project-memory:reload` | 渲染→主 | 无 | `ProjectMemoryState` | 手动重新检测和加载 |
| `project-memory:state-changed` | 主→渲染 | `ProjectMemoryState` | — | 推送通知（热重载、状态变更） |

### preload.ts 暴露

```typescript
// 新增 API
projectMemory: {
  getState: () => ipcRenderer.invoke('project-memory:get-state'),
  generate: () => ipcRenderer.invoke('project-memory:generate'),
  write: (content: string) => ipcRenderer.invoke('project-memory:write', { content }),
  reload: () => ipcRenderer.invoke('project-memory:reload'),
  onStateChanged: (cb: (state: ProjectMemoryState) => void) => {
    const listener = (_: any, state: ProjectMemoryState) => cb(state);
    ipcRenderer.on('project-memory:state-changed', listener);
    return () => ipcRenderer.removeListener('project-memory:state-changed', listener);
  },
}
```

---

## 14. 发布计划

| 阶段 | 内容 |
|------|------|
| **P0（本需求）** | 自动加载、system prompt 注入、热重载、会话级开关、自动生成、UI 查看编辑、40KB 限制 |
| 未来（待评估） | 多文件/层级继承、自动生成多轮修订、记忆文件模板市场 |