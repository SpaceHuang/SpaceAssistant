# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

**要求：与用户沟通必须使用中文。**

## 项目概述

SpaceAssistant 是一款基于 Electron + React + TypeScript 的跨平台桌面应用，集成 LLM API（以 Anthropic Claude 为主），提供 AI 聊天助手功能，支持流式响应、工具调用可视化和思考过程展示。界面语言为中文（zh-CN）。

## 开发命令

```bash
# 安装依赖
npm install

# 同时启动渲染进程和主进程开发模式
npm run dev

# 仅启动渲染进程（Vite 开发服务器，端口 9240）
npm run dev:renderer

# 仅启动主进程（需先构建）
npm run dev:electron

# 构建渲染进程（输出到 dist/renderer/）
npm run build:renderer

# 构建主进程（输出到 dist-electron/，使用 tsconfig.electron.json）
npm run build:electron

# 完整构建（渲染 + 主进程，打包前必须执行）
npm run build

# 运行测试
npm test                    # vitest run
npm run test:watch          # vitest --watch

# 打包分发
npm run pack:win            # Windows NSIS 安装包
npm run pack:mac            # macOS DMG
npm run pack:linux          # Linux AppImage
```

## 架构

### Electron 三进程模型

- **主进程**（`electron/`）：Node.js 运行时。负责 Claude API 调用、数据库、文件系统、API Key 加密和 IPC 处理器。通过 `tsconfig.electron.json` 独立编译为 CommonJS（输出到 `dist-electron/`）。
- **预加载脚本**（`electron/preload.ts`）：通过 `contextBridge` 暴露 `window.api`，作为渲染进程与主进程之间的唯一桥接层。所有 IPC 通道名称在此定义。
- **渲染进程**（`src/renderer/`）：React 18 + Ant Design 5 + Redux Toolkit。由 Vite 构建（输出到 `dist/renderer/`）。

### 核心数据流

1. 渲染进程调用 `window.api.*`（类型定义在 `src/shared/api.ts`）
2. 预加载脚本转发到 `ipcRenderer.invoke/on`
3. 主进程处理器在 `electron/appIpc.ts`（应用逻辑）和 `electron/claudeStreamHandlers.ts`（Claude 流式响应）
4. 流式响应：主进程通过 `webContents.send()` 发送 `claude-chat-delta` / `claude-chat-thinking-delta` / `claude-chat-done` / `claude-chat-error` 事件；渲染进程在 `src/renderer/services/chatStreamService.ts` 中订阅

### 数据库

当前使用 **JSON 文件**（Electron `userData` 目录下的 `spaceassistant-data.json`），而非 SQLite。`electron/database.ts` 模块保持了与未来 SQLite 迁移兼容的接口。所有写入均为原子操作（写临时文件 + rename）。数据在内存中维护，每次修改立即调用 `save()`。

### 共享类型

`src/shared/domainTypes.ts` 是所有领域类型的唯一真实来源（`Session`、`Message`、`ToolUseData`、`ThinkingData`、`AppConfig`、`ModelEntry` 等）。主进程和渲染进程均从此处导入。

### API Key 安全

API Key 通过 Electron 的 `safeStorage` API 加密（`electron/secureApiKey.ts`）。加密值以 base64 字符串存储在数据库 `secrets.apiKeyEnc` 键下。文件系统访问通过路径遍历防护进行沙箱限制（`electron/pathSecurity.ts`）。

### 会话备份

`electron/sessionBackupManager.ts` 将明文 JSON 备份写入工作目录的 `sessions/<id>-<date>/` 下，包含 `session.json` 和 `messages.json`。

## 目录结构

- `electron/` - 主进程代码（编译到 `dist-electron/`）
- `src/renderer/` - React 应用
  - `components/Chat/` - 聊天界面（ChatBubble、ChatView、MessageInput、ChatMarkdown）
  - `components/Config/` - 设置弹窗、关于弹窗
  - `store/` - Redux 切片（`chatSlice`、`sessionSlice`、`configSlice`）
  - `services/` - 业务逻辑（chatStreamService）
  - `hooks.ts` - 类型化的 Redux hooks（`useAppDispatch`、`useTypedSelector`）
- `src/shared/` - 主进程/渲染进程共享的类型和 API 定义
- `src/test/` - 测试配置（jsdom polyfill）
- `docs/` - 产品需求文档和技术设计文档

## 构建系统

- **渲染进程**：Vite + `@vitejs/plugin-react`，`@` 别名映射到 `src/`
- **主进程**：`tsc -p tsconfig.electron.json`（CommonJS 输出，无打包器）
- **测试**：Vitest，渲染进程测试使用 `jsdom` 环境，主进程测试使用 `node` 环境，配置在 `vitest.config.ts`

## 测试

使用 Vitest。渲染进程测试使用 `jsdom` 环境；主进程测试使用 `node` 环境（通过 `environmentMatchGlobs` 配置）。测试文件就近放置：`electron/*.test.ts` 和 `src/renderer/**/*.test.{ts,tsx}`。

## 排障：飞书 CLI 文件日志

飞书主进程全链路调试日志写入 **JSON Lines**，文件名 `FeishuCli-{YYYYmmdd}.log`，目录与 Agent 日志相同：

- 开发模式（`npm run dev`）：`{项目根}/logs/`
- 打包模式：`{workDir}/.agent/logs/`

初始化后会写入 `feishu.logger.startup`。写入前经 `sanitizeForLog` 与飞书字段规则脱敏（不落用户消息正文、token、secret 等）。设置页「飞书操作记录」仍使用 `{userData}/logs/feishu-audit.log`，二者分工不同。

## IPC 通道参考

所有通道定义在 `electron/preload.ts` 和 `electron/appIpc.ts`：
- `session:list|create|get|update|delete` - 会话 CRUD
- `chat:get-messages|append-message|patch-message` - 消息管理
- `claude-chat-send-stream` - 发起流式聊天（立即返回，数据通过事件推送）
- `claude-chat-create-with-tools` - 带工具调用的流式聊天（同步返回）
- `config:get|set|test-connection` - 配置管理
- `file:list-directory|read-file` - 文件浏览（路径相对于 workDir）
- `search:execute|get-history` - 跨会话和文件搜索

## UI 规范

- 左侧边栏使用 VS Code 风格的活动栏（图标条）切换会话、文件、搜索面板
- SVG 图标来自 `src/renderer/assets/`，使用 `?raw` 导入；运行时将 `fill` 替换为 `currentColor`
- 如需新图标，可从 `res/mingcute-icons-main/svg/` 目录按分类查找（如 `arrow/`、`file/`、`device/`、`editor/` 等），复制 SVG 文件到 `src/renderer/assets/` 后使用
- 全局使用 Ant Design 组件；自定义样式在 `src/renderer/styles.css`
- 三栏布局：左侧边栏（328px）| 中间聊天区 | 右侧边栏（240px，预留位）
