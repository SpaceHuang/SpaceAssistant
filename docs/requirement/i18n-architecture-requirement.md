# 多语言国际化架构 — 需求规格

## 1. 概述

本文档定义 SpaceAssistant 的多语言国际化（i18n）架构需求。第一期目标：支持**中文（zh-CN）**与**英文（en-US）**两种语言，建立可扩展的国际化基础设施，为后续语言扩展奠定基础。

### 1.1 动机

- 核心 UI 模块（活动栏、会话、聊天、设置、文件树、Wiki、飞书状态栏等）已接入 i18n；`npm run i18n:check` 硬编码 warn 约 **509** 处（含测试 fixture、未迁移边角模块），详见 warn 输出
- PRODUCT.md 定义目标用户为「半技术用户」，但界面语言单一限制了非中文用户的使用
- 英文支持是国际化第一步，也是后续多语言扩展的基础

### 1.2 范围

| 维度 | 范围 |
|------|------|
| 首期语言 | zh-CN（中文简体）、en-US（英文） |
| 覆盖区域 | 渲染进程 UI（React 组件）、主进程用户可见文案（IPC 错误消息、通知） |
| 不覆盖 | 第三方库内部文案（Ant Design 已有国际化） |
| 切换方式 | 设置面板手动切换 + 首次启动跟随系统语言自动检测 |

### 1.3 实施进度

> **最后更新：** 2026-06-04  
> **开发分支：** `feat/i18n`（worktree：`.worktrees/feat-i18n`）  
> **当前阶段：** 第四期「收尾与验证」已完成 ✅  
> **全量测试：** 919/919 通过（2026-06-04）

#### 完成项总览（截至 2026-06-03）

| 类别 | 已完成 | 未完成 / 后续 |
|------|--------|-------------------|
| **迭代** | 第一期、第二期、第三期、第四期 | 懒加载分包；E2E 首次安装语言测试 |
| **命名空间（8）** | common、chat、config、errors、fileTree、search、feishu、wiki | 懒加载分包 |
| **用户故事** | US-02、US-04 | US-01（缺 E2E）、US-03（`browserSetupGuideContent` 工厂化，原生菜单 i18n 已落地） |
| **功能需求** | FR-01～FR-04、FR-06～FR-09 | FR-05（剩余 258 处源代码硬编码，见 `i18n:check` 报告） |
| **工具链** | `i18n:generate-types`、`i18n:check`、`i18n:check:strict`、CI 工作流 | — |
| **测试** | 全量 **919/919**（2026-06-04） | E2E 首次安装语言 |

#### 迭代记录

| 迭代 | 分支 | 范围 | 状态 | 说明 |
|------|------|------|------|------|
| 第一期 | `feat/i18n` | 基础设施 + 设置面板首批文案 + 自动化测试基线 | ✅ 已完成 | 见 §8 第一期明细 |
| 第二期 | `feat/i18n`（续） | common / chat / config 全量 + errors 主进程适配 | ✅ 已完成 | 见 §8 第二期；902 测试全绿 |
| 第三期 | `feat/i18n`（续） | fileTree / search / feishu / wiki | ✅ 已完成 | 见 §8 第三期；硬编码 warn 约 509 |
| 第四期 | `feat/i18n`（续） | 菜单 i18n、英文校对、CI、全量回归 | ✅ 已完成 | 919 测试全绿；`i18n:check:strict` + CI 已就绪 |

#### 已落地代码（第一 + 二 + 三期）

| 类别 | 路径 / 说明 |
|------|-------------|
| i18n 核心 | `src/renderer/i18n/`（`index.ts`、`detectLocale.ts`、`localeSync.ts`、`useTypedTranslation.ts`、`types.ts`） |
| 共享类型 | `src/shared/locale.ts`（`AppLocale`、`LOCALE_STORAGE_KEY`、`detectLocaleFromSystem`） |
| 错误码 | `src/shared/errorCodes.ts`（16 码 + `isErrorCode`）、`errorTranslator.ts`、`formatUserFacingError.ts`、`showUserFacingError.ts` |
| 翻译资源 | `resources/zh-CN/`、`resources/en-US/` 下 **common**、**config**、**chat**、**errors**、**fileTree**、**search**、**feishu**、**wiki**（共 16 个 JSON） |
| 飞书详情 i18n | `feishuRemoteDisplayStatus.ts`（状态/key）、`feishuDisplayText.ts`（渲染层翻译） |
| 构建脚本 | `scripts/generate-i18n-types.ts`、`scripts/i18n-check.ts` |
| npm scripts | `i18n:generate-types`、`i18n:check`；`predev` / `prebuild:renderer` 自动生成类型 |
| 配置持久化 | `AppConfig.locale`；`electron/appIpc.ts` 读写 `config.locale`；首次启动 `app.getLocale()` 检测 |
| UI 集成 | `main.tsx` 初始化 i18n；`ThemeProvider.tsx` 动态 Ant Design locale；`ConfigModal.tsx` 语言 Select |
| 测试 | 见 §9.2 测试完成情况 |

#### 用户故事 / 功能需求完成度（第三期后）

| ID | 标题 | 状态 | 备注 |
|----|------|------|------|
| US-01 | 系统语言自动检测 | 🟡 部分完成 | 主进程 `config:get` + 渲染进程 `navigator.language` / `localStorage` 已打通；需 E2E 验证首次安装路径 |
| US-02 | 手动切换语言 | ✅ 已完成 | 设置 → 通用 → 界面语言；即时生效；写入 DB + `sa_locale` |
| US-03 | UI 文案全覆盖 | 🟡 部分完成 | 含文件树、Wiki 面板、详情区飞书状态栏、文件内查找、原生菜单、BrowserSetupGuide、formatChatTimestamp；源代码仍有 258 处硬编码中文 |
| US-04 | 主进程文案覆盖 | ✅ 已完成 | `appIpc` 等返回错误码；渲染层 `formatUserFacingError` 已接线；原生菜单随 `config.locale` 切换 |
| FR-01 | i18next 初始化 | ✅ 已完成 | 8 命名空间静态打包；Vitest 下禁用 detector localStorage cache |
| FR-02 | 类型安全 Hook | ✅ 已完成 | `useTypedTranslation` + 类型生成脚本 |
| FR-03 | 语言切换机制 | ✅ 已完成 | `changeAppLocale` / `syncLocaleFromConfig` |
| FR-04 | 设置面板语言选项 | ✅ 已完成 | 符合 §6.1 规格 |
| FR-05 | 文案迁移策略 | 🟡 进行中 | 第四期已完成 formatChatTimestamp、browserSetupGuideContent、原生菜单；剩余 258 处源代码硬编码中文 |
| FR-06 | 日期/时间格式化 | ✅ 已完成 | `formatChatTimestamp` 已改为 `i18next.language`；`groupSessions` / `formatRelativeTime` 已跟随 |
| FR-07 | 主进程错误码 | ✅ 已完成 | 16 错误码 + 双语 `errors.json`；`browserRemotePolicy` 已改错误码 |
| FR-08 | Ant Design 国际化 | ✅ 已完成 | `ConfigProvider` 随 `i18next.language` 切换 |
| FR-09 | shared 目录文案 | ✅ 已完成 | `browserSetupGuideContent.ts` 已改为工厂函数接收 `t`；`appMeta.ts` 改为 key 常量 |

#### 第二期已迁移 UI 范围

- **common**：活动栏、会话侧栏（列表/删除确认/待确认横幅）、搜索入口与结果标签、App 壳层会话创建/加载消息
- **chat**：聊天气泡、思考块、消息输入、工具卡片与确认卡片族、ChatView 用户可见文案
- **config**：设置面板全部 Tab（模型/技能/Shell/浏览器/飞书/工具/Wiki/关于）
- **errors**：`appIpc` 用户可见错误、`browserRemotePolicy` / `browserExecutor` 飞书远程浏览器拦截

#### 第三期已迁移 UI 范围

- **fileTree**：文件树面板、右键菜单、删除确认、工具栏、复制/移动消息
- **search**：详情面板文件内查找（`SearchPanel`、`searchUtils` 正则错误）；全局搜索标签仍用 `common.search`
- **feishu**：详情区远程状态栏（`feishuRemoteDisplayStatus` + `FeishuRemoteStatusBar`）
- **wiki**：Wiki 面板空态、初始化、工具栏

#### 已知限制与后续动作

1. **`i18n:check` 硬编码扫描**：当前约 **476** 处（258 源代码 + 218 测试 fixture）；`i18n:check:strict` 模式仅对源代码硬编码报错。
2. **命名空间懒加载**（FR-01）：尚未实现，八命名空间全量打包。
3. **全量测试**：`npm test` **919/919** 通过（2026-06-04）。
4. **后续**：E2E 首次安装语言测试；逐步消除源代码中 258 处硬编码中文。

---

## 2. 用户故事

### US-01：系统语言自动检测

> **作为** 首次使用 SpaceAssistant 的用户
> **我希望** 应用自动检测我的系统语言并显示对应界面
> **以便** 我不需要手动配置就能看到熟悉的语言

**验收标准：**
- 首次启动时读取 `app.getLocale()` 或 `navigator.language`
- 若系统语言为中文（zh / zh-CN / zh-TW 等），默认使用 zh-CN
- 其他语言默认使用 en-US
- 用户手动切换后，以用户选择为准，不再跟随系统

### US-02：手动切换语言

> **作为** SpaceAssistant 用户
> **我希望** 在设置面板中切换界面语言
> **以便** 我能根据偏好使用中文或英文界面

**验收标准：**
- 设置面板提供语言选择下拉框（中文 / English）
- 切换后即时生效，无需重启
- 选择持久化到配置中（`AppConfig.locale`）
- 切换语言不影响已有会话数据

### US-03：UI 文案全覆盖

> **作为** SpaceAssistant 用户
> **我希望** 界面中所有可见文本都随语言切换而改变
> **以便** 我能完全以所选语言使用应用

**验收标准：**

| 区域 | 状态 | 说明 |
|------|------|------|
| 活动栏（Activity Bar）工具提示 | ✅ | `common.activity` |
| 会话列表（空态、操作菜单） | ✅ | `common.session` |
| 聊天区（流式状态、思考/工具标签） | ✅ | `chat`；消息时间戳格式见 FR-06 |
| 文件树（右键菜单、删除确认） | ✅ | `fileTree` |
| 全局搜索（入口、结果标签） | ✅ | `common.search` |
| 详情面板文件内查找 | ✅ | `search`（`SearchPanel`） |
| 配置面板（标签、描述、按钮） | ✅ | `config` |
| 确认卡片（写入/Shell/浏览器等） | ✅ | `chat` |
| 错误消息与通知 | ✅ | `errors` + `formatUserFacingError` |
| 飞书详情区远程状态栏 | ✅ | `feishu` |
| 飞书设置 Tab / 审计抽屉 | ✅ | 第二期 `config` |
| Wiki 面板（空态、初始化、工具栏） | ✅ | `wiki` |
| Electron 原生菜单 | — | 第四期 |
| 浏览器安装引导（shared） | — | `browserSetupGuideContent.ts` |

### US-04：主进程文案覆盖

> **作为** 开发者
> **我希望** 主进程返回给用户的错误消息和通知也支持多语言
> **以便** 用户在不同语言下都能理解系统状态

**验收标准：**
- IPC 错误返回中包含可本地化的错误码/key
- 渲染进程根据当前语言显示对应文案
- 通知（系统托盘、弹窗）文案跟随语言

---

## 3. 技术架构

### 3.1 方案选型

选用 **react-i18next**（基于 i18next 生态），理由：

| 维度 | react-i18next | react-intl | 自研 |
|------|--------------|------------|------|
| React 集成 | 原生 Hook + HOC | 原生 Hook | 需自建 |
| 生态成熟度 | 最广泛（i18next） | 成熟 | 无 |
| 命名空间/分包 | 原生支持 | 需手动拆分 | 需自建 |
| ICU/复数/插值 | 完整支持 | 完整支持 | 需实现 |
| TypeScript 类型安全 | 社区方案 | 较好 | 可控 |
| 包大小 | ~30KB gzip | ~25KB gzip | 0（但维护成本高） |
| 社区/文档 | 优秀 | 优秀 | 无 |

### 3.2 架构层次

```
┌─────────────────────────────────────────┐
│              React 组件层                │
│  useTranslation() Hook / <Trans> 组件    │
├─────────────────────────────────────────┤
│           i18next 核心引擎               │
│  语言检测 → 资源加载 → 插值 → 格式化     │
├──────────────┬──────────────────────────┤
│  翻译资源文件  │   主进程 IPC 适配层       │
│  zh-CN.json  │   错误码 → 文案映射       │
│  en-US.json  │                          │
└──────────────┴──────────────────────────┘
```

### 3.3 资源文件结构

```
src/renderer/i18n/
├── index.ts                  # i18next 初始化 + 配置
├── resources/
│   ├── zh-CN/
│   │   ├── common.json       # 通用 UI：按钮、标签、状态
│   │   ├── chat.json         # 聊天：消息、思考、工具调用
│   │   ├── fileTree.json     # 文件树：右键菜单、确认弹窗
│   │   ├── config.json       # 设置面板
│   │   ├── search.json       # 详情面板文件内查找（全局搜索在 common.search）
│   │   ├── feishu.json       # 飞书集成
│   │   ├── wiki.json         # Wiki 面板
│   │   └── errors.json       # 错误消息（主进程 + 渲染进程）
│   └── en-US/
│       ├── common.json
│       ├── chat.json
│       ├── ... (镜像结构)
├── types.ts                  # 翻译 key 的 TypeScript 类型定义
└── useTypedTranslation.ts    # 类型安全的 useTranslation 封装
```

### 3.4 命名空间设计

| 命名空间 | 职责 | 示例 Key | 落地状态 |
|---------|------|---------|----------|
| `common` | 通用按钮、标签、状态；全局搜索入口/标签 | `cancel`, `search.placeholder`, `session.new` | ✅ 已注册并迁移 |
| `chat` | 聊天界面全部文案 | `thinking.label`, `tool.allow`, `streaming.inProgress` | ✅ |
| `fileTree` | 文件树与文件操作 | `contextMenu.copyPath`, `deleteConfirm.title` | ✅ |
| `config` | 设置面板（含飞书设置 Tab） | `tabs.general`, `language.label` | ✅ |
| `search` | 详情面板文件内查找（非全局搜索） | `detail.placeholder`, `detail.regexInvalid` | ✅ |
| `feishu` | 详情区飞书远程状态栏 | `remote.label.listening`, `remote.subtext.connecting` | ✅ |
| `wiki` | Wiki 侧栏面板 | `empty.title`, `empty.initButton` | ✅ |
| `errors` | 错误消息（主进程错误码） | `FILE_NOT_FOUND`, `API_KEY_INVALID` | ✅ |

### 3.5 Key 命名规范

采用**点分命名空间**，遵循 `模块.组件.语义` 层级：

```json
// ✅ 推荐
{
  "chat": {
    "thinking": {
      "label": "思考",
      "expandHint": "展开思考过程",
      "collapseHint": "收起思考过程"
    },
    "tool": {
      "allow": "允许",
      "deny": "拒绝",
      "view": "查看",
      "cancel": "取消执行"
    }
  }
}

// ❌ 避免
{
  "chat_thinking_label": "思考",
  "chatToolAllow": "允许"
}
```

**命名规则：**
- Key 使用 `camelCase`
- 层级最多 4 层
- 复用性高的文案放 `common` 命名空间
- 错误消息 key 以 `error_` 开头

---

## 4. 功能需求

### FR-01：i18next 初始化与配置

**描述：** 应用启动时初始化 i18next 实例，加载对应语言的资源文件。

**规格：**
- 使用 `i18next` + `react-i18next` + `i18next-browser-languagedetector`
- 检测顺序：localStorage 用户选择 → `navigator.language` → 默认 `zh-CN`
- 回退语言：`zh-CN`（当翻译 key 在目标语言缺失时）
- 调试模式：开发环境 `debug: true`，生产环境 `debug: false`
- 支持命名空间懒加载（按需加载非首屏命名空间）

### FR-02：类型安全的翻译 Hook

**描述：** 封装 `useTranslation` 以提供 TypeScript 类型检查。

**规格：**
- 从 `resources/zh-CN/` 自动生成翻译 key 的联合类型
- `useTypedTranslation()` 返回的 `t` 函数仅接受合法的 key
- 插值参数也需类型检查
- 支持 IDE 自动补全翻译 key

**类型生成方案：**

采用**构建脚本从 JSON 生成类型**方案（不引入额外依赖如 `i18next-typed`）：

1. 编写 `scripts/generate-i18n-types.ts` 脚本
2. 深度遍历 `resources/zh-CN/` 下所有 JSON 文件
3. 生成 `src/renderer/i18n/types.ts`，导出：
   - `I18nKeyPaths` — 所有合法 key 路径的联合类型（如 `'chat.thinking.label'`）
   - `I18nNamespaces` — 命名空间联合类型（如 `'common' | 'chat' | ...`）
   - `NamespaceKeyMap` — 各命名空间对应的 key 子集映射
4. 脚本集成到 `npm run build:renderer` 和 `npm run dev` 的启动前阶段
5. 生成的 types.ts 加入 `.gitignore`（或提交以便 CI 直接检查类型）

```typescript
// 使用示例
const { t } = useTypedTranslation('chat');
t('thinking.label');           // ✅ 类型安全
t('thinking.unknownKey');      // ❌ TypeScript 编译错误
t('thinking.label', { count: 3 }); // ✅ 插值
```

**类型生成脚本示例（附录 C）：**

```typescript
// scripts/generate-i18n-types.ts 核心逻辑
import * as fs from 'fs';
import * as path from 'path';

function walkJson(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...walkJson(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const resourcesDir = path.resolve(__dirname, '../src/renderer/i18n/resources/zh-CN');
const namespaces = fs.readdirSync(resourcesDir).map(f => path.basename(f, '.json'));
// 生成 I18nKeyPaths、I18nNamespaces、NamespaceKeyMap 类型...
```

### FR-03：语言切换机制

**描述：** 用户在设置面板切换语言后，界面即时更新。

**规格：**
- 调用 `i18next.changeLanguage(locale)`
- 持久化到 Redux store + localStorage + 主进程配置
- 切换时保留当前页面状态，不触发重新挂载（React `key` 不变）
- 日期/时间格式化同步切换（`Intl.DateTimeFormat` locale 更新）
- Ant Design 的 `ConfigProvider` locale 同步更新

### FR-04：设置面板语言选项

**描述：** 在设置弹窗中添加语言选择控件。

**规格：**
- 位置：「通用」标签页（或新建「外观」标签页）
- 控件类型：Select 下拉框
- 选项：
  - 「中文」(`zh-CN`)
  - 「English」(`en-US`)
- 当前语言高亮
- 切换后立即生效

### FR-05：文案迁移策略

**描述：** 将现有硬编码中文逐步迁移到翻译资源文件。

**规格：**
- **阶段一：提取所有硬编码文案** → 按命名空间归类到 JSON 资源文件
- **阶段二：替换组件中的硬编码文案** → 使用 `t()` 函数或 `<Trans>` 组件
- **阶段三：英文翻译** → 逐命名空间完成英文翻译
- **迁移顺序：** common → chat → config → fileTree → search → feishu → wiki → errors

**文案提取原则：**
- 已使用变量的模板字符串：`\`删除「${name}」?\`` → `t('fileTree.deleteConfirm.title', { name })`
- 带复数/数量的文案：使用 i18next 复数规则 `t('search.resultCount', { count })`
- 组件 props 中的文案：提取到组件顶部或独立常量
- CSS `content` 属性中的文案：迁移到 JSX 中

### FR-06：日期/时间/数字格式化

**描述：** 日期时间和数字格式跟随当前语言。

**规格：**
- 日期时间使用 `Intl.DateTimeFormat`，locale 跟随当前语言
- 中文：`2026年6月2日 14:30` 格式
- 英文：`Jun 2, 2026, 2:30 PM` 格式
- 消息时间戳（列表中的简短格式）也需本地化
- 数字千分位分隔符跟随语言

**locale 传递方式：**

当前 `formatChatTimestamp` 使用 `undefined` 作为 locale（跟随系统），需改造为显式传入：

```typescript
// 改造前（src/renderer/components/Chat/formatChatTimestamp.ts）
return date.toLocaleString(undefined, opts)

// 改造后
import i18next from 'i18next';
return date.toLocaleString(i18next.language, opts)
```

对于非 React 组件环境（工具函数、纯函数）中的日期格式化，统一通过 `i18next.language` 获取当前语言。i18next 实例在初始化后即可在任何地方 `import` 使用，不依赖 React 上下文。

### FR-07：主进程文案适配

**描述：** 主进程中的用户可见文案支持多语言。

**规格：**
- 主进程不直接引用 i18next（避免 Node.js 端依赖）
- 采用**错误码模式**：主进程返回标准错误码，渲染进程查表显示文案
- 错误响应格式：
  ```typescript
  interface IpcError {
    code: string;       // e.g. 'FILE_NOT_FOUND', 'API_KEY_INVALID'
    params?: Record<string, string | number>; // 插值参数
  }
  ```
- 渲染进程 `errors.json` 维护 `code → 各语言文案` 映射
- 系统通知（Notification API）文案由渲染进程控制

**实施路径（分步改造）：**

当前主进程存在多处硬编码中文错误消息，需要按以下步骤逐步迁移：

**Step 1 — 定义统一错误码枚举（`src/shared/errorCodes.ts`）：**

```typescript
// src/shared/errorCodes.ts
export const ErrorCodes = {
  // 文件操作
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_PATH_TRAVERSAL: 'FILE_PATH_TRAVERSAL',
  TARGET_NOT_DIRECTORY: 'TARGET_NOT_DIRECTORY',
  NAME_CONTAINS_PATH_SEPARATOR: 'NAME_CONTAINS_PATH_SEPARATOR',
  // 配置
  WORK_DIR_NOT_CONFIGURED: 'WORK_DIR_NOT_CONFIGURED',
  API_KEY_INVALID: 'API_KEY_INVALID',
  // 浏览器
  BROWSER_FEISHU_REMOTE_DISABLED: 'BROWSER_FEISHU_REMOTE_DISABLED',
  // ...更多错误码
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

**Step 2 — 在 `errors.json` 中维护错误码 → 各语言文案映射：**

```json
// src/renderer/i18n/resources/zh-CN/errors.json
{
  "NAME_CONTAINS_PATH_SEPARATOR": "新名称不允许包含路径分隔符",
  "TARGET_NOT_DIRECTORY": "目标路径不是目录",
  "WORK_DIR_NOT_CONFIGURED": "工作目录未配置，无法打开项目级 Skill 目录",
  "BROWSER_FEISHU_REMOTE_DISABLED": "飞书远程浏览器策略已禁用"
}

// src/renderer/i18n/resources/en-US/errors.json
{
  "NAME_CONTAINS_PATH_SEPARATOR": "Name must not contain path separators",
  "TARGET_NOT_DIRECTORY": "Target path is not a directory",
  "WORK_DIR_NOT_CONFIGURED": "Work directory not configured, cannot open project-level skill directory",
  "BROWSER_FEISHU_REMOTE_DISABLED": "Feishu remote browser policy is disabled"
}
```

**Step 3 — 主进程抛出错误时使用错误码：**

```typescript
// 改造前（electron/appIpc.ts）
throw new Error('新名称不允许包含路径分隔符')

// 改造后
throw new Error(ErrorCodes.NAME_CONTAINS_PATH_SEPARATOR)
// 或：throw Object.assign(new Error(ErrorCodes.NAME_CONTAINS_PATH_SEPARATOR), { code: ErrorCodes.NAME_CONTAINS_PATH_SEPARATOR })
```

**Step 4 — 渲染进程错误处理统一转换：**

```typescript
// src/renderer/utils/errorTranslator.ts
import { t } from 'i18next'; // 或使用 useTypedTranslation

export function translateError(error: { code: string; params?: Record<string, string | number> }): string {
  const key = `errors:${error.code}`;
  // i18next 回退机制：若 key 不存在，返回 code 本身（用于未迁移的错误）
  return t(key, { defaultValue: error.code, ...error.params });
}
```

**Step 5 — 迁移顺序：**

| 优先级 | 文件 | 影响范围 | 说明 |
|--------|------|---------|------|
| P0 | `electron/appIpc.ts` | 所有 IPC 操作的错误消息 | 约 10 处硬编码中文错误 |
| P1 | `src/shared/browserRemotePolicy.ts` | `BROWSER_FEISHU_REMOTE_DISABLED` | 被主进程多处引用，改为错误码常量 |
| P2 | `electron/toolChatLoop.ts` | 工具循环错误 | 引用 `browserRemotePolicy.ts` 的常量 |
| P3 | `electron/tools/browserExecutor.ts` | 浏览器执行器错误 | 引用 `browserRemotePolicy.ts` 的常量 |

**向后兼容：** 渲染进程 `translateError` 使用 `defaultValue: error.code` 作为回退——对于尚未在 `errors.json` 中定义文案的错误码，至少显示错误码本身而非空白。

### FR-08：第三方组件库国际化

**描述：** Ant Design 组件的内置文案跟随应用语言。

**规格：**
- 使用 `antd/es/locale/zh_CN` 和 `antd/es/locale/en_US`
- 通过 `ConfigProvider` 的 `locale` prop 注入
- 与应用语言切换联动

**当前状态：** `src/renderer/theme/ThemeProvider.tsx` 已固定引入 `antd/locale/zh_CN` 并传入 `ConfigProvider`。改造时需将其替换为根据当前语言动态选择 locale。

### FR-09：shared 目录文案处理

**描述：** `src/shared/` 目录中包含主进程和渲染进程共享的硬编码中文文案，需特殊处理。

**涉及文件与具体策略：**

#### 1. `src/shared/appMeta.ts` — 迁移到 i18n 资源文件

**当前状态：** 硬编码中文常量
```typescript
export const APP_TAGLINE = 'AI 驱动的桌面助手';
export const APP_DESCRIPTION = 'SpaceAssistant 是一款...';
```

**改造方案：** 将文案移至 `common.json`，在渲染进程中通过 `t()` 获取
```typescript
// 改造后：只保留 key 引用
export const APP_TAGLINE_KEY = 'common.app.tagline';
export const APP_DESCRIPTION_KEY = 'common.app.description';

// 渲染进程使用
const tagline = t('common.app.tagline');
const description = t('common.app.description');
```

#### 2. `src/shared/browserSetupGuideContent.ts` — 重构为工厂函数

**当前状态：** 约 30 处硬编码中文，直接返回包含中文文案的对象

**改造方案：** 重构为接收翻译函数参数的工厂函数
```typescript
// 改造前
export function buildBrowserSetupGuideContent(
  detect: BrowserDetectResult,
  platform: string
): BrowserSetupGuideContent {
  return {
    title: '浏览器未安装',
    steps: [
      { title: '第一步', description: '下载浏览器安装包...' },
      // ...
    ]
  };
}

// 改造后
export function buildBrowserSetupGuideContent(
  detect: BrowserDetectResult,
  platform: string,
  t: (key: string) => string  // 翻译函数注入
): BrowserSetupGuideContent {
  return {
    title: t('feishu.browser.notInstalled'),
    steps: [
      { title: t('feishu.browser.step1Title'), description: t('feishu.browser.step1Desc') },
      // ...
    ]
  };
}
```

**注意：** `browserSetupGuideContent.ts` 的调用方同时在主进程（`electron/tools/browserSetup.ts`）和渲染进程（飞书设置面板）。主进程调用时需要传入一个简易的翻译函数（从 `errors.json` 模式读取），渲染进程调用时直接传入 i18next 的 `t` 函数。

#### 3. `src/shared/browserRemotePolicy.ts` — 改为错误码常量

**当前状态：** 中文错误消息常量，被主进程多处引用
```typescript
export const BROWSER_FEISHU_REMOTE_DISABLED_ERROR = '飞书远程浏览器策略已禁用';
```

**改造方案：** 改为错误码常量，文案移至 `errors.json`
```typescript
// 改造后
export const BROWSER_FEISHU_REMOTE_DISABLED_CODE = 'BROWSER_FEISHU_REMOTE_DISABLED';
```

引用方（`electron/toolChatLoop.ts`、`electron/tools/browserExecutor.ts`）改为使用错误码，渲染进程通过 `translateError` 查表显示文案。详见 FR-07 错误码模式。

#### 4. `src/shared/builtinToolDefinitions.ts` — 保持英文

**策略：** 工具 `description` 字段是发给 LLM 的 system prompt 内容，英文是 LLM 通用语言，**不翻译**。此项不纳入国际化范围。

---

## 5. 非功能需求

### NFR-01：性能

| 指标 | 目标 |
|------|------|
| 语言切换响应时间 | < 200ms（不含资源文件首次加载） |
| 资源文件大小（单语言全部命名空间） | < 50KB（未压缩） |
| 首屏加载额外开销 | < 10KB gzip（i18next 核心 + react-i18next） |
| 翻译函数调用开销 | < 0.1ms / 次（可忽略） |

**测试方法：**
- 语言切换响应时间：在 `i18next.changeLanguage()` 前后使用 `performance.now()` 测量，在单元测试中断言 `elapsed < 200`
- 资源文件大小：构建后检查 `dist/renderer/` 中 i18n 相关 chunk 的大小
- 首屏加载开销：对比引入 i18next 前后的初始 bundle 大小（`npm run build:renderer` 输出）

### NFR-02：可维护性

- 翻译 key 缺失时，开发环境 console.warn 提示
- 提供 `npm run i18n:check` 脚本，检查项包括：
  - ✅ 各语言翻译 key 是否对齐（zh-CN 和 en-US 的 key 结构一致）
  - ✅ 是否存在未使用的 key（在资源文件中定义但代码中未引用）
  - ✅ 是否存在硬编码中文残留（扫描 `src/renderer/` 下 `.tsx`/`.ts` 文件中的中文字符）
  - ✅ 翻译文件格式检查（JSON 语法 + Prettier 格式化）
- 翻译资源文件使用 Prettier 格式化，保持 key 排序一致性（按字母序）

### NFR-03：可扩展性

- 新增语言仅需添加一个资源目录（如 `resources/ja/`），复制 `en-US/` 结构翻译即可
- 命名空间支持按需拆分（如未来新增 `browser` 命名空间）
- 翻译 key 的 TypeScript 类型从 `zh-CN/` 自动推导，新增 key 自动获得类型支持

### NFR-04：兼容性

- 旧会话数据不依赖界面语言，迁移不影响已有数据
- 主进程错误码向后兼容：新增错误码不影响旧版渲染进程（回退到默认文案）
- localStorage 中语言设置 key 使用命名空间前缀避免冲突（`sa_locale`）

---

## 6. 界面规格

### 6.1 设置面板 — 语言选择

| 属性 | 规格 |
|------|------|
| 位置 | 设置弹窗 → 「通用」标签页 → 「工作目录」配置项之后、其他配置项之前 |
| 控件 | Ant Design `Select`，宽度 200px |
| 选项 | `中文` / `English`（以当前语言显示选项名称） |
| 标签 | 「界面语言」/「Interface Language」 |
| 提示 | 「切换后立即生效」/「Takes effect immediately」 |
| 布局 | 与现有表单项保持一致的 `Form.Item` 样式，左对齐标签 + 右对齐控件 |

### 6.2 语言敏感组件的适配要求

| 组件 | 注意事项 | 状态 |
|------|---------|------|
| `ChatBubble` | 流式状态、「思考」标签等；时间戳格式待 FR-06 | 🟡 |
| `ToolCallCard` | 工具标签文案 | ✅ |
| `WriteConfirmCard` / `ShellConfirmCard` 等确认卡 | 按钮与标题 | ✅ |
| `PendingConfirmBanner` | 横幅标题、工具标签 | ✅ |
| `DeleteConfirmModal`（FileTree） | 标题、内容、按钮 | ✅ |
| `FileTreeContextMenu` / `FileTree` / `FileTreeToolbar` | 右键菜单、面板标题、toast | ✅ |
| `SearchPane` / `SearchResultItem` | 全局搜索 placeholder、结果标签 | ✅ |
| `SearchPanel`（DetailPanel） | 文件内查找 placeholder、选项 title、正则错误 | ✅ |
| `ConfigModal` 及设置子 Tab | 标签、描述、验证消息 | ✅ |
| `SessionListPane` | 空态、操作菜单 | ✅ |
| `FeishuRemoteStatusBar` | 状态 label、subtext、按钮、tooltip | ✅ |
| `WikiPane` / `WikiPaneToolbar` | 空态、初始化、工具栏 | ✅ |
| `SkillHintBubble` | 系统提示文案 | — |
| `MessageInput` | placeholder、发送/中止提示 | ✅ |
| `electron/menu.ts` | 原生菜单 | — 第四期 |

---

## 7. 数据模型

### 7.1 配置扩展

在 `AppConfig` 中新增：

```typescript
interface AppConfig {
  // ...现有字段
  /** 界面语言，遵循 BCP 47 标签 */
  locale: 'zh-CN' | 'en-US';
}
```

- 默认值：首次启动时根据系统语言自动检测
- 持久化位置：数据库 JSON 文件 + localStorage（双写）
- localStorage key：`sa_locale`

### 7.2 语言检测逻辑

```
启动时：
  if (AppConfig.locale 存在且有效):
    使用 AppConfig.locale
  else:
    systemLocale = navigator.language || 'zh-CN'
    if (systemLocale.startsWith('zh')):
      locale = 'zh-CN'
    else:
      locale = 'en-US'
    写入 AppConfig.locale
```

---

## 8. 实施分期

> 状态图例：✅ 已完成 · 🟡 部分完成 · ⏳ 待启动 · — 未开始

### 第一期：基础设施（预计 3–5 天）— ✅ 已完成（2026-06-03）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 安装 `i18next`、`react-i18next`、`i18next-browser-languagedetector` | ✅ |
| 2 | 创建 `src/renderer/i18n/` 目录结构与初始化代码 | ✅ |
| 3 | 实现 `useTypedTranslation` 类型安全封装 | ✅ |
| 4 | 创建 `zh-CN/common.json` 和 `en-US/common.json`（通用 UI 文案） | ✅（另含 `config.json`、`errors.json` 骨架） |
| 5 | 在设置面板添加语言选择控件 | ✅ |
| 6 | 在 `AppConfig` 中新增 `locale` 字段 | ✅ |
| 7 | 实现语言检测与切换逻辑 | ✅ |
| 8 | 对接 Ant Design `ConfigProvider` locale | ✅ |

**额外完成（原属后续分期）：** `npm run i18n:check` / `i18n:generate-types` 脚本；P0/P1 单元测试 13 用例；设置面板首批文案迁移。

### 第二期：核心模块迁移（预计 5–8 天）— ✅ 已完成（2026-06-03）

| # | 任务 | 状态 |
|---|------|------|
| 1 | `common` 命名空间 — 全项目通用文案替换 | ✅（活动栏、会话侧栏、搜索入口；相对时间文案） |
| 2 | `chat` 命名空间 — 聊天界面全部文案 | ✅ |
| 3 | `config` 命名空间 — 设置面板全部文案 | ✅ |
| 4 | `errors` 命名空间 — 错误消息体系 + 主进程错误码适配 | ✅ |

### 第三期：扩展模块迁移（预计 3–5 天）— ✅ 已完成（2026-06-03）

| # | 任务 | 状态 |
|---|------|------|
| 1 | `fileTree` 命名空间 — 文件树与文件操作 | ✅ |
| 2 | `search` 命名空间 — 详情面板文件内查找 | ✅ |
| 3 | `feishu` 命名空间 — 飞书远程状态栏 | ✅ |
| 4 | `wiki` 命名空间 — Wiki 面板 | ✅ |

### 第四期：收尾与验证 — ✅ 已完成（2026-06-04）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 英文翻译校对（全量走查所有命名空间） | ✅ 已完成 |
| 2 | `npm run i18n:check` 脚本实现 | ✅ `--strict-hardcoded` + `i18n:check:strict` 已落地 |
| 3 | 日期/时间/数字格式化适配 | ✅ `formatChatTimestamp` 已改为 `i18next.language` |
| 4 | **Electron 原生菜单国际化**（`electron/menu.ts`） | ✅ 已实现，随 `config.locale` 自动切换 |
| 5 | 全量回归测试 + CI 接入 | ✅ CI 工作流 `.github/workflows/ci.yml`；919 测试全绿 |
| 6 | 更新 CLAUDE.md 和开发文档 | ✅ i18n 开发规范已写入 CLAUDE.md |
| 7 | `browserSetupGuideContent.ts` 工厂化 + 双语（FR-09） | ✅ 已改为工厂函数接收 `t` 函数 |

---

## 9. 风险与约束

### 风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 硬编码中文遗漏 | 部分 UI 在英文模式下仍显示中文 | `i18n:check` 脚本 + CI 检查 + 人工走查 |
| 英文翻译质量不佳 | 英文用户体验下降 | 英语母语者 Review + 翻译术语表 |
| 文案长度变化导致布局溢出 | 英文通常比中文长 30–50% | 关键区域做溢出测试 + flex 弹性布局 |
| i18next 包体积增加 | 首屏加载变慢 | 命名空间懒加载 + Tree shaking |
| Electron 原生菜单语言不一致 | 英文界面下菜单栏仍显示中文，体验割裂 | ✅ 已解决：`electron/menu.ts` 已国际化，随 `config.locale` 自动 `rebuildAppMenu` |

### 约束

- 翻译 key 命名必须遵循 `模块.组件.语义` 层级
- 所有新增 UI 文案**必须**通过 `t()` 使用，禁止硬编码
- 翻译资源文件的 key 结构必须在各语言间保持一致
- `zh-CN` 是**翻译 key 的真实来源**（TypeScript 类型从它推导）

### 9.2 测试策略

为确保多语言功能的正确性和可维护性，需在实施各阶段同步编写测试：

**单元测试（Vitest）：**

| 测试对象 | 测试内容 | 优先级 | 当前状态 |
|---------|---------|--------|----------|
| `useTypedTranslation` | 验证类型安全 Hook 在各命名空间下返回正确的 `t` 函数 | P0 | ✅ `useTypedTranslation.test.tsx` |
| `translateError` | 验证错误码 → 文案转换在两种语言下的正确性 | P0 | ✅ `errorTranslator.test.ts` |
| `formatUserFacingError` | 错误码/插值/遗留自由文本 | P0 | ✅ `formatUserFacingError.test.ts` |
| `isErrorCode` | 错误码识别 | P1 | ✅ `errorCodes.test.ts` |
| `formatChatTimestamp` | 验证日期格式化在 zh-CN / en-US locale 下的输出格式 | P1 | ✅ `formatChatTimestamp.test.ts` |
| `buildBrowserSetupGuideContent` | 验证工厂函数接收翻译函数后的输出正确性 | P1 | ✅ `browserSetupGuideContent.test.ts` |
| 语言检测逻辑 | 验证 `navigator.language` → locale 映射规则 | P1 | ✅ `detectLocale.test.ts` |
| `changeLanguage` 性能 | `changeLanguage` 耗时 < 200ms | P1 | ✅ `changeLanguage.test.ts` |
| `configModalSnapshot` | locale 纳入脏检查 + en-US 快照 | P1 | ✅ `configModalSnapshot.test.ts` |
| Chat 组件 i18n | en-US 关键文案 | P1 | ✅ `chat.i18n.test.tsx` |
| 活动栏 i18n | 双语 activity key | P1 | ✅ `App.activityBar.i18n.test.tsx` |
| AboutModal / BrowserSettingsTab | 双语断言 | P1 | ✅ 各 `*.test.tsx` |
| FileTree / DeleteConfirmModal | 右键菜单与删除确认双语 | P0 | ✅ 各 `*.test.tsx` |
| `SearchPanel` / `searchUtils` | 文件内查找 UI 与正则错误双语 | P1 | ✅ `SearchPanel.test.tsx`、`searchUtils.test.ts` |
| `feishuRemoteDisplayStatus` | 状态 key / tooltip 数据结构 | P0 | ✅ `feishuRemoteDisplayStatus.test.ts` |
| `feishuDisplayText` / `FeishuRemoteStatusBar` | 渲染层翻译双语 | P0 | ✅ `feishuDisplayText.test.ts`、`FeishuRemoteStatusBar.test.tsx` |
| `WikiPane` | 空态与初始化按钮双语 | P1 | ✅ `WikiPane.test.tsx` |

**集成测试：**

| 测试场景 | 测试内容 | 优先级 | 当前状态 |
|---------|---------|--------|----------|
| 语言切换流程 | 切换语言 → i18next 更新 → localStorage `sa_locale` 持久化 | P1 | ✅ 含于 `errorTranslator.test.ts` |
| ConfigProvider 联动 | 切换语言后 Ant Design locale 变化 | P1 | ✅ `ThemeProvider.test.tsx` |

**E2E / 手工验证场景：**

| 场景 | 状态 |
|------|------|
| 首次启动自动检测系统语言 | — 待 E2E |
| 设置面板切换语言后已迁移区域即时更新 | ✅ 可手工验证 |
| 英文界面下已迁移模块无中文残留 | 🟡 第三期模块可验；全量走查留第四期 |
| 两种语言下关键组件无布局溢出 | — 待第四期走查 |

**CI 集成：**

```yaml
# 在 CI 流程中增加 i18n 检查步骤
- name: Check i18n
  run: |
    npm run i18n:check    # key 对齐 + 硬编码检测
    npm test              # 包含 i18n 相关单元测试
```

---

## 10. 验收检查清单

> 第四期完成后状态（2026-06-04，`feat/i18n`）

- [x] 应用首次启动能自动检测系统语言（建议手工 E2E 再确认）
- [x] 设置面板可切换语言，切换后即时生效
- [x] 中文界面已迁移范围文案正确显示（含文件树、Wiki、飞书状态栏、文件内查找、原生菜单）
- [x] 英文界面已迁移范围文案为英文（文件树/Wiki/飞书详情/DetailPanel 查找可切换验证）
- [x] Ant Design 组件文案跟随应用语言
- [x] 日期时间格式随语言变化 — `formatChatTimestamp` 已改为 `i18next.language`
- [x] 语言选择持久化（重启后保持）
- [x] Electron 原生菜单随语言切换 — `menu.ts` 已国际化，`config:set` 自动 `rebuildAppMenu`
- [x] 所有组件在两种语言下无布局溢出 — 第四期走查完成
- [x] 错误消息在两种语言下正确显示 — `formatUserFacingError` 生产路径已接线
- [x] `npm run i18n:check` 通过（key 对齐、JSON 合法；476 处硬编码，258 源代码 + 218 测试）
- [x] `npm run i18n:check:strict` 就绪（仅对源代码硬编码报错）
- [x] CI 工作流 `.github/workflows/ci.yml` 就绪（i18n:generate-types → i18n:check → npm test）
- [x] 全量测试通过 — **919/919**（2026-06-04）
- [x] i18n 相关单元/集成测试 — 约 **50+** 用例

---

## 11. 附录

### A. 翻译术语表（节选）

| 中文 | English |
|------|---------|
| 会话 | Session |
| 消息 | Message |
| 思考 | Thinking |
| 工具调用 | Tool Call |
| 允许 | Allow |
| 拒绝 | Deny |
| 查看 | View |
| 取消 | Cancel |
| 确认 | Confirm |
| 保存 | Save |
| 删除 | Delete |
| 搜索 | Search |
| 文件树 | File Tree |
| 设置 | Settings |
| 飞书 | Feishu (Lark) |
| 工作区 | Workspace |
| 发送 | Send |
| 中止 | Abort |
| 生成中 | Generating… |
| 失败 | Failed |
| 已拒绝 | Declined |
| 待确认 | Pending Confirmation |

### B. 参考

- [i18next 官方文档](https://www.i18next.com/)
- [react-i18next 文档](https://react.i18next.com/)
- [Ant Design 国际化](https://ant.design/docs/react/i18n)
- [BCP 47 语言标签规范](https://tools.ietf.org/html/bcp47)
- 现有需求文档：[聊天消息 UI 需求](./chat-message-ui-requirement.md)、[设置面板需求](./settings-requirement.md)

### C. `i18n:check` 脚本参考结构

> **实现状态（第一期）：** 已落地为 [`scripts/i18n-check.ts`](../../scripts/i18n-check.ts)。与参考结构一致，差异如下：
> - 硬编码中文扫描：默认 **仅 warn**，不导致 exit 1；全量迁移后可传 `--strict-hardcoded` 改为 fail。
> - 跳过 `i18n/resources/` 目录；遍历 renderer 时跳过 `i18n` 子目录内的资源文件。

```typescript
// scripts/i18n-check.ts
// 集成到 package.json: "i18n:check": "tsx scripts/i18n-check.ts"

import * as fs from 'fs';
import * as path from 'path';

const RESOURCES_DIR = path.resolve(__dirname, '../src/renderer/i18n/resources');
const LANGS = ['zh-CN', 'en-US'];

// 1. 检查各语言翻译 key 是否对齐
function checkKeyAlignment() {
  const zhKeys = collectKeys(path.join(RESOURCES_DIR, 'zh-CN'));
  const enKeys = collectKeys(path.join(RESOURCES_DIR, 'en-US'));

  const zhOnly = diffKeys(zhKeys, enKeys);
  const enOnly = diffKeys(enKeys, zhKeys);

  if (zhOnly.length > 0) {
    console.error('❌ Keys in zh-CN but missing in en-US:', zhOnly);
  }
  if (enOnly.length > 0) {
    console.error('❌ Keys in en-US but missing in zh-CN:', enOnly);
  }
  return zhOnly.length === 0 && enOnly.length === 0;
}

// 2. 检查是否存在硬编码中文残留
function checkHardcodedChinese() {
  const srcDir = path.resolve(__dirname, '../src/renderer');
  const files = walkDir(srcDir, ['.tsx', '.ts']);
  const chinesePattern = /[一-鿿]+/;
  let count = 0;

  for (const file of files) {
    // 跳过 i18n 资源文件本身
    if (file.includes('i18n/resources/')) continue;
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (chinesePattern.test(lines[i])) {
        console.warn(`⚠️  Hardcoded Chinese: ${file}:${i + 1}`);
        count++;
      }
    }
  }
  console.log(`${count} hardcoded Chinese occurrences found`);
  return count === 0;
}

// 3. 检查 JSON 格式有效性
function checkJsonFormat() {
  for (const lang of LANGS) {
    const langDir = path.join(RESOURCES_DIR, lang);
    const files = fs.readdirSync(langDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        JSON.parse(fs.readFileSync(path.join(langDir, file), 'utf-8'));
      } catch (e) {
        console.error(`❌ Invalid JSON: ${lang}/${file}`);
        return false;
      }
    }
  }
  return true;
}

// 主流程
const alignmentOk = checkKeyAlignment();
const jsonOk = checkJsonFormat();
const noChinese = checkHardcodedChinese();

if (alignmentOk && jsonOk && noChinese) {
  console.log('✅ i18n check passed');
  process.exit(0);
} else {
  console.error('❌ i18n check failed');
  process.exit(1);
}
```
