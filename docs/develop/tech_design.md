
# SpaceAssistant 开发技术方案

## 目录

1. [需求分析](#1-需求分析)
2. [技术选型](#2-技术选型)
3. [架构设计](#3-架构设计)
4. [目录结构](#4-目录结构)
5. [核心模块设计](#5-核心模块设计)
    - 5.1 聊天模块
    - 5.2 配置模块
    - 5.3 菜单模块
    - 5.4 文件浏览模块
    - 5.5 搜索模块
6. [会话及消息数据存储与管理](#6-会话及消息数据存储与管理)
    - 6.1 数据模型设计
    - 6.2 存储策略
    - 6.3 会话持久化与恢复
    - 6.4 消息序列化与反序列化
    - 6.5 明文备份与知识复用
    - 6.6 性能优化策略
    - 6.7 数据安全与兼容性
7. [数据库设计](#7-数据库设计)
8. [API 接口设计](#8-api-接口设计)
9. [安全设计](#9-安全设计)
10. [部署与集成](#10-部署与集成)
11. [代码规范](#11-代码规范)
12. [开发计划](#12-开发计划)

---

## 1. 需求分析

基于产品需求文档，核心需求包括：

| 需求类别 | 核心功能 | 技术要点 |
|---------|---------|---------|
| 流式聊天 | 实时消息接收、Tool Use 可视化、Thinking 过程展示 | WebSocket/流式响应、状态管理 |
| 大模型配置 | API Key 安全存储、模型参数配置、连接测试 | 密钥管理、表单验证 |
| 应用菜单 | 文件/查看/帮助菜单、快捷键支持 | Electron Menu API |
| 文件浏览 | 目录导航、文件预览 | Node.js 文件系统 API |
| 搜索功能 | 全局搜索、历史记录 | 全文索引、正则匹配 |
| 跨平台 | Windows/macOS/Linux 支持 | Electron 平台适配 |

---

## 2. 技术选型

| 层级 | 技术 | 版本 | 选型理由 |
|------|------|------|---------|
| 桌面框架 | Electron | 28.x | 跨平台能力成熟，支持原生功能调用 |
| 前端框架 | React | 18.x | 生态成熟，支持 Hooks 和并发特性 |
| 类型系统 | TypeScript | 5.x | 类型安全，减少运行时错误 |
| 状态管理 | Redux Toolkit | 2.x | 状态管理清晰，支持中间件扩展 |
| UI 组件库 | Ant Design | 5.x | 组件丰富，设计规范统一 |
| HTTP 客户端 | Axios | 1.x | 支持拦截器、请求取消 |
| 图标库 | Lucide React | 最新 | 图标精美，体积小 |
| 密钥存储 | keytar | 7.x | 系统钥匙串集成，安全存储 |
| 数据库 | SQLite | 3.x | 轻量级，无需额外服务 |
| 构建工具 | Vite | 6.x | 快速构建，热更新支持 |

---

## 3. 架构设计

### 3.1 整体架构

采用经典的 Electron 三进程架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                      Main Process (Node.js)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │ Claude SDK  │  │   keytar    │  │   File System      │    │
│  │ Integration │  │ (密钥存储)   │  │   Operations       │    │
│  └─────────────┘  └─────────────┘  └─────────────────────┘    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │   Menu      │  │  SQLite     │  │   IPC Handlers     │    │
│  │   Manager   │  │  Database   │  │   (API桥接)        │    │
│  └─────────────┘  └─────────────┘  └─────────────────────┘    │
└──────────────────┬──────────────────────────────────────────────┘
                   │ IPC (contextBridge)
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Preload Script                              │
│          安全的 API 桥接层，类型定义与验证                        │
└──────────────────┬──────────────────────────────────────────────┘
                   │ window.api.*
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Renderer Process (Browser)                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │   React     │  │   Redux     │  │   UI Components    │    │
│  │   Components│  │   Store     │  │   (Ant Design)     │    │
│  └─────────────┘  └─────────────┘  └─────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 核心模块关系

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Chat       │      │  Config      │      │   Menu       │
│  Module      │      │  Module      │      │  Module      │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                      │
       ▼                     ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│                     Preload API                              │
└────────────────────────────┬─────────────────────────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Claude      │      │  Keytar      │      │  FileSystem  │
│  Client      │      │  Service     │      │  Service     │
└──────────────┘      └──────────────┘      └──────────────┘
```

---

## 4. 目录结构

```
SpaceAssistant/
├── electron/                    # 主进程代码
│   ├── main.ts                 # 主进程入口
│   ├── preload.ts              # IPC 桥接层
│   ├── menu.ts                 # 菜单管理
│   ├── claudeClient.ts         # Claude API 封装
│   ├── keytarService.ts        # 密钥存储服务
│   ├── fileSystemService.ts    # 文件系统服务
│   ├── sessionService.ts       # 会话服务
│   ├── messageService.ts       # 消息服务
│   ├── database.ts             # SQLite 数据库
│   └── ipcHandlers.ts          # IPC 处理器
├── src/                        # 渲染进程代码
│   ├── renderer/               # React 应用
│   │   ├── main.tsx            # 入口文件
│   │   ├── App.tsx             # 根组件
│   │   ├── components/         # UI 组件
│   │   │   ├── Layout/         # 布局组件
│   │   │   │   ├── LeftPanel.tsx
│   │   │   │   ├── MiddlePanel.tsx
│   │   │   │   └── RightPanel.tsx
│   │   │   ├── Chat/           # 聊天组件
│   │   │   │   ├── ChatBubble.tsx
│   │   │   │   ├── MessageInput.tsx
│   │   │   │   ├── ToolUseCard.tsx
│   │   │   │   └── ThinkingIndicator.tsx
│   │   │   ├── Session/        # 会话组件
│   │   │   │   ├── SessionList.tsx
│   │   │   │   └── SessionItem.tsx
│   │   │   ├── Config/         # 配置组件
│   │   │   │   └── ConfigPanel.tsx
│   │   │   ├── FileBrowser/    # 文件浏览组件
│   │   │   │   └── FileTree.tsx
│   │   │   └── Search/         # 搜索组件
│   │   │       └── SearchPanel.tsx
│   │   ├── store/              # Redux 状态管理
│   │   │   ├── chatSlice.ts    # 聊天状态
│   │   │   ├── configSlice.ts  # 配置状态
│   │   │   ├── sessionSlice.ts # 会话状态
│   │   │   └── index.ts        # Store 配置
│   │   ├── services/           # 业务服务
│   │   │   ├── chatService.ts  # 聊天服务
│   │   │   ├── sessionService.ts # 会话服务
│   │   │   └── configService.ts # 配置服务
│   │   └── types/              # 类型定义
│   │       └── index.ts        # 共享类型
│   └── shared/                 # 共享代码
│       └── api.ts              # API 类型定义
├── resources/                  # 资源文件
├── dist/                       # 构建输出
├── package.json
├── tsconfig.json
├── vite.config.ts
└── electron-builder.yml        # 打包配置
```

### 工作目录结构（用户数据）

```
<工作目录>/
├── sessions/                   # 会话明文备份目录
│   ├── <session-id>-<date>/
│   │   ├── session.json        # 会话元数据
│   │   └── messages.json       # 完整消息记录（JSON格式）
│   └── ...
└── ...
```

---

## 5. 核心模块设计

### 5.1 聊天模块

#### 5.1.1 数据流设计

| 阶段 | 组件 | 操作 | 状态变化 |
|------|------|------|---------|
| 发送消息 | MessageInput | 用户输入并发送 | `chatStatus: 'sending'` |
| 接收响应 | ChatBubble | 流式接收消息 | `chatStatus: 'streaming'` |
| 完成响应 | ChatService | 消息接收完毕 | `chatStatus: 'completed'` |

#### 5.1.2 状态管理

```typescript
interface ChatState {
  messages: Message[];
  currentSessionId: string | null;
  chatStatus: 'idle' | 'sending' | 'streaming' | 'completed' | 'error';
  error: string | null;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolUse?: ToolUseData;
  thinking?: ThinkingData;
  status: 'sending' | 'sent' | 'streaming' | 'completed' | 'failed';
  version: number;  // 数据版本，用于兼容性
}

interface ToolUseData {
  toolName: string;
  toolType: string;
  parameters: Record<string, unknown>;
  result?: ToolResult;
  status: 'calling' | 'completed' | 'failed';
  timestamp: number;
  duration?: number;  // 调用耗时
}

interface ToolResult {
  data: unknown;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface ThinkingData {
  content: string;
  isVisible: boolean;
  startTime: number;
  endTime?: number;
}

interface Session {
  id: string;
  name: string;
  preview: string;
  model: string;
  temperature: number;
  maxTokens: number;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  metadata: Record<string, unknown>;
}
```

#### 5.1.3 核心组件

| 组件 | 职责 | 关键功能 |
|------|------|---------|
| ChatBubble | 消息气泡展示 | 渲染文本、代码块、Tool Use 卡片 |
| MessageInput | 消息输入框 | 多行输入、发送/取消、快捷键 |
| ToolUseCard | 工具调用展示 | 显示工具名称、参数、结果 |
| ThinkingIndicator | 思考过程展示 | 动态显示思考内容 |

### 5.2 配置模块

#### 5.2.1 配置结构

```typescript
interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  defaultModel: string;
}

interface ModelInfo {
  name: string;
  displayName: string;
  maxTokens: number;
}
```

#### 5.2.2 密钥存储流程

```
用户输入 API Key
       │
       ▼
┌──────────────────┐
│ 验证密钥格式     │
└────────┬─────────┘
         │ 有效
         ▼
┌──────────────────┐
│ keytar.setPassword│
│ (安全存储到系统钥匙串) │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 保存配置到数据库  │
└──────────────────┘
```

#### 5.2.3 连接测试流程

```
用户点击"测试连接"
       │
       ▼
┌──────────────────┐
│ 从 keytar 获取   │
│ API Key          │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 调用 Claude API  │
│ (简单的消息请求)  │
└────────┬─────────┘
         │
         ├─ 成功 ─→ 显示"连接成功"
         │
         └─ 失败 ─→ 显示错误信息
```

### 5.3 菜单模块

#### 5.3.1 菜单结构

```
文件
 └── 退出 (Ctrl+Q / Cmd+Q)
 
查看
 ├── 开发者工具 (Ctrl+Shift+I / Cmd+Option+I)
 ├── ──────────
 └── 设置 (Ctrl+, / Cmd+,)
 
帮助
 └── 关于
```

#### 5.3.2 菜单配置

```typescript
interface MenuConfig {
  label: string;
  accelerator?: string;
  click?: () => void;
  role?: string;
  submenu?: MenuConfig[];
  separator?: boolean;
}

const menuTemplate: MenuConfig[] = [
  {
    label: '文件',
    submenu: [
      {
        label: '退出',
        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
        click: () => app.quit()
      }
    ]
  },
  {
    label: '查看',
    submenu: [
      {
        label: '开发者工具',
        accelerator: process.platform === 'darwin' ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
        click: () => mainWindow?.webContents.openDevTools()
      },
      { separator: true },
      {
        label: '设置',
        accelerator: process.platform === 'darwin' ? 'Cmd+,' : 'Ctrl+,',
        click: () => ipcMain.emit('open-settings')
      }
    ]
  },
  {
    label: '帮助',
    submenu: [
      {
        label: '关于',
        click: () => ipcMain.emit('open-about')
      }
    ]
  }
];
```

#### 5.3.3 平台适配

| 平台 | 菜单位置 | 特殊处理 |
|------|---------|---------|
| macOS | 系统菜单栏 | 应用名称显示在菜单最左侧 |
| Windows | 窗口标题栏 | 默认显示 |
| Linux | 窗口标题栏 | 依赖窗口管理器 |

### 5.4 文件浏览模块

#### 5.4.1 文件系统 API

| API | 功能 | 实现方式 |
|-----|------|---------|
| `listDirectory` | 列出目录内容 | `fs.readdir` + `fs.stat` |
| `readFile` | 读取文件内容 | `fs.readFile` |
| `getFileIcon` | 获取文件图标 | 根据扩展名判断 |

#### 5.4.2 文件类型映射

| 文件类型 | 扩展名 | 图标 |
|---------|-------|------|
| 文本文件 | .txt, .md, .json | 文本图标 |
| 代码文件 | .ts, .js, .py | 代码图标 |
| 文档文件 | .doc, .pdf | 文档图标 |
| 图片文件 | .jpg, .png | 图片图标 |
| 目录 | - | 文件夹图标 |

### 5.5 搜索模块

#### 5.5.1 搜索流程

```
用户输入搜索关键词
       │
       ▼
┌──────────────────┐
│ 搜索会话记录     │
│ (SQLite 查询)    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 搜索文件内容     │
│ (正则匹配)       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 合并并排序结果   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 显示搜索结果     │
└──────────────────┘
```

#### 5.5.2 搜索状态

```typescript
interface SearchState {
  query: string;
  results: SearchResult[];
  isSearching: boolean;
  history: string[];
}

interface SearchResult {
  id: string;
  type: 'session' | 'file';
  title: string;
  preview: string;
  path?: string;
  sessionId?: string;
}
```

---

## 6. 会话及消息数据存储与管理

### 6.1 数据模型设计

#### 6.1.1 会话数据模型

```typescript
interface Session {
  id: string;                    // UUID
  name: string;                 // 会话名称
  preview: string;              // 预览内容（最后一条消息）
  model: string;                // 使用的模型
  temperature: number;          // 温度参数
  maxTokens: number;            // 最大token数
  createdAt: number;           // 创建时间戳
  updatedAt: number;           // 更新时间戳
  messageCount: number;        // 消息数量
  metadata: SessionMetadata;   // 元数据
  schemaVersion: number;       // 数据结构版本
}

interface SessionMetadata {
  tags?: string[];
  favorite?: boolean;
  customSettings?: Record<string, unknown>;
  originalWorkDir?: string;    // 原始工作目录（记录创建时的工作目录）
}
```

#### 6.1.2 消息数据模型

```typescript
interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolUse?: ToolUseData;
  thinking?: ThinkingData;
  status: 'sending' | 'sent' | 'streaming' | 'completed' | 'failed';
  schemaVersion: number;
}

interface ToolUseData {
  id: string;
  toolName: string;
  toolType: string;
  parameters: Record<string, unknown>;
  result?: ToolResult;
  status: 'calling' | 'completed' | 'failed';
  timestamp: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

interface ToolResult {
  data: unknown;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface ThinkingData {
  content: string;
  isVisible: boolean;
  startTime: number;
  endTime?: number;
  metadata?: Record<string, unknown>;
}
```

### 6.2 存储策略

#### 6.2.1 双层存储架构

采用**双层存储架构**：

1. **SQLite 数据库**（主存储）
   - 存储会话列表和消息索引
   - 快速查询和列表展示
   - 事务保障数据一致性

2. **文件系统**（明文备份）
   - `sessions/` 目录存储完整的 JSON 格式备份
   - 便于用户查看、编辑和知识复用
   - 提供数据恢复能力

#### 6.2.2 文件命名规则

```
sessions/<session-id>-<date>/
├── session.json        # 会话元数据
└── messages.json       # 完整消息记录
```

其中：
- `<session-id>`: 会话的 UUID
- `<date>`: 创建日期，格式为 YYYYMMDD（如 20260514）

示例：
```
sessions/550e8400-e29b-41d4-a716-446655440000-20260514/
├── session.json
└── messages.json
```

#### 6.2.3 明文备份文件格式

**session.json 格式：**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Python 学习对话",
  "preview": "如何使用 requests 库发送 HTTP 请求？",
  "model": "claude-3-sonnet-20240229",
  "temperature": 0.7,
  "maxTokens": 4096,
  "createdAt": 1715712000000,
  "updatedAt": 1715712600000,
  "messageCount": 15,
  "metadata": {
    "tags": ["学习", "Python"],
    "favorite": false
  },
  "schemaVersion": 1
}
```

**messages.json 格式：**
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "exportedAt": 1715712600000,
  "schemaVersion": 1,
  "messages": [
    {
      "id": "msg-001",
      "role": "user",
      "content": "如何使用 requests 库发送 HTTP 请求？",
      "timestamp": 1715712000000,
      "status": "completed",
      "schemaVersion": 1
    },
    {
      "id": "msg-002",
      "role": "assistant",
      "content": "以下是使用 requests 库发送 HTTP 请求的示例...",
      "timestamp": 1715712010000,
      "thinking": {
        "content": "用户询问 requests 库的使用，我需要提供清晰的示例代码...",
        "isVisible": true,
        "startTime": 1715712005000,
        "endTime": 1715712008000
      },
      "toolUse": {
        "id": "tool-001",
        "toolName": "code_executor",
        "toolType": "execution",
        "parameters": { "code": "import requests" },
        "status": "completed",
        "timestamp": 1715712006000,
        "result": {
          "success": true,
          "data": { "output": "" }
        }
      },
      "status": "completed",
      "schemaVersion": 1
    }
  ]
}
```

### 6.3 会话持久化与恢复

#### 6.3.1 会话创建流程

```
用户点击"新会话"
       │
       ▼
┌─────────────────────────────────┐
│ 生成 UUID 作为会话 ID           │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 初始化会话对象（设置默认参数）   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 写入 SQLite 数据库              │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 创建 sessions/<id>-<date>/ 目录 │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 写入 session.json 备份文件      │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 更新会话列表状态                │
└─────────────────────────────────┘
```

#### 6.3.2 会话加载流程

```
用户点击会话列表中的会话
       │
       ▼
┌─────────────────────────────────┐
│ 从 SQLite 查询会话基本信息      │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 从 SQLite 查询该会话的所有消息  │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 反序列化消息数据（处理版本迁移）│
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 更新 Redux 状态                 │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 渲染消息列表                    │
└─────────────────────────────────┘
```

#### 6.3.3 会话删除流程

```
用户选择删除会话（确认后）
       │
       ▼
┌─────────────────────────────────┐
│ 从 SQLite 删除会话记录          │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 从 SQLite 删除消息记录          │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 删除 sessions/<id>-<date>/ 目录 │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 更新会话列表状态                │
└─────────────────────────────────┘
```

### 6.4 消息序列化与反序列化

#### 6.4.1 消息序列化流程

```typescript
class MessageSerializer {
  static serialize(message: Message): SerializedMessage {
    return {
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      toolUse: message.toolUse ? this.serializeToolUse(message.toolUse) : undefined,
      thinking: message.thinking ? this.serializeThinking(message.thinking) : undefined,
      status: message.status,
      schemaVersion: message.schemaVersion
    };
  }

  static serializeToolUse(toolUse: ToolUseData): SerializedToolUseData {
    return {
      id: toolUse.id,
      toolName: toolUse.toolName,
      toolType: toolUse.toolType,
      parameters: JSON.stringify(toolUse.parameters),  // 确保可序列化
      result: toolUse.result ? {
        data: JSON.stringify(toolUse.result.data),
        success: toolUse.result.success,
        error: toolUse.result.error,
        metadata: toolUse.result.metadata ? JSON.stringify(toolUse.result.metadata) : undefined
      } : undefined,
      status: toolUse.status,
      timestamp: toolUse.timestamp,
      duration: toolUse.duration,
      metadata: toolUse.metadata ? JSON.stringify(toolUse.metadata) : undefined
    };
  }

  static serializeThinking(thinking: ThinkingData): SerializedThinkingData {
    return {
      content: thinking.content,
      isVisible: thinking.isVisible,
      startTime: thinking.startTime,
      endTime: thinking.endTime,
      metadata: thinking.metadata ? JSON.stringify(thinking.metadata) : undefined
    };
  }
}
```

#### 6.4.2 消息反序列化流程

```typescript
class MessageDeserializer {
  static deserialize(serialized: SerializedMessage): Message {
    const result: Message = {
      id: serialized.id,
      sessionId: serialized.sessionId,
      role: serialized.role,
      content: serialized.content,
      timestamp: serialized.timestamp,
      status: serialized.status,
      schemaVersion: serialized.schemaVersion
    };

    // 版本迁移
    if (serialized.schemaVersion < CURRENT_SCHEMA_VERSION) {
      this.migrate(result, serialized.schemaVersion);
    }

    if (serialized.toolUse) {
      result.toolUse = this.deserializeToolUse(serialized.toolUse);
    }

    if (serialized.thinking) {
      result.thinking = this.deserializeThinking(serialized.thinking);
    }

    return result;
  }

  static deserializeToolUse(serialized: SerializedToolUseData): ToolUseData {
    return {
      id: serialized.id,
      toolName: serialized.toolName,
      toolType: serialized.toolType,
      parameters: JSON.parse(serialized.parameters),
      result: serialized.result ? {
        data: JSON.parse(serialized.result.data),
        success: serialized.result.success,
        error: serialized.result.error,
        metadata: serialized.result.metadata ? JSON.parse(serialized.result.metadata) : undefined
      } : undefined,
      status: serialized.status,
      timestamp: serialized.timestamp,
      duration: serialized.duration,
      metadata: serialized.metadata ? JSON.parse(serialized.metadata) : undefined
    };
  }

  static deserializeThinking(serialized: SerializedThinkingData): ThinkingData {
    return {
      content: serialized.content,
      isVisible: serialized.isVisible,
      startTime: serialized.startTime,
      endTime: serialized.endTime,
      metadata: serialized.metadata ? JSON.parse(serialized.metadata) : undefined
    };
  }

  static migrate(message: Message, fromVersion: number): void {
    // 实现版本迁移逻辑
    if (fromVersion < 1) {
      // 从版本 0 迁移到 1
      message.schemaVersion = 1;
    }
  }
}
```

### 6.5 明文备份与知识复用

#### 6.5.1 自动备份策略

| 触发事件 | 备份内容 | 频率 |
|---------|---------|------|
| 新消息 | 更新 messages.json | 每次新消息后 |
| 会话重命名 | 更新 session.json | 立即 |
| 参数变更 | 更新 session.json | 立即 |
| 应用退出 | 全量同步检查 | 应用关闭前 |

#### 6.5.2 备份文件同步流程

```typescript
class SessionBackupManager {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  async backupSession(session: Session, messages: Message[]): Promise<void> {
    const sessionDir = this.getSessionDir(session.id, session.createdAt);
    await fs.mkdir(sessionDir, { recursive: true });

    // 备份会话元数据
    const sessionJsonPath = path.join(sessionDir, 'session.json');
    await fs.writeFile(sessionJsonPath, JSON.stringify(session, null, 2));

    // 备份消息
    const messagesJsonPath = path.join(sessionDir, 'messages.json');
    const messagesExport = {
      sessionId: session.id,
      exportedAt: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      messages: messages
    };
    await fs.writeFile(messagesJsonPath, JSON.stringify(messagesExport, null, 2));
  }

  async restoreSession(sessionId: string): Promise<{ session: Session; messages: Message[] } | null> {
    const sessionDirs = await this.findSessionDirs(sessionId);
    if (sessionDirs.length === 0) return null;

    const latestDir = sessionDirs[sessionDirs.length - 1];
    const sessionPath = path.join(latestDir, 'session.json');
    const messagesPath = path.join(latestDir, 'messages.json');

    const [sessionJson, messagesJson] = await Promise.all([
      fs.readFile(sessionPath, 'utf-8'),
      fs.readFile(messagesPath, 'utf-8')
    ]);

    const session = JSON.parse(sessionJson);
    const messagesExport = JSON.parse(messagesJson);

    return {
      session,
      messages: messagesExport.messages.map((m: any) => MessageDeserializer.deserialize(m))
    };
  }

  private getSessionDir(sessionId: string, createdAt: number): string {
    const dateStr = new Date(createdAt).toISOString().slice(0, 10).replace(/-/g, '');
    return path.join(this.workDir, 'sessions', `${sessionId}-${dateStr}`);
  }

  private async findSessionDirs(sessionId: string): Promise<string[]> {
    const sessionsDir = path.join(this.workDir, 'sessions');
    const dirs = await fs.readdir(sessionsDir);
    return dirs.filter(dir => dir.startsWith(sessionId))
               .map(dir => path.join(sessionsDir, dir))
               .sort();
  }
}
```

#### 6.5.3 知识复用功能

1. **会话导出功能**
   - 支持导出单个会话为 zip 压缩包
   - 包含完整的 messages.json 和 session.json
   - 可选导出为 Markdown 格式（便于阅读）

2. **会话导入功能**
   - 支持从备份文件导入会话
   - 自动处理版本兼容性
   - 导入后生成新的会话 ID 避免冲突

3. **Markdown 导出格式**
```markdown
# 会话: Python 学习对话
创建时间: 2026-05-14

---

## 用户 (2026-05-14 10:00)
如何使用 requests 库发送 HTTP 请求？

---

## 助手 (2026-05-14 10:00)
> **思考过程**
> 用户询问 requests 库的使用，我需要提供清晰的示例代码...

> **工具调用: code_executor**
> 参数: {"code": "import requests"}
> 结果: 执行成功

以下是使用 requests 库发送 HTTP 请求的示例...
```

### 6.6 性能优化策略

#### 6.6.1 数据库优化

| 优化项 | 策略 |
|-------|------|
| 索引 | 为 sessionId、createdAt、updatedAt 添加索引 |
| 分页查询 | 消息列表支持分页加载 |
| 事务 | 使用事务确保数据一致性 |
| 连接池 | 复用数据库连接 |

#### 6.6.2 缓存策略

```typescript
class SessionCache {
  private cache: Map<string, { session: Session; messages: Message[]; timestamp: number }>;
  private readonly TTL = 30 * 60 * 1000; // 30分钟

  get(sessionId: string): { session: Session; messages: Message[] } | null {
    const cached = this.cache.get(sessionId);
    if (cached && Date.now() - cached.timestamp < this.TTL) {
      return { session: cached.session, messages: cached.messages };
    }
    this.cache.delete(sessionId);
    return null;
  }

  set(session: Session, messages: Message[]): void {
    this.cache.set(session.id, {
      session,
      messages,
      timestamp: Date.now()
    });
  }
}
```

#### 6.6.3 写入优化

- 使用 debounce 合并频繁的写入操作
- 异步写入文件，不阻塞 UI
- 增量更新，避免全量重写

### 6.7 数据安全与兼容性

#### 6.7.1 数据安全措施

1. **备份完整性检查**
   - 写入前计算文件哈希值
   - 读取时验证哈希值
   - 检测文件损坏

2. **异常处理**
   - 写入失败时保留旧版本
   - 提供数据恢复向导
   - 记录详细错误日志

3. **并发控制**
   - 使用文件锁防止并发写入
   - 实现乐观锁机制

#### 6.7.2 兼容性保障

1. **版本化数据结构**
   - 每个数据对象都有 schemaVersion 字段
   - 提供向前兼容的迁移路径

2. **向后兼容读取**
   - 旧版本数据仍然可以读取
   - 缺失字段使用默认值

3. **迁移工具**
   - 提供数据迁移脚本
   - 支持批量迁移旧数据

#### 6.7.3 数据验证

```typescript
class DataValidator {
  static validateSession(session: Session): ValidationResult {
    const errors: string[] = [];
    if (!session.id) errors.push('Session ID is required');
    if (!session.name) errors.push('Session name is required');
    return {
      valid: errors.length === 0,
      errors
    };
  }

  static validateMessage(message: Message): ValidationResult {
    const errors: string[] = [];
    if (!message.id) errors.push('Message ID is required');
    if (!message.content) errors.push('Message content is required');
    return {
      valid: errors.length === 0,
      errors
    };
  }
}
```

---

## 7. 数据库设计

### 7.1 数据库表结构

#### 7.1.1 sessions 表（会话表）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 会话唯一标识 |
| name | TEXT | NOT NULL | 会话名称 |
| preview | TEXT | | 预览内容 |
| model | TEXT | NOT NULL | 使用的模型 |
| temperature | REAL | NOT NULL | 温度参数 |
| maxTokens | INTEGER | NOT NULL | 最大token数 |
| messageCount | INTEGER | NOT NULL | 消息数量 |
| metadata | TEXT | | 元数据（JSON） |
| schemaVersion | INTEGER | NOT NULL | 数据结构版本 |
| createdAt | INTEGER | NOT NULL | 创建时间（时间戳） |
| updatedAt | INTEGER | NOT NULL | 更新时间（时间戳） |

**索引：**
- `CREATE INDEX idx_sessions_createdAt ON sessions(createdAt);`
- `CREATE INDEX idx_sessions_updatedAt ON sessions(updatedAt);`

#### 7.1.2 messages 表（消息表）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 消息唯一标识 |
| sessionId | TEXT | FOREIGN KEY | 所属会话 |
| role | TEXT | NOT NULL | user/assistant/system |
| content | TEXT | NOT NULL | 消息内容 |
| toolUse | TEXT | | Tool Use 数据（JSON） |
| thinking | TEXT | | Thinking 内容（JSON） |
| status | TEXT | NOT NULL | 状态 |
| schemaVersion | INTEGER | NOT NULL | 数据结构版本 |
| timestamp | INTEGER | NOT NULL | 时间戳 |
| sequence | INTEGER | NOT NULL | 消息序号 |

**索引：**
- `CREATE INDEX idx_messages_sessionId ON messages(sessionId);`
- `CREATE INDEX idx_messages_timestamp ON messages(timestamp);`
- `CREATE INDEX idx_messages_sequence ON messages(sessionId, sequence);`

#### 7.1.3 configs 表（配置表）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 配置标识 |
| key | TEXT | NOT NULL | 配置键 |
| value | TEXT | NOT NULL | 配置值 |
| createdAt | INTEGER | NOT NULL | 创建时间 |
| updatedAt | INTEGER | NOT NULL | 更新时间 |

#### 7.1.4 searchHistory 表（搜索历史表）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 记录唯一标识 |
| query | TEXT | NOT NULL | 搜索关键词 |
| timestamp | INTEGER | NOT NULL | 搜索时间 |

### 7.2 数据库连接管理

```typescript
class Database {
  private db: sqlite3.Database | null = null;
  
  async open(): Promise<void> {
    const dbPath = path.join(app.getPath('userData'), 'spaceassistant.db');
    this.db = new sqlite3.Database(dbPath);
    await this.initTables();
  }
  
  private async initTables(): Promise<void> {
    // 创建 sessions 表
    // 创建 messages 表
    // 创建 configs 表
    // 创建 searchHistory 表
  }
  
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    // 执行查询并返回结果
  }
  
  async execute(sql: string, params?: unknown[]): Promise<void> {
    // 执行非查询语句
  }
}
```

---

## 8. API 接口设计

### 8.1 IPC 通道定义

#### 8.1.1 渲染进程 → 主进程

| 通道名 | 参数 | 返回值 | 功能 |
|--------|------|--------|------|
| `session:list` | `-` | `Session[]` | 获取会话列表 |
| `session:create` | `{ name, model?, temperature?, maxTokens? }` | `Session` | 创建会话 |
| `session:get` | `{ sessionId }` | `Session` | 获取会话信息 |
| `session:update` | `{ sessionId, name, temperature?, maxTokens? }` | `Session` | 更新会话 |
| `session:delete` | `{ sessionId }` | `void` | 删除会话 |
| `session:export` | `{ sessionId, format? }` | `{ path, data }` | 导出国话 |
| `session:import` | `{ filePath }` | `Session` | 导入会话 |
| `chat:send-message` | `{ sessionId, content }` | `void` | 发送消息 |
| `chat:stream-response` | `{ sessionId }` | `Stream` | 接收流式响应 |
| `chat:get-messages` | `{ sessionId, limit?, offset? }` | `Message[]` | 获取消息列表 |
| `config:get` | `-` | `AppConfig` | 获取配置 |
| `config:set` | `{ config }` | `void` | 设置配置 |
| `config:test-connection` | `-` | `{ success, error }` | 测试连接 |
| `file:list-directory` | `{ path }` | `FileInfo[]` | 列出目录 |
| `file:read-file` | `{ path }` | `{ content, encoding }` | 读取文件 |
| `search:execute` | `{ query }` | `SearchResult[]` | 执行搜索 |
| `search:get-history` | `-` | `string[]` | 获取搜索历史 |

#### 8.1.2 主进程 → 渲染进程

| 通道名 | 参数 | 功能 |
|--------|------|------|
| `chat:message-received` | `{ message }` | 消息接收通知 |
| `chat:stream-update` | `{ sessionId, content }` | 流式更新通知 |
| `chat:error` | `{ error }` | 错误通知 |
| `config:updated` | `{ config }` | 配置更新通知 |

### 8.2 Claude API 封装

```typescript
class ClaudeClient {
  private apiKey: string;
  private baseUrl: string;
  private client: Anthropic;
  
  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.anthropic.com';
    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl
    });
  }
  
  async sendMessage(
    messages: Message[],
    model: string = 'claude-3-sonnet-20240229',
    options?: MessageOptions
  ): Promise<Stream> {
    return this.client.messages.stream({
      model,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature || 0.7,
      tools: options?.tools
    });
  }
  
  async testConnection(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: 'claude-3-sonnet-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      });
      return true;
    } catch {
      return false;
    }
  }
}
```

---

## 9. 安全设计

### 8.1 密钥安全

| 措施 | 实现方式 |
|------|---------|
| API Key 存储 | 使用 keytar 存储到系统钥匙串 |
| 明文隐藏 | 配置界面中显示为掩码 |
| 传输安全 | 仅在内存中传递，不落地存储 |

### 8.2 路径安全

```typescript
function resolveSafePath(basePath: string, relativePath: string): string {
  const resolved = path.resolve(basePath, relativePath);
  if (!resolved.startsWith(basePath)) {
    throw new Error('路径遍历攻击检测');
  }
  return resolved;
}
```

### 8.3 输入验证

| 输入类型 | 验证规则 |
|----------|---------|
| API Key | 非空，格式匹配 |
| Base URL | 有效 URL 格式 |
| 消息内容 | 长度限制（如 40KB） |
| 文件路径 | 安全路径验证 |

### 8.4 错误处理

| 错误类型 | 处理方式 |
|----------|---------|
| API 调用失败 | 显示友好错误提示 |
| 网络错误 | 提示检查网络连接 |
| 权限错误 | 提示用户授权 |
| 未知错误 | 记录日志并显示通用提示 |

---

## 10. 部署与集成

### 10.1 构建流程

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建渲染进程
npm run build:renderer

# 构建主进程
npm run build:electron

# 打包 Windows
npm run pack:win

# 打包 macOS
npm run pack:mac

# 打包 Linux
npm run pack:linux
```

### 10.2 electron-builder 配置

```yaml
appId: com.example.spaceassistant
productName: SpaceAssistant
directories:
  output: release
files:
  - dist/
  - dist-electron/
  - node_modules/
  - package.json
win:
  target:
    - target: nsis
      arch:
        - x64
mac:
  target:
    - target: dmg
      arch:
        - x64
        - arm64
linux:
  target:
    - target: AppImage
      arch:
        - x64
```

---

## 11. 代码规范

### 11.1 TypeScript 规范

| 规则 | 说明 |
|------|------|
| 严格模式 | `"strict": true` |
| 空接口 | 使用 `Record<string, never>` |
| 类型断言 | 避免使用 `any`，优先使用类型守卫 |
| 函数参数 | 使用 `readonly` 数组 |

### 11.2 React 规范

| 规则 | 说明 |
|------|------|
| Hooks 顺序 | useState → useCallback → useEffect |
| 组件命名 | PascalCase |
| 文件命名 | kebab-case |
| 无状态组件 | 使用箭头函数 |

### 11.3 目录规范

| 目录 | 内容 |
|------|------|
| components | 纯展示组件 |
| containers | 业务容器组件 |
| services | 业务逻辑服务 |
| store | Redux 状态管理 |
| types | TypeScript 类型定义 |
| utils | 工具函数 |

---

## 12. 开发计划

### 12.1 里程碑计划

| 阶段 | 时间 | 目标 |
|------|------|------|
| 第一阶段 | 1-2 周 | 项目初始化、基础架构搭建、数据库设计 |
| 第二阶段 | 2-3 周 | 会话管理、数据存储、备份功能 |
| 第三阶段 | 2-3 周 | 聊天功能开发（流式响应） |
| 第四阶段 | 2-3 周 | 配置功能、菜单功能开发 |
| 第五阶段 | 1-2 周 | 文件浏览、搜索功能开发 |
| 第六阶段 | 1-2 周 | 测试、bug 修复、优化 |

### 12.2 关键任务

| 任务 | 负责人 | 预估时间 |
|------|--------|---------|
| 项目初始化 | 架构师 | 1 周 |
| 数据库设计与实现 | 后端开发 | 1 周 |
| 会话管理模块 | 全栈开发 | 2 周 |
| 主进程开发 | 后端开发 | 2 周 |
| 渲染进程开发 | 前端开发 | 3 周 |
| 菜单系统开发 | 全栈开发 | 1 周 |
| 测试与调试 | 测试工程师 | 2 周 |

---

**文档版本**: v1.0  
**创建日期**: 2026年5月14日  
**适用范围**: SpaceAssistant 桌面应用开发团队

